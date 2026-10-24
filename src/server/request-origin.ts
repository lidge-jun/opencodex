import { codexRequestProvenance } from "../codex/request-provenance";

export interface RequestOriginOptions {
  endpoint?: "responses" | "responses-compact" | "messages" | "chat-completions";
  transport?: "websocket";
  internalHelper?: boolean;
}

export interface RequestOrigin {
  readonly endpoint: string;
  readonly transport: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly headerThreadId?: string;
  readonly metadataThreadId?: string;
  readonly parentThreadId?: string;
  readonly identity: string;
  readonly role: string;
  readonly purpose: string;
  readonly stream?: boolean;
  readonly store?: boolean;
  readonly generate?: boolean;
  readonly inputItems: number;
  readonly tools: number;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function uuid(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const id = value.trim();
  return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) ? id : undefined;
}

/** Capture only request-owned identity and shape, before routing mutates the body. */
export function captureRequestOrigin(body: unknown, headers: Headers, options: RequestOriginOptions = {}): RequestOrigin {
  const raw = object(body), client = object(raw?.client_metadata);
  const headerValue = headers.get("thread-id"), metadataValue = client?.thread_id;
  const own = uuid(headerValue), metadata = uuid(metadataValue), turn = uuid(client?.turn_id);
  const invalid = (headerValue !== null && !own)
    || (metadataValue !== undefined && !metadata)
    || (client?.turn_id !== undefined && !turn)
    || (raw !== undefined && Object.hasOwn(raw, "client_metadata") && !client);
  const identity = invalid ? "invalid" : own && metadata && own !== metadata ? "conflict"
    : own && metadata && turn ? "matched" : own ? "header-only" : "missing";
  const provenance = codexRequestProvenance(body, headers, options);
  const bound = identity === "matched" || identity === "header-only";
  return Object.freeze({
    endpoint: options.endpoint ?? "responses", transport: options.transport ?? "http",
    threadId: bound ? own : undefined, turnId: identity === "matched" ? turn : undefined,
    headerThreadId: own, metadataThreadId: metadata,
    parentThreadId: uuid(headers.get("x-codex-parent-thread-id")), identity,
    role: bound ? provenance.role : "unknown", purpose: provenance.purpose,
    stream: typeof raw?.stream === "boolean" ? raw.stream : undefined,
    store: typeof raw?.store === "boolean" ? raw.store : undefined,
    generate: typeof raw?.generate === "boolean" ? raw.generate : undefined,
    inputItems: Array.isArray(raw?.input) ? raw.input.length : typeof raw?.input === "string" ? 1 : 0,
    tools: Array.isArray(raw?.tools) ? raw.tools.length : 0,
  });
}

const known = (value: unknown, values: readonly string[], fallback = "unknown") =>
  typeof value === "string" && values.includes(value) ? value : fallback;
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000
  ? Number(value) : undefined;
const flag = (value: unknown) => typeof value === "boolean" ? value : undefined;

/** Whitelist again at the final boundary; no body, credentials, URLs or free text can escape. */
export function requestOriginLogRecord(requestId: string, startedAt: number, status: number, origin?: RequestOrigin) {
  return {
    version: 1, pid: process.pid,
    requestId: /^ocx-[a-f0-9]{32}$/i.test(requestId) ? requestId : "unavailable",
    startedAt: Number.isFinite(startedAt) && startedAt >= 0 ? startedAt : undefined,
    status: Number.isInteger(status) && status >= 0 && status <= 599 ? status : undefined,
    captured: origin !== undefined,
    endpoint: known(origin?.endpoint, ["responses", "responses-compact", "messages", "chat-completions"]),
    transport: known(origin?.transport, ["http", "websocket"]),
    threadId: uuid(origin?.threadId), turnId: uuid(origin?.turnId),
    headerThreadId: uuid(origin?.headerThreadId), metadataThreadId: uuid(origin?.metadataThreadId),
    parentThreadId: uuid(origin?.parentThreadId),
    identity: known(origin?.identity, ["matched", "header-only", "conflict", "missing", "invalid"], "missing"),
    role: known(origin?.role, ["main", "subagent", "unknown"]),
    purpose: known(origin?.purpose, ["turn", "compaction", "helper", "unknown"]),
    stream: flag(origin?.stream), store: flag(origin?.store), generate: flag(origin?.generate),
    inputItems: count(origin?.inputItems), tools: count(origin?.tools),
  };
}
