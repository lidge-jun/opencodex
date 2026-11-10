# 020 — Signals and visibility (wp2): activity, catalog freshness, observe, ?children=1, ocx link check

> **Revision 2 (audit r1).** Folds H1 (server and cli tests go to the `layout-clients.json` shard, 000 "Test
> registration rule"), H5 (`validateChildJob` is tolerant from this first CLI that reads job documents),
> M6 (`ChildOp` imported from 010's `child-observations.ts`; `ObserveOutcome.probe` carries the plan so 030 no
> longer patches this module; `link-child-ops-routes.test.ts` is NEW here and MODIFY in 030), M9 (`probe`
> carries the Child clock) and L15 (the observe op mutates no install but is not side-effect-free everywhere).

> **Revision 4 (CodeRabbit on #8500).** Folds 4529521959 (freshness compares the etag a Child was served or synced
> with the current etag; time is display only, so a restored file with an old mtime still reads `behind`) and
> 4529521968 (a GET proves a fetch only: the pull recorder stores the etag served once the body is fully written, and
> the wp5 fan-out decides eligibility from `catalogSyncedEtag`, which 030 writes only when a Home-run sync reports
> `synced`). The routes module exports `catalogRevisionForRoutes()`, the lazy production wiring of
> `createCatalogRevisionMonitor` that 030's env reuses.

- **Work phase:** wp2. **Depends on:** wp1 (`010_foundations.md`: `remoteUpdatePlanArgv`,
  `classifyUpdatePlanProbe`, `child-observations.ts`). **Class:** C4: one new POST route that runs a
  remote command over the pinned SSH channel, and a new opt-in status projection.
- **Outcome:** the Home knows, per link, whether a model request is running and when the last one ended
  (D5); when each Child last pulled `/v1/catalog` and when the Home's catalog last changed (D6); and,
  after one SSH call, the Child's installed version, install kind and update route (D3).
  `GET /api/link/status?children=1` adds a `child` block to every row on a Home (D8). `ocx link status`
  asks for it and validates it; `ocx link check (--link-id <id> | --all)` runs the observe operation.
  Older CLIs and the dashboard see identical rows (no query, no field).
- **IN:** `src/link/child-activity.ts`, `src/link/child-catalog-freshness.ts`, `src/link/child-observe.ts`,
  a minimal `src/link/child-ops-engine.ts` (job model and observe only), `link-child-ops-routes.ts`
  (`POST /api/link/children/operations` with `op:"observe"`, `GET /api/link/children/jobs/{jobId}`),
  relay/listener wiring, the projection attacher, CLI validation and verb, capability, skill surface, docs.
- **OUT:** sync / restart-codex / update runners, `DELETE` 409, policy, timers and fan-out (wp3, wp5);
  the GUI (wp6, which starts sending `?children=1`); the Child Codex-state report (wp8; `child.codex` is
  `null` until then); widening the local-control socket allowlist (`local-control-listener.ts:41`).

## Decisions and deviations from 004

1. **Observe runs through a minimal job engine (decided here).** Two options were weighed: a synchronous
   `POST /api/link/{id}/check` (no engine), or the D14 job resource restricted to `op:"observe"`. The job
   resource wins: the route, its `ocx.link.child-job/1` document and the CLI polling contract are the
   ones wp3 keeps, so wp3 adds runners instead of retiring a route (a route removal is a public contract
   change, `route-registry.ts` and the capability ratchet in `tests/cli/cli-capabilities.test.ts:200-262`),
   and an observe of 20 Children (one SSH session each, up to 60 s) cannot hold an HTTP request open.
   wp2's engine has only the D11 job model, per-link lock, concurrency 3, 32-job / 1-hour retention and the
   observe runner. **030 must extend this file, not create it;** any other `op` answers `400 invalid_body` in wp2.
2. **No timer in wp2 (deviation from D6).** D6 keeps the Home catalog revision with a 5-minute poll plus an
   auto-refresh hook. The verdict is only shown on a status read, so wp2 checks the revision on each
   `?children=1` read: `lstat` the catalog file, hash only when size or mtime changed, persist only when the
   etag changed. The hook beside `setCatalogAutoRefreshClientFanout` (`src/codex/catalog-auto-refresh.ts:53-58`)
   and the quiet-period trigger belong to wp5, which needs them for fan-out. A Home without links runs none
   of this: the attacher runs only for `?children=1` on `role === "home"`.
3. **`changedAt` is the file's mtime, not "now", and it is display only.** When the etag changes,
   `changedAt = min(now, mtimeMs)`. Revision 4 (4529521959): no verdict compares times. A file restored with an
   older preserved mtime changes the etag but not the order of times, so the verdict compares etags instead.
4. **What counts as activity.** Every POST that `linkRouteAllowed` admits (`src/link/routes.ts:23-29`)
   except `/v1/messages/count_tokens`. GET/HEAD (`/v1/catalog`, `/readyz`, `/v1/usage`, artifacts), the
   management relay and the parity POST never count (they are not admitted by `linkRouteAllowed` alone,
   `optional-listeners.ts:103-104`), matching D5.

## File change map

| Path | Kind | Purpose |
| --- | --- | --- |
| src/link/child-activity.ts | NEW | per-link in-flight count and last data end |
| src/link/child-catalog-freshness.ts | NEW | pull recorder, revision monitor, verdict |
| src/link/child-observe.ts | NEW | the observe runner (D3) |
| src/link/child-ops-engine.ts | NEW | job registry, per-link lock, observe dispatch (030 extends) |
| src/link/status-projection.ts | MODIFY (after :83) | `LinkChildOpsStatus` type, `attachLinkChildOps` |
| src/server/index/link-relay-sessions.ts | MODIFY (:19-27, :103-120) | `activity` option, paired with the drain lease |
| src/server/index/link-listener.ts | MODIFY (:51-63, :85, :117, :227) | lifecycle-owned activity book, `linkActivity` |
| src/server/index/optional-listeners.ts | MODIFY (:36-59, :87, :106-108, :126, :166) | `linkActivity`, catalog pull recorder subscription |
| src/server/management/context.ts | MODIFY (:162) | listener pick gains `linkActivity`, `catalogPulledAt` |
| src/server/management/link-route-state.ts | MODIFY (:31-47) | optional `linkActivity`/`catalogPulledAt`; state gains `childOps`, `catalogRevision` |
| src/server/management/link-child-ops-routes.ts | NEW | two job routes |
| src/server/management/link-routes.ts | MODIFY (:309-314, :347) | `?children=1` attach, delegating branch |
| src/server/management/route-registry.ts | MODIFY (after :439) | two routes |
| src/cli/link-status-child.ts | NEW | `validateChildOps` for status rows |
| src/cli/link-child-ops.ts | NEW | `runLinkCheck`, job document validator, poller |
| src/cli/link.ts | MODIFY (:36-47, :159, :178, :311, :385-396) | usage, row key, query, switch arm |
| src/cli/capabilities-access-remote.ts | MODIFY (append) | `link check` capability |
| src/cli/registry.ts | MODIFY (:154-163) | link usage and details |
| src/cli/help.ts | MODIFY (:70) | `check` in the verb list |
| skills/ocx/references/* | MODIFY | regenerated surface, hand pages |
| docs and structure | MODIFY | see "Docs" |

None of these files is near its cap: `link-routes.ts` 363, `link.ts` 446, `optional-listeners.ts` 174,
`link-listener.ts` 244, `status-projection.ts` 177, `capabilities-access-remote.ts` 168, `registry.ts` 861.
`src/cli/index.ts`, `src/server/index.ts` and `serve-options.ts` are untouched (F4).

## Changes

### src/link/child-activity.ts (NEW, pure, no timers)

```ts
import { linkRouteAllowed } from "./routes";

export const DEFAULT_IDLE_AFTER_MS = 600_000;
export interface LinkActivitySnapshot { inFlight: number; lastDataEndAt: number | null; observedSince: number }
export interface LinkActivity {
  /** null = a legacy key admission without a relay session; it counts against every link. */
  begin(linkId: string | null): () => void;
  snapshot(linkId: string, now: number): LinkActivitySnapshot;
}
/** Model traffic only: a POST the data-plane table admits, except token counting. */
export function linkActivityCounts(url: URL, req: Request): boolean {
  return req.method === "POST" && url.pathname !== "/v1/messages/count_tokens" && linkRouteAllowed(url, req);
}
export function isLinkIdle(s: LinkActivitySnapshot, now: number, idleAfterMs = DEFAULT_IDLE_AFTER_MS): boolean {
  return s.inFlight === 0 && now - (s.lastDataEndAt ?? s.observedSince) >= idleAfterMs;
}
export function createLinkActivity(deps: { now?: () => number } = {}): LinkActivity {
  const now = deps.now ?? Date.now;
  const observedSince = now();
  const perLink = new Map<string, { inFlight: number; lastDataEndAt: number | null }>();
  let legacy = { inFlight: 0, lastDataEndAt: null as number | null };
  return {
    begin(linkId) {
      const entry = linkId === null ? legacy : (perLink.get(linkId) ?? perLink.set(linkId, { inFlight: 0, lastDataEndAt: null }).get(linkId)!);
      entry.inFlight += 1;
      let ended = false;
      return () => { if (ended) return; ended = true; entry.inFlight -= 1; entry.lastDataEndAt = now(); };
    },
    snapshot(linkId, _at) {
      const entry = perLink.get(linkId);
      const ends = [entry?.lastDataEndAt ?? null, legacy.lastDataEndAt].filter((v): v is number => v !== null);
      return { inFlight: (entry?.inFlight ?? 0) + legacy.inFlight, lastDataEndAt: ends.length ? Math.max(...ends) : null, observedSince };
    },
  };
}
```

Memory: one small entry per link id that ever relayed; links are bounded by `links.json`. wp3 may add
`forget(linkId)` on removal.

### src/server/index/link-relay-sessions.ts

Before (`:19-27` options; `:103-120`):

```ts
  connectionGeneration?: (linkId: string) => string | undefined;
}
...
      const nonce = req.headers.get(LINK_RELAY_SESSION_HEADER);
      let release: () => void;
      if (nonce !== null) {
        const session = consume(nonce);
        if (!session) return refuse();
        release = session.release;
        ...
      } else {
        if (closing) return new Response(null, { status: 503 });
        release = acquire();
      }
