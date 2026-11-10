# 050 — wp5: Child policy and automatic catalog fan-out (fix for root-cause layer 1)

> **Revision 2 (audit r1).** Folds H1 (registration per 000 "Test registration rule"), H3 (the per-link backoff becomes
> the exported `createLinkBackoff`, keyed by link and a key, which 070 reuses with the target version), M6 (canonical
> names: `activeJob`, `sharedCatalogRevisionMonitor`; reconciliation items 4–5 written into the host code, 2.3 and 2.6),
> M7 (this phase fixes layer 1 only; layer 2 stays manual by default, 000 "Root cause"), M11 (docs disclose the
> default-on fan-out) and L12 (verifier facts on 61151e3457).

> **Revision 4 (CodeRabbit on #8500).** Folds 4529521968 (eligibility compares 030's `catalogSyncedEtag` with the
> current etag; a GET no longer marks a Child current, superseding reconciliation item 4 for the scheduler),
> 4529522014 (`childObservationsPath` from `paths.ts`), 4529522051 (an unreadable or invalid policy file turns
> automatic operations off until the operator saves a policy; `ENOENT` keeps the defaults), 4529522058 (a legacy
> backoff with no known peer version retries after `BACKOFF_MAX_MS` or as soon as a version appears),
> 4529522063 (the host gives each automatic job `autoSyncAllowed`, which 030's sync runner asks at item start) and
> 4529522103 (`createLinkBackoff` gains `countOn`, so 070's cap counts only `UPDATE_ATTEMPT_CAP_STATES`, the R1
> rule that 070 stated but this code did not implement).

- **Work-phase:** wp5. **Depends on:** wp3 ([030](030_child_operations.md): engine, routes, CLI), wp4
  ([040](040_sync_loosening.md): restart-children plumbing and busy skips), and through them wp1/wp2.
- **Class:** C3 with C4 parts (a new mutating management route, a background job that opens SSH sessions
  by default). Independent review required; security review rides with wp3's if both land in one review
  window, otherwise this PR asks for its own.

**Outcome.** A Home catalog change reaches every eligible Child without anyone running `ocx sync`. The Home
watches its own catalog (the auto-refresh tick reports `changed`, and a 5-minute poll catches dashboard and
management edits), waits 60 s for edits to settle, then submits one `sync` job (no restart) through the
wp3 engine for each Home-initiated, connected, not busy link whose last catalog pull is older than the
change, and that is either idle or already shares the Home's Codex settings digest. Failures back off
from 5 minutes to 6 hours per link. The behaviour is governed by a link-owned policy file,
`<configDir>/link/child-policy.json`, with three knobs and their defaults: `catalogFanout: "auto"`,
`childCodexRestart: "never"`, `updates: "auto-when-idle"` (A1; read by wp7), plus `idleAfterMs: 600000`.
Operators read and change it with `GET/PUT /api/link/children/policy` and `ocx link policy`. Nothing of
this loads, and no timer starts, on a Home without links. An end-to-end oracle test pins that every Home
catalog row's context window equals the Child's row after the automatic sync (A3).

**IN:** `src/link/child-policy.ts`, `src/link/child-ops-scheduler.ts`, `src/link/child-ops-host.ts`, one
slot in `src/codex/catalog-auto-refresh.ts`, the start/stop hook in `src/server/index/optional-listeners.ts`,
`whenDone` on the engine, policy routes, `ocx link policy`, one capability, docs, structure, tests.

**OUT:** automatic updates and the notify sweep (070, which reads `updates`); GUI policy panel (060); any
Child-side change; `src/server/background-lifecycle.ts` (D6 rejects hooking
`refreshConnectedClientsAfterCatalogChange`, which is gated by the local-client policy); `serve-options.ts`
(F4: 3 lines of headroom); `src/types/config.ts` (policy stays out of `config.json`, D18).

## Interfaces consumed

Same rule as 030: names follow the earlier phases if they differ; behaviour is binding.

| Producer | Symbol | Behaviour |
|---|---|---|
| wp3 | `sharedChildOpsEngine()`, `ChildOpsEnv`, `submit({ op:"sync", trigger:"auto", ... })`, `activeJob()` | 030 `2.2` |
| wp3 | `childOpsEnvFor` shape | The host here builds the same env without a request `ctx` |
| wp2 `src/link/child-catalog-freshness.ts` | `createCatalogRevisionMonitor(deps): { current(): CatalogRevision \| null }`; wp5 adds `sharedCatalogRevisionMonitor()` | The scheduler sees it through `schedulerRevision()` (2.3): `current()` maps null to `{ etag: null, changedAt: null }`; `recompute()` is true when the etag moved since the last look. `changedAt` is the catalog file's `mtimeMs` (020 decision 3). |
| wp2 | `catalogPulledAt` in the observation cache, `LinkRouteListener.linkActivity` / listener `activity` | D6, D5 |
| wp4 | nothing new at runtime | `ocx sync --child` is independent; the engine's busy skip already covers concurrent work |

### Reconciliation with 020 as written (binding; applied in the code of 2.2, 2.3 and 2.6 at revision 2)

020 defines `createCatalogRevisionMonitor(deps): { current(): CatalogRevision | null }` (lstat, size/mtime cache,
hash on change, persists `homeCatalog` in `child-observations.json`), a `CatalogPullRecorder` owned by
`optional-listeners.ts` (`catalogPulledAt(linkId)` on `OptionalListenerSet`), and a monitor instance created
lazily in the routes module and kept on `LinkRouteState.catalogRevision`. wp5 therefore:

1. adds `sharedCatalogRevisionMonitor()` to `src/link/child-catalog-freshness.ts` (a process singleton with 020's
   production wiring) and makes 020's route state default to it, so the status rows and the scheduler compare
   against one revision;
2. builds the scheduler's `revision.recompute()` as "call `current()`, return true when the etag differs from the
   last one the scheduler saw", and `revision.current()` as `current() ?? { etag: null, changedAt: null }`;
3. requires `changedAt` to be the catalog file's `mtimeMs` when the etag moves (020 states this for the first
   observation only; if its persist path uses detection time, wp5 changes it, Deviation 3);
