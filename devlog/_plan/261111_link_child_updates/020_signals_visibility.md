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

> **Revision 5 (wp2 P re-verification against dev 29a5278c1c, wp1 merged as #8505).** Rebinds this plan to the merged
> wp1 exports, moves the catalog pull hook into the relay (the existing `onAuthenticatedCatalog` fires on admission
> with no etag, and `serve-options.ts` is 3 lines under the 2000-line ratchet), and folds the carried items: peer and
> ephemeral observations write `updateInFlight: null` (#8500 final review), a wp2 test that a missing `links.json`
> prunes every entry (CodeRabbit on #8505). Full list: "wp2 P re-verification (base dev 29a5278c1c)" at the end.

- **Work phase:** wp2. **Depends on:** wp1, merged in #8505. Exports used, exactly as merged:
  `src/link/child-gated-ocx.ts` (`remoteUpdatePlanArgv(homeVersion, platform)`, `classifyUpdatePlanProbe(result,
  { homeVersion, desktopUpdateRequest, platform? })`, `PlanProbeVerdict`, `SshResult`),
  `src/link/child-update-contract.ts` (`PlanClassification`, `InstallKind`, `UpdateRoute`, `PlanRuntimeOwner`),
  `src/link/child-observations.ts` (`ChildOp`, `ChildOperationSummary`, `ChildObservation`, `ChildObservationsFile`,
  `CARRIED_OBSERVATION_FIELDS`, `withoutCarriedFields`, `readChildObservations`, `updateChildObservations(mutate,
  { path?, storePath?, maxEntries? })`, `patchChildObservation(file, linkId, patch, now)`),
  `src/link/ssh-argv.ts` (`buildExecArgv`, `LinkSshArgumentError`), `src/link/sync-fanout-classify.ts`
  (`parseOcxVersion`). **Class:** C4: one new POST route that runs a
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
| src/link/child-observations.ts | MODIFY (:193-200) | `patchChildObservation` keeps `observedAt` for a carried-fields-only patch |
| src/link/status-projection.ts | MODIFY (after :83) | `LinkChildOpsStatus` type, `attachLinkChildOps` |
| src/server/index/link-relay-sessions.ts | MODIFY (:19-27, :103-120, :129-154) | `activity` option paired with the drain lease; `catalogServed` option fired when a `/v1/catalog` body completes |
| src/server/index/link-listener.ts | MODIFY (:51-63, :85, :117, :218-227) | lifecycle-owned activity book, `linkActivity`, `onCatalogServed` |
| src/server/index/optional-listeners.ts | MODIFY (:36-59, :87, :106-108, :126, :166) | `linkActivity`, `catalogPull`, pull recorder subscribed to `onCatalogServed` |
| src/server/management/context.ts | MODIFY (:162) | listener pick gains `linkActivity`, `catalogPull` |
| src/server/management/link-route-state.ts | MODIFY (:31-47) | optional `linkActivity`/`catalogPull`; state gains `childOps`, `catalogRevision` |
| src/server/management/link-child-ops-routes.ts | NEW | two job routes |
| src/server/management/link-routes.ts | MODIFY (:309-314, :347) | `?children=1` attach, delegating branch |
| src/server/management/route-registry.ts | MODIFY (after :439) | two routes |
| src/cli/link-status-child.ts | NEW | `validateChildOps` for status rows |
| src/cli/link-child-ops.ts | NEW | `runLinkCheck`, job document validator, poller |
| src/cli/link.ts | MODIFY (:36-47, :159, :179, :312, :385-397) | usage, row key, query, switch arm and exit code |
| src/cli/capabilities-access-remote.ts | MODIFY (append) | `link check` capability |
| src/cli/registry.ts | MODIFY (:154-163) | link usage and details |
| src/cli/help.ts | MODIFY (:70) | `check` in the verb list |
| tests/clients/link-child-observations.test.ts | MODIFY (wp1 file, registered) | missing `links.json` prunes every entry; carried-only patch keeps `observedAt` |
| skills/ocx/references/* | MODIFY | regenerated surface, hand pages |
| docs and structure | MODIFY | see "Docs" |

None of these files is near its cap: `link-routes.ts` 363, `link.ts` 446, `optional-listeners.ts` 174,
`link-listener.ts` 244, `link-relay-sessions.ts` 158, `child-observations.ts` 201, `status-projection.ts` 177,
`capabilities-access-remote.ts` 168, `registry.ts` 861 (re-counted on 29a5278c1c).
`src/cli/index.ts`, `src/server/index.ts` and `src/server/index/serve-options.ts` are untouched (F4). The last one is
1997 lines against the 2000-line `THRESHOLD` (`scripts/file-size-ratchet.ts:4`), so no pull hook may be added there;
the relay owns it (below).

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
  /** Revision 5: a 200 `GET /v1/catalog` whose body the Child read to the end. linkId from the relay session, else
   *  null with keyId from the response's `x-opencodex-key-id` (`bounded-request.ts:80-88`, legacy key admission). */
  catalogServed?: (served: { linkId: string | null; keyId: string | null; etag: string }) => void;
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
HEAD/no body and the dispatch throw (`:121-155`), so an aborted stream ends the activity too. The check
runs after session validation, so a refused request never counts.

Catalog pulls (Revision 5). The existing `onAuthenticatedCatalog` (`serve-options.ts:391-393`) fires on admission,
before the body, carries no etag, and also drives the supervisor (`optional-listeners.ts:126`) and the enrollment
wait (`link-enrollment.ts:347`), so it keeps its meaning and signature. The `/v1/catalog` response sets no etag
header (`serve-options.ts:768-847`). The relay already sees every hub-link request and knows when a body ends, so it
records the pull. When `options.catalogServed` is set, `url.pathname === "/v1/catalog" && url.search === ""`,
`req.method === "GET"` and `response.status === 200`, the body loop (`:129-154`) feeds each chunk to a
`createHash("sha256")`. Only the `next.done` branch then calls `catalogServed({ linkId: activityLink, keyId:
activityLink ? null : response.headers.get("x-opencodex-key-id"), etag: \`"\${hash.digest("hex")}"\` })` inside a
try/catch that logs `[link] catalog pull record failed` and the error name. That etag is byte-for-byte `catalogEtag(body)`
(`catalog-download.ts:40-42`, sha256 of the UTF-8 body). Cancel, abort, a read error and HEAD record nothing.

### src/server/index/link-listener.ts and optional-listeners.ts

`link-listener.ts`: `const activity = createLinkActivity();` beside `peers` (`:85`); `:117` passes
`{ peers, activity, catalogServed: served => { for (const listener of catalogServedListeners) listener(served); },
connectionGeneration, fingerprints }`; the interface (`:51-63`) and return object (`:218-227`) gain
`linkActivity(linkId: string, now: number): LinkActivitySnapshot` and
`onCatalogServed(listener: (served: { linkId: string | null; keyId: string | null; etag: string }) => void): () => void`
(a `Set` beside `authenticatedCatalogListeners`, `:83`).

`optional-listeners.ts`: `OptionalListenerSet` gains `linkActivity` and `catalogPull(linkId): CatalogPull | null`.
In `start`, next to the supervisor subscription (`:126`):

```ts
      catalogPulls ??= createCatalogPullRecorder({ storePath: linkDeps.storePath });
      unregisterCatalogPulls ??= linkListener.onCatalogServed(served => catalogPulls!.record(served));
```

and `stop` (`:166`) unregisters it and calls `catalogPulls?.flush()`. Only the hub-link listener's relay fires
`onCatalogServed`, so a Home without links records nothing. A legacy admission whose response lacks the key header
(an unconfigured key, `withRemoteCatalogKeyId`) and a key id absent from `links.json` record nothing. Revision 4
still holds: the record happens once the body has been read in full, never on admission, and carries the etag of the
bytes served. That still proves only a fetch: a Child whose sync fails after fetching is shown as having pulled, and
that is why wp5's fan-out does not use this record (050 `behind`).

### src/link/child-catalog-freshness.ts (NEW)

```ts
export interface CatalogPull { at: number; etag: string }
export interface CatalogPullRecorder {
  /** Revision 5: from the relay's onCatalogServed; keyId resolves through links.json when linkId is null. */
  record(served: { linkId: string | null; keyId: string | null; etag: string }): void; pulled(linkId: string): CatalogPull | null;
  /** Kept for 050's binding and the status row; equals pulled(linkId)?.at ?? null. */
  pulledAt(linkId: string): number | null; flush(): void }
/** A linkId absent from links.json, or a keyId no link holds, records nothing. Memory always, file at most once per link per 30 s. */
export function createCatalogPullRecorder(deps: { storePath?: string; now?: () => number; debounceMs?: number;
  /** Persists catalogPulledAt and catalogPulledEtag (010 cache fields). Default: updateChildObservations(file =>
   *  patchChildObservation(file, linkId, { catalogPulledAt: pull.at, catalogPulledEtag: pull.etag }, new Date(pull.at)),
   *  { storePath }); both are carried fields, so observedAt is kept (child-observations.ts MODIFY below). A throw
   *  (ConfigMutationLockError under contention) keeps the memory value and retries on the next flush. */
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

### src/link/child-observations.ts (MODIFY, wp1 file)

Merged `patchChildObservation` (`:193-200`) stamps `observedAt = now` on every patch. Every writer wp2 adds
(pull recorder, `lastOperation`) patches carried fields only, so a pull every 30 s would make `child.update.observedAt`
read "just observed" for install facts days old. wp2 changes one line, with no signature change:

```ts
// before
  file.children[linkId] = { ...base, ...patch, observedAt: now.toISOString() };
// after: a patch of carried fields only keeps the install facts' time; a new entry is still stamped
  const carriedOnly = Object.keys(patch).every(key => (CARRIED_OBSERVATION_FIELDS as readonly string[]).includes(key));
  file.children[linkId] = { ...base, ...patch, observedAt: carriedOnly && file.children[linkId] ? base.observedAt : now.toISOString() };
```

030, 050 and 070 call the same function with the same four arguments and inherit this. The wp1 case
`patchChildObservation keeps carried fields and stamps observedAt` patches non-carried fields and stays green.

### src/link/child-observe.ts (NEW)

```ts
import { classifyUpdatePlanProbe, remoteUpdatePlanArgv } from "./child-gated-ocx";
import type { PlanClassification } from "./child-update-contract";
import type { ChildObservation } from "./child-observations";
import type { LinkPeerEntry } from "./peer-report";
import type { inspectRemoteChildRuntime } from "./remote-plant";
import { buildExecArgv, LinkSshArgumentError } from "./ssh-argv";
import type { SshRunner } from "./ssh-runner";
import type { LinkRecord } from "./store";
import { parseOcxVersion } from "./sync-fanout-classify";

export interface ObserveDeps {
  runner: Pick<SshRunner, "run">; knownHostsFile: string; homeVersion: string;
  peer: (linkId: string) => LinkPeerEntry; platformOf: (record: LinkRecord) => Promise<"posix" | "windows">;
  inspect: typeof inspectRemoteChildRuntime; now: () => Date;
}
/** Set only for a parsed plan. childNowMs is the Child's clock from the gate (010, M9); startedAt is the Home's clock when
 *  the probe was sent; platform is the one step 3 resolved, so the wp3 update runner never probes it again. */
export interface ObserveProbe { classification: PlanClassification; childNowMs: number | null; startedAt: number; platform: "posix" | "windows" }
/** observation is a whole ChildObservation with every carried field null; writers strip them with withoutCarriedFields. */
export interface ObserveOutcome { state: "succeeded" | "owner-action" | "unsupported" | "offline" | "failed"; reason: string | null;
  observation: ChildObservation | null; probe: ObserveProbe | null }
export async function observeChild(record: LinkRecord, deps: ObserveDeps): Promise<ObserveOutcome>;
```

Every observation sets all non-carried fields, so nothing from an earlier observe survives a later one (the
write uses `withoutCarriedFields`, which keeps only the fields in `CARRIED_OBSERVATION_FIELDS`). Rows below
list `{source, installedVersion, installKind, runtimeOwner, updateRoute, updateReason, targetVersion, updateInFlight}`;
`observedAt` is `deps.now()` and every carried field is `null`. A peer version enters `installedVersion` only when
`parseStrictSemver` accepts it, otherwise `null` (the cache reader drops an entry whose version fails, `child-observations.ts:67`).

Order (D3, with 010's ephemeral refusal):

1. `direction === "client-initiated"` → `unsupported`/`child-initiated`; observation `{source:"peer", installedVersion: peer(record.id).observed?.version, installKind:"unknown", runtimeOwner:null, updateRoute:"none", updateReason:"child-initiated", targetVersion:null, updateInFlight:null}`. No SSH.
2. `childKind === "ephemeral"` → `succeeded`; `{source:"peer", installedVersion:null, installKind:"ocx-child", runtimeOwner:null, updateRoute:"replant", updateReason:"ocx-child", targetVersion:null, updateInFlight:null}` (its version is a protocol constant, D10). No SSH.
3. Platform: `record.remotePlatform ?? platformOf(record)` (`requireRemotePlatform`, the reconnect/DELETE template at `link-routes.ts:231-232`); a throw → `offline`/`platform-unknown`.
4. `argv = remoteUpdatePlanArgv(homeVersion, platform)`. It throws `LinkSshArgumentError` before any SSH: message
   `windows-command-too-long` (`ssh-argv.ts:429`) → `failed`/`windows-command-too-long`; `invalid Home version`
   (`child-gated-ocx.ts:14`) → `failed`/`home-version-invalid`. Then
   `runner.run(buildExecArgv({alias, knownHostsFile, argv}), {timeoutMs: 60_000, maxOutputBytes: 65_536})` →
   `classifyUpdatePlanProbe(result, {homeVersion, desktopUpdateRequest: peer(record.id).observed?.features?.includes("desktop-update-request/1") ?? false, platform})`.
   Always pass `platform`: the Windows script prints no entry marker, and only this argument makes the classifier
   infer `binary` (`child-gated-ocx.ts:88-102, :100`). Today `null` and `binary` classify alike (only `pair` changes the
   route), so this keeps the wp1 contract rather than fixing a visible bug; the observe test pins it.
   - `plan` → `succeeded`; `{source:"plan", installedVersion, installKind, runtimeOwner, updateRoute, updateReason,
     targetVersion, updateInFlight}` all from `verdict.classification` (`targetVersion` is the plan's, equal to
     `homeVersion` except for `target-mismatch`);
     `probe = { classification, childNowMs: verdict.childNowMs, startedAt, platform }` where `startedAt = deps.now().getTime()`
     read just before `runner.run`. Every other branch returns `probe: null`. The wp3 update runner reads the plan
     token, route, installer and Child clock from `probe`; observe itself ignores it.
   - `ephemeral` → as step 2 (a record without `childKind` whose Child runs `ocx-child`).
   - `legacy` (`child-ocx-lacks-orchestrated-update` or `child-ocx-version-unknown`) → `owner-action`/`legacy-ocx`;
     POSIX: `installedVersion = parseOcxVersion(inspect(runner, alias, knownHostsFile, "posix")?.ocxVersionLine ?? "")`
     (one more SSH call, read-only, `remote-plant.ts:115-125`), `source:"inspect"`; Windows: the peer version,
     `source:"peer"`. Both: `installKind:"unknown", runtimeOwner:null, updateRoute:"owner-action", updateReason:"legacy-ocx",
     targetVersion:null, updateInFlight:null`.
   - `offline` → `offline`/`ssh-failed`, observation `null` (unchanged). `failed` → `failed` with its reason, observation
     `null`; the merged reasons are `child-ocx-not-found`, `child-ocx-not-contained`, `child-platform-unsupported`,
     `child-ocx-lacks-expect-link`, `child-gate-failed`, `child-output-invalid` (also a malformed clock line, which
     invalidates the whole framing), `contract-usage`, `child-plan-failed`, `contract-unknown`,
     `contract-output-invalid`, `contract-output-too-large`; all match the cache's reason pattern (`child-observations.ts:55`).
     A runner throw → `offline`/`ssh-error`.
5. The engine writes `withoutCarriedFields(outcome.observation)` through `writeObservation` when it is not `null`, so
   every field in `CARRIED_OBSERVATION_FIELDS` survives from the previous entry (030 2.3 `runObserveItem` keeps
   this exact line). Source `"inspect"` with route `"none"` is never written by observe; it is the shape
   `patchChildObservation` gives a Child first touched by a carried-only write, and the projection reads it as "not observed".

### src/link/child-ops-engine.ts (NEW, observe only; 030 extends)

```ts
import { withoutCarriedFields, type ChildObservation, type ChildOp, type ChildOperationSummary } from "./child-observations";    // ChildOp is declared once, in 010 (000 "Canonical names"); wp2 admits "observe" only
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
  /** Revision 5: the shape 030's ChildOpsEnv keeps (030 2.1). Production: updateChildObservations(file =>
   *  patchChildObservation(file, linkId, patch, now())), the same binding 050 uses. */
  writeObservation: (linkId: string, patch: Partial<ChildObservation>) => void;
  now?: () => Date; jobId?: () => string; concurrency?: number }): ChildOpsEngine;
```

Rules (D11): `jobId` is `"ljob_" + 16 hex` from `randomBytes(8)`; one engine-wide `Map<linkId, jobId>`; an item whose
link is held becomes `busy`/`link-operation-in-progress` without SSH, and a single-link request whose link is held
answers `link_operation_in_progress`; `"all"` expands to every link in `links.json` (client-initiated rows give an
`unsupported` item without SSH, so the operator sees them); concurrency 3; the record is re-read before SSH and a
vanished link ends `refused`/`link-removed`; finished jobs are kept 1 hour, at most 32; every finished item writes
`lastOperation`. Items carry no remote text (D11 privacy). A Home restart loses the in-memory jobs only.
Revision 5: an observed item makes two writes, `withoutCarriedFields(outcome.observation)` (when not `null`) and then
`{ lastOperation: summary }` at finish; the second is carried-only, so it keeps the `observedAt` the first stamped.
`updateChildObservations` throws `ConfigMutationLockError` on contention (busy_timeout 0); each write is wrapped,
logs `[link] child observation write failed linkId=<id> error=<name>` and never changes the item's state, because the
file is a cache and the job document already carries the result.

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
  activity(linkId: string): LinkActivitySnapshot | null; catalogPull(linkId: string): CatalogPull | null;
  revision: CatalogRevision | null; activeJob(linkId: string): LinkChildOpsStatus["activeJob"];
}
/** Home rows only. Skew compares installed ?? running with homeVersion; ocx-child and unparsable versions are "unknown". */
export function attachLinkChildOps(dto: LinkStatusDto, sources: LinkChildOpsSources): LinkStatusDto;
```

`LinkStatusDto.links[]` gains `child?: LinkChildOpsStatus`. The pull is the newer of the recorder's memory value and
the cached `{catalogPulledAt, catalogPulledEtag}`; `catalog.state = catalogVerdict(pull?.etag ?? null,
observation?.catalogSyncedEtag ?? null, revision)` and `catalog.pulledAt = pull?.at ?? null` (Revision 5: the verdict
needs the etag, so the source returns the pull, not only its time). `activity` absent (no listener method) reads
`{ idle: false, inFlight: 0, lastDataEndAt: null }`: unknown is never idle. An observation that observe never wrote
(source `"inspect"` with `updateRoute "none"`, the `patchChildObservation` default for a Child first touched by a
`lastOperation` or pull write) projects `installedVersion: null, installKind: null, update: { route: null, reason: null,
observedAt: null }`, so "not observed yet" never reads as "no update route".

### CLI: src/cli/link-status-child.ts, src/cli/link-child-ops.ts, src/cli/link.ts

`link.ts` before/after:

```ts
// :159 before
assertKeys(candidate, [...], [...PARITY_KEYS, "peer", "tunnel", "childKind"], `link ${index}`);
// after
assertKeys(candidate, [...], [...PARITY_KEYS, "peer", "tunnel", "childKind", "child"], `link ${index}`);
// :179 after the tunnel spread
      ...(candidate.child !== undefined ? { child: validateChildOps(candidate.child, index) } : {}),
// :312 before → after (the call starts on :311)
linkRequest<unknown>("/api/link/status?compatibility=1&diagnostics=1", ...)
linkRequest<unknown>("/api/link/status?compatibility=1&diagnostics=1&children=1", ...)
// LINK_USAGE (:44) adds:   ocx link check (--link-id <id> | --all) [--no-wait] [--json]
// switch (:395) adds:      else if (command === "check") checkExit = await runLinkCheck(args, deps, linkRequest, LINK_USAGE);
// :396 message lists "check"
// :385-397 exit: runCliAction (runtime-api.ts:545-558) maps only thrown errors (2 usage, 4 on 404, 5 on 409, 1) and
// returns 0 on success, so the verdict exit travels beside it:
//   let checkExit = 0; const code = await runCliAction(async () => { ... }); return code === 0 ? checkExit : code;
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
verbs print JSON, `link.ts:313, :382`). Exit (D15), returned by `runLinkCheck`: 0 if every item `succeeded` or `up-to-date`; 6 if any
`busy`/`offline`/`refused`/`owner-action`/`unsupported`; 1 for `failed`, `uncertain` or an API error; a 404 from an
older Home prints "This Home does not support Child operations; update the Home." and exits 4, through the same
`runCliAction` wrapper the wp3 verbs use (404 → 4, 409 → 5; architect reflection G2). `linkRequest` already rethrows a
`RuntimeApiError` with the HTTP status (`link.ts:248-251`); `runLinkCheck` catches only the 404 of its POST and rethrows
`new RuntimeApiError("This Home does not support Child operations; update the Home.", 404)`.

`validateChildJob(value): ChildJob` (this file, wp2) is tolerant from its first release, with the code 030 2.8 shows:
known keys are type-checked, unknown keys at job, item, `sync` and `restart` level are ignored, and an unknown
string in an enum field (`op`, `trigger`, job `state`, item `state`, `reason`, `sync.state`, `restart.outcome`) is
passed through for display. A wp2 CLI therefore keeps polling a wp3+ Home whose items carry `sync` and `restart`,
and a wp3–wp7 CLI keeps working against a wp8+ Home whose `restart.outcome` gains values (G1, audit H5).

Capability (`capabilities-access-remote.ts`): `command: ["link","check"]`, routes the two job routes, flags `--link-id`
(string, repeatable), `--all`, `--no-wait`, `--json`, `mutates: true` (it writes the Home's observation cache and runs
a command on the Child), `json: "payload"`, details: changes no install on the Child (it runs `update --plan`, which only
computes; an npm Child without a census pair runs it through its `ocx` shim, so the launcher's ordinary bootstrap
(sync-guard bookkeeping, Bun resolution) runs first, as for any pinned sync; the gated script exports
`OCX_NO_DESKTOP_HANDOFF=1` on both platforms, so no Desktop handoff runs), one SSH call per Child (two for a POSIX Child
older than 2.97.0), Home-initiated links only, loopback admin authority, exit codes. `registry.ts:154-163` adds
`"Check: ocx link check (--link-id <id> | --all) [--no-wait] [--json]"` and `check` in `usage`; `help.ts:70` adds `check`.
No contract string yet: `link.child-ops/1` is claimed by wp3 when all ops exist.

## Field chains

| Field | Created | Serialized | Deserialized | Consumers |
| --- | --- | --- | --- | --- |
| activity `inFlight`/`lastDataEndAt` | `createLinkActivity` via relay `dispatch` | `child.activity` | `validateChildOps`; GUI wp6 | wp3 restart idle gate, wp4 `restart-skipped:link-active`, wp5/wp7 schedulers |
| `catalogPulledAt`, `catalogPulledEtag` | relay `catalogServed` → pull recorder (body read to the end) | memory + `child-observations.json` | wp1 reader | `child.catalog.pulledAt`, verdict (etag) |
| `catalogSyncedEtag` (Revision 4) | 030 `pinnedSync` on `synced` | `child-observations.json` | wp1 reader | verdict, wp5 fan-out eligibility |
| `homeCatalog` | revision monitor | file header | wp1 reader | `child.catalog.homeChangedAt`, verdict, wp5 trigger |
| observation fields (all non-carried, `updateInFlight` included) | `observeChild` → engine | file | wp1 reader | `child.installedVersion/installKind/update`, wp3 update item, wp7 sweep |
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
  records nothing` and `recorded pull carries the served etag` (4529521968). Revision 5, through a real
  `createLinkRelaySessions` with a fake dispatch serving a catalog body in two chunks: `a completed body reports the
  session link and catalogEtag(body)`; `cancel mid-body, HEAD and a 404 report nothing`; `legacy admission reports
  the x-opencodex-key-id key and a null link`; `a key no link holds records nothing`; `a pull write keeps observedAt`.
- `tests/clients/link-child-observe.test.ts` (clients), fake `runner.run` returning scripted framed output:
  `client-initiated and ephemeral never call SSH`; `plan up-to-date, orchestrated, desktop-request (peer feature)
  and launcher-bypassed rows`; `exit 121 lacks marker → inspect (POSIX) or peer (Windows) and owner-action`;
  `255 → offline`; `platform discovery throw → offline`; `runner throw → offline`. Revision 5:
  `peer, ephemeral and legacy observations write updateInFlight null` (#8500 final review: assert
  `updateInFlight`, `runtimeOwner` and `targetVersion` are `null` on the client-initiated and `ocx-child` rows, and
  that an engine write of an ephemeral observation over a stored plan entry with `updateInFlight: true` leaves `null`);
  `plan observation copies updateInFlight and runtimeOwner from the classification`; `Windows plan without an entry
  marker is classified with platform windows` (spy on the probe context); `a Windows argv over the budget is failed
  windows-command-too-long with no SSH` (fake `remoteUpdatePlanArgv` seam or a Home version long enough to throw);
  `malformed child-now line → failed child-output-invalid`; `invalid peer version stores installedVersion null`.
- `tests/clients/link-child-observations.test.ts` (wp1 file, already registered; MODIFY): `missing links.json prunes
  every entry` (CodeRabbit on #8505: seed two entries, write through `updateChildObservations` with a `storePath` that
  does not exist; `readLinkStore` returns `emptyLinkStore()` for a missing path, `store.ts:118-125`, so `children`
  ends `{}`, unlike the existing `damaged links.json does not prune` at `:92`); `a carried-only patch keeps
  observedAt` (`{ lastOperation }` and `{ catalogPulledAt, catalogPulledEtag }` on an existing entry; a new entry is
  still stamped).
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
files), one line each before the closing `}` (after `"link-child-observations.test.ts": "clients"`, `:185`, which
gains a trailing comma), and the same five lines in `tests/fixtures/test-layout-expected.json` (after `:1657`).
Nothing goes into `layout.json` (1999 lines on 29a5278c1c; the file-size ratchet fails at 2000). This phase owns
`tests/server/link-child-ops-routes.test.ts` (NEW); 030 and 050 add cases to it (MODIFY) and do not register it again.
`cli-link-check.test.ts` adds `job validator tolerance`: a job with an extra top-level key, an item with
`sync`/`restart` objects and an unknown `restart.outcome` string validates and renders; a known key with the
wrong type (`items: {}`, `jobId: 7`) still throws.
Existing files that must stay green: `tests/server/link-management-routes.test.ts`,
`tests/clients/link-status-projection.test.ts`, `tests/clients/link-peer-compatibility.test.ts`,
`tests/cli/cli-link.test.ts`, `tests/server/management-route-registry.test.ts`, `tests/cli/cli-capabilities.test.ts`,
`tests/ci-workflows/skill-ocx.test.ts`, `tests/clients/link-relay-bound-transport.test.ts`, `tests/lab/core-link-boundary.test.ts`.
Revision 5 adds wp1's `tests/clients/link-child-observations.test.ts`, `tests/clients/link-gated-ocx-argv.test.ts` and
`tests/clients/link-child-update-contract.test.ts` to that list.

