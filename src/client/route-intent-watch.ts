/** Child-owned watch: authenticated reads only; local reconciliation stays with the runtime scheduler. */
import type { OcxClientConnectionConfig } from "../types";
import { LINK_ROUTE_INTENT_PATH } from "../link/management-routes";
import { parseHomeRouteIntentDocument, routeIntentDigest, ROUTE_INTENT_DIGEST_PATTERN, type HomeRouteIntentDocument } from "../link/route-intent";
import { ROUTE_INTENT_AFTER_HEADER, ROUTE_INTENT_WAKE_HEADER, ROUTE_INTENT_WATCH_HEADER } from "../link/route-intent-watch";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { signalWithTimeout } from "../lib/abort";
import { fetchBoundLinkRelay } from "./link-relay-transport";

const WATCH_READ_TIMEOUT_MS = 40_000; // Home wait (30 s), relay proof and bounded body share one budget.
const WATCH_MAX_BYTES = 64 * 1024;
const WATCH_MAX_HEADER_BYTES = 8 * 1024;
const WATCH_RETRY_MS = 5_000;
export type RouteIntentWatchKey = string | (() => string | null);
export interface RouteIntentWatchReadDeps {
  /** Trusted complete-send test seam; production always uses the connection-bound relay. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export type RouteIntentWatchResult = { kind: "fresh"; document: HomeRouteIntentDocument; watchSupported: boolean; wakeReason?: "changed" | "notified" | "timeout" }
  | { kind: "unsupported" } | { kind: "cancelled" } | { kind: "failed"; reason: "route_intent_watch_unavailable" };

function cancel(response: Response): void {
  try { void response.body?.cancel().catch(() => {}); } catch { /* no untrusted cleanup can extend the deadline */ }
}
/** No selectors, redirects, management writes, cached fallback or durable receipt writes. */
export async function watchHomeRouteIntent(
  connection: OcxClientConnectionConfig, key: RouteIntentWatchKey, afterDigest?: string, deps: RouteIntentWatchReadDeps = {},
): Promise<RouteIntentWatchResult> {
  const failed = (): RouteIntentWatchResult => ({ kind: "failed", reason: "route_intent_watch_unavailable" });
  if (deps.signal?.aborted) return { kind: "cancelled" };
  if (connection.transport !== "link" || !connection.link || !connection.apiKeyId
    || (afterDigest !== undefined && !ROUTE_INTENT_DIGEST_PATTERN.test(afterDigest))) return failed();
  const budget = deps.timeoutMs ?? WATCH_READ_TIMEOUT_MS;
  if (!Number.isInteger(budget) || budget < 1 || budget > WATCH_READ_TIMEOUT_MS) return failed();
  const deadline = signalWithTimeout(budget, deps.signal);
  let response: Response | undefined;
  try {
    // A long-lived runtime survives key rotation. Never retain the resolved credential across GETs.
    const admissionKey = typeof key === "function" ? key() : key;
    if (!admissionKey) return failed();
    const target = { tunnelPort: connection.link.tunnelPort, linkId: connection.link.linkId, apiKeyId: connection.apiKeyId, admissionKey };
    const destination = `http://127.0.0.1:${target.tunnelPort}${LINK_ROUTE_INTENT_PATH}`;
    const init: RequestInit = { method: "GET", redirect: "manual", signal: deadline.signal,
      headers: { accept: "application/json", authorization: `Bearer ${admissionKey}`, [ROUTE_INTENT_WATCH_HEADER]: "1",
        ...(afterDigest === undefined ? {} : { [ROUTE_INTENT_AFTER_HEADER]: afterDigest }) } };
    response = deps.fetchImpl ? await deps.fetchImpl(destination, init) : await fetchBoundLinkRelay(target, destination, init);
    if (response.status === 404) return { kind: "unsupported" };
    if (response.status !== 200) return failed();
    let headerBytes = 0;
    for (const [name, value] of response.headers) headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    const support = response.headers.get(ROUTE_INTENT_WATCH_HEADER);
    const wakeReason = response.headers.get(ROUTE_INTENT_WAKE_HEADER);
    const declared = response.headers.get("content-length");
    if (headerBytes > WATCH_MAX_HEADER_BYTES || (support !== null && support !== "1")
      || (wakeReason !== null && wakeReason !== "changed" && wakeReason !== "notified" && wakeReason !== "timeout")
      || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
      || (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > WATCH_MAX_BYTES))) return failed();
    const read = await readBoundedResponseBytes(response, { maxBytes: WATCH_MAX_BYTES, signal: deadline.signal });
    if (read.oversized) return failed();
    const document = parseHomeRouteIntentDocument(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)));
    return document ? { kind: "fresh", document, watchSupported: support === "1", ...(wakeReason === null ? {} : { wakeReason }) } : failed();
  } catch { return deps.signal?.aborted ? { kind: "cancelled" } : failed(); }
  finally { if (response) cancel(response); deadline.cleanup(); }
}

