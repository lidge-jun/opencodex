import { ANTHROPIC_REQUEST_BYTES } from "../adapters/anthropic-image-guard";

export interface CacheRuntimeState {
  running: boolean;
  turn: string | null;
}

export interface CacheUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface RenewalWire {
  identity: string;
  turnId: string;
  model: string;
  body: string;
  allowed(): boolean;
  send(body: string, signal: AbortSignal, dispatched: () => void): Promise<Response>;
  record(event: RenewalResult): void;
}

export interface CachePrefixComparison {
  previousCachedTokens: number;
  previousCacheAgeMs: number;
  identityChanged: boolean;
  toolsChanged: boolean;
  systemChanged: boolean;
  optionsChanged: boolean;
  previousMessages: number;
  currentMessages: number;
  firstChangedMessage: number | null;
  previousBodyBytes: number;
  currentBodyBytes: number;
}

const stableCacheValue = (value: unknown) => JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item);
const cacheMessage = (message: Record<string, unknown>) => ({ ...message,
  content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content });

// Compare in memory; emit only fixed booleans and counts, never prompt text or account identity.
export function compareCachePrefix(previous: RenewalWire, current: RenewalWire,
  previousCachedTokens: number, previousCacheAgeMs: number): CachePrefixComparison | undefined {
  try {
    const before = JSON.parse(previous.body), after = JSON.parse(current.body);
    const stable = stableCacheValue;
    const options = ({ messages, tools, system, max_tokens, stream, ...rest }: Record<string, unknown>) => rest;
    const left = Array.isArray(before.messages) ? before.messages : [];
    const right = Array.isArray(after.messages) ? after.messages : [];
    let firstChangedMessage: number | null = null;
    for (let index = 0; index < left.length; index++) {
      if (index >= right.length || stable(cacheMessage(left[index])) !== stable(cacheMessage(right[index]))) { firstChangedMessage = index; break; }
    }
    return { previousCachedTokens, previousCacheAgeMs: Math.max(0, previousCacheAgeMs),
      identityChanged: previous.identity !== current.identity,
      toolsChanged: stable(before.tools) !== stable(after.tools),
      systemChanged: stable(before.system) !== stable(after.system),
      optionsChanged: stable(options(before)) !== stable(options(after)),
      previousMessages: left.length, currentMessages: right.length, firstChangedMessage,
      previousBodyBytes: Buffer.byteLength(previous.body, "utf8"), currentBodyBytes: Buffer.byteLength(current.body, "utf8") };
  } catch { return; }
}

/** Keep the confirmed tail reachable when an append moves automatic caching beyond its lookback. */
export function retainCachePrefix(previous: RenewalWire, current: RenewalWire): string {
  const comparison = compareCachePrefix(previous, current, 0, 0);
  if (!comparison || comparison.identityChanged || comparison.toolsChanged || comparison.systemChanged
    || comparison.optionsChanged || comparison.firstChangedMessage !== null
    || comparison.currentMessages <= comparison.previousMessages) return current.body;
  try {
    const before = JSON.parse(previous.body), after = JSON.parse(current.body);
    if (before.cache_control?.type !== "ephemeral" || after.cache_control?.type !== "ephemeral"
      || before.cache_control.ttl === "1h" || after.cache_control.ttl === "1h") return current.body;
    const index = before.messages.length - 1;
    if (index < 0) return current.body;
    const message = cacheMessage(after.messages[index]);
    const blocks = message.content as Array<Record<string, unknown>>;
    const tail = blocks?.[blocks.length - 1];
    if (!tail || ["thinking", "redacted_thinking"].includes(String(tail.type))) return current.body;
    // Only replace the adapter's penultimate-user point; caller-supplied locations stay intact.
    const users = after.messages.flatMap((item: any, i: number) => item.role === "user" ? [i] : []);
    const pointMessage = users[users.length - 2];
    const content = after.messages[pointMessage]?.content;
    const textPoint = Array.isArray(content) ? content.findLastIndex((item: any) => item.type === "text") : -1;
    const pointBlock = textPoint >= 0 ? textPoint : Array.isArray(content) ? content.length - 1 : -1;
    for (const [i, item] of after.messages.entries()) {
      if (!Array.isArray(item.content)) continue;
      for (const [j, block] of item.content.entries()) {
        if (block.cache_control && (i !== pointMessage || j !== pointBlock
          || stableCacheValue(block.cache_control) !== stableCacheValue(after.cache_control))) return current.body;
      }
    }
    for (const item of after.messages) {
      if (Array.isArray(item.content)) for (const block of item.content) delete block.cache_control;
    }
    blocks[blocks.length - 1] = { ...tail, cache_control: after.cache_control };
    after.messages[index] = { ...message, content: blocks };
    let points = 0;
    const body = JSON.stringify(after, (key, value) => { if (key === "cache_control" && value) points++; return value; });
    return points <= 4 && Buffer.byteLength(body, "utf8") <= ANTHROPIC_REQUEST_BYTES ? body : current.body;
  } catch { return current.body; }
}

