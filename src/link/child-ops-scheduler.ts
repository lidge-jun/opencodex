import type { ChildOpsEngine } from "./child-ops-engine";
import type { ChildJob, ChildOpsEnv } from "./child-ops-types";
import type { ChildPolicyRead } from "./child-policy";

/**
 * The Home's automatic catalog fan-out (050): after a Home catalog change settles, one no-restart sync job per pass for
 * every eligible Child through the shared Child-ops engine. Timers come from the host (unref'd); this module starts
 * none of its own, and nothing loads it on a Home without links (INV-LINK-CHILD-OPS-01).
 */
export const QUIET_PERIOD_MS = 60_000;
export const QUIET_MAX_DEFER_MS = 300_000;
export const CATALOG_POLL_MS = 300_000;
export const BACKOFF_MIN_MS = 300_000;
export const BACKOFF_MAX_MS = 21_600_000;
/** States that grow the backoff for catalog fan-out; busy is retried at the next poll without growth. */
export const BACKOFF_STATES: ReadonlySet<string> = new Set(["failed", "offline", "uncertain", "refused", "unsupported"]);
export const CATALOG_BACKOFF_KEY = "catalog";

export interface LinkBackoff {
  /** key: CATALOG_BACKOFF_KEY for fan-out; the target version for automatic updates (070). */
  blocked(linkId: string, key: string, now: number, peerVersion: string | null): boolean;
  record(linkId: string, key: string, outcome: { state: string; reason: string | null }, now: number, peerVersion: string | null): void;
  /** Attempts recorded for (link, key) since its last success. 070 caps automatic update attempts with it. */
  attempts(linkId: string, key: string): number;
  /** Last attempt for the link under any key; 070 rotates candidates by it (least recent first). */
  lastAttemptAt(linkId: string): number | null;
}
/** legacy: a Child below 2.93 (lacks --expect-link). legacyAtVersion null means its version was not known yet. */
interface BackoffEntry { until: number; delayMs: number; attempts: number; legacy: boolean; legacyAtVersion: string | null }

/** Per-link exponential backoff shared by the catalog fan-out (here) and the update sweep (070). Memory only. */
export function createLinkBackoff(options: { growOn?: ReadonlySet<string>; countOn?: ReadonlySet<string>; minMs?: number;
  maxMs?: number } = {}): LinkBackoff {
  const growOn = options.growOn ?? BACKOFF_STATES;
  // Revision 4 (4529522103): only these states count toward attempts(); absent ⇒ every non-success outcome counts.
  const countOn = options.countOn ?? null;
  const minMs = options.minMs ?? BACKOFF_MIN_MS, maxMs = options.maxMs ?? BACKOFF_MAX_MS;
  const entries = new Map<string, BackoffEntry>();
  const last = new Map<string, number>();
  const key = (linkId: string, name: string): string => `${linkId}\u0000${name}`;
  return {
    blocked(linkId, name, now, peerVersion) {
      const entry = entries.get(key(linkId, name));
      if (!entry) return false;
      // A Child below 2.93 is retried only after it reports a different version (D6). Revision 4 (4529522058): with no
      // version known at the time, any reported version, or the end of the maxMs backoff, allows one retry.
      // #8557 review: once a version was recorded, a report without one is not "another version".
      if (entry.legacy) return entry.legacyAtVersion !== null ? peerVersion === null || peerVersion === entry.legacyAtVersion
        : peerVersion === null && now < entry.until;
      return now < entry.until;
    },
    record(linkId, name, { state, reason }, now, peerVersion) {
      last.set(linkId, now);
      const k = key(linkId, name);
      const previous = entries.get(k);
      if (state === "succeeded" || state === "up-to-date") { entries.delete(k); return; }
      const attempts = (previous?.attempts ?? 0) + (countOn === null || countOn.has(state) ? 1 : 0);
      if (state === "owner-action" && reason === "child-ocx-lacks-expect-link") {
        entries.set(k, { until: peerVersion === null ? now + maxMs : Number.POSITIVE_INFINITY, delayMs: maxMs, attempts,
          legacy: true, legacyAtVersion: peerVersion });
        return;
      }
      if (!growOn.has(state)) { entries.set(k, { until: now, delayMs: previous?.delayMs ?? 0, attempts, legacy: false, legacyAtVersion: null }); return; }
      const delayMs = previous && previous.delayMs > 0 ? Math.min(previous.delayMs * 2, maxMs) : minMs;
      entries.set(k, { until: now + delayMs, delayMs, attempts, legacy: false, legacyAtVersion: null });
    },
    attempts: (linkId, name) => entries.get(key(linkId, name))?.attempts ?? 0,
    lastAttemptAt: linkId => last.get(linkId) ?? null,
  };
}

export interface ChildOpsSchedulerDeps {
  engine: ChildOpsEngine;
  env: () => ChildOpsEnv;
  readPolicy: () => ChildPolicyRead;
  revision: { current(): { etag: string | null; changedAt: number | null }; recompute(): Promise<boolean> };
  /** Revision 4 (4529521968): 030's catalogSyncedEtag; a GET of /v1/catalog does not count as delivered. */
  syncedEtag: (linkId: string) => string | null;
  /** codexSettingsDigest of the Home settings; null when they cannot be projected. */
  homeDigest: () => string | null;
  /** The Child's parity report appliedCodexSettingsDigest. */
  childDigest: (linkId: string) => string | null;
  /** The relay peer report's version. */
  peerVersion: (linkId: string) => string | null;
  /** 050 Revision 6: a runtime whose runtimeRole is client operates no Children. */
  isClientRuntime: () => boolean;
  setCatalogChangedSlot: (fanout: (() => void) | null) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** Extension point for wp7; called once per poll after the catalog pass. Unset in wp5. */
  afterPoll?: () => Promise<void>;
}