4. takes `pulledAt` from the binding (`optional-listeners`'s `catalogPulledAt`, in memory and current) instead of
   re-reading the observation file: `ChildOpsHostBinding` gains `pulledAt: (linkId) => number | null`.
5. maps 020's `LinkActivitySnapshot` to the env's `{ idle, inFlight }` with `isLinkIdle(snapshot, now, readChildPolicy().policy.idleAfterMs)`,
   in both `childOpsEnvFor` (030) and the host binding, so `ocx link policy --idle-after-minutes` governs every idle decision.


## 1. File change map

| Path | Kind | Purpose | Anchor |
|---|---|---|---|
| src/link/child-policy.ts | NEW | Policy schema, defaults, strict read, atomic write | — |
| src/link/child-ops-scheduler.ts | NEW | Quiet period, eligibility (digest and idle rules), backoff, poll timer | — |
| src/link/child-ops-host.ts | NEW | Builds the env and scheduler for the running Home; the only module optional-listeners imports (dynamically) | — |
| src/link/child-ops-engine.ts | MODIFY | `whenDone(jobId)` | wp3 file |
| src/codex/catalog-auto-refresh.ts | MODIFY | `setCatalogAutoRefreshLinkFanout` slot, fired on `outcome.changed` | :53-58, :263-264 |
| src/server/index/optional-listeners.ts | MODIFY | Start the host when the link listener owns its socket; stop on close and stop | :112-130, :145-146, :153-172 |
| src/server/management/link-child-ops-routes.ts | MODIFY | `GET/PUT /api/link/children/policy` | wp3 file |
| src/server/management/route-registry.ts | MODIFY | Two declarations | after wp3's entries |
| src/cli/link-child-ops.ts, src/cli/link.ts | MODIFY | `ocx link policy` | wp3 files; switch :385-398 |
| src/cli/capabilities-access-remote.ts | MODIFY | `link policy` capability | wp3 block |
| src/cli/registry.ts | MODIFY | Help line | :154-163 |
| skills/ocx (generated + 05_remote_hub.md) | REGENERATE / MODIFY | `bun run skill:surface`; policy recipe | — |
| docs-site guides/remote-link.md + 7 locales; reference/cli/lifecycle.md + 7 locales | MODIFY | Automatic catalog fan-out and policy | 030's new sections |
| structure/remote-link.md, structure/manifest.json, INDEX.md | MODIFY | Scheduler behaviour, no-timer-without-links invariant | :9, :67-71 |
| tests (Section 5) | NEW | scheduler, policy, routes, CLI, slot, boundary, oracle | — |

## 2. Changes

### 2.1 src/link/child-policy.ts (NEW, full content)

```ts
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { linkDir } from "./paths";

export const CHILD_POLICY_SCHEMA = "ocx.link.child-policy/1" as const;
export const CATALOG_FANOUT = ["auto", "manual"] as const;
export const CHILD_CODEX_RESTART = ["never", "app-server-when-idle"] as const;
export const CHILD_UPDATES = ["off", "notify", "auto-when-idle"] as const;
export const IDLE_AFTER_MIN_MS = 60_000;
export const IDLE_AFTER_MAX_MS = 3_600_000;

export interface ChildPolicy {
  catalogFanout: typeof CATALOG_FANOUT[number];
  childCodexRestart: typeof CHILD_CODEX_RESTART[number];
  updates: typeof CHILD_UPDATES[number];
  idleAfterMs: number;
}
export const DEFAULT_CHILD_POLICY: Readonly<ChildPolicy> = Object.freeze({
  catalogFanout: "auto", childCodexRestart: "never", updates: "auto-when-idle", idleAfterMs: 600_000,
});
/** Revision 4 (4529522051): what a damaged or unreadable file means. Nothing automatic runs until the operator saves. */
export const FAIL_CLOSED_CHILD_POLICY: Readonly<ChildPolicy> = Object.freeze({
  catalogFanout: "manual", childCodexRestart: "never", updates: "off", idleAfterMs: 600_000,
});
export interface ChildPolicyRead { policy: ChildPolicy; warning: "policy-file-invalid" | null }
const KEYS = ["schema", "catalogFanout", "childCodexRestart", "updates", "idleAfterMs"] as const;

export function childPolicyPath(configDir?: string): string {
  return join(linkDir(configDir), "child-policy.json");
}

/** Field-wise check shared by the file reader and PUT; returns null on any invalid value. */
export function validPolicyPatch(value: Record<string, unknown>): Partial<ChildPolicy> | null {
  const out: Partial<ChildPolicy> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === "catalogFanout" && (CATALOG_FANOUT as readonly unknown[]).includes(v)) out.catalogFanout = v as ChildPolicy["catalogFanout"];
    else if (key === "childCodexRestart" && (CHILD_CODEX_RESTART as readonly unknown[]).includes(v)) out.childCodexRestart = v as ChildPolicy["childCodexRestart"];
    else if (key === "updates" && (CHILD_UPDATES as readonly unknown[]).includes(v)) out.updates = v as ChildPolicy["updates"];
    else if (key === "idleAfterMs" && typeof v === "number" && Number.isSafeInteger(v) && v >= IDLE_AFTER_MIN_MS && v <= IDLE_AFTER_MAX_MS) out.idleAfterMs = v;
    else return null;
  }
  return out;
}

/** Absent file ⇒ defaults, no warning. Unreadable, unknown key or bad value ⇒ FAIL_CLOSED_CHILD_POLICY plus a warning. */
export function readChildPolicy(path = childPolicyPath()): ChildPolicyRead {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { policy: { ...DEFAULT_CHILD_POLICY }, warning: null }
      : { policy: { ...FAIL_CLOSED_CHILD_POLICY }, warning: "policy-file-invalid" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    const record = parsed as Record<string, unknown>;
    if (record.schema !== CHILD_POLICY_SCHEMA || Object.keys(record).some(key => !(KEYS as readonly string[]).includes(key))) throw new Error("keys");
    const { schema: _schema, ...fields } = record;
    const patch = validPolicyPatch(fields);
    if (!patch) throw new Error("value");
    return { policy: { ...DEFAULT_CHILD_POLICY, ...patch }, warning: null };
  } catch { return { policy: { ...FAIL_CLOSED_CHILD_POLICY }, warning: "policy-file-invalid" }; }
}

/** Read-merge-write under the config mutation lock; the file always holds every key. */
export function updateChildPolicy(patch: Partial<ChildPolicy>, path = childPolicyPath()): ChildPolicy {
  return withConfigMutationLockSync(() => {
    const next: ChildPolicy = { ...readChildPolicy(path).policy, ...patch };
    mkdirSync(linkDir(), { recursive: true, mode: 0o700 });
    atomicWriteFile(path, `${JSON.stringify({ schema: CHILD_POLICY_SCHEMA, ...next }, null, 2)}\n`);
    return next;
  });
}
```
A damaged file is not rewritten on read: the warning stays visible in `GET /api/link/children/policy`
until the operator saves a policy. Until then fan-out is `manual` and updates are `off` (Revision 4): a file the
operator wrote to opt out must not turn the defaults back on by becoming unreadable. A save merges onto that
fail-closed policy and writes every key, so the operator sees and chooses each mode again. `atomicWriteFile(path, content)` (src/config/atomic-write.ts:458)
publishes from an exclusively created private temp, the same path `links.json` uses, so the file is private.

### 2.2 src/link/child-ops-scheduler.ts (NEW, full exported API and core logic)

```ts
import type { ChildOpsEngine } from "./child-ops-engine";
import type { ChildJob, ChildOpsEnv } from "./child-ops-types";
import type { ChildPolicyRead } from "./child-policy";

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

/** Per-link exponential backoff shared by the catalog fan-out (here) and the update sweep (070). */
export function createLinkBackoff(options: { growOn?: ReadonlySet<string>; countOn?: ReadonlySet<string>; minMs?: number;
  maxMs?: number } = {}): LinkBackoff {
  const growOn = options.growOn ?? BACKOFF_STATES;
  // Revision 4 (4529522103): only these states count toward attempts(); absent ⇒ every non-success outcome counts.
  const countOn = options.countOn ?? null;
  const minMs = options.minMs ?? BACKOFF_MIN_MS, maxMs = options.maxMs ?? BACKOFF_MAX_MS;
  const entries = new Map<string, BackoffEntry>();
  const last = new Map<string, number>();
  const id = (linkId: string, key: string): string => `${linkId}\u0000${key}`;
  return {
    blocked(linkId, key, now, peerVersion) {
      const entry = entries.get(id(linkId, key));
      if (!entry) return false;
      // A Child below 2.93 is retried only after it reports a different version (D6). Revision 4 (4529522058): with no
      // version known at the time, any reported version, or the end of the maxMs backoff, allows one retry.
      if (entry.legacy) return entry.legacyAtVersion !== null ? peerVersion === entry.legacyAtVersion
        : peerVersion === null && now < entry.until;
      return now < entry.until;
    },
    record(linkId, key, { state, reason }, now, peerVersion) {
      last.set(linkId, now);
      const k = id(linkId, key);
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
    attempts: (linkId, key) => entries.get(id(linkId, key))?.attempts ?? 0,
    lastAttemptAt: linkId => last.get(linkId) ?? null,
  };
}

export interface ChildOpsSchedulerDeps {
  engine: ChildOpsEngine;
  env: () => ChildOpsEnv;
  readPolicy: () => ChildPolicyRead;
  revision: { current(): { etag: string | null; changedAt: number | null }; recompute(): Promise<boolean> };
  /** Revision 4 (4529521968): 030's catalogSyncedEtag; a GET of /v1/catalog no longer counts as delivered. */
  syncedEtag: (linkId: string) => string | null;
  homeDigest: () => string | null;                         // codexSettingsDigest of the Home settings
  childDigest: (linkId: string) => string | null;          // parity appliedCodexSettingsDigest
  peerVersion: (linkId: string) => string | null;          // relay peer report
  setCatalogChangedSlot: (fanout: (() => void) | null) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** Extension point for wp7; called once per poll after the catalog pass. */
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
  let stopped = true;

  const behind = (linkId: string): boolean => {
    const etag = deps.revision.current().etag;
    if (etag === null) return false;
    return deps.syncedEtag(linkId) !== etag;   // etag equality, never time order (4529521959)
  };

  const record = (job: ChildJob, now: number): void => {
    for (const item of job.items) backoff.record(item.linkId, CATALOG_BACKOFF_KEY, item, now, deps.peerVersion(item.linkId));
  };

  const evaluate = async (): Promise<ChildJob[]> => {
    if (running || stopped) return [];
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
        // Digest rule (D6): a sync that applies changed settings restarts the Child's client runtime
        // and cuts relayed streams, so a busy Child is synced only when its settings already match.
        if (!idle && !sameSettings) continue;
        (idle && policy.childCodexRestart === "app-server-when-idle" ? withRestart : plain).push(link.id);
      }
      const jobs: ChildJob[] = [];
      for (const [ids, restart] of [[plain, "none"], [withRestart, "app-server"]] as const) {
        if (ids.length === 0) continue;
        const result = deps.engine.submit({ op: "sync", linkIds: [...ids], restart, trigger: "auto" }, env);
        if (!result.ok) continue;
        const done = await deps.engine.whenDone(result.job.jobId);
        if (done) { record(done, env.now()); jobs.push(done); }
      }
      return jobs;
    } finally { running = false; }
  };

  const armQuiet = (): void => {
    if (stopped) return;
    const now = deps.env().now();
    firstChangeAt ??= now;
    if (quiet !== null) deps.clearTimeout(quiet);
    const wait = Math.min(QUIET_PERIOD_MS, Math.max(0, firstChangeAt + QUIET_MAX_DEFER_MS - now));
    quiet = deps.setTimeout(() => { quiet = null; firstChangeAt = null; void evaluate().catch(() => {}); }, wait);
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
    },
    notifyCatalogChanged: armQuiet,
    evaluateForTest: evaluate,
  };
}
```
Timers come from the host as `unref`'d handles, so the scheduler never keeps the process alive.

### 2.3 src/link/child-ops-host.ts (NEW, full content)

Revision 2 writes 050's reconciliation items 4 and 5 into the code: `pulledAt` comes from the binding (020's recorder,
in memory and current), and activity is mapped with `isLinkIdle` and the policy's `idleAfterMs` on every read.

