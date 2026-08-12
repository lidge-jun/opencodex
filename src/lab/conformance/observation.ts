import type {
  CaseRecord,
  NormalizedEvent,
  NormalizedObservation,
  ToolCallProjection,
} from "./types";
import { normalizeSseBytes } from "./sse-normalize";

export function emptyObservation(): NormalizedObservation {
  return {
    client: {
      request: { status: 0, headers: {}, json: null, rawBytes: 0 },
      response: {
        status: 0,
        headers: {},
        json: null,
        events: [],
        toolCalls: [],
        mcpCalls: [],
        terminal: null,
        normalizedText: "",
      },
    },
    upstream: { requests: [], responses: [] },
    process: { exitCode: null },
    verifiers: {},
  };
}

export function recordUpstreamRequest(
  observation: NormalizedObservation,
  json: unknown,
  status = 0,
): void {
  const body = JSON.stringify(json ?? null);
  observation.upstream.requests.push({
    status,
    headers: {},
    json,
    rawBytes: new TextEncoder().encode(body).byteLength,
  });
}

export function setClientResponse(
  observation: NormalizedObservation,
  patch: Partial<NormalizedObservation["client"]["response"]>,
): void {
  observation.client.response = { ...observation.client.response, ...patch };
}

function parseToolArguments(raw: unknown, kind: "function" | "custom"): unknown {
  if (kind === "custom") return typeof raw === "string" ? raw : "";
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

interface ToolCallProjectionResult {
  calls: ToolCallProjection[];
  sawCallItems: boolean;
  duplicateIds: boolean;
}

function projectToolCallsDetailed(output: unknown[]): ToolCallProjectionResult {
  const calls: ToolCallProjection[] = [];
  let ordinal = 0;
  let sawCallItems = false;
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (rec.type === "function_call") {
      sawCallItems = true;
      const id = rec.call_id ?? rec.id;
      const name = rec.name;
      if (typeof id !== "string" || id.length === 0 || typeof name !== "string" || name.length === 0) continue;
      const args = parseToolArguments(rec.arguments, "function");
      if (args === null) continue;
      calls.push({ id, name, arguments: args, kind: "function", ordinal: ordinal++ });
    } else if (rec.type === "custom_tool_call") {
      sawCallItems = true;
      const id = rec.call_id ?? rec.id;
      const name = rec.name;
      if (typeof id !== "string" || id.length === 0 || typeof name !== "string" || name.length === 0) continue;
      calls.push({
        id,
        name,
        arguments: parseToolArguments(rec.input, "custom"),
        kind: "custom",
        ordinal: ordinal++,
      });
    }
  }
  const ids = calls.map((call) => call.id);
  const duplicateIds = new Set(ids).size !== ids.length;
  return { calls: duplicateIds ? [] : calls, sawCallItems, duplicateIds };
}

/** Build toolCalls projection from Responses output items or SSE events (manifest §5). */
export function projectToolCallsFromOutput(output: unknown[]): ToolCallProjection[] {
  return projectToolCallsDetailed(output).calls;
}

function projectToolCallsFromEventsDetailed(events: NormalizedEvent[]): ToolCallProjectionResult {
  const output: unknown[] = [];
  for (const ev of events) {
    if (ev.event === "response.output_item.done" && ev.data && typeof ev.data === "object") {
      const data = ev.data as Record<string, unknown>;
      const item = data.item;
      if (item && typeof item === "object") output.push(item);
    }
  }
  return projectToolCallsDetailed(output);
}

export function projectToolCallsFromEvents(events: NormalizedEvent[]): ToolCallProjection[] {
  return projectToolCallsFromEventsDetailed(events).calls;
}

export function projectMcpCalls(toolCalls: ToolCallProjection[]): Array<{ namespace: string; name: string }> {
  const out: Array<{ namespace: string; name: string }> = [];
  for (const call of toolCalls) {
    if (!call.name.startsWith("mcp__")) continue;
    const idx = call.name.lastIndexOf("__");
    if (idx <= 0 || idx >= call.name.length - 2) continue;
    const namespace = call.name.slice(0, idx);
    const name = call.name.slice(idx + 2);
    if (!namespace || !name) continue;
    if (new TextEncoder().encode(namespace).byteLength > 64 || new TextEncoder().encode(name).byteLength > 64) continue;
    out.push({ namespace, name });
  }
  return out;
}

