# 080 — Child-side release: Codex-state report, restart outcome, ocx-child build info, Desktop update request

> **Revision 4 (CodeRabbit on #8500).** Folds 4529522121 (a 404 from an older Home pauses the Codex-state report for
> 30 minutes instead of for the process lifetime, so a Home upgrade is picked up without restarting the Child),
> 4529522131 (a failed `check_and_show` never reaches `after_check`: the request stays pending and is retried; a
> request whose checks fail until its window ends is `check-failed`) and 4529522141 (`installing` or `busy` at the
> end of the window is `uncertain`/`desktop-install-unresolved`, recorded in `pendingUpdateRecovery` with its request
> id, and reconciled by a status call before any new request).

> **Revision 2 (audit r1).** Folds H1 (registration per 000 "Test registration rule"), H4 (the Desktop branch in
> `runUpdateItem` precedes the Windows refusal; 070's `AUTO_UPDATE_ROUTES` gains `desktop-request`; Windows Desktop
> claims match the code), H5 (the widened `restart.outcome` needs no CLI change: 030's validator passes unknown values
> through), M6 (`runDesktopRequestItem` is called with 020's `ObserveProbe`; the gated call passes every
> `GatedOcxCommand` field, `acceptEphemeral` and `reportEntry` included), M9 (the Desktop request takes a relative
> `--ttl-ms` so the Child computes its own deadline; exit 3 carries its reason, and `window-invalid` maps to
> `refused`/`desktop-window-invalid`) and L17 (`start_poll` I/O stays an outline, marked below).

- **Work phase:** wp8
- **Depends on:** wp3 (job engine `src/link/child-ops-engine.ts`, `ChildJobItem`, the `child` projection
  attacher `attachLinkChildOps` from wp2). The Child halves stand alone; the Home halves plug into wp3.
- **Class:** C4. A new write on the Home link listener (D7), a new Desktop updater entry point (D9)
  and a new peer-visible contract need explicit security review (`src/AGENTS.md`, `MAINTAINERS.md:83`).

**Outcome.** A linked Child tells its Home whether its running Codex app-servers loaded the
catalog it has on disk and which catalog that is, so the Remote Link row shows "Codex restart
needed" from the Child's own evidence instead of an inference. A Home-driven restart reports
what happened on the Child (`done`, `refused`, `failed`, `skipped`) instead of `requested`.
`ocx-child` reports its real crate version without touching the 2.98.0 protocol constant. A
Desktop Child can be updated from the Home: the Home writes a request through the Child's own
CLI, and the Desktop app installs its normal signed update only when that update's version
equals the Home's version.

**IN:** D7, D13 marker, D10, D9 (CLI, Tauri poll, Home route), peer features
`link-child-codex-state/1`, `desktop-update-request/1`, `ocx-child/<crateVersion>`.
**OUT:** any file under `src/update/*` (D19); re-planting `ocx-child`; Child-initiated mutating
ops; a version chosen by the caller; GUI rendering of these fields (wp6, `060_dashboard.md`).

## File change map

| Path | Kind | Purpose |
| --- | --- | --- |
| `src/link/child-codex-state.ts` | NEW | Report type, strict parser, ordered in-memory store, route predicate, feature id (mirrors `src/link/child-parity.ts:18-124`). |
| `src/server/index/link-management.ts` | MODIFY :36-80 | Shared bounded report reader; `handleChildCodexStateReport`; dispatch branch at :80. |
| `src/server/index/optional-listeners.ts` | MODIFY :19, :103-104 | Admit the exact POST on the Home link listener. |
| `src/client/link-codex-state-reporter.ts` | NEW | Child reporter: change check every 60 s, send on change or every 5 min, 404 stops. |
| `src/client/link-home.ts` | MODIFY after :371 | `sendLinkChildCodexStateReport` (mirror of :341-371). |
| `src/client/runtime.ts` | MODIFY :41, :378-379, :409-410, :488-489 | Start and stop the reporter beside `activeReporter`. |
| `src/remote/features.ts` | MODIFY :33-62 | Two sources and two features. |
| `src/cli/restart-outcome-marker.ts` | NEW | Pure map `RestartScopeOutcome` → marker line. |
| `src/cli/sync-command.ts` | MODIFY :78, :237-243 | Print the marker on pinned (`--expect-link`) syncs only. |
| `src/link/child-restart-marker.ts` | NEW | Home parser of the marker. |
| `src/link/child-desktop-request.ts` | NEW | Home argv for the request and status, strict status parser, result mapping. |
| `src/link/child-ops-engine.ts` (wp3) | MODIFY | Restart items read the marker; update items run route `desktop-request`. |
| `src/link/status-projection.ts` (wp2 attacher) | MODIFY | `child.codex` from the store; `child.childBuild` from peer features. |
| `src/cli/desktop-update-request.ts` | NEW | `ocx desktop update-request` (write, `--status`). |
| `src/cli/dispatch.ts` | MODIFY near :916 | `desktop` runner. |
| `src/cli/registry.ts` | MODIFY before :850 | `desktop` entry. |
| `src/cli/capabilities-access-remote.ts`, `src/cli/capability-contracts.ts:2` | MODIFY | Capability `desktop update-request`; contract `desktop.update-request/1`. |
| `desktop/src-tauri/src/update_request.rs` | NEW | Request/result types, pure decision, file IO, 30 s poll. |
| `desktop/src-tauri/src/updater.rs` | MODIFY :448-456 | Start the poll from `start_background_checks`. |
| `desktop/src-tauri/src/recovery.rs` | MODIFY after :92 | `pub fn home(app)` getter for the bound config home. |
| `desktop/src-tauri/src/lib.rs` | MODIFY :64 | `mod update_request;` |
| `native/ocx-child/src/cli.rs` | MODIFY :68-120 | `build-info --json`. |
| `native/ocx-child/src/relay.rs` | MODIFY :46 | Append `ocx-child/<CARGO_PKG_VERSION>` to peer features. |
| `structure/remote-link.md`, `structure/desktop-shell.md`, `structure/manifest.json` | MODIFY | Ownership and invariants (Docs section). |

## Changes

### A. D7 — Child Codex-state report