## Docs and source-of-truth sync

- `structure/remote-link.md`: "Home and Child version report" (`:116-127`) gets the `?children=1` block and its
  sources; "Tunnels, management and CLI" (`:67-71`) the two job routes and `ocx link check`; "Dashboard
  admission" (`:55`) adds both routes to the list. Add `src/server/management/link-child-ops-routes.ts`,
  `src/cli/link-child-ops.ts` and `src/cli/link-status-child.ts` to the `remote-link.md` `documents` list in
  `structure/manifest.json` (`:1360-1380`; the new `src/link/child-*.ts` modules are already covered by its
  `src/link/` entry), then `bun run structure:index` (files staged first, `structure/AGENTS.md`). The wp1 paragraph
  at `remote-link.md:9` gains one sentence: the observe runner passes the platform to `classifyUpdatePlanProbe`, and
  the relay, not `onAuthenticatedCatalog`, records catalog pulls.
- `docs-site/src/content/docs/guides/remote-link.md` ("Link status" `:66`, "CLI reference" `:137-148`, "Home and
  Child versions" `:162-180`) and its `fr, ja, ko, ru, tr, zh-cn, zh-tw` copies; `reference/cli/lifecycle.md`
  "Remote Link apply parity" (`:1333-1367`, where `ocx link status --json` rows are described at `:1359`) and the same
  7 locales: `ocx link check`, the `child` block, the 60 s budget, POSIX
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
| `bun test tests/server/link-management-routes.test.ts tests/clients/link-status-projection.test.ts tests/clients/link-peer-compatibility.test.ts tests/cli/cli-link.test.ts tests/server/management-route-registry.test.ts tests/cli/cli-capabilities.test.ts tests/ci-workflows/skill-ocx.test.ts tests/clients/link-relay-bound-transport.test.ts tests/lab/core-link-boundary.test.ts tests/clients/link-child-observations.test.ts tests/clients/link-gated-ocx-argv.test.ts tests/clients/link-child-update-contract.test.ts` | ran 2026-11-11 on 29a5278c1c: 274 pass, 0 fail, 12 files, exit 0 | yes: `link-routes.ts`, `status-projection.ts`, `link.ts`, `route-registry.ts`, capabilities, skills, relay sessions, wp1 modules |
| the five new test files | new; fail before implementation | new modules and routes |
| `bun run typecheck` | ran on 29a5278c1c: exit 0, "No type errors in 2,388 files" | all `src/` |
| `bun run skill:surface:check` | ran on 29a5278c1c: exit 0, "All 9 generated management surface files are current." | `skills/ocx` vs `src/cli/capabilities.ts` |
| `bun run structure:check` | ran on 29a5278c1c: exit 0, "structure/ SSOT checks passed" (the earlier `anthropic-account-pool.md` failure is gone) | manifest `documents` |
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
8. Revision 5: client-initiated, `ocx-child` and legacy observations store `updateInFlight: null`; a plan observation stores
   the plan's value; a later observe never leaves an earlier one's non-carried field behind.
9. Revision 5: a write with a missing `links.json` leaves `children` empty; a pull or `lastOperation` write keeps the
   entry's `observedAt`.

## Security notes, risks and Windows

The new POST runs one command per Child over the pinned channel already used by DELETE and planting. It never
changes an install: below 2.97.0 the gate stops before `update` runs, and `update --plan` only computes. It is not
free of side effects on every Child version: an npm or pnpm Child without a census pair runs the plan through its
`ocx` shim, so the Node launcher's ordinary bootstrap (sync-guard bookkeeping, Bun resolution) runs first, exactly as
it does for every pinned sync the Home already sends there (D20). The gated script exports `OCX_NO_DESKTOP_HANDOFF=1`
(`ssh-argv.ts:373`; Windows `remote-windows.ts:232-244`), so the launcher's Desktop CLI handoff (`bin/ocx.mjs:1407-1431`) does not run. Its answer is
reduced to closed reason tokens and never stored verbatim. The job routes take the same
principals as probe/apply; Tailscale identity sessions are refused first (`link-routes.ts:273`); on a non-loopback
Home the CLI's POST gets 403 over TCP like revoke today (the socket admits only `GET /api/link/status`,
`src/server/index/local-control-listener.ts:41`). Risk: an observe of many Children holds three SSH sessions at a time for up to
60 s each; bounded by concurrency 3 and the per-link lock. Windows: observe is supported (no install change; a dropped
channel only loses the answer); a pre-2.97 Windows Child's installed version comes from the peer report because
Windows inspection does not read the served census (`structure/remote-link.md:9`). A Windows plan probe whose encoded
command would exceed the budget fails before SSH (`windows-command-too-long`); it fits any Home version of at most 40
characters (`structure/remote-link.md:9`).