export function filterAnthropicEvents(events: ReturnType<typeof normalizeSseBytes>): ReturnType<typeof normalizeSseBytes> {
  return events.filter((e) => e.event !== "ping");
}

function deriveTerminal(events: NormalizedEvent[]): string | null {
  if (events.some((e) => e.event === "error")) return "failed";
  if (events.some((e) => e.event === "response.failed")) return "failed";
  if (events.some((e) => e.event === "response.completed")) return "completed";
  if (events.some((e) => e.event === "message_stop")) return "message_stop";
  if (events.some((e) => e.event === "response.incomplete")) return "incomplete";
  return null;
}

function extractOutputText(json: Record<string, unknown>): string {
  let text = "";
  const output = json.output;
  if (!Array.isArray(output)) return text;
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown[] }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && (part as { type?: string }).type === "output_text") {
        text += String((part as { text?: string }).text ?? "");
      }
    }
  }
  return text;
}

export function deriveNormalizedText(events: NormalizedEvent[], json: unknown): string {
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const text = extractOutputText(json as Record<string, unknown>);
    if (text) return text;
  }
  let text = "";
  for (const ev of events) {
    if (ev.event === "response.output_text.delta" && ev.data && typeof ev.data === "object") {
      text += String((ev.data as { delta?: string }).delta ?? "");
    }
    if (ev.event === "content_block_delta" && ev.data && typeof ev.data === "object") {
      const delta = (ev.data as { delta?: { text?: string } }).delta;
      if (delta && typeof delta.text === "string") text += delta.text;
    }
  }
  return text;
}

export function finalizeObservation(
  observation: NormalizedObservation,
  events: NormalizedEvent[],
  json: unknown = null,
  status = 200,
): void {
  const eventProjection = projectToolCallsFromEventsDetailed(events);
  const jsonProjection = projectToolCallsDetailed(
    json && typeof json === "object" && !Array.isArray(json)
      ? ((json as { output?: unknown[] }).output ?? [])
      : [],
  );
  const selectedProjection = eventProjection.sawCallItems ? eventProjection : jsonProjection;
  const resolvedToolCalls = selectedProjection.calls;
  const terminal = deriveTerminal(events);
  setClientResponse(observation, {
    events,
    toolCalls: resolvedToolCalls,
    mcpCalls: projectMcpCalls(resolvedToolCalls),
    terminal,
    normalizedText: deriveNormalizedText(events, json),
    json,
    status,
  });
  observation.verifiers.duplicate_tool_call_ids = selectedProjection.duplicateIds;
}

export function attachVerifiers(observation: NormalizedObservation, caseRecord: CaseRecord): void {
  observation.verifiers = { ...observation.verifiers, ...buildVerifiers(observation, caseRecord) };
}

function buildVerifiers(observation: NormalizedObservation, caseRecord: CaseRecord): Record<string, unknown> {
  const verifiers: Record<string, unknown> = {};
  const toolCalls = observation.client.response.toolCalls;

  verifiers.nonoverlap_order = (() => {
    const ids: string[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      if (!call.id || call.arguments === null) return [];
      if (call.ordinal !== i) return [];
      ids.push(call.id);
    }
    const unique = new Set(ids);
    return unique.size === ids.length ? ids : [];
  })();

  verifiers.call_result_order = evaluateCallResultOrder(observation);

  if (caseRecord.id === "codex-core.protocol.compaction-and-special-items") {
    verifiers.compaction_replayed = evaluateCompactionReplayed(caseRecord);
    verifiers.local_shell_correlated = evaluateLocalShellCorrelated(caseRecord);
    verifiers.tool_search_error = evaluateToolSearchError(caseRecord);
  }

  if (caseRecord.id === "responses-core.protocol.json-sse-equivalence") {
    verifiers.json_sse_equivalence = evaluateJsonSseEquivalence(caseRecord);
  }

  if (caseRecord.id === "vision-core.protocol.modality-gate") {
    verifiers.modality_path = evaluateModalityPath(caseRecord);
    verifiers.silent_image_drop = evaluateSilentImageDrop(caseRecord);
  }

  return verifiers;
}