**`src/link/child-codex-state.ts` (NEW), full API:**
```ts
import { LINK_MANAGEMENT_PREFIX } from "./management-routes";
import { isEpochMs } from "./child-parity";

export const LINK_CHILD_CODEX_STATE_PATH = `${LINK_MANAGEMENT_PREFIX}/child-codex-state`;
export const LINK_CHILD_CODEX_STATE_VERSION = "1";
export const LINK_CHILD_CODEX_STATE_MAX_BYTES = 1024;
export type ChildAppServerState = "fresh" | "stale" | "not_running" | "unknown"; // = CodexAppServerCatalogState
const APP_SERVER_STATES: readonly ChildAppServerState[] = ["fresh", "stale", "not_running", "unknown"];
const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/;   // base64url SHA-256, as src/client/connect.ts:942 writes it
const MAX_STALE = 1024;

export interface LinkChildCodexStateReport {
  linkId: string;
  runtimeStartedAt: number;            // epoch ms, same clock and meaning as the parity report
  sequence: number;                    // process-wide, increasing
  catalogFingerprint: string | null;   // connection.catalogFingerprint (src/types/config.ts:540)
  catalogSyncedAt: number | null;      // Date.parse(connection.catalogSyncedAt) (:551)
  appServers: ChildAppServerState;     // collectCodexAppServerCatalogStateWithin (app-server-processes.ts:1285)
  staleCount: number;                  // processes started at or before the catalog mtime
}
export interface LinkChildCodexState extends Omit<LinkChildCodexStateReport, "linkId" | "sequence"> {
  reportedAt: number;                  // Home clock
}

export function parseLinkChildCodexStateReport(value: unknown): LinkChildCodexStateReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = ["linkId", "runtimeStartedAt", "sequence", "catalogFingerprint", "catalogSyncedAt", "appServers", "staleCount"];
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !actual.every(key => keys.includes(key))) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.linkId !== "string" || !LINK_ID.test(v.linkId) || !isEpochMs(v.runtimeStartedAt)) return null;
  if (typeof v.sequence !== "number" || !Number.isSafeInteger(v.sequence) || v.sequence < 0) return null;
  if (v.catalogFingerprint !== null && (typeof v.catalogFingerprint !== "string" || !FINGERPRINT.test(v.catalogFingerprint))) return null;
  if (v.catalogSyncedAt !== null && !isEpochMs(v.catalogSyncedAt)) return null;
  if ((v.catalogFingerprint === null) !== (v.catalogSyncedAt === null)) return null;
  if (!APP_SERVER_STATES.includes(v.appServers as ChildAppServerState)) return null;
  if (typeof v.staleCount !== "number" || !Number.isSafeInteger(v.staleCount) || v.staleCount < 0 || v.staleCount > MAX_STALE) return null;
  if ((v.appServers === "stale") !== (v.staleCount > 0)) return null;
  return v as unknown as LinkChildCodexStateReport;
}

export interface LinkChildCodexStateStore {
  record(report: LinkChildCodexStateReport, currentLinkIds: ReadonlySet<string>): boolean;
  get(linkId: string): LinkChildCodexState | null;
  clear(): void;
}
export function createLinkChildCodexStateStore(now: () => number = Date.now): LinkChildCodexStateStore;
// Same rules as createLinkChildParityStore (child-parity.ts:90-116): prune absent links on every
// record, keep only (runtimeStartedAt, sequence)-newer reports, get() returns null when none.
export const homeLinkChildCodexState: LinkChildCodexStateStore = createLinkChildCodexStateStore();

export function linkChildCodexStateRouteAllowed(url: URL, req: Request): boolean {
  return url.pathname === LINK_CHILD_CODEX_STATE_PATH && req.method === "POST" && url.search === "" && !req.headers.has("upgrade");
}
```

**`src/server/index/link-management.ts`.** Before (:42-70) `handleChildParityReport` reads and checks
the body inline. After: the method, key, length, 5 s bounded read, UTF-8 decode and key-owns-link
steps move into one helper used by both handlers, so the two writes cannot drift:
```ts
async function readLinkReport<T extends { linkId: string }>(req: Request, url: URL, admittedKeyId: string | undefined,
  maxBytes: number, parse: (value: unknown) => T | null,
): Promise<{ ok: true; report: T; linkIds: Set<string> } | { ok: false; response: Response }>;
// body = the current lines 43-67 with LINK_CHILD_PARITY_MAX_BYTES -> maxBytes and the parser injected.

async function handleChildParityReport(req: Request, url: URL, admittedKeyId: string | undefined): Promise<Response> {
  const read = await readLinkReport(req, url, admittedKeyId, LINK_CHILD_PARITY_MAX_BYTES, parseLinkChildParityReport);
  if (!read.ok) return read.response;
  homeLinkChildParity.record(read.report, read.linkIds);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
async function handleChildCodexStateReport(req: Request, url: URL, admittedKeyId: string | undefined): Promise<Response> {
  const read = await readLinkReport(req, url, admittedKeyId, LINK_CHILD_CODEX_STATE_MAX_BYTES, parseLinkChildCodexStateReport);
  if (!read.ok) return read.response;
  homeLinkChildCodexState.record(read.report, read.linkIds);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
// :80, after the parity branch:
  if (url.pathname === LINK_CHILD_CODEX_STATE_PATH) return handleChildCodexStateReport(req, url, admittedKeyId);
```
Status codes stay those of today: 404 wrong method/query/upgrade, 403 `link_key_required`,
413 `report_too_large`, 400 `invalid_report`, 503 `link_store_unavailable`, 403 `link_mismatch`, 204.

**`src/server/index/optional-listeners.ts:103-104`.** Before:
`linkRouteAllowed(url, req) || linkManagementRouteAllowed(url, req) || linkChildParityRouteAllowed(url, req)`.
After: append `|| linkChildCodexStateRouteAllowed(url, req)`, import at :19, and extend the comment
at :99-102 to "two writes, both display-only". The Child's own ingress keeps the data-only table.