export interface RouteIntentRuntimeWatchDeps extends Omit<RouteIntentWatchReadDeps, "signal"> {
  /** Share this with the periodic tick. Resolve after apply/report; reject busy/failure to retain the event. */
  requestSync: () => Promise<unknown>;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}
export interface RouteIntentRuntimeWatch { stop(): void }
const liveWatches = new Map<string, RouteIntentRuntimeWatch>();

/** One GET per live link; one in-flight scheduler request plus one coalesced pending event. */
export function startRouteIntentWatch(
  connection: OcxClientConnectionConfig, key: RouteIntentWatchKey, deps: RouteIntentRuntimeWatchDeps,
): RouteIntentRuntimeWatch {
  if (connection.transport !== "link" || !connection.link) return { stop() {} };
  const linkId = connection.link.linkId;
  const existing = liveWatches.get(linkId);
  if (existing) return existing;
  // Do not let caller mutation redirect a long-lived watch onto a different connection.
  const owner = structuredClone(connection);
  const abort = new AbortController();
  const set = deps.setTimer ?? ((cb, ms) => { const timer = setTimeout(cb, ms); timer.unref(); return timer; });
  const clear = deps.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let timer: unknown, retry: unknown;
  let stopped = false, syncing = false, pending = false;
  let after: string | undefined;
  const drain = async () => {
    if (stopped || syncing) return;
    syncing = true;
    try {
      while (pending && !stopped) {
        pending = false;
        try { await deps.requestSync(); }
        catch {
          pending = true;
          if (!stopped) retry = set(() => { retry = undefined; void drain(); }, WATCH_RETRY_MS);
          break;
        }
      }
    } finally { syncing = false; }
  };
  const request = () => {
    pending = true;
    if (retry === undefined) void drain();
  };
  const schedule = (ms: number) => { if (!stopped) timer = set(() => { timer = undefined; void poll(); }, ms); };
  const poll = async () => {
    if (stopped) return;
    const started = Date.now();
    const result = await watchHomeRouteIntent(owner, key, after, { ...deps, signal: abort.signal });
    if (stopped || result.kind === "cancelled") return;
    // A pre-watch Home answers immediately forever. Its existing periodic sync remains authoritative.
    if (result.kind === "unsupported" || (result.kind === "fresh" && !result.watchSupported)) return;
    if (result.kind === "failed") { schedule(WATCH_RETRY_MS); return; }
    const next = routeIntentDigest(result.document);
    const unchanged = after === next;
    after = next;
    if (!unchanged || result.wakeReason !== "timeout") request();
    // Broken peers advertising support but never waiting cannot make a tight loop.
    schedule(unchanged ? Math.max(0, 1_000 - (Date.now() - started)) : 0);
  };
  const handle: RouteIntentRuntimeWatch = { stop() {
    if (stopped) return;
    stopped = true; pending = false;
    abort.abort();
    if (timer !== undefined) clear(timer);
    if (retry !== undefined) clear(retry);
    timer = retry = undefined;
    liveWatches.delete(linkId);
    // An already-entered local apply is owned/fenced by requestSync, never cancelled mid-write here.
  } };
  liveWatches.set(linkId, handle);
  schedule(0);
  return handle;
}