```

After:

```ts
  connectionGeneration?: (linkId: string) => string | undefined;
  /** Per-link model-traffic book owned by the listener lifecycle (D5); survives rebinds. */
  activity?: import("../../link/child-activity").LinkActivity;
}
...
      const nonce = req.headers.get(LINK_RELAY_SESSION_HEADER);
      let release: () => void;
      let activityLink: string | null = null;
      if (nonce !== null) {
        const session = consume(nonce);
        if (!session) return refuse();
        release = session.release;
        activityLink = session.linkId;
        ...unchanged checks...
      } else {
        if (closing) return new Response(null, { status: 503 });
        release = acquire();
      }
      if (options.activity && linkActivityCounts(url, req)) {
        const lease = release, end = options.activity.begin(activityLink);
        release = () => { end(); lease(); };   // both halves are idempotent
      }
```

The wrapped `release` is the one every path already calls: body end, cancel, abort before headers,
HEAD/no body and the dispatch throw (`:123-155`), so an aborted stream ends the activity too. The check
runs after session validation, so a refused request never counts.

### src/server/index/link-listener.ts and optional-listeners.ts

`link-listener.ts`: `const activity = createLinkActivity();` beside `peers` (`:85`); `:117` passes
`{ peers, activity, connectionGeneration, fingerprints }`; the interface (`:51-63`) and return object
(`:227`) gain `linkActivity(linkId: string, now: number): LinkActivitySnapshot`.

`optional-listeners.ts`: `OptionalListenerSet` gains `linkActivity` and `catalogPulledAt(linkId): number | null`.
In `start`, next to the supervisor subscription (`:126`):

```ts
      catalogPulls ??= createCatalogPullRecorder({ storePath: linkDeps.storePath });
      unregisterCatalogPulls ??= linkListener.onAuthenticatedCatalog((apiKeyId, etag) => catalogPulls!.record(apiKeyId, etag));
