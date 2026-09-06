import type { OcxConfig } from "../types";
import { MAIN_CODEX_ACCOUNT_ID, isSelectableCodexPoolAccount } from "./account-id";
import { readCodexAccountRecord } from "./account-store";
import { captureMainAccountIdentityGeneration, getObservedMainQuotaIdentityKey } from "./main-account-cache";
import { getCodexQuotaHealthSnapshot } from "./routing";
import { getStrictAccountQuota } from "./quota";
import { getCodexQuotaRevision, subscribeCodexQuotaChanges } from "./quota-events";
import { CODEX_STRICT_QUOTA_FRESHNESS_MS, getCodexStrictQuotaStatus, isCodexStrictQuotaEnabled, type CodexStrictQuotaConfig } from "./strict-quota";

type Refresh = (config: OcxConfig, accountIds: readonly string[], policy?: CodexStrictQuotaConfig) => Promise<void>;
type Probe = { attemptedAt: number; credentialKey: string };
export type StrictCodexQuotaRefreshResult = {
  /** Attempted does not claim a successful quota read; eligibility still comes from the cache. */
  status: "off" | "idle" | "attempted" | "failed";
  accountIds: readonly string[];
};
const probes = new Map<string, Probe>();
const groups = new Map<OcxConfig, WaitGroup>();
// One batch at a time preserves the auth API's bounded concurrency across overlapping requests.
let flight: Promise<StrictCodexQuotaRefreshResult> | undefined;
let refresh: Refresh = async (config, ids, policy) => {
  const { refreshStrictCodexPoolQuotaSnapshots } = await import("./auth-api");
  await refreshStrictCodexPoolQuotaSnapshots(config, ids, policy);
};
let clock = () => Date.now();
let schedule = (fn: () => void, delay: number) => setTimeout(fn, delay);
let cancel = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer);

function accountIds(config: OcxConfig): string[] {
  return [...new Set([MAIN_CODEX_ACCOUNT_ID, ...(config.codexAccounts ?? [])
    .filter(isSelectableCodexPoolAccount).map(account => account.id)])]
    .filter(id => !config.pausedCodexAccountIds?.includes(id));
}
function credentialKey(id: string): string {
  if (id === MAIN_CODEX_ACCOUNT_ID) {
    return `${getObservedMainQuotaIdentityKey() ?? "unknown"}:${captureMainAccountIdentityGeneration()}`;
  }
  const record = readCodexAccountRecord(id);
  return record && record.deletedAt == null ? String(record.generation) : "absent";
}

/** A predicted reset schedules a read; it never changes eligibility by itself. */
function probeDueAt(config: CodexStrictQuotaConfig, id: string, now: number): number {
  const state = getCodexStrictQuotaStatus(config, id, "shared", now);
  const prior = probes.get(id);
  // Authentication repair must not inherit backoff earned by the old credential.
  if (prior && prior.credentialKey !== credentialKey(id)) return now;
  const attemptedAt = prior?.attemptedAt;
  const observedAt = state.updatedAt;
  if (attemptedAt === undefined && observedAt === undefined) return now;
  let due = Math.max(attemptedAt ?? 0, observedAt ?? 0) + CODEX_STRICT_QUOTA_FRESHNESS_MS;
  if (state.state === "blocked") {
    for (const window of getStrictAccountQuota(id)?.windows ?? []) {
      const raw = window.resetAt;
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) continue;
      const resetMs = raw < 1_000_000_000_000 ? raw * 1000 : raw;
      // One early probe per prediction. A failed post-reset read earns normal backoff.
      if (resetMs > Math.max(attemptedAt ?? 0, window.observedAt)) due = Math.min(due, resetMs + 1000);
    }
  }
  return due;
}

