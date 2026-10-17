import { guardResponseBodyInactivity } from "../../lib/response-body-inactivity";
import { isNonReplayableResponse } from "../../lib/upstream-retry";
import { isPlainObject } from "../responses-snapshot-codec";
import { BoundedSseFrameBuffer, joinSseFrameBytes } from "../sse-frame-buffer";
import { sseDataPayload } from "../sse-payload-rewrite";
import { EMPTY_COMPLETION_MAX_BUFFERED_BYTES, EMPTY_COMPLETION_MAX_BUFFERED_EVENTS, EMPTY_COMPLETION_RETRY_ENV } from "./empty-completion-guard";
import { selfContainedResponsesBody } from "./reset-replay";
import { carryResponseToolOwnership } from "./response-tool-ownership";

const MAX_BYTES = EMPTY_COMPLETION_MAX_BUFFERED_BYTES;
const MAX_EVENTS = EMPTY_COMPLETION_MAX_BUFFERED_EVENTS;
const MAX_HOLD_MS = 30_000;
const decoder = new TextDecoder();
const reasoningEvents = new Set([
  "response.reasoning_summary_part.added", "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
  "response.reasoning_text.delta", "response.reasoning_text.done",
]);
type RecordValue = Record<string, unknown>;

function partCommits(part: unknown): boolean {
  return !isPlainObject(part) || part.type !== "output_text" || part.text !== ""
    || (part.annotations !== undefined && (!Array.isArray(part.annotations) || part.annotations.length > 0));
}
function outputCommits(output: unknown): boolean {
  if (output === undefined) return false;
  return !Array.isArray(output) || output.some(item => !isPlainObject(item)
    || (item.type !== "reasoning" && (item.type !== "message" || !Array.isArray(item.content) || item.content.some(partCommits))));
}
function wellFormedEmpty(snapshot: unknown): snapshot is RecordValue {
  return isPlainObject(snapshot) && typeof snapshot.id === "string" && snapshot.id.trim().length > 0
    && snapshot.object === "response" && snapshot.status === "completed" && Array.isArray(snapshot.output)
    && snapshot.error == null && snapshot.incomplete_details == null
    && snapshot.output.every(item => isPlainObject(item) && typeof item.id === "string" && item.id.length > 0
      && (item.type === "reasoning" || (item.type === "message" && item.role === "assistant"
        && item.status === "completed" && Array.isArray(item.content) && !item.content.some(partCommits))));
}
function eventCommits(event: RecordValue): boolean {
  if (event.replayUnsafe === true) return true;
  switch (event.type) {
    case "response.created": case "response.in_progress": case "response.queued": case "response.heartbeat":
      return isPlainObject(event.response) && outputCommits(event.response.output);
    case "response.output_item.added": case "response.output_item.done": return outputCommits([event.item]);
    case "response.content_part.added": case "response.content_part.done": return partCommits(event.part);
    case "response.output_text.delta": return event.delta !== "";
    case "response.output_text.done": return event.text !== "";
    default: return !reasoningEvents.has(String(event.type));
  }
}

export interface OpenGatewayCompletionGuardOptions {
  readonly url: string;
  readonly body: unknown;
  readonly signal: AbortSignal;
  readonly retry: () => Promise<Response>;
  readonly recordUsage: (usage: unknown) => void;
  readonly retryEnabled?: boolean;
  readonly stallTimeoutMs?: number;
  /** Expiry releases original bytes; it never aborts a healthy upstream. */
  readonly holdTimeoutMs?: number;
}

type Inspection = { kind: "pass"; response: Response }
  | { kind: "empty" | "invalid"; snapshot: RecordValue; streaming: boolean };