```

and `stop` (`:166`) unregisters it and calls `catalogPulls?.flush()`. `onAuthenticatedCatalog` fires only for a
configured link key on the hub-link ingress (`serve-options.ts:391-393`), so a Home without links records nothing.
Revision 4: it fires when the response body has been written in full, never on admission, and passes the
`catalogEtag` of the bytes served (`src/server/catalog-download.ts:40-42`). An aborted body records nothing. That
still proves only a fetch: a Child whose sync fails after fetching is shown as having pulled, and that is why wp5's
fan-out does not use this record (050 `behind`).

### src/link/child-catalog-freshness.ts (NEW)

```ts
export interface CatalogPull { at: number; etag: string }
export interface CatalogPullRecorder { record(apiKeyId: string, etag: string): void; pulled(linkId: string): CatalogPull | null;
  /** Kept for 050's binding and the status row; equals pulled(linkId)?.at ?? null. */
  pulledAt(linkId: string): number | null; flush(): void }
/** keyId → linkId through links.json; memory always, file at most once per link per 30 s. */
export function createCatalogPullRecorder(deps: { storePath?: string; now?: () => number; debounceMs?: number;
  /** Persists catalogPulledAt and catalogPulledEtag (010 cache fields). */
  write?: (linkId: string, pull: CatalogPull) => void }): CatalogPullRecorder;

export interface CatalogRevision { etag: string; changedAt: number }
export interface CatalogRevisionMonitor { current(): CatalogRevision | null }
/** lstat → (size, mtime) cache → hash on change → persist `homeCatalog` in child-observations.json when the etag moved. */
export function createCatalogRevisionMonitor(deps: { catalogPath: () => string; read: (path: string) => string | null;
  load: () => CatalogRevision | null; persist: (revision: CatalogRevision) => void; now?: () => number }): CatalogRevisionMonitor;