export interface RenewalResult {
  status: number;
  reason: string;
  sent: boolean;
  started: number;
  duration: number;
  usage?: CacheUsage;
  diagnostics?: RenewalDiagnostics;
}

type RenewalCancelReason = "natural-confirmed" | "identity-changed" | "turn-replaced"
  | "runtime-not-running" | "scope-not-eligible" | "expired" | "renewal-failed" | "shutdown";

export interface RenewalDiagnostics {
  attempt: number;
  cacheAgeMs: number;
  expectedCachedTokens: number;
  phase: "send" | "response-body" | "response";
  outcome: "hit" | "cancelled" | "timeout" | "network-error" | "transport-error"
    | "invalid-response" | "http-error" | "unconfirmed";
  cancelReason?: RenewalCancelReason;
  networkCode?: string;
}

const NETWORK_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET",
  "EPIPE", "ETIMEDOUT", "ESOCKETTIMEDOUT", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);

function failureDiagnostic(error: unknown, attempt: AbortSignal, parent: AbortSignal) {
  const row = error as { code?: unknown; cause?: { code?: unknown }; message?: unknown } | undefined;
  const code = row?.code ?? row?.cause?.code;
  const networkCode = typeof code === "string" && NETWORK_CODES.has(code) ? code : undefined;
  if (parent.aborted) return { outcome: "cancelled" as const, cancelReason: parent.reason as RenewalCancelReason };
  if (attempt.aborted) return { outcome: "timeout" as const };
  if (row?.message === "cache-runtime-not-active") return { outcome: "cancelled" as const, cancelReason: "runtime-not-running" as const };
  return { outcome: networkCode ? "network-error" as const : "transport-error" as const,
    ...(networkCode ? { networkCode } : {}) };
}

interface Snapshot {
  ordinal: number;
  wire: RenewalWire;
  cachedTokens: number;
  confirmedAt: number;
  turn: string;
}

interface Entry {
  runId: string;
  confirm?: () => void;
  runtime: CacheRuntimeState;
  latest: number;
  snapshot?: Snapshot;
  timer?: unknown;
  controller?: AbortController;
  unsubscribe?: () => void;
}

export interface RenewalDependencies {
  now(): number;
  later(fn: () => void, delay: number): unknown;
  clear(timer: unknown): void;
  watch(thread: string, update: (state: CacheRuntimeState) => void, turn?: string): () => void;
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("cache-renewal-aborted"));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export function cacheUsage(value: unknown): CacheUsage | undefined {
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  const names = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;
  if (names.some(name => !Number.isSafeInteger(row[name]) || Number(row[name]) < 0)) return;
  return Object.fromEntries(names.map(name => [name, row[name]])) as unknown as CacheUsage;
}

export function renewalBody(serialized: string): string | undefined {
  try {
    const body = JSON.parse(serialized);
    if (!body || typeof body !== "object" || Array.isArray(body) || body.max_tokens === 0
      || body.thinking?.type === "enabled" || body.output_config?.format
      || ["any", "tool"].includes(body.tool_choice?.type)) return;
    let cached = false;
    let long = false;
    const visit = (item: unknown): void => {
      if (Array.isArray(item)) { item.forEach(visit); return; }
      if (!item || typeof item !== "object") return;
      for (const [key, value] of Object.entries(item)) {
        if (key === "cache_control" && value && typeof value === "object") {
          const control = value as Record<string, unknown>;
          cached ||= control.type === "ephemeral";
          long ||= control.ttl === "1h";
        } else visit(value);
      }
    };
    visit(body);
    if (!cached || long) return;
    return JSON.stringify({ ...body, max_tokens: 0, stream: false });
  } catch { return; }
}

export class AnthropicCacheRenewal {
  private entries = new Map<string, Entry>();
  private ordinal = 0;
  constructor(private readonly deps: RenewalDependencies) {}

  prepare(thread: string, wire: RenewalWire): string {
    const entry = this.entries.get(thread), previous = entry?.snapshot;
    if (!previous || entry?.runId !== wire.turnId || !entry.runtime.running
      || this.deps.now() - previous.confirmedAt >= 300_000 || !wire.allowed()) return wire.body;
    return retainCachePrefix(previous.wire, wire);
  }