```ts
import { readLinkStore } from "./store";
import { linkKnownHostsPath, linkStorePath } from "./paths";
import { createSshRunner } from "./ssh-runner";
import { projectLinkStatus } from "./status-projection";
import type { LinkTunnelStatus } from "./supervisor";
import { sharedChildOpsEngine } from "./child-ops-engine";
import type { ChildOpsEnv } from "./child-ops-types";
import { createChildOpsScheduler, type ChildOpsScheduler } from "./child-ops-scheduler";
import { readChildPolicy } from "./child-policy";
import { sharedCatalogRevisionMonitor, type CatalogRevisionMonitor } from "./child-catalog-freshness";
import { isLinkIdle, type LinkActivitySnapshot } from "./child-activity";
import { observeChild, type ObserveDeps } from "./child-observe";
import { inspectRemoteChildRuntime } from "./remote-plant";
import { requireRemotePlatform } from "./remote-platform";
import { childObservationsPath } from "./paths";      // Revision 4 (4529522014): exported by paths.ts (010)
import { patchChildObservation, readChildObservations, updateChildObservations } from "./child-observations";
import { homeLinkChildParity } from "./child-parity";
import { codexSettingsDigest, projectHomeCodexSettings } from "./codex-settings";
import { packageVersion } from "../lib/package-version";
import { setCatalogAutoRefreshLinkFanout } from "../codex/catalog-auto-refresh";

export interface ChildOpsHostBinding {
  config: () => import("../types").OcxConfig;
  supervisorStatus: () => readonly LinkTunnelStatus[];
  listenerStatus: () => { state: "off" | "listening" | "failed"; port: number | null };
  /** 020's listener linkActivity; null when the listener has no activity book (never idle). */
  activity: (linkId: string, now: number) => LinkActivitySnapshot | null;
  /** 020's CatalogPullRecorder.pulledAt: status display only since Revision 4; the scheduler reads syncedEtag. */
  pulledAt: (linkId: string) => number | null;
  /** 020's listener peerObservation. */
  peer: ObserveDeps["peer"];
}

/** The scheduler's revision view over 020's monitor: recompute() is true when the etag moved since it last looked. */
export function schedulerRevision(monitor: CatalogRevisionMonitor = sharedCatalogRevisionMonitor()) {
  let seen: string | null | undefined;
  return {
    current: () => { const r = monitor.current(); return r ? { etag: r.etag, changedAt: r.changedAt } : { etag: null, changedAt: null }; },
    async recompute(): Promise<boolean> {
      const etag = monitor.current()?.etag ?? null;
      const changed = seen !== undefined && etag !== seen;
      seen = etag;
      return changed;
    },
  };
}

/** One env shape for the routes (030 childOpsEnvFor) and this host; idleAfterMs is the policy value (item 5).
 *  Revision 4 (4529522063): autoSyncAllowed is the scheduler's own rule (idle, or settings already equal), asked again
 *  by 030's runSyncItem when each automatic item starts. */
export function hostChildOpsEnv(binding: ChildOpsHostBinding, runner: ReturnType<typeof createSshRunner>,
  digests?: { home: () => string | null; child: (linkId: string) => string | null }): ChildOpsEnv {
  const store = () => readLinkStore(linkStorePath());
  const hosts = linkKnownHostsPath();
  const version = packageVersion("0.0.0");
  const idleAfterMs = readChildPolicy().policy.idleAfterMs;
  const env: ChildOpsEnv = {
    readStore: store, runner, knownHostsFile: hosts, homeVersion: version, now: Date.now, sleep: ms => Bun.sleep(ms),
    wireState: id => projectLinkStatus(store(), binding.supervisorStatus(), binding.listenerStatus(), binding.config())
      .links.find(link => link.id === id)?.state ?? null,
    activity: id => {
      const now = Date.now();
      const snapshot = binding.activity(id, now);
      return snapshot ? { inFlight: snapshot.inFlight, idle: isLinkIdle(snapshot, now, idleAfterMs) } : null;
    },
    observe: record => observeChild(record, { runner, knownHostsFile: hosts, homeVersion: version, peer: binding.peer,
      platformOf: async link => requireRemotePlatform(runner, link.alias, hosts), inspect: inspectRemoteChildRuntime,
      now: () => new Date() }),
    readObservation: id => readChildObservations(childObservationsPath()).children[id] ?? null,
    writeObservation: (id, patch) => { updateChildObservations(file => patchChildObservation(file, id, patch, new Date())); },
    catalogEtag: () => sharedCatalogRevisionMonitor().current()?.etag ?? null,
  };
  if (digests) env.autoSyncAllowed = id => {
    if (env.activity(id)?.idle === true) return true;
    const home = digests.home();
    return home !== null && digests.child(id) === home;
  };
  return env;
}

export function startChildOpsHost(binding: ChildOpsHostBinding): () => void {
  const runner = createSshRunner();
  const version = packageVersion("0.0.0");
  const peerVersion = (id: string): string | null => binding.peer(id).observed?.version ?? null;
  const unref = <T>(handle: T): T => { (handle as { unref?: () => void }).unref?.(); return handle; };
  const homeDigest = (): string | null => { try { return codexSettingsDigest(projectHomeCodexSettings(binding.config(), version).settings); } catch { return null; } };
  const childDigest = (id: string): string | null => homeLinkChildParity.get(id).appliedCodexSettingsDigest;
  const scheduler: ChildOpsScheduler = createChildOpsScheduler({
    engine: sharedChildOpsEngine(), env: () => hostChildOpsEnv(binding, runner, { home: homeDigest, child: childDigest }),
    readPolicy: () => readChildPolicy(),
    revision: schedulerRevision(),
    syncedEtag: id => readChildObservations(childObservationsPath()).children[id]?.catalogSyncedEtag ?? null,
    homeDigest, childDigest,
    peerVersion,
    setCatalogChangedSlot: setCatalogAutoRefreshLinkFanout,
    setTimeout: (fn, ms) => unref(setTimeout(fn, ms)), clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => unref(setInterval(fn, ms)), clearInterval: h => clearInterval(h as ReturnType<typeof setInterval>),
  });
  scheduler.start();
  return () => scheduler.stop();
}
```
`child-ops-host.ts` importing `src/codex/catalog-auto-refresh.ts` is an outward edge from `src/link` to a
module `background-lifecycle.ts` already loads, and the slot setter is all it uses. 070 extends this host
with the update sweep through `afterPoll` and its own start-time sweep. `sharedCatalogRevisionMonitor()` is added to
`child-catalog-freshness.ts` (reconciliation item 1) and 020's route state defaults its `catalogRevision` to it, so the
status rows and this scheduler compare against one revision.