NOT RUN: full `bun run test` (shared host).

## wp2 P re-verification (base dev 29a5278c1c)

Checked every anchor, imported name and type above against `origin/dev` 29a5278c1c, which contains wp1 (#8505).
Since the roadmap commit (ddee2c2003), wp1 changed only `src/link/{child-gated-ocx,child-update-contract,child-observations,
sync-fanout-classify,ssh-argv,remote-windows,paths}.ts`, `src/cli/sync-fanout.ts`, two structure docs and the clients test
layout. None of the files this phase modifies moved, so most anchors held. Changes:

1. **wp1 rebinding.** Dependencies list the merged exports by name. `observeChild` passes `platform` to
   `classifyUpdatePlanProbe` (wp1 deviation: Windows infers entry `binary`), reads Desktop support from
   `peer(id).observed?.features`, maps `remoteUpdatePlanArgv` throws (`windows-command-too-long`, invalid Home
   version) to `failed` before SSH, takes `targetVersion`, `runtimeOwner` and `updateInFlight` from the classification,
   reads the legacy POSIX version with `parseOcxVersion(inspect(...).ocxVersionLine)`, and lists the merged failure
   reasons, including the malformed clock line that invalidates the whole framing.
2. **Observation writes.** The engine's `writeObservation` is `(linkId, patch: Partial<ChildObservation>)`, the shape
   030 and 050 already use; it writes `withoutCarriedFields(observation)` and then `{ lastOperation }`, and a
   `ConfigMutationLockError` is logged without changing the item. `patchChildObservation` keeps `observedAt` for a
   carried-only patch, so pull and `lastOperation` writes no longer make old install facts look fresh. The projection reads
   the `patchChildObservation` default for a never-observed Child (wp1 deviation: `inspect`/`unknown`/`none`) as not observed.
3. **Catalog pull hook moved to the relay.** The plan assumed `onAuthenticatedCatalog((apiKeyId, etag))` firing after the
   body. In the merged code it fires on admission with `apiKeyId` only (`serve-options.ts:391-393`), and the supervisor
   and enrollment depend on that, so it stays. `serve-options.ts` is at 1997/2000 lines, so the hook cannot go there.
   The relay hashes a completed `/v1/catalog` body and reports `{linkId, keyId, etag}` through a new
   `onCatalogServed`. The recorder's `record` and the projection source (`catalogPull`, which carries the etag the
   verdict needs) follow.