export type CatalogState = "current" | "behind" | "unknown";
/** Revision 4: etag equality, never time order. syncedEtag is 030's catalogSyncedEtag (a Home-run sync that synced). */
export function catalogVerdict(pulledEtag: string | null, syncedEtag: string | null, revision: CatalogRevision | null): CatalogState {
  if (revision === null || (pulledEtag === null && syncedEtag === null)) return "unknown";
  return pulledEtag === revision.etag || syncedEtag === revision.etag ? "current" : "behind";
}
```

Production wiring (in the routes module, lazily): `catalogPath` = `readCodexCatalogPath()` and `read` =
`JSON.stringify(readCatalog(path))`, the exact bytes `/v1/catalog` serves (`src/server/catalog-download.ts:55-62`),
hashed with `catalogEtag` (`:40-42`). A file that cannot be read gives `current() === null` (`unknown`). The
first observation after an upgrade has no stored revision: it stores `{etag, changedAt: mtimeMs}`.
Limitation (004 assumption 5): an effort-gate refusal (`src/client/connect.ts:932`) still pulls the catalog
and so reads as `current`; wp8's report closes that.

### src/link/child-observe.ts (NEW)

```ts
export interface ObserveDeps {
  runner: Pick<SshRunner, "run">; knownHostsFile: string; homeVersion: string;
  peer: (linkId: string) => LinkPeerEntry; platformOf: (record: LinkRecord) => Promise<"posix" | "windows">;
  inspect: typeof inspectRemoteChildRuntime; now: () => Date;
}
/** Set only for a parsed plan. childNowMs is the Child's clock from the gate (010, M9); startedAt is the Home's clock when
 *  the probe was sent; platform is the one step 3 resolved, so the wp3 update runner never probes it again. */
export interface ObserveProbe { classification: PlanClassification; childNowMs: number | null; startedAt: number; platform: "posix" | "windows" }
export interface ObserveOutcome { state: "succeeded" | "owner-action" | "unsupported" | "offline" | "failed"; reason: string | null;
  observation: ChildObservation | null; probe: ObserveProbe | null }
export async function observeChild(record: LinkRecord, deps: ObserveDeps): Promise<ObserveOutcome>;
```

Order (D3, with 010's ephemeral refusal):

1. `direction === "client-initiated"` → `unsupported`/`child-initiated`; observation `{source:"peer", installedVersion: peer version, installKind:"unknown", updateRoute:"none", updateReason:"child-initiated"}`. No SSH.
2. `childKind === "ephemeral"` → `succeeded`; `{source:"peer", installedVersion:null, installKind:"ocx-child", updateRoute:"replant", updateReason:"ocx-child"}` (its version is a protocol constant, D10). No SSH.
3. Platform: `record.remotePlatform ?? platformOf(record)` (`requireRemotePlatform`, the reconnect/DELETE template at `link-routes.ts:231-232`); a throw → `offline`/`platform-unknown`.
4. `runner.run(buildExecArgv({alias, knownHostsFile, argv: remoteUpdatePlanArgv(homeVersion, platform)}), {timeoutMs: 60_000, maxOutputBytes: 65_536})` → `classifyUpdatePlanProbe(result, {homeVersion, desktopUpdateRequest: peer features include "desktop-update-request/1"})`.
   - `plan` → `succeeded`; observation from the classification, `source:"plan"`, `targetVersion: homeVersion`;
     `probe = { classification, childNowMs: verdict.childNowMs, startedAt, platform }` where `startedAt = deps.now().getTime()`
     read just before `runner.run`. Every other branch returns `probe: null`. The wp3 update runner reads the plan
     token, route, installer and Child clock from `probe`; observe itself ignores it.
   - `ephemeral` → as step 2 (a record without `childKind` whose Child runs `ocx-child`).
   - `legacy` → `owner-action`/`legacy-ocx`; installed version from `inspect(...)` on POSIX (one more SSH call, read-only, `remote-plant.ts:110-115`), from the peer report on Windows; `installKind:"unknown"`, `updateRoute:"owner-action"`.
   - `offline` → `offline`/`ssh-failed`, observation unchanged. `failed` → `failed` with its reason. A runner throw → `offline`/`ssh-error`.
5. The engine writes the observation with `updateChildObservations` (wp1), keeping `catalogPulledAt`,
   `lastOperation` and `suppressedTarget` from the previous entry.

### src/link/child-ops-engine.ts (NEW, observe only; 030 extends)

```ts
import type { ChildOp, ChildOperationSummary } from "./child-observations";    // ChildOp is declared once, in 010 (000 "Canonical names"); wp2 admits "observe" only
export type ChildItemState = "queued" | "running" | "succeeded" | "up-to-date" | "busy" | "offline" | "refused"
  | "owner-action" | "unsupported" | "failed" | "uncertain";
export interface ChildJobItem { linkId: string; alias: string; state: ChildItemState; reason: string | null; hint?: string;
  fromVersion?: string; toVersion?: string; startedAt: string | null; finishedAt: string | null }
export interface ChildJob { schema: "ocx.link.child-job/1"; jobId: string; op: ChildOp; trigger: "manual" | "auto";
  restart: "none" | "app-server" | "codex"; state: "queued" | "running" | "done"; createdAt: string; finishedAt: string | null; items: ChildJobItem[] }
export type SubmitResult = { ok: true; job: ChildJob } | { ok: false; code: "link_not_found" | "link_operation_in_progress" | "no_eligible_links" };
export interface ChildOpsEngine {
  submit(request: { op: "observe"; linkIds: readonly string[] | "all"; trigger: "manual" | "auto" }): SubmitResult;
  job(jobId: string): ChildJob | undefined;                         // structuredClone snapshot
  activeJob(linkId: string): { jobId: string; op: ChildOp; state: "queued" | "running" } | null;
}
export function createChildOpsEngine(deps: { readStore: () => LinkStore; observe: (record: LinkRecord) => Promise<ObserveOutcome>;
  writeObservation: (linkId: string, outcome: ObserveOutcome, summary: ChildOperationSummary) => void;
  now?: () => Date; jobId?: () => string; concurrency?: number }): ChildOpsEngine;