export interface ChildOpsScheduler {
  start(): void;
  stop(): void;
  notifyCatalogChanged(): void;
  /** Test seam: run one evaluation now and wait for the jobs it submitted. */
  evaluateForTest(): Promise<ChildJob[]>;
}

export function createChildOpsScheduler(deps: ChildOpsSchedulerDeps): ChildOpsScheduler {
  const backoff = createLinkBackoff();
  let quiet: unknown = null;
  let firstChangeAt: number | null = null;
  let poll: unknown = null;
  let running = false;
  let rerun = false;
  let stopped = true;

  // Etag equality, never time order (4529521959); an unreadable Home catalog makes no Child behind.
  const behind = (linkId: string): boolean => {
    const etag = deps.revision.current().etag;
    return etag !== null && deps.syncedEtag(linkId) !== etag;
  };

  const record = (job: ChildJob, now: number): void => {
    for (const item of job.items) backoff.record(item.linkId, CATALOG_BACKOFF_KEY, item, now, deps.peerVersion(item.linkId));
  };

  const evaluate = async (): Promise<ChildJob[]> => {
    if (stopped || deps.isClientRuntime()) return [];
    // 050 Revision 6: a quiet timer that fires during a pass is not lost; the pass evaluates once more when it ends.
    if (running) { rerun = true; return []; }
    const { policy } = deps.readPolicy();
    if (policy.catalogFanout !== "auto") return [];
    running = true;
    try {
      const env = deps.env();
      const now = env.now();
      const homeDigest = deps.homeDigest();
      const plain: string[] = [];
      const withRestart: string[] = [];
      for (const link of env.readStore().links) {
        if (link.direction !== "hub-initiated" || env.wireState(link.id) !== "connected") continue;
        if (deps.engine.activeJob(link.id) || backoff.blocked(link.id, CATALOG_BACKOFF_KEY, now, deps.peerVersion(link.id)) || !behind(link.id)) continue;
        const idle = env.activity(link.id)?.idle === true;
        const sameSettings = homeDigest !== null && deps.childDigest(link.id) === homeDigest;
        // Digest rule (D6): a sync that applies changed settings restarts the Child's client runtime and cuts relayed
        // streams, so a busy Child is synced only when its settings already match.
        if (!idle && !sameSettings) continue;
        (idle && policy.childCodexRestart === "app-server-when-idle" ? withRestart : plain).push(link.id);
      }
      const jobs: ChildJob[] = [];
      for (const [ids, restart] of [[plain, "none"], [withRestart, "app-server"]] as const) {
        if (ids.length === 0) continue;
        // #8557 review: the first group's job can run for minutes. A stop() (listener closed, shutdown) or a policy
        // change in that time governs the next group, which is admitted against the policy as it is now.
        const current = deps.readPolicy().policy;
        if (stopped || deps.isClientRuntime() || current.catalogFanout !== "auto") break;
        const restartNow = restart === "app-server" && current.childCodexRestart === "app-server-when-idle" ? "app-server" : "none";
        // submit reads links.json and can throw (the POST route maps that to 503); the next poll retries.
        let result: ReturnType<ChildOpsEngine["submit"]>;
        try { result = deps.engine.submit({ op: "sync", linkIds: [...ids], restart: restartNow, trigger: "auto" }, env); } catch { continue; }
        if (!result.ok) continue;     // a single-link list held by a job or a reserve() answers link_operation_in_progress
        const done = await deps.engine.whenDone(result.job.jobId);
        if (done) { record(done, env.now()); jobs.push(done); }
      }
      return jobs;
    } finally {
      running = false;
      if (rerun) { rerun = false; if (!stopped) void evaluate().catch(() => []); }
    }
  };

  const armQuiet = (): void => {
    if (stopped) return;
    const now = deps.env().now();
    firstChangeAt ??= now;
    if (quiet !== null) deps.clearTimeout(quiet);
    const wait = Math.min(QUIET_PERIOD_MS, Math.max(0, firstChangeAt + QUIET_MAX_DEFER_MS - now));
    quiet = deps.setTimeout(() => { quiet = null; firstChangeAt = null; void evaluate().catch(() => []); }, wait);
  };

  const onPoll = async (): Promise<void> => {
    let changed = false;
    try { changed = await deps.revision.recompute(); } catch { /* next poll */ }
    if (changed) armQuiet();
    else if (quiet === null) await evaluate().catch(() => []);  // retries idle-blocked and backed-off links
    await deps.afterPoll?.().catch(() => {});
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      deps.setCatalogChangedSlot(() => armQuiet());
      poll = deps.setInterval(() => { void onPoll(); }, CATALOG_POLL_MS);
      // A Home restarted after a change still owes its Children a sync.
      void deps.revision.recompute().catch(() => false).then(() => armQuiet());
    },
    stop() {
      if (stopped) return;
      stopped = true;
      deps.setCatalogChangedSlot(null);
      if (quiet !== null) deps.clearTimeout(quiet);
      if (poll !== null) deps.clearInterval(poll);
      quiet = poll = null;
      firstChangeAt = null;
      rerun = false;
    },
    notifyCatalogChanged: armQuiet,
    evaluateForTest: evaluate,
  };
}