### 2.4 src/link/child-ops-engine.ts (MODIFY, wp3 file)

Add to `ChildOpsEngine` and its implementation:
```ts
  /** Resolves with the finished job, or null when it is unknown or already pruned. */
  whenDone(jobId: string): Promise<ChildJob | null>;
```
```ts
  const runs = new Map<string, Promise<void>>();       // jobId -> execute() promise, set in submit()
  ...
    async whenDone(jobId) {
      await runs.get(jobId);
      return this.job(jobId) ?? null;          // 020's job() answers undefined for an unknown or pruned id
    },
```
`submit` stores the `execute` promise in `runs` next to `running` and deletes it in the same `finally`.

### 2.5 src/codex/catalog-auto-refresh.ts (MODIFY)

Before (:53-58):
```ts
export type CatalogChangedClientFanout =
  (isCurrent: () => boolean) => Promise<ReadonlyArray<{ readonly ok: boolean }>>;
let clientFanout: CatalogChangedClientFanout | null = null;
export function setCatalogAutoRefreshClientFanout(fanout: CatalogChangedClientFanout | null): void {
  clientFanout = fanout;
}
```
After (appended below it):
```ts
/**
 * Notified after a tick committed a changed catalog. Owned by the link Child-ops scheduler, which
 * registers only while this Home has links, so a Home without links pays one null check.
 * Synchronous and fire-and-forget: the scheduler debounces and does its own work later.
 */
export type CatalogChangedLinkFanout = () => void;
let linkFanout: CatalogChangedLinkFanout | null = null;
export function setCatalogAutoRefreshLinkFanout(fanout: CatalogChangedLinkFanout | null): void {
  linkFanout = fanout;
}
```
Before (:263-264):
```ts
    recordCatalogAutoRefreshOutcome(outcome.catalogRefresh, outcome.changed, reloadRequired);
    if (outcome.changed) {
```
After:
```ts
    recordCatalogAutoRefreshOutcome(outcome.catalogRefresh, outcome.changed, reloadRequired);
    if (outcome.changed) {
      try { linkFanout?.(); } catch { /* the scheduler's 5-minute poll catches the change */ }
```
The slot carries no data and imports nothing from `src/link`, so `tests/lab/core-link-boundary.test.ts`
is unaffected even though `background-lifecycle.ts` loads this module statically.

