import { createHmac, randomBytes } from "node:crypto";
import { codexWsReuseAcrossTurnsEnabled } from "../../config/codex-ws-reuse-setting";
import { registerOptionalShutdownHook } from "../../lib/optional-shutdown-hooks";
import { CODEX_RESPONSES_HTTP_URL, CODEX_WS_FRAME_HEADERS } from "./codex-ws-request";
import { CODEX_WS_ID_MAX_BYTES } from "./codex-ws-correlation";
import { CodexWsSession } from "./codex-ws-session";

export const CODEX_WS_POOL_MAX_SESSIONS = 32;
export const CODEX_WS_POOL_IDLE_MS = 30_000;
export const CODEX_WS_POOL_MAX_AGE_MS = 5 * 60_000;
export const CODEX_WS_POOL_WAIT_MS = 750;
/** Retained sockets per account+thread while cross-turn reuse is on. */
export const CODEX_WS_POOL_SCOPE_LIMIT = 2;
const CODEX_WS_POOL_WAIT_DEPTH = 2;
const MUTABLE_HEADERS = new Set<string>(CODEX_WS_FRAME_HEADERS);
let processKey: Buffer | undefined;
let poolSequence = 0;

export interface CodexWsReuseIdentity { key: string; scope: string; routeTag: string }
function value(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
    && !/[\u0000-\u001f\u007f]/.test(value) && Buffer.byteLength(value) <= CODEX_WS_ID_MAX_BYTES;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function digest(input: unknown): string {
  processKey ??= randomBytes(32);
  return createHmac("sha256", processKey).update(JSON.stringify(input)).digest("hex");
}

/** Identity comes from the selected outgoing request, never a model label or caller hint. */
export function codexWsReuseIdentity(url: string, headers: Record<string, string>, frameText: string, proxy?: string, dialUrl?: string): CodexWsReuseIdentity | null {
  if (url !== CODEX_RESPONSES_HTTP_URL) return null;
  let body: unknown;
  try { body = JSON.parse(frameText); } catch { return null; }
  if (!record(body) || !record(body.client_metadata)) return null;
  // Reuse complete HTTP creates only. Cache-dependent continuation, warmup and
  // named WS lanes need a different lifecycle/recovery contract.
  if (body.previous_response_id != null || Object.hasOwn(body, "stream_id")
    || Object.hasOwn(body, "generate") || body.background === true) return null;
  const metadata = body.client_metadata;
  const bodyThread = metadata.thread_id;
  const headerThread = headers["thread-id"];
  if (bodyThread !== undefined && !value(bodyThread)) return null;
  if (headerThread !== undefined && !value(headerThread)) return null;
  if (bodyThread !== undefined && headerThread !== undefined && bodyThread !== headerThread) return null;
  const thread = bodyThread ?? headerThread;
  const turn = metadata.turn_id;
  const account = headers["chatgpt-account-id"];
  const authorization = headers.authorization;
  if (![thread, turn, account, authorization, body.model].every(value)) return null;
  if (body.service_tier !== undefined && !value(body.service_tier)) return null;
  const immutable = Object.entries(headers).filter(([name]) => !MUTABLE_HEADERS.has(name)).sort(([a], [b]) => a.localeCompare(b));
  if (immutable.length > 128 || immutable.some(([, field]) => !value(field))
    || immutable.reduce((bytes, [name, field]) => bytes + Buffer.byteLength(name) + Buffer.byteLength(field), 0) > 32 * 1024) return null;
  const reuseAcrossTurns = codexWsReuseAcrossTurnsEnabled();
  const scope = digest(reuseAcrossTurns ? [url, account, thread] : [url, account, thread, turn]);
  const lite = metadata.ws_request_header_x_openai_internal_codex_responses_lite;
  if (lite !== undefined && lite !== "true" && lite !== "false") return null;
  // `dialUrl` is the socket destination after plugin rewrites; absent means the canonical one.
  const routeTag = digest(["route", authorization, proxy ?? null, dialUrl ?? null]);
  return { scope, routeTag, key: digest([scope, authorization, body.model, body.service_tier ?? null, lite ?? null, immutable, proxy ?? null, dialUrl ?? null]) };
}

interface Entry { identity: CodexWsReuseIdentity; session: CodexWsSession; createdAt: number; idleAt: number; retired: boolean }
interface Waiter { key: string; resolve: (session: CodexWsSession | null) => void; timer: ReturnType<typeof setTimeout>; onAbort: () => void; signal?: AbortSignal }
interface PoolOptions { now?: () => number; maxSessions?: number; idleMs?: number; maxAgeMs?: number; waitMs?: number }

/** Bounded retained sockets only. Busy/capacity misses keep the existing one-shot path. */
export class CodexWsPool {
  private readonly entries = new Map<string, Entry>();
  private readonly waiters: Waiter[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private detachShutdown?: () => void;
  private readonly hookKey = `codex-upstream-ws-pool-${++poolSequence}`;
  private readonly now: () => number;
  private readonly maxSessions: number;
  private readonly idleMs: number;
  private readonly maxAgeMs: number;
  private readonly waitMs: number;
  constructor(options: PoolOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions ?? CODEX_WS_POOL_MAX_SESSIONS;
    this.idleMs = options.idleMs ?? CODEX_WS_POOL_IDLE_MS;
    this.maxAgeMs = options.maxAgeMs ?? CODEX_WS_POOL_MAX_AGE_MS;
    this.waitMs = options.waitMs ?? CODEX_WS_POOL_WAIT_MS;
  }

  acquire(identity: CodexWsReuseIdentity, url: string, headers: Record<string, string>, proxy?: string): CodexWsSession | null {
    return this.claim(identity, url, headers, proxy).session;
  }

  /**
   * Before any frame is sent, wait for the matching busy socket instead of dialing a throwaway.
   * The queue is FIFO and at most two deep. An abort or the deadline returns null.
   */
  acquireWaiting(
    identity: CodexWsReuseIdentity,
    url: string,
    headers: Record<string, string>,
    proxy: string | undefined,
    signal?: AbortSignal,
  ): Promise<CodexWsSession | null> {
    const claimed = this.claim(identity, url, headers, proxy);
    if (claimed.session || !claimed.busy) return Promise.resolve(claimed.session);
    if (signal?.aborted) return Promise.resolve(null);
    if (this.waiters.filter(waiter => waiter.key === identity.key).length >= CODEX_WS_POOL_WAIT_DEPTH) {
      return Promise.resolve(null);
    }
    return new Promise(resolve => {
      const waiter: Waiter = {
        key: identity.key,
        resolve,
        signal,
        timer: setTimeout(() => this.finishWaiter(waiter, null), this.waitMs),
        onAbort: () => this.finishWaiter(waiter, null),
      };
      waiter.timer.unref?.();
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private claim(
    identity: CodexWsReuseIdentity,
    url: string,
    headers: Record<string, string>,
    proxy?: string,
  ): { session: CodexWsSession | null; busy: boolean } {
    this.sweep();
    this.retireSiblings(identity);
    const existing = this.entries.get(identity.key);
    if (existing) {
      if (existing.retired) return { session: null, busy: false };
      if (existing.session.busy) return { session: null, busy: true };
      if (existing.session.reserve()) { this.arm(); return { session: existing.session, busy: false }; }
      this.remove(existing);
    } else if (codexWsReuseAcrossTurnsEnabled() && this.scopeCount(identity.scope) >= CODEX_WS_POOL_SCOPE_LIMIT) {
      const oldest = [...this.entries.values()]
        .filter(entry => entry.identity.scope === identity.scope && !entry.session.busy)
        .sort((left, right) => left.idleAt - right.idleAt)[0];
      if (!oldest) return { session: null, busy: false };
      this.remove(oldest);
    }
    if (this.entries.size >= this.maxSessions) {
      const oldest = [...this.entries.values()].filter(entry => !entry.session.busy).sort((a, b) => a.idleAt - b.idleAt)[0];
      if (!oldest) return { session: null, busy: false };
      this.remove(oldest);
    }
    const createdAt = this.now();
    const session = new CodexWsSession(url, headers, true, () => this.changed(entry), proxy);
    const entry: Entry = { identity, session, createdAt, idleAt: createdAt, retired: false };
    session.reserve();
    this.entries.set(identity.key, entry);
    this.detachShutdown ??= registerOptionalShutdownHook(this.hookKey, () => this.dispose());
    return { session, busy: false };
  }

  private retireSiblings(identity: CodexWsReuseIdentity): void {
    const reuseAcrossTurns = codexWsReuseAcrossTurnsEnabled();
    for (const entry of this.entries.values()) {
      if (entry.identity.scope !== identity.scope || entry.identity.key === identity.key) continue;
      const routeChanged = entry.identity.routeTag !== identity.routeTag;
      if (reuseAcrossTurns && !routeChanged) continue;
      entry.retired = true;
      if (!entry.session.busy) this.remove(entry);
    }
  }

  private scopeCount(scope: string): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.identity.scope === scope && !entry.retired) count += 1;
    return count;
  }

  private finishWaiter(waiter: Waiter, session: CodexWsSession | null): void {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return;
    this.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(session);
  }

  private changed(entry: Entry): void {
    if (this.entries.get(entry.identity.key) !== entry) return;
    if (entry.session.closed) this.entries.delete(entry.identity.key);
    else if (!entry.session.busy) {
      const waiter = this.waiters.find(candidate => candidate.key === entry.identity.key);
      if (waiter && !entry.retired && entry.session.reserve()) {
        this.finishWaiter(waiter, entry.session);
        this.arm();
        return;
      }
      entry.idleAt = this.now();
      if (entry.retired || entry.idleAt - entry.createdAt >= this.maxAgeMs) this.remove(entry);
    }
    this.arm();
  }

  private remove(entry: Entry): void {
    if (this.entries.get(entry.identity.key) === entry) this.entries.delete(entry.identity.key);
    entry.session.dispose(new Error("codex websocket retained session expired"));
    this.arm();
  }

  sweep(): void {
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (!entry.session.busy && (entry.session.closed || entry.retired
        || now - entry.idleAt >= this.idleMs || now - entry.createdAt >= this.maxAgeMs)) this.remove(entry);
    }
    this.arm();
  }

  private arm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.entries.size) {
      this.detachShutdown?.();
      this.detachShutdown = undefined;
      return;
    }
    let deadline = Infinity;
    for (const entry of this.entries.values()) if (!entry.session.busy) {
      deadline = Math.min(deadline, entry.idleAt + this.idleMs, entry.createdAt + this.maxAgeMs);
    }
    if (!Number.isFinite(deadline)) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.sweep(); }, Math.max(1, deadline - this.now()));
    this.timer.unref?.();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.detachShutdown?.();
    this.detachShutdown = undefined;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const waiter of [...this.waiters]) this.finishWaiter(waiter, null);
    for (const entry of entries) entry.session.dispose(new DOMException("codex websocket pool shutdown", "AbortError"));
  }

  snapshot(): { size: number; active: number; timer: boolean } {
    return { size: this.entries.size, active: [...this.entries.values()].filter(entry => entry.session.busy).length, timer: this.timer !== undefined };
  }
}

export const codexWsPool = new CodexWsPool();
