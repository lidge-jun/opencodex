import { readBoundedResponseBody } from "../../lib/bounded-body";
import {
  BoundedSseFrameBuffer,
  joinSseFrameBytes,
  MAX_CLIENT_SSE_FRAME_BYTES,
} from "../sse-frame-buffer";
import { sseDataPayload } from "../relay";

export const CODEX_MODEL_CAPACITY_MESSAGE =
  "Selected model is at capacity. Please try a different model.";

const CAPACITY_CODES: ReadonlySet<string> = new Set([
  "server_is_overloaded",
  "slow_down",
]);

type JsonRecord = Record<string, unknown>;

export type CodexCapacityInspection =
  | { kind: "capacity"; response: Response }
  | { kind: "pass"; response: Response };

/** Narrow an unknown JSON value to a non-array object. */
function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

/** Normalize only whitespace and case for the exact-message compatibility check. */
function normalizeCapacityMessage(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

/** Match one structured capacity signal or the exact standard message. */
function hasCapacitySignal(value: unknown): boolean {
  if (typeof value === "string") return CAPACITY_CODES.has(value.trim().toLocaleLowerCase("en-US"));
  const candidate = record(value);
  if (!candidate) return false;
  const code = typeof candidate.code === "string"
    ? candidate.code.trim().toLocaleLowerCase("en-US")
    : "";
  if (CAPACITY_CODES.has(code)) return true;
  const type = typeof candidate.type === "string"
    ? candidate.type.trim().toLocaleLowerCase("en-US")
    : "";
  if (CAPACITY_CODES.has(type)) return true;
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return normalizeCapacityMessage(message)
    === normalizeCapacityMessage(CODEX_MODEL_CAPACITY_MESSAGE);
}

/** Exact structured capacity signals, plus the one standard message compatibility case. */
export function isCodexCapacityPayload(payload: unknown): boolean {
  const root = record(payload);
  if (!root) return false;
  const response = record(root.response);
  return [
    root,
    root.error,
    root.last_error,
    response,
    response?.error,
    response?.last_error,
  ].some(hasCapacitySignal);
}

/** Return whether a Responses envelope represents a terminal failure. */
function isFailedDocument(payload: unknown): boolean {
  const root = record(payload);
  if (!root) return false;
  const response = record(root.response);
  return root.type === "response.failed"
    || root.type === "error"
    || root.status === "failed"
    || response?.status === "failed";
}

/** Parse an SSE data payload without treating malformed bytes as retryable. */
function parsePayload(payload: string | null): unknown | undefined {
  if (!payload || payload === "[DONE]") return undefined;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

/** Allow only lifecycle events that cannot expose model output. */
function isSafePreOutputLifecycle(payload: unknown): boolean {
  const event = record(payload);
  if (!event) return false;
  return event.type === "response.created"
    || event.type === "response.in_progress"
    || event.type === "response.queued"
    || event.type === "response.heartbeat";
}

/** Rebuild a response while preserving status and non-length headers. */
function responseWithBody(response: Response, body: BodyInit | null): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Replay inspected bytes before resuming the untouched upstream reader. */
function replayBufferedThenReader(
  buffered: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
  terminalError?: unknown,
): ReadableStream<Uint8Array> {
  let prefixIndex = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (prefixIndex < buffered.length) {
        controller.enqueue(buffered[prefixIndex++]!);
        return;
      }
      if (terminalError !== undefined) {
        controller.error(terminalError);
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => undefined);
    },
  });
}

/** Return a committed attempt with every inspected byte restored. */
function passWithBufferedBody(
  response: Response,
  buffered: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
  terminalError?: unknown,
): CodexCapacityInspection {
  return {
    kind: "pass",
    response: responseWithBody(response, replayBufferedThenReader(buffered, reader, terminalError)),
  };
}