4. **CLI.** Query anchor `link.ts:312`; JSON print anchors `:313, :382`. Exit 6 cannot pass through `runCliAction`, which
   returns 0 on success, so `runLinkCheck` returns its code and `runLinkCommand` returns it when the wrapper returns 0.
   The 404 message is a rethrown `RuntimeApiError(…, 404)`.
5. **Launcher wording.** The gated scripts export `OCX_NO_DESKTOP_HANDOFF=1` on both platforms, so the security note and
   the capability details no longer claim a Desktop handoff check runs.
6. **Carried items.** (a) Peer, ephemeral and legacy observations set `updateInFlight: null` (with `runtimeOwner` and
   `targetVersion` null), tested in `link-child-observe.test.ts`; (b) `missing links.json prunes every entry` is added to
   `tests/clients/link-child-observations.test.ts` (already registered); (c) `010_foundations.md` Revision 6 item 5 now
   says a malformed clock invalidates the whole framing.
7. **Anchor refreshes.** `remote-plant.ts:115-125`, relay body loop `:129-154`, `structure/remote-link.md:9` (was `:11`),
   `lifecycle.md` "Remote Link apply parity" `:1333-1367` (was `:1336-1404`), `local-control-listener.ts` full path,
   `bin/ocx.mjs:1407-1431`, `layout.json` 1999 lines, registration insertion points `layout-clients.json:185` and
   `test-layout-expected.json:1657`, `manifest.json` `remote-link.md` entry `:1360-1380`.