**`src/client/link-codex-state-reporter.ts` (NEW):**
```ts
export const LINK_CODEX_STATE_CHECK_MS = 60_000;      // cheap: one connection-state read
export const LINK_CODEX_STATE_PERIOD_MS = 300_000;    // a process listing at most every 5 min unless the catalog changed
export const LINK_CODEX_STATE_FIRST_MS = 15_000;
export const LINK_CODEX_STATE_COLLECT_MS = 5_000;
export interface LinkCodexStateReporterDeps {
  connection: OcxClientConnectionConfig; linkKey: () => string | null; runtimeStartedAt: string;
  readCatalog?: () => { fingerprint: string | null; syncedAt: number | null };   // readClientConnectionState(), connected only
  collect?: (deadlineMs: number) => Promise<CodexAppServerCatalogStatus>;       // collectCodexAppServerCatalogStateWithin
  send?: typeof sendLinkChildCodexStateReport;
  now?: () => number; setTimer?: (cb: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void;
}
export function linkCodexStateReport(linkId: string, runtimeStartedAt: number, sequence: number,
  catalog: { fingerprint: string | null; syncedAt: number | null }, status: CodexAppServerCatalogStatus,
): LinkChildCodexStateReport {
  const mtime = status.catalogMtimeMs;
  const staleCount = status.state === "stale" && mtime !== null
    ? Math.min(1024, status.processes.filter(p => p.startedAtMs !== null && p.startedAtMs <= mtime).length) : 0;
  const both = catalog.fingerprint !== null && catalog.syncedAt !== null;
  return { linkId, runtimeStartedAt, sequence, catalogFingerprint: both ? catalog.fingerprint : null,
    catalogSyncedAt: both ? catalog.syncedAt : null, appServers: staleCount > 0 ? "stale" : status.state === "stale" ? "unknown" : status.state, staleCount };
}
export function createLinkCodexStateReporter(deps: LinkCodexStateReporterDeps): { start(): void; stop(): void };
```
Tick rule: every `CHECK_MS` read the catalog pair; collect and send when the pair differs from the
last accepted send **or** `PERIOD_MS` has passed since it; `"unsupported"` (404) pauses sending for
`UNSUPPORTED_RETRY_MS` (30 min, Revision 4) and then tries again, so a Home upgraded underneath a running Child starts
receiving reports within 30 minutes without a Child restart; a reconnect of the link tunnel also ends the pause at once.
An older Home answers that retry with one more 404, which costs nothing. `"failed"` retries on the next check. Timers are unref'd like
`link-parity-reporter.ts:60-64`. The 60 s check is what makes "after each sync" true: the sync runs
in another process and writes `catalogSyncedAt` (`connect.ts:939-945`), which the next check sees.

**`src/client/runtime.ts`.** Before (:378-379): only `createLinkParityReporter(...)`. After: a second
module variable `activeCodexStateReporter` created and started in the same branch, and stopped
and nulled at :409-410 and :488-489 next to `activeReporter`.

**`src/remote/features.ts`.** `PeerFeatureSources` (:33-39) gains
`readonly linkChildCodexStateVersion: string;` and `readonly desktopUpdateRequest: boolean;`.
`PEER_FEATURES` (:45-52) appends:
```ts
  s => `link-child-codex-state/${s.linkChildCodexStateVersion}`,
  s => s.desktopUpdateRequest ? "desktop-update-request/1" : null,
```
`currentPeerFeatureSources` sets `linkChildCodexStateVersion: LINK_CHILD_CODEX_STATE_VERSION` and
`desktopUpdateRequest: process.env[DESKTOP_SUPERVISED_ENV] === "1"` (`src/lib/system-restart-contract.ts:85`;
the sidecar sets it, `desktop/src-tauri/src/sidecar.rs:207`). The Desktop shell and its bundled ocx
ship in one artifact (F5), so a Desktop-supervised ocx that has this code runs under a shell that polls.