### 2.6 src/server/index/optional-listeners.ts (MODIFY)

The host starts exactly when the supervisor would: when the link listener owns its socket, which happens
only when `links.json` has links (link-listener.ts:112-115). Add inside `createOptionalListenerSet`:
```ts
  let stopChildOps: (() => void) | undefined;
  let childOpsStarting = false;
  /** Dynamic import: a Home without links never loads src/link/child-ops-* (no-timer-without-links). */
  const syncChildOpsHost = (): void => {
    if (!linkListenerOwnsTarget(linkListener.status())) { stopChildOps?.(); stopChildOps = undefined; return; }
    if (stopChildOps || childOpsStarting) return;
    childOpsStarting = true;
    void import("../../link/child-ops-host").then(host => {
      childOpsStarting = false;
      if (!linkListenerOwnsTarget(linkListener.status()) || stopChildOps) return;
      stopChildOps = host.startChildOpsHost({
        config: () => activeConfig!,
        supervisorStatus: () => supervisor.status(),
        listenerStatus: () => linkListener.status(),
        activity: (linkId, now) => linkListener.linkActivity?.(linkId, now) ?? null,   // LinkActivitySnapshot; the host maps idle
        pulledAt: linkId => catalogPulls.pulledAt(linkId),   // 020's CatalogPullRecorder created in this file (catalogPulls)
        peer: linkId => linkListener.peerObservation(linkId),
      });
    }).catch(() => { childOpsStarting = false; });
  };
```
Call sites: in `start(ctx)` after `supervisor.start()` (:127-129) add `syncChildOpsHost();` (inside the same
`if`). Wrap `ensureStarted` (:145): `ensureStarted: () => linkListener.ensureStarted().then(() => syncChildOpsHost())`.
Wrap `close` (:146): `close: () => linkListener.close().then(() => syncChildOpsHost())`. In `stop()` (:153) add
`stopChildOps?.(); stopChildOps = undefined;` before `supervisorStop`. `start` stays synchronous: the dynamic
import is not awaited, which keeps the `startServer` no-await window intact (AGENTS.md "Optional subsystems").
The file grows from 174 to about 200 lines; it has no cap.

### 2.7 Policy routes (MODIFY src/server/management/link-child-ops-routes.ts)

The POST handler 030 wrote now builds its env with the policy threshold (reconciliation item 5):
`childOpsEngineFor(state).submit({ ...parsed, trigger: "manual" }, childOpsEnvFor(ctx, state, readChildPolicy().policy.idleAfterMs))`.