Kept unchanged: G1 tolerant validators (`validateChildOps`, `validateChildJob`), `?children=1` opt-in on Home rows only,
`ocx link check` through `runCliAction` with 404 → 4, the test registration rule (clients shard plus the expected
fixture, nothing in `layout.json`), and no timer in wp2.

Fresh evidence on 29a5278c1c: the 12-file focused command in "Verifiers" ran 274 pass, 0 fail; `bun run typecheck`
exit 0 (2,388 files); `bun run skill:surface:check` exit 0; `bun run structure:check` exit 0; `bun run privacy:scan`
"Privacy scan passed" with these two doc edits in the tree.
NOT RUN: full `bun run test` (shared host; plan-only change).


## Revision 7 (architect recheck of the wp2 catalog-pull hook)

Verdict ALIGNED with D6. Folded:

1. `onCatalogServed` is invoked only after `finish()` and `controller.close()` in the relay's pull stream, never inside the
   `next.done` branch before the close. The catalog recorder updates its in-memory map synchronously and defers the
   observation-file write with a timer (coalesced, at most one write per link per 30 s as before); a lock failure is
   logged. Test: a recorder that throws, and one that blocks, still let the Child's response stream close and the
   relay session release.
2. Test: the etag the relay computes for a served `/v1/catalog` body equals `catalogEtag` of the same serialized body
   (no compression on this path today; the test fails if one is ever introduced without updating the hash).