function evaluateCallResultOrder(observation: NormalizedObservation): string {
  const request = observation.upstream.requests[0]?.json as { input?: unknown[] } | undefined;
  const input = request?.input;
  if (!Array.isArray(input)) return "fail";
  const pendingCallIds = new Set<string>();
  let callCount = 0;
  let resultCount = 0;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const record = item as { type?: string; call_id?: unknown };
    if (record.type === "function_call") {
      if (typeof record.call_id !== "string" || record.call_id.length === 0) return "fail";
      if (pendingCallIds.has(record.call_id)) return "fail";
      pendingCallIds.add(record.call_id);
      callCount++;
      continue;
    }
    if (record.type === "function_call_output") {
      if (typeof record.call_id !== "string" || record.call_id.length === 0) return "fail";
      if (!pendingCallIds.delete(record.call_id)) return "fail";
      resultCount++;
    }
  }
  return callCount > 0 && resultCount === callCount && pendingCallIds.size === 0 ? "pass" : "fail";
}

function evaluateCompactionReplayed(caseRecord: CaseRecord): boolean {
  const vector = JSON.parse(caseRecord.fixture.bytesUtf8) as { input?: unknown[] };
  const input = vector.input;
  if (!Array.isArray(input)) return false;
  const compaction = input.find((i) => i && typeof i === "object" && (i as { type?: string }).type === "context_compaction");
  if (!compaction) return false;
  return typeof (compaction as { encrypted_content?: string }).encrypted_content === "string";
}

function evaluateLocalShellCorrelated(caseRecord: CaseRecord): boolean {
  const vector = JSON.parse(caseRecord.fixture.bytesUtf8) as { input?: unknown[] };
  const input = vector.input;
  if (!Array.isArray(input)) return false;
  let shellId: string | undefined;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const type = (item as { type?: string }).type;
    if (type === "local_shell_call") {
      shellId = String((item as { call_id?: string }).call_id ?? "");
      continue;
    }
    if (type === "function_call_output" && shellId) {
      return String((item as { call_id?: string }).call_id ?? "") === shellId;
    }
  }
  return false;
}

function evaluateToolSearchError(caseRecord: CaseRecord): string | null {
  const vector = JSON.parse(caseRecord.fixture.bytesUtf8) as { input?: unknown[] };
  const input = vector.input;
  if (!Array.isArray(input)) return null;
  const failed = input.filter((i) => i && typeof i === "object" && (i as { type?: string }).type === "tool_search_output"
    && (i as { status?: string }).status === "failed");
  if (failed.length !== 1) return null;
  return String((failed[0] as { error?: string }).error ?? "");
}

function evaluateModalityPath(caseRecord: CaseRecord): string {
  const vector = JSON.parse(caseRecord.fixture.bytesUtf8) as Record<string, unknown>;
  const requestHasImage = Boolean(vector.requestHasImage);
  const modalities = vector.modelInputModalities as string[] | undefined;
  const sidecar = vector.visionSidecar as { enabled?: boolean } | undefined;
  if (requestHasImage && Array.isArray(modalities) && modalities.includes("image")) return "native";
  if (sidecar?.enabled) return "sidecar";
  return "unsupported";
}

function evaluateSilentImageDrop(caseRecord: CaseRecord): boolean {
  const vector = JSON.parse(caseRecord.fixture.bytesUtf8) as Record<string, unknown>;
  if (!Boolean(vector.requestHasImage)) return false;
  // Protocol V1's closed modality-gate vector treats the explicit `unsupported` path as a
  // typed rejection, not as an omitted image. Native/sidecar paths likewise preserve it.
  return !["native", "sidecar", "unsupported"].includes(evaluateModalityPath(caseRecord));
}

function evaluateJsonSseEquivalence(caseRecord: CaseRecord): string {
  const vector = JSON.parse(caseRecord.fixture.bytesUtf8) as { json?: Record<string, unknown>; sse?: string };
  const json = vector.json;
  const sse = vector.sse ?? "";
  if (!json) return "fail";
  const jsonProjection = {
    text: extractOutputText(json),
    terminal: String(json.status ?? ""),
  };
  const events = normalizeSseBytes(new TextEncoder().encode(sse), "openai-responses");
  let sseText = "";
  let sseTerminal = "";
  for (const ev of events) {
    if (ev.event === "response.output_text.delta" && ev.data && typeof ev.data === "object") {
      sseText += String((ev.data as { delta?: string }).delta ?? "");
    }
    if (ev.event === "response.completed" && ev.data && typeof ev.data === "object") {
      const response = (ev.data as { response?: { status?: string } }).response;
      sseTerminal = String(response?.status ?? "");
    }
  }
  const sseProjection = { text: sseText, terminal: sseTerminal };
  return JSON.stringify(jsonProjection) === JSON.stringify(sseProjection) ? "pass" : "fail";
}