  begin(thread: string, wire: RenewalWire, observe?: (reason: string, usage: unknown, comparison?: CachePrefixComparison) => void): (usage: unknown) => string {
    const report = (reason: string, usage: unknown, comparison?: CachePrefixComparison): string => {
      try { observe?.(reason, usage, comparison); } catch { /* Diagnostic sinks cannot affect cache state. */ }
      return reason;
    };
    if (!wire.turnId || !renewalBody(wire.body) || !wire.allowed()) { this.forget(thread); return raw => report("scope-not-eligible", raw); }
    const prior = this.entries.get(thread);
    if (prior && prior.runId !== wire.turnId) this.drop(thread, prior, "turn-replaced");
    let entry = this.entries.get(thread);
    if (!entry) {
      entry = { runtime: { running: false, turn: null }, latest: 0, runId: wire.turnId };
      this.entries.set(thread, entry);
      entry.unsubscribe = this.deps.watch(thread, state => this.runtime(thread, state), wire.turnId);
      if (this.entries.get(thread) !== entry) { entry.unsubscribe(); return raw => report("runtime-not-running", raw); }
    }
    const current = entry;
    const ordinal = ++this.ordinal;
    const started = this.deps.now();
    const turn = wire.turnId;
    const previous = entry.snapshot;
    entry.latest = ordinal;
    if (entry.snapshot && entry.snapshot.wire.identity !== wire.identity) this.pause(entry, "identity-changed");
    if (!entry.snapshot) {
      if (entry.timer) this.deps.clear(entry.timer);
      entry.timer = this.deps.later(() => this.drop(thread, current, "expired"), 300_000);
    }
    let accepted = false;
    const acceptUsage = (raw: unknown): string => {
      const usage = cacheUsage(raw);
      const live = this.entries.get(thread);
      if (accepted) return report("already-accepted", raw);
      if (!usage) return report("invalid-usage", raw);
      if (live !== current) return report("entry-replaced", raw);
      if (live.latest !== ordinal) return report("request-superseded", raw);
      if (live.runId !== turn) return report("turn-replaced", raw);
      if (!wire.allowed()) return report("identity-disabled", raw);
      const cachedTokens = usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
      if (!cachedTokens) return report("no-cache", raw);
      if (this.deps.now() >= started + 300_000) return report("expired", raw);
      if (!live.runtime.running) { live.confirm = () => { acceptUsage(usage); }; return report("runtime-pending", raw); }
      const comparison = observe && previous && usage.cache_creation_input_tokens > 0
        && usage.cache_read_input_tokens < previous.cachedTokens / 2
        ? compareCachePrefix(previous.wire, wire, previous.cachedTokens, started - previous.confirmedAt) : undefined;
      accepted = true;
      this.pause(live, "natural-confirmed");
      live.snapshot = { ordinal, wire, cachedTokens, confirmedAt: started, turn };
      this.schedule(thread, live);
      return report("accepted", raw, comparison);
    };
    return acceptUsage;
  }

  private runtime(thread: string, state: CacheRuntimeState): void {
    const entry = this.entries.get(thread);
    if (!entry) return;
    entry.runtime = state;
    if (!state.running) this.drop(thread, entry, "runtime-not-running");
    else entry.confirm?.();
  }

  private pause(entry: Entry, reason: RenewalCancelReason): void {
    entry.confirm = undefined;
    if (entry.timer) this.deps.clear(entry.timer);
    entry.timer = undefined;
    entry.controller?.abort(reason);
    entry.controller = undefined;
    entry.snapshot = undefined;
  }

  private drop(thread: string, entry: Entry, reason: RenewalCancelReason): void {
    if (this.entries.get(thread) !== entry) return;
    this.pause(entry, reason);
    this.entries.delete(thread);
    entry.unsubscribe?.();
  }

  private schedule(thread: string, entry: Entry): void {
    const snapshot = entry.snapshot;
    if (!snapshot) return;
    entry.timer = this.deps.later(() => { void this.renew(thread, entry, snapshot).catch(() => this.drop(thread, entry, "renewal-failed")); },
      Math.max(0, snapshot.confirmedAt + 270_000 - this.deps.now()));
  }