## Revision 8 (wp2 plan audit, base 29a5278c1c)

Audit verdict GO-WITH-FIXES (blockers 4, no High/Critical). Dispositions, binding on the implementation:

1. **Blocker, accepted.** `runLinkCheck` maps a 404 to "This Home does not support Child operations; update the Home."
   (exit 4) only when the error code is not `link_not_found` (an older Home answers `not_found` for the unknown
   route). A new Home's `link_not_found` for a mistyped `--link-id` keeps its own message and exit 4 through
   `runCliAction`, as `runRevoke` does (`src/cli/link.ts:353`). Tests for both.
2. **Blocker, accepted.** `tests/cli/cli-link.test.ts` is MODIFY: its status-URL assertion (`:147`) becomes
   `/api/link/status?compatibility=1&diagnostics=1&children=1`.
3. **Blocker, accepted.** The revision monitor's save of `homeCatalog` during `GET ?children=1` catches
   `ConfigMutationLockError`, keeps the value in memory and retries on the next read; the status response never fails
   on lock contention. Test: a held config lock during a `?children=1` read still returns 200 with the computed
   catalog state, and the next read persists it.
4. **Blocker, accepted. Security-review gate.** Acceptance adds: before merge, an explicit security review (a fresh
   review task with security scope, its verdict recorded in the PR) of the new `POST /api/link/children/operations`
   route that runs a command on a Child. Scope: the "either" auth (dashboard session or admin token on loopback),
   Tailscale identity sessions refused, a closed op set with fixed command arguments (observe only in wp2), link ids
   validated against `links.json` and the `lnk_` pattern, client-initiated links refused, no remote output stored or
   logged verbatim, and the local-control socket allowlist unchanged (status only).
5. Low, accepted (G1 class). `validateChildOps` maps an unknown enum value (`installKind`, `route`, `versionSkew`,
   `catalog.state`, `codex.appServers`) to `"unknown"` instead of throwing, and accepts a `codex` object by keeping
   its known fields. A known key with a wrong primitive type still throws.
6. Low, accepted. The activity book does not record `lastDataEndAt` for a legacy-path request that ends 401/403.
7. Low, accepted. Limitations: the enrollment check's `/v1/catalog` fetch counts as a pull.
8. Low, accepted. SSH runner output-limit and decode errors map to `failed` with reasons `ssh-output-limit` and
   `ssh-output-decode`; only transport failures stay `offline`.
9. Low, accepted. The CLI wait deadline is `ceil(items/3) × 120 s + 30 s`.
10. Low, accepted. `inspectRemoteChildRuntime` is awaited.
11. Low, accepted. The operations POST answers `409 runtime_role_client` on a runtime whose `runtimeRole` is `client`.
12. Low, accepted. An unknown item state in a job document makes `ocx link check` exit 1.