```

Rules (D11): `jobId` is `"ljob_" + 16 hex` from `randomBytes(8)`; one engine-wide `Map<linkId, jobId>`; an item whose
link is held becomes `busy`/`link-operation-in-progress` without SSH, and a single-link request whose link is held
answers `link_operation_in_progress`; `"all"` expands to every link in `links.json` (client-initiated rows give an
`unsupported` item without SSH, so the operator sees them); concurrency 3; the record is re-read before SSH and a
vanished link ends `refused`/`link-removed`; finished jobs are kept 1 hour, at most 32; every finished item writes
`lastOperation`. Items carry no remote text (D11 privacy). A Home restart loses the in-memory jobs only.

### src/server/management/link-child-ops-routes.ts (NEW) and link-routes.ts

```ts
export async function handleLinkChildOpsRoutes(ctx: ManagementContext, state: LinkRouteState): Promise<Response | null>;
// POST /api/link/children/operations  auth "either"; body exactly {op:"observe", linkIds: string[] (1..64 valid ids) | "all"}
//   → 202 {job}; 400 invalid_body (any other op or key, wp2); 404 link_not_found; 409 link_operation_in_progress / no_eligible_links
// GET  /api/link/children/jobs/{jobId}  auth "either"; jobId /^ljob_[0-9a-f]{16}$/ → 200 {job}; 400 invalid_job_id; 404 job_not_found
```

The engine is created lazily per `LinkRouteState` (`state.childOps ??= createChildOpsEngine(...)`) with the real
`createSshRunner` / `ctx.deps.sshRunner` seam (`link-route-state.ts:103-117`), `linkKnownHostsPath()`, `packageVersion`
and `state.listener.peerObservation`. In `handleLinkRoutes`, before the reconnect matcher (`link-routes.ts:347`):

```ts
  if (path.startsWith("/api/link/children/")) {
    const { handleLinkChildOpsRoutes } = await import("./link-child-ops-routes");
    return handleLinkChildOpsRoutes(ctx, state);
  }
```

The `DELETE` branch (`:355`) would otherwise read `/api/link/children/...` as a link id; the delegation comes first,
and a `DELETE /api/link/children/x` answers 404 from the new module. Status (`:313-314`) gains, after diagnostics:

```ts
    if (url.searchParams.get("children") === "1" && dto.role === "home") {
      const { attachLinkChildOpsForState } = await import("./link-child-ops-routes");
      attachLinkChildOpsForState(dto, state, store);
    }
```

`route-registry.ts` after `:439`: `{ method: "POST", path: "/api/link/children/operations", module: "server/management/link-child-ops-routes", mutates: true }` and
`{ method: "GET", path: "/api/link/children/jobs/{jobId}", module: "server/management/link-child-ops-routes", mutates: false, mechanism: "regex" }`.

### src/link/status-projection.ts

```ts
export interface LinkChildOpsStatus {
  homeVersion: string; runningVersion: string | null; installedVersion: string | null; installKind: InstallKind | null;
  versionSkew: "same" | "behind" | "ahead" | "unknown";
  update: { route: UpdateRoute | null; reason: string | null; observedAt: string | null };
  catalog: { state: CatalogState; pulledAt: number | null; homeChangedAt: number | null };
  codex: null;                                    // wp8 widens to { appServers, reportedAt } | null
  activity: { idle: boolean; inFlight: number; lastDataEndAt: number | null };
  activeJob: { jobId: string; op: ChildOp; state: "queued" | "running" } | null;
  lastOperation: ChildOperationSummary | null;
}
export interface LinkChildOpsSources {
  homeVersion: string; now: number; idleAfterMs: number;
  peerVersion(linkId: string): string | null; observation(linkId: string): ChildObservation | null;
  activity(linkId: string): LinkActivitySnapshot | null; catalogPulledAt(linkId: string): number | null;
  revision: CatalogRevision | null; activeJob(linkId: string): LinkChildOpsStatus["activeJob"];
}
/** Home rows only. Skew compares installed ?? running with homeVersion; ocx-child and unparsable versions are "unknown". */
export function attachLinkChildOps(dto: LinkStatusDto, sources: LinkChildOpsSources): LinkStatusDto;
```

`LinkStatusDto.links[]` gains `child?: LinkChildOpsStatus`. `catalogPulledAt` is the larger of the recorder's memory
value and the cached file value. `activity` absent (no listener method) reads `{ idle: false, inFlight: 0, lastDataEndAt: null }`:
unknown is never idle.

### CLI: src/cli/link-status-child.ts, src/cli/link-child-ops.ts, src/cli/link.ts

`link.ts` before/after:

```ts
// :159 before
assertKeys(candidate, [...], [...PARITY_KEYS, "peer", "tunnel", "childKind"], `link ${index}`);
// after
assertKeys(candidate, [...], [...PARITY_KEYS, "peer", "tunnel", "childKind", "child"], `link ${index}`);
// :179 after the tunnel spread
      ...(candidate.child !== undefined ? { child: validateChildOps(candidate.child, index) } : {}),