  private async renew(thread: string, entry: Entry, snapshot: Snapshot): Promise<void> {
    entry.timer = undefined;
    const live = () => this.entries.get(thread) === entry && entry.snapshot === snapshot
      && entry.runtime.running && entry.runId === snapshot.turn && snapshot.wire.allowed();
    if (!live() || this.deps.now() >= snapshot.confirmedAt + 300_000) { this.drop(thread, entry, "scope-not-eligible"); return; }
    const body = renewalBody(snapshot.wire.body);
    if (!body) { this.drop(thread, entry, "scope-not-eligible"); return; }
    const controller = new AbortController();
    entry.controller = controller;
    const deadline = snapshot.confirmedAt + 300_000;
    let renewedAt: number | undefined;
    try {
      for (let attempt = 0; attempt < 3 && live() && this.deps.now() < deadline && !controller.signal.aborted; attempt++) {
        const attemptController = new AbortController();
        const cancel = () => attemptController.abort(controller.signal.reason);
        controller.signal.addEventListener("abort", cancel, { once: true });
        // Status checks, pacing and the response share the remaining cache lifetime.
        const timeout = this.deps.later(() => attemptController.abort("attempt-timeout"), deadline - this.deps.now());
        let sent = false;
        let started = this.deps.now();
        let delay: number | undefined;
        const record = (event: Omit<RenewalResult, "diagnostics">, detail: Pick<RenewalDiagnostics, "phase" | "outcome" | "cancelReason" | "networkCode">) =>
          snapshot.wire.record({ ...event, diagnostics: { attempt: attempt + 1,
            cacheAgeMs: Math.max(0, started - snapshot.confirmedAt), expectedCachedTokens: snapshot.cachedTokens, ...detail } });
        try {
          const response = await abortable(snapshot.wire.send(body, attemptController.signal, () => {
            if (!live() || this.deps.now() >= deadline || attemptController.signal.aborted) throw new Error("cache-renewal-cancelled");
            sent = true;
            started = this.deps.now();
          }).then(response => {
            if (attemptController.signal.aborted) {
              void response.body?.cancel().catch(() => {});
              throw new Error("cache-renewal-aborted");
            }
            return response;
          }), attemptController.signal);
          let raw: any;
          let bodyFailure: ReturnType<typeof failureDiagnostic> | undefined;
          try { raw = await abortable(response.json(), attemptController.signal); }
          catch (error) { raw = undefined; bodyFailure = failureDiagnostic(error, attemptController.signal, controller.signal); }
          const usage = cacheUsage(raw?.usage);
          const hit = response.ok && sent && Array.isArray(raw?.content) && raw.content.length === 0 && usage && usage.output_tokens === 0
            && usage.cache_creation_input_tokens === 0 && usage.cache_read_input_tokens >= snapshot.cachedTokens;
          const reason = hit ? "hit" : usage?.cache_creation_input_tokens ? "unexpected-write" : response.ok ? "unconfirmed" : "http-error";
          record({ status: response.status, reason, sent, started, duration: this.deps.now() - started, usage },
            bodyFailure ? { phase: "response-body", ...bodyFailure,
              outcome: bodyFailure.outcome === "transport-error" ? "invalid-response" : bodyFailure.outcome }
              : { phase: "response", outcome: hit ? "hit" : response.ok ? "unconfirmed" : "http-error" });
          if (hit) { renewedAt = started; break; }
          const type = raw?.error?.type;
          if ((response.status === 429 && type === "rate_limit_error") || ([503, 529].includes(response.status) && type === "overloaded_error")) {
            const retryAfter = response.headers.get("retry-after");
            const seconds = retryAfter === null ? NaN : Number(retryAfter);
            delay = retryAfter === null ? 250 * (attempt + 1) : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
          }
          if (usage && (usage.cache_creation_input_tokens || usage.cache_read_input_tokens || usage.output_tokens)) delay = undefined;
        } catch (error) {
          record({ status: 0, reason: sent ? "unknown" : "not-sent", sent, started, duration: this.deps.now() - started },
            { phase: "send", ...failureDiagnostic(error, attemptController.signal, controller.signal) });
          const code = (error as { code?: string })?.code;
          if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(code ?? "")) delay = 250 * (attempt + 1);
        } finally {
          this.deps.clear(timeout);
          controller.signal.removeEventListener("abort", cancel);
        }
        if (attempt === 2 || delay === undefined || delay < 0 || this.deps.now() + delay >= deadline || !live() || controller.signal.aborted) break;
        await new Promise<void>(resolve => {
          const timer = this.deps.later(finish, delay!);
          function finish() { controller.signal.removeEventListener("abort", abort); resolve(); }
          const abort = () => { this.deps.clear(timer); finish(); };
          controller.signal.addEventListener("abort", abort, { once: true });
          if (controller.signal.aborted) abort();
        });
      }
    } finally {
      if (live()) {
        entry.controller = undefined;
        if (renewedAt !== undefined) {
          snapshot.confirmedAt = renewedAt;
          this.schedule(thread, entry);
        } else if (entry.latest !== snapshot.ordinal) {
          // Stop the failed renewal, but let an in-flight newer natural request confirm its own cache.
          this.pause(entry, "renewal-failed");
          entry.timer = this.deps.later(() => this.drop(thread, entry, "expired"), 300_000);
        } else this.drop(thread, entry, "renewal-failed");
      }
    }
  }

  forget(thread: string): void {
    const entry = this.entries.get(thread);
    if (entry) this.drop(thread, entry, "scope-not-eligible");
  }

  close(): void {
    for (const [thread, entry] of this.entries) this.drop(thread, entry, "shutdown");
  }
}