/** Cancelling one caller does not abort the shared metadata read needed by other callers. */
function waitForRefresh<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** Request-triggered usage reads. No idle timer and no inference/reset-credit calls. */
export async function refreshStrictCodexQuotasOnDemand(
  config: OcxConfig, requestedIds?: ReadonlySet<string>,
  options: { policy?: CodexStrictQuotaConfig; signal?: AbortSignal } = {},
): Promise<StrictCodexQuotaRefreshResult> {
  options.signal?.throwIfAborted();
  const policy = options.policy ?? config;
  if (!isCodexStrictQuotaEnabled(policy)) return { status: "off", accountIds: [] };
  let joined: StrictCodexQuotaRefreshResult | undefined;
  // A different batch may cover only part of this request. Re-evaluate after it settles;
  // per-account attempt markers suppress duplicate reads, including failed reads.
  while (flight) joined = await waitForRefresh(flight, options.signal);
  const configured = accountIds(config);
  const now = clock();
  const ids = configured.filter(id => (!requestedIds || requestedIds.has(id))
    && getCodexStrictQuotaStatus(policy, id, "shared", now).state !== "ready"
    && probeDueAt(policy, id, now) <= now);
  if (!ids.length) {
    const joinedIds = joined?.accountIds.filter(id => configured.includes(id) && (!requestedIds || requestedIds.has(id))) ?? [];
    return joinedIds.length ? { status: joined!.status, accountIds: joinedIds } : { status: "idle", accountIds: [] };
  }
  for (const id of ids) probes.set(id, { attemptedAt: now, credentialKey: credentialKey(id) });
  // Start in a microtask so the shared flight exists before any synchronous injected work.
  const batch = Promise.resolve().then(() => refresh(config, ids, policy)).then(
    (): StrictCodexQuotaRefreshResult => ({ status: "attempted", accountIds: ids }),
    (): StrictCodexQuotaRefreshResult => ({ status: "failed", accountIds: ids }),
  );
  const owned = batch.finally(() => { if (flight === owned) flight = undefined; });
  flight = owned;
  return waitForRefresh(owned, options.signal);
}

type WaitGroup = {
  listeners: Set<() => void>;
  timer?: ReturnType<typeof setTimeout>;
  unsubscribe: () => void;
};

/** Wait only while a real request is pending. The last cancellation removes the sole timer. */
export function waitForStrictCodexQuotaChange(
  config: OcxConfig, signal?: AbortSignal, observedRevision?: number,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    let group = groups.get(config);
    if (!group) {
      const created: WaitGroup = { listeners: new Set(), unsubscribe: () => {} };
      const wake = () => { for (const listener of [...created.listeners]) listener(); };
      created.unsubscribe = subscribeCodexQuotaChanges(wake);
      groups.set(config, created);
      group = created;
    }
    const owner = group;
    const cleanup = () => {
      owner.listeners.delete(done);
      signal?.removeEventListener("abort", aborted);
      if (owner.listeners.size === 0) {
        if (owner.timer !== undefined) { cancel(owner.timer); delete owner.timer; }
        owner.unsubscribe();
        if (groups.get(config) === owner) groups.delete(config);
      }
    };
    const done = () => { cleanup(); resolve(); };
    const aborted = () => { cleanup(); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
    owner.listeners.add(done);
    signal?.addEventListener("abort", aborted, { once: true });
    // Subscribe first, then compare: a manual reset between refusal and registration
    // must cause a retry now, rather than being lost until the next metadata probe.
    if (observedRevision !== undefined && getCodexQuotaRevision() !== observedRevision) {
      done(); return;
    }
    if (owner.timer === undefined) {
      const now = clock();
      // A request has already probed its real candidates before waiting. Unobserved rows
      // (notably a missing or fenced native main) must not turn the group into a 1s poll.
      const candidates = accountIds(config).filter(id => probes.has(id) || getStrictAccountQuota(id) !== null);
      const cooldowns = accountIds(config).flatMap(id => {
        const until = getCodexQuotaHealthSnapshot(id, "shared", now)?.cooldownUntil;
        return until !== undefined && until > now ? [until] : [];
      });
      // Real candidates were attempted before entering this wait. A past deadline can
      // belong to a stale native-main snapshot this request cannot use; it must not
      // repeatedly wake the whole group. Events still wake immediately after a new read.
      const probeDeadlines = candidates.map(id => probeDueAt(config, id, now)).filter(due => due > now);
      const due = Math.min(now + CODEX_STRICT_QUOTA_FRESHNESS_MS, ...probeDeadlines, ...cooldowns);
      owner.timer = schedule(() => {
        delete owner.timer;
        // The pending requests perform the next coalesced refresh before selecting.
        for (const listener of [...owner.listeners]) listener();
      }, Math.max(1000, due - now));
      owner.timer.unref?.();
    }
  });
}

export function strictCodexQuotaWaiterCount(): number {
  let count = 0;
  for (const group of groups.values()) count += group.listeners.size;
  return count;
}

/** Test injection keeps request/wakeup tests off user credentials and real timers. */
export function setStrictCodexQuotaRefreshForTests(fn: Refresh, runtime?: {
  now?: () => number;
  setTimeout?: typeof schedule;
  clearTimeout?: typeof cancel;
}): () => void {
  if (flight || groups.size) throw new Error("Cannot replace quota runtime while requests are active");
  const previous = { refresh, clock, schedule, cancel };
  refresh = fn; clock = runtime?.now ?? clock;
  schedule = runtime?.setTimeout ?? schedule; cancel = runtime?.clearTimeout ?? cancel;
  probes.clear();
  return () => {
    if (flight || groups.size) throw new Error("Quota test left active requests");
    ({ refresh, clock, schedule, cancel } = previous); probes.clear();
  };
}