/** Inspect bounded lifecycle-only SSE frames until capacity or output commits the attempt. */
async function inspectSseCapacityBeforeOutput(
  response: Response,
  signal?: AbortSignal,
): Promise<CodexCapacityInspection> {
  const body = response.body;
  if (!body) return { kind: "pass", response };
  const reader = body.getReader();
  const framer = new BoundedSseFrameBuffer(MAX_CLIENT_SSE_FRAME_BYTES);
  const buffered: Uint8Array[] = [];
  const completeFrameParts: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let bufferedBytes = 0;
  let frameBytes = 0;

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      let next: { done: boolean; value?: Uint8Array };
      try {
        next = await reader.read();
      } catch (error) {
        framer.dispose();
        return passWithBufferedBody(response, buffered, reader, error);
      }
      if (next.done) {
        framer.dispose();
        return passWithBufferedBody(response, buffered, reader);
      }
      const chunk = next.value!;
      buffered.push(chunk);
      bufferedBytes += chunk.byteLength;

      let frames: ReturnType<BoundedSseFrameBuffer["feed"]>;
      try {
        frames = framer.feed(chunk);
      } catch {
        framer.dispose();
        return passWithBufferedBody(response, buffered, reader);
      }

      for (const frame of frames) {
        completeFrameParts.push(frame.block, frame.delimiter);
        frameBytes += frame.block.byteLength + frame.delimiter.byteLength;
        if (frameBytes > MAX_CLIENT_SSE_FRAME_BYTES) {
          framer.dispose();
          return passWithBufferedBody(response, buffered, reader);
        }
        const payloadText = sseDataPayload(decoder.decode(frame.block));
        if (payloadText === null) continue;
        if (payloadText === "[DONE]") {
          framer.dispose();
          return passWithBufferedBody(response, buffered, reader);
        }
        const payload = parsePayload(payloadText);
        if (isFailedDocument(payload)) {
          if (isCodexCapacityPayload(payload)) {
            framer.dispose();
            void reader.cancel("Codex capacity retry").catch(() => undefined);
            const capacityBytes = Uint8Array.from(joinSseFrameBytes(completeFrameParts));
            return {
              kind: "capacity",
              response: responseWithBody(response, capacityBytes),
            };
          }
          framer.dispose();
          return passWithBufferedBody(response, buffered, reader);
        }
        if (!isSafePreOutputLifecycle(payload)) {
          framer.dispose();
          return passWithBufferedBody(response, buffered, reader);
        }
      }

      if (bufferedBytes > MAX_CLIENT_SSE_FRAME_BYTES) {
        framer.dispose();
        return passWithBufferedBody(response, buffered, reader);
      }
    }
  } catch (error) {
    framer.dispose();
    void reader.cancel(error).catch(() => undefined);
    throw error;
  }
}

/**
 * Inspect a Codex response only while no substantive Responses event has been
 * exposed. SSE lifecycle frames are held under the existing client-frame byte
 * bound; any unknown or output-bearing event commits the attempt permanently.
 */
export async function inspectCodexCapacityBeforeOutput(
  response: Response,
  options: { streamRequested: boolean; signal?: AbortSignal },
): Promise<CodexCapacityInspection> {
  const contentType = response.headers.get("content-type")?.toLocaleLowerCase("en-US") ?? "";
  const isEventStream = contentType.includes("text/event-stream")
    || (response.ok && !!response.body && !contentType && options.streamRequested);
  if (isEventStream) return inspectSseCapacityBeforeOutput(response, options.signal);
  if (!response.ok
    && response.status !== 402
    && response.status !== 429
    && response.status < 500) {
    return { kind: "pass", response };
  }

  try {
    const body = await readBoundedResponseBody(response.clone(), {
      signal: options.signal,
      fatalUtf8: true,
    });
    if (!body.displaySafe || body.truncated || !body.text.trim()) {
      return { kind: "pass", response };
    }
    const payload = JSON.parse(body.text) as unknown;
    const rebuilt = responseWithBody(response, body.text);
    const capacity = isCodexCapacityPayload(payload)
      && (!response.ok || isFailedDocument(payload));
    return capacity ? { kind: "capacity", response: rebuilt } : { kind: "pass", response: rebuilt };
  } catch {
    if (options.signal?.aborted) throw options.signal.reason;
    return { kind: "pass", response };
  }
}