**Projection (`src/link/status-projection.ts`, wp2's `LinkChildOpsStatus`, 020 :300-321).** Before:
`codex: null;`. After:
```ts
  codex: { appServers: ChildAppServerState; staleCount: number; catalogMatchesHome: boolean | null;
           catalogSyncedAt: number | null; reportedAt: number } | null;
  childBuild: string | null;      // D10, crate version from peer feature "ocx-child/<semver>"
// LinkChildOpsSources gains:
  codexState(linkId: string): LinkChildCodexState | null;          // homeLinkChildCodexState.get
  peerFeatures(linkId: string): readonly string[] | null;          // peerObservation(linkId).observed?.features
// attachLinkChildOps fills:
  const s = sources.codexState(link.id);
  const homeFp = sources.revision ? Buffer.from(sources.revision.etag.slice(1, -1), "hex").toString("base64url") : null;
  codex: s && { appServers: s.appServers, staleCount: s.staleCount, catalogSyncedAt: s.catalogSyncedAt, reportedAt: s.reportedAt,
    catalogMatchesHome: s.catalogFingerprint === null || homeFp === null ? null : s.catalogFingerprint === homeFp },
  childBuild: link.childKind === "ephemeral" ? parseChildBuild(sources.peerFeatures(link.id)) : null,
```
The Home's `catalogEtag` is quoted hex SHA-256 over the served body (`src/server/catalog-download.ts:40-42`);
the Child hashes the bytes it downloaded and wrote verbatim (`src/client/connect.ts:939-942`), so equal
digests mean the same catalog. This closes 004 assumption 5 (an effort-gate refusal looks "current" by
pull time). `parseChildBuild` accepts exactly one `ocx-child/<strict semver>` id, else null.
`src/cli/link-status-child.ts` `validateChildOps` relaxes `codex === null` to this shape and adds
`childBuild` (string | null). Released CLIs from wp2 on ignore unknown keys inside `child` and accept `codex` as null or an object (020, architect reflection G1), so adding `childBuild` and the `codex` object here needs no CLI change.

### B. D13 — Restart outcome marker

**`src/cli/restart-outcome-marker.ts` (NEW):**
```ts
export const CODEX_RESTART_MARKER_PREFIX = "ocx-fanout:codex-restart:";
export type CodexRestartMarker = "done" | "refused" | "failed" | "skipped";
const REFUSED = new Set(["unsupported_platform", "test_environment", "restart_in_flight", "self_ancestry", "relaunch_context_failed", "handoff_started"]);
export function codexRestartMarker(outcome: RestartScopeOutcome | null): CodexRestartMarker {
  if (outcome === null) return "skipped";                                  // no catalog write, nothing restarted
  const apps = outcome.appServers?.restart;
  if (apps && (apps.failed.length > 0 || apps.surviving.length > 0)) return "failed";
  const desktop = outcome.desktopApp;
  if (!desktop) return "done";
  if (desktop.reason === undefined) return desktop.relaunch === "started" ? "done" : "failed";
  if (desktop.reason === "no_targets") return "done";                     // nothing was running stale
  return REFUSED.has(desktop.reason) ? "refused" : "failed";              // relaunch_failed, package_discovery_failed, process_probe_failed, targets_survived
}
```
**`src/cli/sync-command.ts`.** Before (:237-243) `handleConnectedSyncCatalogWrite(result, scope): Promise<void>`
returns nothing. After it returns `RestartScopeOutcome | null` (null when `!catalogWritten && !cacheSynced`);
at :78:
```ts
        const restartOutcome = await handleConnectedSyncCatalogWrite(result, restartScope);
        if (expectation && (restartScope.appServers || restartScope.desktopApp)) {
          const { CODEX_RESTART_MARKER_PREFIX, codexRestartMarker } = await import("./restart-outcome-marker");
          process.stderr.write(`${CODEX_RESTART_MARKER_PREFIX}${codexRestartMarker(restartOutcome)}\n`);
        }
```
Only a pinned (Home-driven) sync with a restart flag prints it, so local `ocx sync` output is unchanged.
Older Homes are unaffected: `classifySyncResult` reads only the `selected` marker count and, for exit
5/121, the last stderr line; the marker is written on the exit-0 path before any later line.

**`src/link/child-restart-marker.ts` (NEW, Home):**
```ts
export type ChildRestartOutcome = "requested" | "unsupported" | "not-run" | "done" | "refused" | "failed";
/** Exactly one marker line ⇒ its value ("skipped" ⇒ "not-run"); none ⇒ "requested" (Child older than wp8); several or unknown ⇒ "requested". */
export function parseCodexRestartMarker(stderr: string): ChildRestartOutcome;
```
**`src/link/child-ops-runners.ts` (030 §2.3).** `pinnedSync` returns `{ sync: SyncResult; restartMarker: ChildRestartOutcome }`,
computing `parseCodexRestartMarker(result.stderr)` from the same `SshRunResult`. In `runSyncItem` and
`runRestartCodexItem` (030 :419-452) the literal `"requested"` after a synced sync becomes `restartMarker`.
030's server-side `ChildRestartOutcome` union (030 2.1) widens to include `done`, `refused` and `failed`. The CLI needs no
change: 030's `validateChildJob` accepts any lowercase token in `restart.outcome` and renders it (audit H5), so a CLI from
wp3–wp7 keeps working against a Home of this release; 060's label table gains the new values.

### C. D10 — ocx-child build info

**`native/ocx-child/src/cli.rs`** (:75-120 match) gains, before `other =>`:
```rust
        "build-info" => match args.get(1).map(String::as_str) {
            Some("--json") | None => {
                println!("{}", serde_json::json!({
                    "schema": "ocx-child.build/1",
                    "crateVersion": env!("CARGO_PKG_VERSION"),
                    "protocolVersion": OCX_PROTOCOL_COMPAT_VERSION,
                    "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
                }));
                0
            }
            _ => { eprintln!("Usage: ocx-child build-info --json"); 2 }
        },
```
The usage line at :70 adds `build-info`. `--version` keeps printing `opencodex 2.98.0` (lib.rs:18-21).
**`native/ocx-child/src/relay.rs:46`** before: `const PEER_FEATURES: &str = "relay-auth/2,link-management-relay,link-peer-report/1";`
after: `const PEER_FEATURES: &str = concat!("relay-auth/2,link-management-relay,link-peer-report/1,ocx-child/", env!("CARGO_PKG_VERSION"));`
(`FEATURE_ID` allows `/` and dots, `src/link/peer-report.ts:19`.) `ocx-child` sends no Codex-state report.

### D. D9 — Desktop update request

**Config-dir question, resolved.** The shell does not compute its home: it runs the bundled CLI
`ocx resolve --json` (`desktop/src-tauri/src/resolve.rs:301-302`), whose `configHome` is `getConfigDir()`
(`src/cli/resolve.ts:94,266,275`; `src/config/paths.ts:21-27`, `OPENCODEX_HOME` or `~/.opencodex`). Startup
binds it with `crate::recovery::bind_home(app, &target.home)` (`startup.rs:840-842`). The sidecar inherits
the app's environment and adds only `OPENCODEX_GUI_DIST`, `OCX_DESKTOP_SUPERVISED`, `OCX_TELEMETRY`
(`sidecar.rs:200-211`), so the bound home is the served runtime's config dir. The SSH writer can still
run under another `OPENCODEX_HOME`; it then finds no Desktop-owned runtime in its dir and refuses
(`not-desktop-owned`), and the Home shows an owner action instead of writing a request nobody reads.

**`src/cli/desktop-update-request.ts` (NEW):**
```ts
export const DESKTOP_UPDATE_REQUEST_SCHEMA = "ocx.desktop.update-request/1";
export const DESKTOP_UPDATE_RESULT_SCHEMA = "ocx.desktop.update-result/1";
export const DESKTOP_REQUEST_STATUS_SCHEMA = "ocx.desktop.update-request-status/1";
export const DESKTOP_REQUEST_MAX_WINDOW_MS = 30 * 60_000;
export const DESKTOP_REQUEST_ID = /^dreq_[0-9a-f]{16}$/;
export type DesktopResultState = "installing" | "installed" | "not-available" | "version-mismatch" | "busy" | "failed" | "expired";
export type DesktopRequestState = "pending" | DesktopResultState | "superseded";
export interface DesktopUpdateRequestFile { schema: typeof DESKTOP_UPDATE_REQUEST_SCHEMA; requestId: string;
  targetVersion: string; requestedAt: number; notAfter: number }
export interface DesktopRequestStatus { schema: typeof DESKTOP_REQUEST_STATUS_SCHEMA; requestId: string;
  state: DesktopRequestState; targetVersion: string | null; at: number }
export interface DesktopCommandIo { configDir?: () => string; now?: () => number; randomId?: () => string;
  desktopOwned?: () => "desktop" | "other" | "unknown"; stdout?: Pick<Console, "log">; stderr?: Pick<Console, "error"> }
/** ocx desktop update-request --version <V> --ttl-ms <ms> [--request-id <id>] [--json]
 *  ocx desktop update-request --status --request-id <id> [--json]
 *  Exit 0 written/read, 2 usage, 3 refused, 1 I/O failure. Under --json, exit 3 prints exactly one line
 *  {"error":"not-desktop-owned"|"ownership-unknown"|"window-invalid"} on stdout so the Home can tell them apart. */
export async function runDesktopCommand(args: readonly string[], io?: DesktopCommandIo): Promise<number>;
```
Write path: strict semver `--version`; `--ttl-ms` an integer with `0 < ttl <= MAX_WINDOW_MS` (30 min), and the Child
computes `notAfter = now + ttl` on its own clock (M9: a deadline the Home computed would be evaluated against a clock it
cannot see); a TTL outside that range is `window-invalid`;
`resolveServiceOwnership()` owned by `"desktop"`, or `inspectDesktopSupervision().kind === "desktop"`, both
from `src/service/*`, never `src/update/*`) must say `desktop`; then `atomicWriteFile(<configDir>/desktop/update-request.json, …)`
with dir 0700 and file 0600, replacing any older request. It prints the status document (state `pending`).
Status path: a result file with the same `requestId` ⇒ its state; the request file names another id ⇒
`superseded`; `now > notAfter` and no result ⇒ `expired`; else `pending`. Files over 1 KiB or with unknown
keys read as absent. **`dispatch.ts`** gains `desktop: async deps => (await import("./desktop-update-request")).runDesktopCommand(deps.args.slice(1)),`;
**`registry.ts`** gains `{ name: "desktop", usage: "ocx desktop update-request (--version <v> --ttl-ms <ms> [--request-id <id>] | --status --request-id <id>) [--json]", summary: "Ask the supervising OpenCodex Desktop app to install its signed update when it equals the requested version.", details: [...] }`.
Capability `["desktop","update-request"]` (`mutates: true`, `json: "payload"`, no routes) in
`capabilities-access-remote.ts`; `CAPABILITY_CONTRACTS` gains `"desktop.update-request/1"`.