async function inspect(response: Response, options: OpenGatewayCompletionGuardOptions): Promise<Inspection> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const streaming = contentType.includes("text/event-stream")
    || (!contentType && isPlainObject(options.body) && options.body.stream === true);
  if (!response.body || (!streaming && !contentType.includes("application/json"))) return { kind: "pass", response };
  const guarded = guardResponseBodyInactivity(response, options.signal, streaming ? options.stallTimeoutMs ?? 0 : 0);
  const reader = guarded.response.body?.getReader();
  if (!reader) return { kind: "pass", response };
  const framer = new BoundedSseFrameBuffer(MAX_BYTES);
  const held: Uint8Array[] = [];
  let bytes = 0, events = 0, transferred = false, cleaned = false;
  let pending: ReturnType<typeof reader.read> | undefined;
  const holdMs = options.holdTimeoutMs ?? MAX_HOLD_MS;
  const deadline = performance.now() + holdMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">(resolve => { timer = setTimeout(() => resolve("expired"), holdMs); });
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    guarded.dispose();
    reader.releaseLock();
  };
  const pass = (): Inspection => {
    transferred = true;
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index < held.length) { controller.enqueue(held[index++]); return; }
        try {
          const next = await (pending ?? reader.read());
          pending = undefined;
          if (next.done) { cleanup(); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) { cleanup(); controller.error(error); }
      },
      cancel() { cleanup(); },
    }, { highWaterMark: 0 });
    return { kind: "pass", response: carryResponseToolOwnership(response, new Response(body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    })) };
  };
  const terminal = (snapshot: unknown): Inspection => ({
    kind: wellFormedEmpty(snapshot) ? "empty" : "invalid",
    snapshot: isPlainObject(snapshot) ? snapshot : {}, streaming,
  });
  try {
    for (;;) {
      if (performance.now() >= deadline) return pass();
      pending = reader.read();
      let next: Awaited<typeof pending> | "expired";
      try { next = await Promise.race([pending, expired]); }
      catch { return pass(); }
      if (next === "expired") return pass();
      pending = undefined;
      if (!next.done) {
        if (bytes + next.value.byteLength > MAX_BYTES || held.length >= MAX_EVENTS) {
          held.push(next.value);
          return pass();
        }
        held.push(next.value.slice());
        bytes += next.value.byteLength;
      }
      if (!streaming) {
        if (!next.done) continue;
        let snapshot: unknown;
        try { snapshot = JSON.parse(decoder.decode(joinSseFrameBytes(held))); }
        catch { return terminal(undefined); }
        if (isPlainObject(snapshot) && (outputCommits(snapshot.output)
          || snapshot.error != null || ["failed", "incomplete", "queued", "in_progress"].includes(String(snapshot.status)))) return pass();
        return terminal(snapshot);
      }
      let frames;
      try { frames = next.done ? [{ block: framer.finish() }] : framer.feed(next.value); }
      catch { return pass(); }
      for (const raw of frames) {
        if (raw.block.byteLength === 0) continue;
        if (++events >= MAX_EVENTS) return pass();
        const block = decoder.decode(raw.block), data = sseDataPayload(block);
        if (data === null) { if (/^event:/m.test(block)) return pass(); continue; }
        let event: unknown;
        try { event = JSON.parse(data); } catch { return pass(); }
        if (!isPlainObject(event)) return pass();
        if (event.replayUnsafe === true) return pass();
        if (event.type === "response.completed") {
          if (isPlainObject(event.response) && outputCommits(event.response.output)) return pass();
          return terminal(event.response);
        }
        if (eventCommits(event)) return pass();
      }
      if (next.done) return pass();
    }
  } finally {
    clearTimeout(timer); framer.dispose();
    if (!transferred) cleanup();
  }
}

function terminalResponse(source: Response, inspection: Exclude<Inspection, { kind: "pass" }>, reason: string): Response {
  const incomplete = reason === "max_output_tokens";
  const snapshot = { ...inspection.snapshot, status: incomplete ? "incomplete" : "failed",
    ...(incomplete ? { incomplete_details: { reason } } : { error: {
      type: "upstream_error", code: reason, message: "OpenGateway returned no usable completion before output.",
    } }),
  };
  const headers = new Headers(source.headers);
  headers.delete("content-length"); headers.delete("content-encoding");
  if (inspection.streaming) headers.set("content-type", "text/event-stream");
  const text = inspection.streaming
    ? `event: response.${snapshot.status}\ndata: ${JSON.stringify({ type: `response.${snapshot.status}`, response: snapshot })}\n\n`
    : JSON.stringify(snapshot);
  return new Response(text, { status: inspection.streaming || incomplete ? 200 : 502, headers });
}

export async function guardOpenGatewayCompletion(response: Response, options: OpenGatewayCompletionGuardOptions): Promise<Response> {
  if (options.url !== "https://apis.opengateway.ai/v1/responses" || response.status !== 200) return response;
  let body: unknown;
  try { body = typeof options.body === "string" ? JSON.parse(options.body) : options.body; }
  catch { return response; }
  if (!isPlainObject(body)) return response;
  const canReplay = options.retryEnabled !== false && process.env[EMPTY_COMPLETION_RETRY_ENV] !== "0"
    && selfContainedResponsesBody(body) && !isNonReplayableResponse(response);
  let selected = response;
  for (let attempt = 0; ; attempt++) {
    const inspected = await inspect(selected, options);
    if (inspected.kind === "pass") return inspected.response;
    if (inspected.kind === "invalid") return terminalResponse(selected, inspected, "invalid_completion");
    const usage = inspected.snapshot.usage;
    if (typeof body.max_output_tokens === "number" && body.max_output_tokens > 0
      && isPlainObject(usage) && typeof usage.output_tokens === "number" && usage.output_tokens >= body.max_output_tokens) {
      return terminalResponse(selected, inspected, "max_output_tokens");
    }
    if (attempt > 0 || !canReplay || options.signal.aborted) {
      return terminalResponse(selected, inspected, attempt > 0 ? "empty_completion_retry_failed" : "empty_completion");
    }
    options.recordUsage(usage);
    selected = await options.retry();
    if (selected.status !== 200) return selected;
  }
}