Inserted before the jobs branch:
```ts
  if (url.pathname === "/api/link/children/policy" && req.method === "GET") {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    return Response.json(readChildPolicy(), { headers: NO_STORE });
  }
  if (url.pathname === "/api/link/children/policy" && req.method === "PUT") {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    const body = await readManagementJsonBodyOr(ctx.req, null);
    const patch = isRecord(body) && Object.keys(body).length > 0 ? validPolicyPatch(body) : null;
    if (!patch) return fail("invalid_body", "Send one or more of catalogFanout, childCodexRestart, updates, idleAfterMs with valid values.", 400);
    try { return Response.json({ policy: updateChildPolicy(patch), warning: null }, { headers: NO_STORE }); }
    catch { return fail("policy_write_failed", "The Child policy could not be saved.", 503); }
  }
```
Imports: `readChildPolicy, updateChildPolicy, validPolicyPatch` from `../../link/child-policy`.
Registry (after wp3's two entries):
```ts
  { method: "GET", path: "/api/link/children/policy", module: "server/management/link-child-ops-routes", mutates: false },
  { method: "PUT", path: "/api/link/children/policy", module: "server/management/link-child-ops-routes", mutates: true },
```
The running scheduler reads the file on every evaluation, so a PUT takes effect at the next quiet period or
poll without a restart.

### 2.8 CLI `ocx link policy` (MODIFY src/cli/link-child-ops.ts, link.ts, capabilities, registry)

```ts
export const LINK_POLICY_USAGE = "  ocx link policy [--updates off|notify|auto-when-idle] [--catalog-fanout auto|manual] [--child-codex-restart never|app-server-when-idle] [--idle-after-minutes <1-60>] [--json]";

export async function runLinkPolicy(args: string[], deps: LinkCliDeps, request: LinkRequest, usage: string): Promise<void> {
  const json = takeJsonFlag(args);
  const patch: Record<string, string | number> = {};
  const pick = (flag: string, key: string, allowed: readonly string[]): void => {
    const value = takeOption(args, flag);
    if (value === undefined) return;
    if (!allowed.includes(value)) throw new CliUsageError(`${flag} must be one of ${allowed.join(", ")}`, usage);
    patch[key] = value;
  };
  pick("--updates", "updates", CHILD_UPDATES);
  pick("--catalog-fanout", "catalogFanout", CATALOG_FANOUT);
  pick("--child-codex-restart", "childCodexRestart", CHILD_CODEX_RESTART);
  const minutes = takeIntegerOption(args, "--idle-after-minutes", { min: 1, max: 60 });
  if (minutes !== undefined) patch.idleAfterMs = minutes * 60_000;
  rejectArgs(args, usage);
  const result = Object.keys(patch).length === 0
    ? await request<unknown>("/api/link/children/policy", {}, deps)
    : await request<unknown>("/api/link/children/policy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }, deps);
  const read = validatePolicyRead(result);            // exact {policy:{4 keys}, warning}
  printData(read, json, [
    `catalog fan-out: ${read.policy.catalogFanout}`, `Child Codex restart: ${read.policy.childCodexRestart}`,
    `updates: ${read.policy.updates}`, `idle after: ${read.policy.idleAfterMs / 60_000} min`,
    ...(read.warning ? ["The policy file was invalid; defaults are in effect until you save a policy."] : []),
  ]);
}
```
`link.ts` switch: `else if (command === "policy") await runLinkPolicy(args, deps, linkRequest, LINK_USAGE);` and the
usage line. `takeIntegerOption` already enforces `min`/`max` (src/cli/runtime-api.ts:282).
Capability (appended to wp3's block in `capabilities-access-remote.ts`):
```ts
  {
    command: ["link", "policy"], summary: "Read or change how this Home keeps its Children current.",
    usage: "ocx link policy [--updates off|notify|auto-when-idle] [--catalog-fanout auto|manual] [--child-codex-restart never|app-server-when-idle] [--idle-after-minutes <1-60>] [--json]",
    routes: [{ method: "GET", path: "/api/link/children/policy" }, { method: "PUT", path: "/api/link/children/policy" }],
    flags: [{ name: "--updates", value: "string", summary: "off, notify, or auto-when-idle (default)." }, { name: "--catalog-fanout", value: "string", summary: "auto (default) or manual." },
      { name: "--child-codex-restart", value: "string", summary: "never (default) or app-server-when-idle." }, { name: "--idle-after-minutes", value: "number", summary: "Minutes without a relayed model request before a Child counts as idle; default 10." },
      { name: "--json", value: "boolean", summary: "Emit {policy, warning} as JSON." }],
    mutates: true, json: "payload",
    details: ["Without flags it reads the policy. Stored in <configDir>/link/child-policy.json on the Home, never in config.json.", "Catalog fan-out syncs Home-initiated Children 60 s after a Home catalog change; it restarts Codex on a Child only with app-server-when-idle."],
  },
```
`registry.ts` (:154-163) adds `Policy: ocx link policy [...]` to the link details.

## 3. Deviations from 004 and 000

1. **PUT accepts a subset.** D14 says "exactly the policy keys". A subset with strict keys and values lets the
   CLI and GUI change one knob without a read-modify-write race across processes; the merge happens under the
   config mutation lock (2.1). An empty body or any unknown key is still `400 invalid_body`.
2. **`updates` default is `auto-when-idle`** (lead amendment A1), not D17's `notify`. This phase only stores it;
   070 acts on it.
3. **`changedAt` is the catalog file mtime**, not the detection time (D6 leaves it open). Otherwise a Child that
   pulled through the Home's own `ocx sync` fan-out before the 5-minute poll noticed the change would be synced
   a second time.
4. **Quiet period has a 5-minute ceiling** (`QUIET_MAX_DEFER_MS`): a steady stream of edits cannot postpone the
   fan-out forever. D6 names only the 60 s quiet period.
5. **A Child below 2.93 is not retried until its peer version changes**, as D6 says, implemented as a backoff
   entry keyed to the observed version; other failures back off 5 min doubling to 6 h; `busy` does not grow the
   backoff (it is retried at the next poll).
6. **The end-to-end oracle lands here** (A3), not in a P9 hardening phase.

## 4. Field chains (PLAN-FIELD-CHAIN-01)

| Field / value | Created | Serialized | Deserialized | Consumers |
|---|---|---|---|---|
| `ocx.link.child-policy/1` file (`catalogFanout`, `childCodexRestart`, `updates`, `idleAfterMs`) | `updateChildPolicy` via `PUT /api/link/children/policy` | `child-policy.json`, 2-space JSON | `readChildPolicy` (strict) | scheduler `evaluate` (`catalogFanout`, `childCodexRestart`); 070 sweep (`updates`, `idleAfterMs`); 020 activity idle threshold reads `idleAfterMs` through the binding (default `DEFAULT_IDLE_AFTER_MS` until wp5 lands); GUI panel (060) |
| `{ policy, warning }` response | policy routes | JSON | `validatePolicyRead` (CLI, exact keys) | `ocx link policy` output; GUI (060) |
| `warning: "policy-file-invalid"` | `readChildPolicy` | response | CLI / GUI | operator message; automatic fan-out and updates stay off until a save (Revision 4) |
| `trigger:"auto"` sync jobs | scheduler | engine job (in-process), `lastOperation` in observations | 030 validator | `?children=1` rows; GUI "automatic" label (060) |
| restart `app-server` on auto sync | scheduler when `childCodexRestart === "app-server-when-idle"` and the link is idle | job `restart` | — | 030 `runSyncItem` (POSIX full Children only) |
| `setCatalogAutoRefreshLinkFanout` slot | `startChildOpsHost` (set), `stop` (null) | N/A (in-process function) | N/A | `tick()` in catalog-auto-refresh.ts |
| Backoff entries | scheduler `record` | N/A, memory only | N/A | `blocked()`; a Home restart clears them (the first evaluation after start may retry once) |

## 5. Tests

New files fail before implementation (their imports do not exist). Register each per 000 "Test registration rule": one
line before the closing `}` of `scripts/test-layout/layout-clients.json` and of `tests/fixtures/test-layout-expected.json`,
with the domain from the table; nothing goes into `layout.json` (1998 lines, the ratchet fails at 2000). Policy route
cases may instead go into 020's `tests/server/link-child-ops-routes.test.ts` (MODIFY); the separate file is kept so the
policy routes have their own owner.

| File | Domain |
|---|---|
| tests/clients/link-child-ops-scheduler.test.ts | clients |
| tests/clients/link-child-policy.test.ts | clients |
| tests/server/link-child-policy-routes.test.ts | server |
| tests/cli/cli-link-policy.test.ts | cli |
| tests/codex-integration/catalog-auto-refresh-link-fanout.test.ts | codex-integration |
| tests/lab/link-child-ops-no-timer.test.ts | lab |
| tests/e2e-style/link-child-catalog-oracle.test.ts (+ tests/fixtures/link-child-catalog-oracle-runner.ts) | e2e-style |

**link-child-ops-scheduler.test.ts** (fake timers through the deps, fake engine recording `submit` calls, fake env):
- `quiet period`: `notifyCatalogChanged()` then advance 59 s ⇒ no submit; 60 s ⇒ one `sync` job, `trigger:"auto"`, `restart:"none"`.
- `burst coalesces`: three notifications 20 s apart ⇒ one job 60 s after the last; `ceiling`: notifications every 30 s for
  10 min ⇒ a job at 5 min.
- `manual policy`: `catalogFanout:"manual"` ⇒ no submit.
- `eligibility`: client-initiated, tunnel `reconnecting`, engine `activeJob` set, `syncedEtag` equal to the current
  etag ⇒ excluded; `syncedEtag null` or different ⇒ included (Revision 4: after the upgrade each connected Child is
  synced once, which also records its etag). `fetched but not synced` (4529521968): a recorded pull of the current
  etag with `syncedEtag` still old ⇒ included.
- `digest rule`: not idle + digest equal ⇒ included; not idle + digest different ⇒ excluded; idle + digest different ⇒ included.
- `restart knob`: `app-server-when-idle` + idle ⇒ second job with `restart:"app-server"`; not idle ⇒ plain job.
- `backoff`: item `failed` ⇒ skipped until +5 min, then +10 min after a second failure, capped at 6 h; `succeeded` clears.
- `legacy Child`: item `owner-action/child-ocx-lacks-expect-link` ⇒ never retried while `peerVersion` stays `2.92.0`;
  retried once it reports `2.97.0`.
- `legacy Child, version unknown` (Revision 4, 4529522058): the same item with `peerVersion null` ⇒ blocked while it stays
  null until `BACKOFF_MAX_MS`, then retried; retried at once when a version is reported.
- `auto sync rechecks` (Revision 4, 4529522063): the host env's `autoSyncAllowed` is false when the link is busy and its
  digest differs, true when idle or when the digests match; with a link that turns busy between submit and item start,
  the item ends `busy/link-active` with no SSH call.
- `poll`: `recompute` returns true ⇒ quiet armed; false with a behind idle link ⇒ immediate evaluation.
- `start/stop`: `start` sets the slot and one interval; `stop` clears both and nulls the slot; a second `start` is a no-op.

- `createLinkBackoff` (H3, shared with 070): keys are independent (`catalog` backoff does not block key `2.100.0`);
  `attempts` counts every record since the last success and resets on `succeeded`; with `countOn` (Revision 4,
  4529522103) only those states count, while `growOn` still decides growth: `countOn` without `busy` and three `busy`
  records ⇒ `attempts` 0 and the backoff grown; `growOn` including `busy` grows on `busy`; `lastAttemptAt` is the
  latest record under any key.
- `host env` (2.3): `hostChildOpsEnv` maps a snapshot with `inFlight 0` and `lastDataEndAt` older than the policy's
  `idleAfterMs` to `idle: true` and a newer one to `false`; `syncedEtag` comes from the observation file's
  `catalogSyncedEtag`.

**link-child-policy.test.ts**: absent file ⇒ defaults with `updates:"auto-when-idle"` and no warning; unknown key, bad
enum, `idleAfterMs: 59_999` or `3_600_001`, wrong schema, malformed JSON, or a read error other than `ENOENT` (a directory
at the path) ⇒ `FAIL_CLOSED_CHILD_POLICY` (`catalogFanout:"manual"`, `updates:"off"`) + `policy-file-invalid` and the
file is untouched (Revision 4, 4529522051); `updateChildPolicy({updates:"notify"})` keeps other keys and writes all five; POSIX mode `0o600`
(skipped on Windows, where ACL hardening is covered by existing atomic-write tests).

**link-child-policy-routes.test.ts**: auth matrix (admin loopback, dashboard, Tailscale 403); `GET` answers `{policy, warning}`;
`PUT {updates:"off"}` ⇒ 200 and the next `GET` shows it; `PUT {}`, unknown key, bad value ⇒ 400; write failure (read-only
dir fake) ⇒ 503 `policy_write_failed`. Registry reconciliation is the existing management-route-registry test.

**cli-link-policy.test.ts**: no flags ⇒ GET and human lines; `--updates notify --json` ⇒ PUT `{updates:"notify"}` and the
JSON document; `--idle-after-minutes 0` and `61` ⇒ exit 2; `--updates sometimes` ⇒ exit 2; invalid response ⇒ exit 1.

**catalog-auto-refresh-link-fanout.test.ts** (sibling of the client-fanout test, same harness): a changed tick calls the
link slot exactly once before the client delivery; an unchanged tick never calls it; a throwing slot does not stop the
client delivery; `setCatalogAutoRefreshLinkFanout(null)` removes it.

**link-child-ops-no-timer.test.ts** (lab domain, beside core-link-boundary):
- `core cannot reach the scheduler`: the import walk of `core-link-boundary.test.ts` (static edges) from `src/router.ts`,
  `src/server/lifecycle.ts`, `src/server/responses/core.ts` and `src/server/background-lifecycle.ts` never reaches
  `src/link/child-ops-*` or `child-policy.ts`.
- `optional-listeners loads the host only dynamically`: its source has no static import of `child-ops-host` and exactly
  one `import("../../link/child-ops-host")`.
- `no timer without links`: `createOptionalListenerSet` with a fake `serve` and an empty store, `start(...)`, then assert no
  `setInterval`/`setTimeout` was created with the scheduler's intervals (spy) and a `mock.module` stand-in for
  `src/link/child-ops-host` records zero `startChildOpsHost` calls; with one link it records one start, and `close()` after
  the last link records one stop.

**link-child-catalog-oracle.test.ts** (A3). Activation: a Home catalog with four rows (`context_window` 1 000 000,
1 048 576, 200 000 and a native 272 000 row, each with `max_context_window`, `effective_context_window_percent` 95 and
`auto_compact_token_limit`) is written to a temp Home `CODEX_HOME`. The Home body is `JSON.stringify(readCatalog(path))`, the
bytes `/v1/catalog` serves (catalog-download.ts:55-62). The scheduler (real) with a real engine (030) runs one evaluation
with one connected, idle, behind link; the fake `runner.run` recognises the pinned sync argv (`sync --expect-link <id> --json`)
and, instead of SSH, spawns `tests/fixtures/link-child-catalog-oracle-runner.ts` with a separate `OPENCODEX_HOME` and
`CODEX_HOME` prepared as a connected link Child (the setup of `tests/clients/client-link-stop.test.ts` around :285). That runner
calls `syncConnectedClient` with `fetchImpl` returning the Home body (as `tests/fixtures/client-link-sync-runner.ts` does) and
`catalogCompatibility.supportedEfforts` covering the fixture's efforts, then prints the framing a real Child prints
(`ocx-fanout:selected:<v>` on stderr, `ocx-fanout:stdout-begin` then the `ocx.sync.fanout/1` document on stdout). Assertions:
the job item ends `succeeded`; for every Home slug, the Child's `$CODEX_HOME/opencodex-catalog.json` row and its
`models_cache.json` entry have equal `context_window`, `max_context_window`, `effective_context_window_percent` and
`auto_compact_token_limit`; no Child row is missing. Failing-first: before wp5 the scheduler import fails; the oracle half
also fails if any future projection clips a window.

Existing suites to keep green: `tests/lab/core-link-boundary.test.ts`, `tests/codex-integration/catalog-auto-refresh-*.test.ts`,
`tests/server/management-route-registry.test.ts`, `tests/cli/cli-capabilities*.test.ts`, `tests/ci-workflows/skill-ocx.test.ts`,
030's four files.

## 6. Docs and source-of-truth sync

- **structure/remote-link.md**: line :9 ("before executing `sync --expect-link` without a restart flag") gains "unless the
  Home's Child policy restarts idle Children's app-servers"; the 030 paragraph gains the scheduler (trigger slot, 5-minute
  poll, 60 s quiet period with a 5-minute ceiling, digest and idle rules, backoff) and the invariant "the Child-ops host is
  loaded and its timers exist only while the link listener owns its socket", bound to
  `tests/lab/link-child-ops-no-timer.test.ts` in `structure/manifest.json` invariants. Owned files: `src/link/` already;
  the `src/codex/catalog-auto-refresh.ts` slot is noted in `structure/catalog.md`, which already describes the
  auto-refresh scheduler. Run `bun run structure:index` and `bun run structure:check`.
- **docs-site** (M11 disclosure): `guides/remote-link.md` adds `### Automatic catalog fan-out and the Child policy` under 030's section.
  It states plainly that catalog fan-out is **on by default**: after a Home catalog change the Home opens a background SSH
  session to each eligible Child and runs its pinned sync, with no operator action; how to turn it off
  (`ocx link policy --catalog-fanout manual`); that it fixes the Child's catalog file but not a Codex app-server that is
  already running (badge "Codex restart needed", Restart Codex or `ocx sync --restart-children`, or the opt-in
  `--child-codex-restart app-server-when-idle`); and that automatic updates default to `auto-when-idle` (A1, opt-out
  `ocx link policy --updates notify|off`, completed by 070). Plus the defaults table, "a Home with no links runs none of this",
  `ocx link policy` examples. `reference/cli/lifecycle.md` adds `ocx link policy`. Same edits in fr, ja, ko,
  ru, tr, zh-cn, zh-tw (14 files). Validate with `cd docs-site && bun run build`.
- **skills/ocx**: `bun run skill:surface` (new `link policy` entry); `05_remote_hub.md` gains "Changing the Child policy needs
  the operator's request; reading it does not."
- **CLI help**: `registry.ts` link details and `LINK_USAGE`.
- **GUI**: none here; 060 renders the policy panel from `GET /api/link/children/policy`.

## 7. Enforcement bypass record (PLAN-BYPASS-NAMED-01)

| Guard | Tier | Executing surface | Known bypass | Residual risk | Wording |
|---|---|---|---|---|---|
| No host, no timer without links | Load-time + test | `optional-listeners.ts` dynamic import, `link-child-ops-no-timer.test.ts` | A future static import of `child-ops-host` from a core file (the test catches it) | None at runtime | "a Home without links loads none of the Child-ops code" |
| Digest rule for busy Children | Runtime heuristic | `evaluate` | The parity digest is the Child's own report and can be stale for up to a minute | A sync that applies settings could restart a busy Child's client runtime; the Child's apply-restart logic is unchanged | "avoids syncing a busy Child whose settings differ" |
| Idle signal | Runtime heuristic | 020 activity book | Sees only traffic relayed through this Home | A Child user typing in Codex without a running turn counts as idle | "idle means no model request relayed for N minutes" |
| Strict policy file | Runtime | `readChildPolicy` | Hand-editing to an invalid value | Defaults (fan-out on) apply silently except for the warning | "an invalid policy file falls back to defaults and is reported" |

## 8. Verifiers (PLAN-VERIFIER-REAL-01)

Run on 00680193cb, 2026-11-11 (the same runs recorded in 030 `8.1`); audit r1 refreshed facts on 61151e3457 where noted:

| Command | Result | Reads this phase's target? |
|---|---|---|
| `bun run typecheck` | exit 0, no type errors in 2,379 files | Yes after implementation (all `src/` and `tests/`) |
| `bun test tests/lab/core-link-boundary.test.ts tests/codex-integration/catalog-auto-refresh-client-fanout.test.ts` (part of a 5-file run) | exit 0, 46 pass / 0 fail across the 5 files | core-link-boundary walks the three core files' static imports (would catch a core → `src/link` edge); the client-fanout test exercises the tick this phase adds a slot to |
| `bun test tests/server/management-route-registry.test.ts` | exit 0, 29 pass | Yes: scans every `src/server/management/*.ts` |
| `bun run skill:surface:check` | exit 0 | Yes after regeneration |
| `bun run structure:check` | revision 1: exit 1 on 00680193cb (a pre-existing 603-line doc); audit r1 on 61151e3457: exit 0 | Yes; the PR must keep it at 0 |
| The seven new test files | new; fail before implementation | Yes |
| NOT RUN: `bun run privacy:scan`, `cd docs-site && bun run build`, `bun run test:changed`, full suite | PR gates / CI | — |

## 9. Acceptance criteria

1. On a Home with one connected, idle, Home-initiated Child whose last catalog pull predates a catalog change, a changed
   auto-refresh tick produces exactly one `sync` job (`trigger:"auto"`, no restart) 60 s later (scheduler test, fake clock).
2. A dashboard model edit that changes the served catalog is picked up by the 5-minute poll and leads to the same job.
3. A busy Child with a different settings digest is skipped and synced at the first poll after it becomes idle.
4. `ocx link policy --catalog-fanout manual` stops automatic jobs from the next evaluation; `auto` resumes them.
5. A Home with no links never imports `src/link/child-ops-host.ts` and creates none of its timers; adding the first link
   starts it, removing the last stops it (no-timer test).
6. After the automatic sync in the oracle test, every Home slug's four context fields equal the Child's catalog and
   `models_cache.json` values.
7. A Child below 2.93 is attempted once, reports `owner-action`, and is not retried until it reports another version.
8. `GET /api/link/children/policy` on a fresh Home answers `catalogFanout:"auto"`, `childCodexRestart:"never"`,
   `updates:"auto-when-idle"`, `idleAfterMs:600000`, `warning:null`.

## 10. Security review notes, risks and Windows

- **Review trigger:** a background job that opens SSH sessions to Children by default, and a new mutating route. The
  sessions are the existing pinned sync with no restart (or app-server only when the operator chose it): no new command,
  credential or trust root. The route is `either`-authorized like the other link routes; Tailscale identity sessions are
  refused.
- **Risks:** (1) Default-on SSH activity: one session per eligible Child per catalog change, bounded by the quiet period,
  backoff and per-link lock; operators can switch it off. (2) A sync that applies changed Home settings may restart the
  Child's client runtime (OCX-6); the digest rule keeps that to idle Children. (3) A running Codex app-server keeps its old
  catalog until restarted (r1 layer b); fan-out fixes the file, `restart-codex` (030) or `app-server-when-idle` fixes the
  process, and 080 makes the state visible. (4) The engine env runs as the Home user and reads only link-owned files.
- **Windows:** fan-out works for Windows Children (the pinned sync supports them); `app-server-when-idle` is reported
  `restart unsupported` there (030 `runSyncItem`). On a Windows Home the scheduler uses the same `SshRunner`; the policy
  file inherits `atomicWriteFile`'s Windows ACL hardening.