**`desktop/src-tauri/src/update_request.rs` (NEW):**
```rust
pub const REQUEST_FILE: &str = "update-request.json";
pub const RESULT_FILE: &str = "update-result.json";
#[derive(Deserialize)] #[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request { pub schema: String, pub request_id: String, pub target_version: String, pub requested_at: u64, pub not_after: u64 }
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)] #[serde(rename_all = "kebab-case")]
pub enum State { Installing, Installed, NotAvailable, VersionMismatch, Busy, Failed, Expired, CheckFailed }
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)] #[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Outcome { pub schema: String, pub request_id: String, pub state: State, pub target_version: String, pub at: u64 }
#[derive(Debug, PartialEq)] pub enum Step { Ignore, Finish(State), Check }

/// Pure. Invalid request (schema, id pattern, X.Y.Z[-pre] version, window > 30 min) ⇒ Ignore.
pub fn decide(req: &Request, prior: Option<&Outcome>, running: &str, now: u64) -> Step {
    if !valid(req) { return Step::Ignore; }
    if let Some(p) = prior.filter(|p| p.request_id == req.request_id) {
        return match p.state {
            State::Installing => Step::Finish(if running == req.target_version { State::Installed } else { State::Failed }),
            State::Busy if now <= req.not_after => Step::Check,
            _ => Step::Ignore,
        };
    }
    if running == req.target_version { return Step::Finish(State::Installed); }
    if now > req.not_after { return Step::Finish(State::Expired); }
    Step::Check
}
/// Pure. Equality only: never newer, never older than the Home's version.
pub fn after_check(pending: Option<&str>, target: &str) -> Result<(), State> {
    match pending { None => Err(State::NotAvailable), Some(v) if v != target => Err(State::VersionMismatch), Some(_) => Ok(()) }
}
// Outline (accepted residual, audit L17): the start_poll I/O below is to be made diff-level at this phase's own P;
// decide/after_check above are the binding, tested contract.
pub fn start_poll(app: AppHandle);   // every 30 s: home = crate::recovery::home(&app)?; read (≤ 1 KiB) home/desktop/REQUEST_FILE,
// prior RESULT_FILE; decide(..., env!("CARGO_PKG_VERSION"), now_ms()); Check ⇒ if tray::is_installing ⇒ write Busy;
// else match updater::check_and_show(&app).await {
//   Err(_) ⇒ Revision 4 (4529522131): do not call after_check (the pending version may be an earlier check's, or none);
//            write nothing and retry at the next 30 s tick; once now > req.not_after with every check failed, write
//            CheckFailed ("check-failed"). Ok(()) ⇒ after_check(page_status(&app).latest_version.as_deref(), target) }
// after_check Ok ⇒ write Installing, then updater::install_pending_version(&app, Some(target)).await; Err(state) ⇒ write state.
// Writes: temp file in the same dir (0600 on Unix) then fs::rename.
```
**`updater.rs`.** `install_pending(app)` becomes `install_pending_version(app, None)`; the new
`pub async fn install_pending_version(app, expected: Option<&str>)` is the same body with the
`claim_install` `pending_version` closure (:291-301) returning `None` when the pending version differs
from `expected`, so a check that swapped in another version between `after_check` and the claim yields
`NoPending`, not an install. `start_background_checks` (:448-456) also calls
`crate::update_request::start_poll(app.clone())`; it stays release-only (`lib.rs:433-435`).
**`recovery.rs`** adds `pub fn home(app: &AppHandle) -> Option<PathBuf>` reading `Recovery.home` (:14).
The drain, ownership and ADR-6033 intent rules apply unchanged because `install()` (:395-430) is reused.

