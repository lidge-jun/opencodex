import { isSafeResponseHeader, safeResponseHeaders } from "../safe-response-headers";

export const CODEX_WS_METADATA_MAX_BYTES = 32 * 1024;
export const CODEX_WS_METADATA_MAX_FAMILIES = 16;
export const CODEX_WS_METADATA_MAX_HEADERS = 128;
export const CODEX_WS_METADATA_MAX_VALUE_BYTES = 4096;

export type CodexWsQuotaObserver = (headers: Headers) => void;
const REASONING_INCLUDED_HEADER = "x-reasoning-included";
const HTTP_HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Bun emits this payload before validating the upgrade; the session must wait for open. */
export function readCodexWsUpgradeHeaders(payload: unknown): Headers {
  try {
    if (!record(payload) || payload.statusCode !== 101 || !Array.isArray(payload.rawHeaders)
      || payload.rawHeaders.length % 2 !== 0 || payload.rawHeaders.length > CODEX_WS_METADATA_MAX_HEADERS * 2) return new Headers();
    const headers = new Headers();
    let bytes = 0;
    let connectionNominated = false;
    for (let i = 0; i < payload.rawHeaders.length; i += 2) {
      const name = payload.rawHeaders[i];
      const value = payload.rawHeaders[i + 1];
      if (typeof name !== "string" || typeof value !== "string"
        || name.length + value.length > CODEX_WS_METADATA_MAX_BYTES - bytes || !HTTP_HEADER_TOKEN.test(name)
        || /[\r\n\0]/.test(value)) return new Headers();
      bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
      if (bytes > CODEX_WS_METADATA_MAX_BYTES) return new Headers();
      const lower = name.toLowerCase();
      if (lower === "connection" && value.split(",").some(token => token.trim().toLowerCase() === REASONING_INCLUDED_HEADER)) {
        connectionNominated = true;
      }
      // Other allowlisted response headers (quota, request id, turn state, model)
      // describe a response, not a reusable connection. Never retain them here.
      if (lower === REASONING_INCLUDED_HEADER) {
        if (Buffer.byteLength(value) > CODEX_WS_METADATA_MAX_VALUE_BYTES) return new Headers();
        headers.append(lower, value);
        if (Buffer.byteLength(headers.get(lower)!) > CODEX_WS_METADATA_MAX_VALUE_BYTES) return new Headers();
      }
    }
    return connectionNominated ? new Headers() : headers;
  } catch {
    // Missing/unsupported or malformed optional metadata cannot authorize a retry.
    return new Headers();
  }
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nativeLimitFamily(event: Record<string, unknown>): string | null {
  const raw = event.metered_limit_name ?? event.limit_name ?? "codex";
  if (typeof raw !== "string") return null;
  const name = raw.trim().toLowerCase().replaceAll("_", "-");
  return name.length <= 64 && /^codex(?:-[a-z0-9-]+)?$/.test(name) ? name : null;
}

function writeWindow(headers: Headers, prefix: string, value: unknown): void {
  if (!record(value) || !finiteNonnegative(value.used_percent)) return;
  headers.set(`${prefix}-used-percent`, String(value.used_percent));
  for (const [field, suffix] of [["window_minutes", "window-minutes"], ["reset_at", "reset-at"]]) {
    const number = value[field!];
    if (finiteNonnegative(number) && Number.isSafeInteger(number)) headers.set(`${prefix}-${suffix}`, String(number));
  }
}

function quotaHeaders(event: Record<string, unknown>): Headers {
  const headers = new Headers();
  const family = nativeLimitFamily(event);
  if (family && record(event.rate_limits)) {
    writeWindow(headers, `x-${family}-primary`, event.rate_limits.primary);
    writeWindow(headers, `x-${family}-secondary`, event.rate_limits.secondary);
  }
  if (record(event.credits)) {
    for (const [field, suffix] of [["has_credits", "has-credits"], ["unlimited", "unlimited"]]) {
      const value = event.credits[field!];
      if (typeof value === "boolean") headers.set(`x-codex-credits-${suffix}`, String(value));
    }
    if (typeof event.credits.balance === "string") setMetadataHeader(headers, "x-codex-credits-balance", event.credits.balance);
  }
  return headers;
}

function setMetadataHeader(headers: Headers, name: string, value: string): void {
  if (Buffer.byteLength(value) > CODEX_WS_METADATA_MAX_VALUE_BYTES) throw new Error("codex websocket metadata value exceeds the size limit");
  if (/[\r\n\0]/.test(value)) return;
  try { headers.set(name, value); } catch { /* invalid provider header is not HTTP authority */ }
}

function responseHeaders(value: unknown): Headers {
  const headers = new Headers();
  if (!record(value)) return headers;
  for (const [name, field] of Object.entries(value)) {
    if (!isSafeResponseHeader(name)) continue;
    if (typeof field !== "string" && typeof field !== "number" && typeof field !== "boolean") continue;
    setMetadataHeader(headers, name, String(field));
  }
  return headers;
}

function assertMetadataBounds(headers: Headers): void {
  let bytes = 0;
  let count = 0;
  const families = new Set<string>();
  for (const [name, value] of headers) {
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    count++;
    const family = /^(x-codex(?:-[a-z0-9-]+)?)-(?:(?:primary|secondary|tertiary)-(?:used-percent|window-minutes|reset-at)|limit-name)$/.exec(name);
    if (family) families.add(family[1]!);
  }
  if (bytes > CODEX_WS_METADATA_MAX_BYTES || count > CODEX_WS_METADATA_MAX_HEADERS || families.size > CODEX_WS_METADATA_MAX_FAMILIES) {
    throw new Error("codex websocket metadata exceeds the bounded header budget");
  }
}

/** One exchange's metadata. The Response owns its final snapshot, not a global history ledger. */
export class CodexWsMetadata {
  private headers = new Headers();
  private ended = false;
  private preludeBytes = 0;
  private committed = false;

  constructor(private observer?: CodexWsQuotaObserver) {}

  snapshot(): Headers { return new Headers(this.headers); }

  /** Seed only the connection-level inclusion signal; per-response frames still win. */
  seed(headers: Headers): void {
    if (this.ended || this.committed || this.headers.has(REASONING_INCLUDED_HEADER)) return;
    const value = headers.get(REASONING_INCLUDED_HEADER);
    if (value !== null) setMetadataHeader(this.headers, REASONING_INCLUDED_HEADER, value);
  }

  private publishQuota(headers: Headers): void {
    // Observation is auxiliary bookkeeping; a consumer exception cannot turn
    // a valid provider frame into a retryable transport failure.
    try { this.observer?.(new Headers(headers)); } catch { /* quota observation is best-effort */ }
  }

  commit(): void {
    this.committed = true;
  }

  /** Returns a sanitized control frame, or null for an ordinary Responses event. */
  consume(event: Record<string, unknown>, bytes: number): string | null {
    if (this.ended) return null;
    if (event.type !== "codex.rate_limits" && event.type !== "codex.response.metadata") return null;
    if (bytes > CODEX_WS_METADATA_MAX_BYTES) throw new Error("codex websocket metadata frame exceeds the size limit");
    if (!this.committed) this.preludeBytes += bytes;
    if (this.preludeBytes > CODEX_WS_METADATA_MAX_BYTES) throw new Error("codex websocket metadata prelude exceeds the size limit");
    const updates = event.type === "codex.rate_limits" ? quotaHeaders(event) : responseHeaders(event.headers);
    const next = this.snapshot();
    for (const name of updates.keys()) {
      if (!name.endsWith("-used-percent")) continue;
      const prefix = name.slice(0, -"used-percent".length);
      next.delete(`${prefix}window-minutes`);
      next.delete(`${prefix}reset-at`);
    }
    for (const [name, value] of updates) next.set(name, value);
    assertMetadataBounds(next);
    this.headers = next;
    if (["primary", "secondary", "tertiary"].some(window => updates.has(`x-codex-${window}-used-percent`))) {
      this.publishQuota(updates);
    }
    return event.type === "codex.response.metadata"
      ? JSON.stringify({ type: event.type, headers: safeResponseHeaders(updates) })
      : JSON.stringify(event);
  }

  finish(): void {
    this.ended = true;
    this.observer = undefined;
  }
}