// :311 before → after
linkRequest<unknown>("/api/link/status?compatibility=1&diagnostics=1", ...)
linkRequest<unknown>("/api/link/status?compatibility=1&diagnostics=1&children=1", ...)
// LINK_USAGE (:44) adds:   ocx link check (--link-id <id> | --all) [--no-wait] [--json]
// switch (:395) adds:      else if (command === "check") await runLinkCheck(args, deps, linkRequest, LINK_USAGE);
// :396 message lists "check"
```

`validateChildOps(value, index): LinkChildOpsStatus` type-checks every key it knows (enums, nullable strings,
non-negative numbers) and ignores unknown keys inside `child`, keeping only the known ones in its result. `codex`
is accepted as `null` or as an object from the start (known fields type-checked, unknown ignored). Reason
(architect reflection G1): `dev` releases every few days, so a CLI released between wp2 and wp8 must keep
reading a later Home's `child` block (`childBuild`, `codex` object from 080) through both `ocx link status`
and the `ocx sync` fan-out status read. Test: a row whose `child` carries an extra key and a `codex` object
validates and drops the extra key; a known key with the wrong type is still rejected. An older Home omits `child`; `validateStatus` is shared with
`readHomeLinkStatus` (`src/cli/sync-link-status.ts:35`), which keeps plain `/api/link/status` in wp2 (wp4 changes it).

`runLinkCheck`: `--link-id` (valid id, repeatable) or `--all`, not both (usage, exit 2); POST `{op:"observe", linkIds}`;
unless `--no-wait`, GET the job every 2 s until `state === "done"` or a deadline of `ceil(items/3) × 75 s + 30 s`
(then print the job and exit 1, `job_still_running`). It always prints the final `ocx.link.child-job/1` JSON (link
verbs print JSON, `link.ts:312, :382`). Exit (D15): 0 if every item `succeeded` or `up-to-date`; 6 if any
`busy`/`offline`/`refused`/`owner-action`/`unsupported`; 1 for `failed`, `uncertain` or an API error; a 404 from an
older Home prints "This Home does not support Child operations; update the Home." and exits 4, through the same
`runCliAction` wrapper the wp3 verbs use (404 → 4, 409 → 5; architect reflection G2).

`validateChildJob(value): ChildJob` (this file, wp2) is tolerant from its first release, with the code 030 2.8 shows:
known keys are type-checked, unknown keys at job, item, `sync` and `restart` level are ignored, and an unknown
string in an enum field (`op`, `trigger`, job `state`, item `state`, `reason`, `sync.state`, `restart.outcome`) is
passed through for display. A wp2 CLI therefore keeps polling a wp3+ Home whose items carry `sync` and `restart`,
and a wp3–wp7 CLI keeps working against a wp8+ Home whose `restart.outcome` gains values (G1, audit H5).

Capability (`capabilities-access-remote.ts`): `command: ["link","check"]`, routes the two job routes, flags `--link-id`
(string, repeatable), `--all`, `--no-wait`, `--json`, `mutates: true` (it writes the Home's observation cache and runs
a command on the Child), `json: "payload"`, details: changes no install on the Child (it runs `update --plan`, which only
computes; an npm Child without a census pair runs it through its `ocx` shim, so the launcher's ordinary bootstrap runs
first, as for any pinned sync), one SSH call per Child (two for a Child
older than 2.97.0), Home-initiated links only, loopback admin authority, exit codes. `registry.ts:154-163` adds
`"Check: ocx link check (--link-id <id> | --all) [--no-wait] [--json]"` and `check` in `usage`; `help.ts:70` adds `check`.
No contract string yet: `link.child-ops/1` is claimed by wp3 when all ops exist.

## Field chains

| Field | Created | Serialized | Deserialized | Consumers |
| --- | --- | --- | --- | --- |
| activity `inFlight`/`lastDataEndAt` | `createLinkActivity` via relay `dispatch` | `child.activity` | `validateChildOps`; GUI wp6 | wp3 restart idle gate, wp4 `restart-skipped:link-active`, wp5/wp7 schedulers |
| `catalogPulledAt`, `catalogPulledEtag` | pull recorder (body fully written) | memory + `child-observations.json` | wp1 reader | `child.catalog.pulledAt`, verdict (etag) |
| `catalogSyncedEtag` (Revision 4) | 030 `pinnedSync` on `synced` | `child-observations.json` | wp1 reader | verdict, wp5 fan-out eligibility |
| `homeCatalog` | revision monitor | file header | wp1 reader | `child.catalog.homeChangedAt`, verdict, wp5 trigger |
| observation fields | `observeChild` → engine | file | wp1 reader | `child.installedVersion/installKind/update`, wp3 update item, wp7 sweep |
| `versionSkew` | `attachLinkChildOps` | `child.versionSkew` | `validateChildOps` | CLI JSON, GUI badge (wp6), wp7 "Update available" |
| `activeJob` | engine | `child.activeJob` | `validateChildOps` | wp4 fan-out `child-busy` skip, GUI |
| `child.codex` | N/A until wp8 (always `null`) | `null` | `codex === null` | wp8 |
| job document | engine | `{job}` responses | `validateChildJob` in `link-child-ops.ts` | CLI, GUI wp6 |

## Tests

New files (all fail before implementation: their imports or routes do not exist):

- `tests/clients/link-child-activity.test.ts` (clients): `counts a relayed model POST until its body ends` — real
  `createLinkRelaySessions` with a fake dispatch streaming a body; snapshot `inFlight 1` mid-stream, `0` and
  `lastDataEndAt` set after the reader finishes; `abort ends the activity` (abort the request signal before headers);
  `catalog, readyz and count_tokens do not count`; `legacy admission counts against every link`; `idle threshold`
  with a fake clock (`observedSince` keeps a fresh Home non-idle for 600 s).
- `tests/clients/link-child-catalog-freshness.test.ts` (clients): `records pulls by key id` with a temp store;
  `writes at most once per 30 s`; `monitor hashes only on size/mtime change` (spy `read`); `changedAt is the
  mtime`; `verdicts current/behind/unknown`; `unreadable catalog is unknown`. Revision 4: `restored file with an older
  mtime reads behind` (4529521959: etag moves, mtime goes back, a pull of the old etag is `behind`); `aborted body
  records nothing` and `recorded pull carries the served etag` (4529521968).
- `tests/clients/link-child-observe.test.ts` (clients), fake `runner.run` returning scripted framed output:
  `client-initiated and ephemeral never call SSH`; `plan up-to-date, orchestrated, desktop-request (peer feature)
  and launcher-bypassed rows`; `exit 121 lacks marker → inspect (POSIX) or peer (Windows) and owner-action`;
  `255 → offline`; `platform discovery throw → offline`; `runner throw → offline`.
- `tests/server/link-child-ops-routes.test.ts` (server): sibling of the 1137-line
  `link-management-routes.test.ts`; uses the same `ctx.deps` seams. `principal matrix` (gui session, admin
  loopback, Tailscale 403, no auth 401); `body validation` (extra key, `op:"sync"` in wp2, 65 ids, bad id) → 400;
  `unknown link → 404`; `second job on a held link → 409`; `job polling to done`; `?children=1 adds child to Home
  rows only and nothing without the query` (key-by-key equality with today's document); `DELETE /api/link/children/x
  is 404, not a link removal`.
- `tests/cli/cli-link-check.test.ts` (cli): `usage errors exit 2`; `exit mapping 0/6/1` from fake job documents;
  `--no-wait prints the queued job`; `old Home 404 message`; `status validates child and accepts its absence`;
  `status sends children=1` (captured URL).

Registration (000 "Test registration rule"): all five files in `scripts/test-layout/layout-clients.json` with their
domains (`"link-child-ops-routes.test.ts": "server"`, `"cli-link-check.test.ts": "cli"`, the three `clients`
files), one line each before the closing `}`, and the same five lines in `tests/fixtures/test-layout-expected.json`.
Nothing goes into `layout.json` (1998 lines; the file-size ratchet fails at 2000). This phase owns
`tests/server/link-child-ops-routes.test.ts` (NEW); 030 and 050 add cases to it (MODIFY) and do not register it again.
`cli-link-check.test.ts` adds `job validator tolerance`: a job with an extra top-level key, an item with
`sync`/`restart` objects and an unknown `restart.outcome` string validates and renders; a known key with the
wrong type (`items: {}`, `jobId: 7`) still throws.
Existing files that must stay green: `tests/server/link-management-routes.test.ts`,
`tests/clients/link-status-projection.test.ts`, `tests/clients/link-peer-compatibility.test.ts`,
`tests/cli/cli-link.test.ts`, `tests/server/management-route-registry.test.ts`, `tests/cli/cli-capabilities.test.ts`,
`tests/ci-workflows/skill-ocx.test.ts`, `tests/clients/link-relay-bound-transport.test.ts`, `tests/lab/core-link-boundary.test.ts`.

## Docs and source-of-truth sync

- `structure/remote-link.md`: "Home and Child version report" (`:116-127`) gets the `?children=1` block and its
  sources; "Tunnels, management and CLI" (`:67-71`) the two job routes and `ocx link check`; "Dashboard
  admission" (`:55`) adds both routes to the list. Add `src/server/management/link-child-ops-routes.ts`,
  `src/cli/link-child-ops.ts` and `src/cli/link-status-child.ts` to the `remote-link.md` `documents` list in
  `structure/manifest.json`, then `bun run structure:index` (files staged first, `structure/AGENTS.md`).
- `docs-site/src/content/docs/guides/remote-link.md` ("Link status" `:66`, "CLI reference" `:137-148`, "Home and
  Child versions" `:162-180`) and its `fr, ja, ko, ru, tr, zh-cn, zh-tw` copies; `reference/cli/lifecycle.md` link
  status section (`:1336-1404`) and the same 7 locales: `ocx link check`, the `child` block, the 60 s budget, POSIX
  vs Windows legacy detection, "Home-initiated links only".
- `skills/ocx`: `bun run skill:surface` regenerates `references/01_surface_access-remote.md` and
  `01_management_surface.md`; hand-edit `05_remote_hub.md`, `02_json_shapes.md` (job document, `child` block),
  `04_failure_semantics.md` (exit 6 partial), then `bun run skill:surface:check`.
- GUI: none in wp2 (no `gui/` file, so no locale or screenshot work).

## Enforcement bypass record

| Guard | Tier | Executing surface | Known bypass | Residual risk / wording |
| --- | --- | --- | --- | --- |
| activity counts only relayed model POSTs | runtime | Home relay | a Child user typing in Codex sends nothing until submit | "idle means no running relayed turn" |
| per-link job lock | runtime, in memory | Home engine | a second Home process on the same config (not supported) | lost on Home restart; wording "one operation per link per Home process" |
| route auth "either" | runtime | management API | any local process with the loopback bootstrap (casual-path, `structure/remote-link.md:55`) | same as probe/apply today |
| `?children=1` opt-in | runtime | status route | none | — |

## Verifiers

| Command | Today | Reads this phase's target |
| --- | --- | --- |
| `bun test tests/server/link-management-routes.test.ts tests/clients/link-status-projection.test.ts tests/clients/link-peer-compatibility.test.ts tests/cli/cli-link.test.ts tests/server/management-route-registry.test.ts tests/cli/cli-capabilities.test.ts tests/ci-workflows/skill-ocx.test.ts tests/clients/link-relay-bound-transport.test.ts` | ran 2026-11-11: 156 pass, 0 fail, exit 0 | yes: `link-routes.ts`, `status-projection.ts`, `link.ts`, `route-registry.ts`, capabilities, skills, relay sessions |
| the five new test files | new; fail before implementation | new modules and routes |
| `bun run typecheck` | ran: exit 0 (2,379 files) | all `src/` |
| `bun run skill:surface:check` | ran: exit 0, "All 9 generated management surface files are current." | `skills/ocx` vs `src/cli/capabilities.ts` |
| `bun run structure:check` | ran: exit 1, pre-existing `anthropic-account-pool.md` 603-line failure only | manifest `documents` |
| `bun run privacy:scan` | ran 2026-11-11: "Privacy scan passed"; rerun at PR time | source and `devlog/` |

## Acceptance criteria

1. While a relayed `/v1/responses` body streams, `child.activity.inFlight` is 1 and `idle` false; after it ends,
   `lastDataEndAt` is set; a `/v1/catalog` GET changes neither (activity test).
2. A Child's authenticated `/v1/catalog` GET moves `child.catalog.pulledAt`; editing the Home catalog file makes it
   `behind` until the next pull (freshness test).
3. `ocx link check --link-id <id>` on a 2.97+ Child prints a done job with one `succeeded` item and `child.installedVersion`
   set; on a 2.96 Child the item is `owner-action`/`legacy-ocx` and the Child received only `--version` (observe test plus 010's gate test).
4. Client-initiated and `ocx-child` rows never trigger SSH.
5. `GET /api/link/status` without `children=1` is byte-for-byte today's document; the admin-token answer with it
   validates in the new CLI; an old CLI never sends the query.
6. A `DELETE` on a `/api/link/children/...` path never removes a link.
7. The core-link boundary test stays green: nothing in `src/router.ts`, `lifecycle.ts` or `responses/core.ts` reaches the new modules.

## Security notes, risks and Windows

The new POST runs one command per Child over the pinned channel already used by DELETE and planting. It never
changes an install: below 2.97.0 the gate stops before `update` runs, and `update --plan` only computes. It is not
free of side effects on every Child version: an npm or pnpm Child without a census pair runs the plan through its
`ocx` shim, so the Node launcher's ordinary bootstrap (Desktop CLI handoff check, Bun resolution;
`bin/ocx.mjs:1403-1440`) runs first, exactly as it does for every pinned sync the Home already sends there
(D20); its answer is reduced to closed reason tokens and never stored verbatim. The job routes take the same
principals as probe/apply; Tailscale identity sessions are refused first (`link-routes.ts:273`); on a non-loopback
Home the CLI's POST gets 403 over TCP like revoke today (the socket admits only `GET /api/link/status`,
`local-control-listener.ts:41`). Risk: an observe of many Children holds three SSH sessions at a time for up to
60 s each; bounded by concurrency 3 and the per-link lock. Windows: observe is supported (no install change; a dropped
channel only loses the answer); a pre-2.97 Windows Child's installed version comes from the peer report because
Windows inspection does not read the served census (`structure/remote-link.md:11`).

NOT RUN: full `bun run test` (shared host).