**Home: `src/link/child-desktop-request.ts` (NEW):**
```ts
/** Sent as --ttl-ms; the Child accepts up to 30 min (DESKTOP_REQUEST_MAX_WINDOW_MS), the Home asks for 20 and then
 *  waits up to 5 min for the peer version, so one item holds the update lane at most ~25 min (070 deviation 7). */
export const DESKTOP_REQUEST_TTL_MS = 20 * 60_000;
export const DESKTOP_STATUS_POLL_MS = 60_000;
export function desktopRequestArgs(target: string, ttlMs: number, requestId: string): string[];
//  ["desktop","update-request","--version",target,"--ttl-ms",String(ttlMs),"--request-id",requestId,"--json"]
export function desktopStatusArgs(requestId: string): string[];
export function parseDesktopRequestStatus(stdout: string, requestId: string): DesktopRequestState | null; // ≤ 4 KiB, exact keys, same id
export type DesktopRefusal = "not-desktop-owned" | "ownership-unknown" | "window-invalid" | "unknown";
/** Exit 3 stdout {"error":<reason>} with exactly that key; anything else is "unknown". */
export function parseDesktopRefusal(stdout: string): DesktopRefusal;
export function desktopItemOutcome(state: DesktopRequestState | { refused: DesktopRefusal } | "unknown-command"): ItemOutcome | "wait";
```
| Child answer | Item |
| --- | --- |
| `pending` | `wait` (poll again; after the window ⇒ `owner-action`/`desktop-app-not-polling`: the app never picked it up) |
| `installing`, `busy` | `wait`; after the window ⇒ `uncertain`/`desktop-install-unresolved` (Revision 4: the app is polling and may still finish) |
| `check-failed` (Revision 4) | `offline`/`desktop-update-check-failed` (transient: grows 070's backoff, never spends the attempt cap) |
| `installed` | wait for peer version == target (≤ 5 min) ⇒ `succeeded`, else `uncertain`/`version-unconfirmed` |
| `not-available` | `owner-action`/`desktop-update-not-published` |
| `version-mismatch` | `refused`/`desktop-version-mismatch` (the published Desktop release differs from the Home's version) |
| `failed` | `failed`/`desktop-install-failed` |
| `expired`, `superseded` | `owner-action`/`desktop-app-not-polling`, `refused`/`desktop-request-superseded` |
| exit 3 `not-desktop-owned` | `owner-action`/`not-desktop-owned` |
| exit 3 `ownership-unknown` | `owner-action`/`desktop-ownership-unknown` |
| exit 3 `window-invalid` | `refused`/`desktop-window-invalid` (a Home/Child version pair that disagrees on the TTL bound; nothing written) |
| exit 3, any other output | `owner-action`/`desktop-request-refused` |
| exit 1 from an ocx without the verb | `owner-action`/`desktop-request-unsupported` |

In `runUpdateItem` (030 2.3) the line `if (plan.updateRoute === "desktop-request") return { state: "owner-action", reason: "desktop-app", ...versions };`
becomes `if (plan.updateRoute === "desktop-request") return runDesktopRequestItem(record, probe, versions, env);`. It
already sits after the idle, suppression and busy checks and **before** the Windows refusal (H4), so a Windows Desktop
Child reaches it. `runDesktopRequestItem(record: LinkRecord, probe: ObserveProbe, versions, env: ChildOpsEnv)` makes one
gated call, 60 s:
```ts
remoteGatedOcxArgv({ minVersion: "2.97.0", lacksMarker: "child-ocx-lacks-orchestrated-update", acceptEphemeral: false,
  reportEntry: false, reportClock: false, launcher: "none",
  args: desktopRequestArgs(env.homeVersion, DESKTOP_REQUEST_TTL_MS, requestId) }, probe.platform)
```
then status calls (`desktopStatusArgs`, same gate fields) every 60 s through `env.sleep` until a terminal state or
`DESKTOP_REQUEST_TTL_MS` plus the 5-minute peer-version wait has passed on the Home's clock. `requestId` =
`"dreq_" + randomBytes(8).hex`. The Home never sends an absolute deadline to the Desktop path.
The post-update `--expect-link` sync (D12 step 7) runs after `succeeded` as for orchestrated updates.
Revision 4 (4529522141): every `uncertain` Desktop outcome (`desktop-install-unresolved`, `version-unconfirmed`) writes
`pendingUpdateRecovery` with `desktopRequestId: requestId` (010 field), so 070 never submits another automatic update for
that link before the record clears or expires. When `runDesktopRequestItem` starts for a link whose unexpired record
carries a `desktopRequestId`, it first runs `desktopStatusArgs(thatId)` and maps the answer by the table above; only a
terminal answer (or none, after expiry) clears the record and allows a new request id.
`check-failed` is a new value of the result file's state: the Child's `desktop update-request --status` reader and the
Home's `parseDesktopRequestStatus` both accept it, since the Rust writer, the CLI and the Home parser ship in this phase.
The route is chosen only when the peer features carry `desktop-update-request/1` (010 :395).

## Field chains

| Field / value | Created | Serialized | Deserialized | Consumers |
| --- | --- | --- | --- | --- |
| report body (7 keys) | `linkCodexStateReport` | `JSON.stringify` in `sendLinkChildCodexStateReport` | `parseLinkChildCodexStateReport` | store → `child.codex` |
| `child.codex.*` | `attachLinkChildOps` | `GET /api/link/status?children=1` | `validateChildOps` (CLI), `gui/src/remote-link-child-ops-api.ts` (060) | `ocx link status`, GUI "Codex restart needed" badge |
| `child.childBuild` | `parseChildBuild` from ocx-child peer feature | same | same | GUI badge (060); CLI status line |
| `link-child-codex-state/1` | `PEER_FEATURES` | `/readyz` `features`, relay challenge header | `parseLinkPeerReport` | GOAT; display only on the Home |
| `desktop-update-request/1` | `PEER_FEATURES` (Desktop-supervised) | relay challenge header | `parseLinkPeerReport` | `classifyUpdatePlanProbe` ctx (010) → route |
| `ocx-child/<v>` | `relay.rs:46` | relay challenge header | `parseLinkPeerReport` | `parseChildBuild` |
| marker `ocx-fanout:codex-restart:*` | `codexRestartMarker` | Child stderr | `parseCodexRestartMarker` | `ChildJobItem.restart.outcome` → job doc → CLI enum (030 :762), GUI (060) |
| request file | `runDesktopCommand` | JSON file 0600 | Rust `Request` (deny unknown) | `decide` |
| result file | Rust poll | JSON file 0600 | `runDesktopCommand --status` | Home `parseDesktopRequestStatus` → item |
| `desktop.update-request/1` | `CAPABILITY_CONTRACTS` | `ocx capabilities --json` | N/A (agent read) | skills/ocx surface |

## Tests

All new root files fail before implementation (the imported modules do not exist). Registration (000 "Test
registration rule"): every new file, whatever its domain (server, cli or clients), on one line before the closing `}` of
`scripts/test-layout/layout-clients.json` and of `tests/fixtures/test-layout-expected.json`; nothing goes into `layout.json`
(1998 lines; the file-size ratchet fails at 2000). The existing `link-child-parity.test.ts` entry stays where it is.

- **`tests/server/link-child-codex-state.test.ts`** (server). Starts a Home with one link like
  `tests/server/link-child-parity.test.ts`. Cases: *accepts a valid report* (204, row `child.codex` filled
  under `?children=1`); *GET / query / upgrade ⇒ 404*; *no key ⇒ 403 link_key_required*; *other link's key
  ⇒ 403 link_mismatch*; *1025 bytes ⇒ 413*; *unknown key, stale with staleCount 0, fingerprint without
  syncedAt ⇒ 400*; *older runtimeStartedAt or lower sequence is ignored*; *removed link is pruned*;
  *catalogMatchesHome true/false/null* (activation: report the Home's own etag as base64url, then one bit off,
  then null); *parity route unchanged* (regression for the shared reader).
- **`tests/clients/link-codex-state-reporter.test.ts`** (clients). Fake timers, collect and send. Cases:
  *first send after 15 s*; *no send at 60 s when nothing changed*; *send within one check after
  catalogSyncedAt changes* (activation: the fake `readCatalog` returns a new pair); *periodic send at 5 min*;
  *404 pauses for 30 min, then retries* and *old Home upgraded to a new Home* (Revision 4: the fake Home answers 404,
  then 204 after the switch; the next send after the pause is accepted, with no reporter restart); *a tunnel reconnect
  ends the pause*; *failure retries at the next check*; *staleCount counts only processes at or before mtime*;
  *a "stale" status with no countable process is sent as "unknown"*.
- **`tests/cli/restart-outcome-marker.test.ts`** (cli). Table over every `DesktopAppRestartReason` plus
  app-server `failed`/`surviving` and `null`. *sync prints the marker only with --expect-link and a restart
  flag* (activation: `runSyncCommand` with mocked `syncConnectedClient` as in `tests/cli/cli-sync-expect-link.test.ts`,
  once with and once without `--expect-link`); *the classifier still reads the output as synced*.
- **`tests/clients/link-child-restart-marker.test.ts`** (clients). *one marker per value*, *skipped ⇒ not-run*,
  *none ⇒ requested*, *two markers ⇒ requested*, *a runner restart item reports done from a fake SshRunResult*.
- **`tests/cli/desktop-update-request.test.ts`** (cli, temp `OPENCODEX_HOME`). *usage errors exit 2*;
  *not desktop-owned ⇒ exit 3 and `{"error":"not-desktop-owned"}`, no file*; *ownership unknown ⇒ exit 3,
  `ownership-unknown`*; *`--ttl-ms 0`, negative, non-integer or over 30 min ⇒ exit 3, `window-invalid`*; *`--not-after` is
  rejected as usage (exit 2)*; *the written `notAfter` equals the injected Child `now` plus the TTL* (M9);
  *writes 0600 file with exact keys* (POSIX mode check skipped on Windows by platform branch, not by skip);
  *status: pending, matching result, superseded, expired, oversize result reads absent*; *capability present
  and `desktop.update-request/1` listed*.
- **`tests/clients/link-child-desktop-request.test.ts`** (clients). argv shape; strict status parse (other id ⇒ null);
  every row of the outcome table, driven through `runUpdateItem` with a fake runner whose status calls
  return a scripted sequence (activation: `pending, pending, installed` then peer version == target ⇒ succeeded).
  Revision 4: `installing` past the window ⇒ `uncertain`/`desktop-install-unresolved` with `pendingUpdateRecovery`
  holding the request id; the next item for that link sends a status call for that id before any new request;
  `check-failed` ⇒ `offline`/`desktop-update-check-failed`.
- **Modified:** `tests/server/readyz-features.test.ts` (`none`/`all` sources gain the two fields; expected
  lists gain `link-child-codex-state/1` and, with `desktopUpdateRequest: true`, `desktop-update-request/1`);
  wp2's projection test and `validateChildOps` test for the widened `codex` and `childBuild`; 030's runner test
  for the widened restart outcome.
- **Rust:** unit tests in `update_request.rs` for every `decide` branch and `after_check` (equal, newer,
  older, none) and a temp-dir round trip of the result writer; Revision 4 (4529522131): *a failed check with an older
  pending version installs nothing and writes nothing*, and *checks failing until `not_after` write `CheckFailed`*
  (the I/O step takes the check as an injected closure so this runs without a network); `native/ocx-child/tests/conformance.rs` gains
  *build-info prints schema ocx-child.build/1 and crateVersion equals CARGO_PKG_VERSION* and *--version still
  prints 2.98.0*.

## Docs and source-of-truth sync

- `structure/remote-link.md`: after :189, a paragraph for the Codex-state report (path, caps, ordering,
  display only, 404 stops, fingerprint comparison); the restart marker beside the pinned-sync text (:9);
  `build-info` and the `ocx-child/<v>` feature in the ocx-child paragraph (:199); the Desktop request route.
- `structure/manifest.json` `remote-link.md` `documents` gains `src/client/link-codex-state-reporter.ts`
  (src/link and native/ocx-child are already directory-owned); then `bun run structure:index`.
- `structure/desktop-shell.md` (owns `desktop/`): after :203, the request poll, equality rule, pinned
  install claim, result file, and that the loopback dashboard still has no updater IPC.
- `structure/cli-management.md` owns `src/cli/`: one line for `ocx desktop update-request`.
- `skills/ocx`: `bun run skill:surface` (new capability), hand page `05_remote_hub.md` (Desktop Children).
- docs-site: `guides/remote-link.md` "Home and Child versions" (:162-180) and its 7 copies (fr, ja, ko, ru,
  tr, zh-cn, zh-tw) gain one paragraph on Desktop Children and the Codex restart badge. wp6 (060) edits the
  same page; whichever lands second rebases.

## Enforcement bypass record

| Guard | Tier | Executing surface | Known bypass | Residual risk | Wording |
| --- | --- | --- | --- | --- | --- |
| Codex-state route caps and key-owns-link | Runtime-enforced | `link-management.ts` | A Child with its own key reports false state about itself | Display only; it can mislabel its own row | "reported by the Child" |
| Desktop request version equality | Runtime-enforced (Rust) | `after_check` + pinned claim | A user process can write the request file | It can only trigger the app's own signed update to a version equal to the request; tray click does the same | "installs only the matching signed update" |
| Desktop-owned refusal | Runtime-enforced (CLI) | `runDesktopCommand` | Writing the file by hand | Same as above | — |
| Restart marker | Advisory | Child stderr | A Child prints any marker | Display only | "as reported by the Child" |

## Verifiers

| Command | Run now? | Result | Reads this phase's target |
| --- | --- | --- | --- |
| `bun test tests/server/link-child-parity.test.ts tests/clients/link-parity-reporter.test.ts tests/server/readyz-features.test.ts tests/cli/sync-fanout.test.ts` | yes, 2026-11-11 on 00680193cb | 25 pass, 0 fail, 4 files | yes: the parity route this phase shares, the feature registry it extends, the classifier the marker must not break |
| `bun test` the six new files above | no | new; fails before implementation | yes |
| `bun run typecheck` | once for 060 and 080 (see 060) | — | yes (`src/**`) |
| `cargo test --manifest-path desktop/src-tauri/Cargo.toml update_request` | no | NOT RUN: Tauri build is heavy on the shared host; CI `desktop shell` job runs it | yes |
| `cargo test --manifest-path native/ocx-child/Cargo.toml --test conformance` | no | NOT RUN: same reason | yes |
| `bun run structure:check`, `bun run skill:surface:check`, `bun run privacy:scan` | at implementation | — | yes: structure docs, capability surface, new files |

## Acceptance criteria

1. A connected full Child ≥ this release posts a Codex-state report within 15 s of runtime start and within
   75 s after an `ocx sync` writes a new catalog; `GET /api/link/status?children=1` shows `child.codex` for it
   (activation: tests/clients reporter + server route tests; manual: run a sync on a test Child).
2. With an app-server started before the catalog write, the row reads `appServers: "stale"`, `staleCount ≥ 1`.
3. `catalogMatchesHome` is `true` right after a pinned sync and `false` after the Home catalog changes and before
   the Child pulls it.
4. An older Home answers 404 and the reporter stops (no further sends).
5. A Home restart-codex job on a Child of this release reports `restart.outcome` `done`, `refused` or `failed`;
   on an older Child it stays `requested`.
6. `ocx-child build-info --json` prints the crate version; `--version` prints `opencodex 2.98.0`; the Home row
   for an ephemeral Child shows `childBuild`.
7. On a Desktop Child, a Home update job with route `desktop-request` writes the request, the app installs only
   when the pending signed update equals the target, and the item ends `succeeded` once the peer version
   equals the target; with a different published version it ends `refused`/`desktop-version-mismatch` and
   nothing installs.
8. `ocx desktop update-request` on a machine whose runtime is not Desktop-owned exits 3 and writes nothing.

## Security review notes and risks

- **Link-listener write (D7).** Same admission as OCX-6: link key, key owns the link, exact path and method,
  1 KiB, 5 s, strict parse, memory only. No setting, routing or admission depends on it. Review: the shared
  reader refactor must not loosen the parity route (regression case above).
- **Desktop updater entry point (D9).** New input to the updater is a local file in the user's config dir.
  It cannot choose an artifact, endpoint or key, cannot downgrade, cannot exceed the Home's version, and expires
  within 30 minutes. Installs go through the signature-verifying `download`, the drain and the ADR-6033 rules.
  The pinned claim closes the check-then-install race. The dashboard still has no updater IPC.
  Anyone able to write the file already runs as the user and could click the tray.
- **Home authority.** The request travels over the pinned SSH channel that already runs arbitrary commands as
  the Child user (D20); this adds no credential or trust root.
- **Privacy.** Reports carry a digest, times, a closed enum and a count; Home parses status into a closed enum;
  no remote text is stored or logged.
- **Risk:** the Desktop updater endpoint serves only the newest stable release; when it is newer than the Home,
  Desktop Children cannot be brought to the Home's version and show `desktop-version-mismatch` until the Home
  updates. That is the intended "never ahead of the Home" rule, stated in the hint.

## Windows behaviour

Supported: the Codex-state reporter (`collectCodexAppServerCatalogStateForRequest` has a Windows path,
`app-server-processes.ts:1143-1147`), `ocx desktop update-request` (file request; 004 D20 lists
desktop-request as supported because an OpenSSH session cannot reach the desktop but a file can), the Rust
poll (`fs::rename` replaces on Windows), `build-info`. The Home reaches the Desktop request on a Windows Child because
030's runner observes Windows Children and evaluates the `desktop-request` branch before its `windows-apply` refusal, and
070's sweep admits a Windows Child only for that route (H4). Tests: 030's runner case *windows desktop-request plan never
ends windows-apply* turns into *windows desktop-request plan sends the gated request through `windowsGatedOcxArgv`* in
this phase, and 070's *windows predicate* case runs with the route admitted. Refused as before: restart on Windows
Children (`unsupported:windows-restart`, no marker is ever requested) and orchestrated apply (`unsupported:windows-apply`).
Windows file mode is not 0600; the config dir's NTFS ACL hardening applies (`src/config/paths.ts:44-58`).

## Deviations from 004 and 000

1. **Report field `staleCount` is tied to `appServers`** (stale ⇔ count > 0) and a stale reading with no
   countable process is sent as `unknown`, so the Home never shows "stale (0)".
2. **`child.codex` is wider than 020's planned `{ appServers, reportedAt }`**: it adds `staleCount`,
   `catalogSyncedAt` and `catalogMatchesHome`, which uses the fingerprint the Child already stores
   (`connect.ts:942`) and closes 004 assumption 5. `childBuild` is a new key on `child`.
3. **Marker values** add `skipped` (no catalog write, so no restart ran) to `done|refused|failed`; the Home
   maps it to 030's `not-run`.
4. **`build-info` reports `os` and `arch` instead of `targetTriple`**: the crate has no build script and Rust
   exposes no target triple at runtime without one.
5. **Tauri code lives in a new `update_request.rs`** called from `updater.rs`, and `install_pending` gains a
   version pin (`install_pending_version`) to close a check-then-claim race 004 did not mention.
6. **First supporting version** is gated by peer feature, not by "≥ 2.101.0": the release derives 2.100.2 at
   this base (090).
7. **Desktop-owned check** reads `src/service/*` (`resolveServiceOwnership`, `inspectDesktopSupervision`)
   rather than the plan in `src/update/orchestrated-entry.ts:41-50`, keeping D19's distance from `src/update/*`.


## Automatic updates for Desktop Children (lead amendment A5)

Once this phase lands, the 070 sweep treats route `desktop-request` like `orchestrated` under
`updates: auto-when-idle`: same stable-Home, Home-first, idle (D5) and suppressed-target rules, target is the
Home's own version, and the Desktop app still installs only its own signed pending update whose version equals
the target, through its existing drain and ownership checks. Edit 070's `AUTO_UPDATE_ROUTES` to
`new Set(["orchestrated", "desktop-request"])` (Windows Children then qualify through this route only, H4), with a test:
an idle Desktop Child (macOS or Windows) with the peer feature `desktop-update-request/1`
gets an automatic update job; one without the feature stays owner-action). Reason: the owner asked for Home-driven
updates "even of the app version", and without this an upgraded Home would never update a Desktop Child on its own.
