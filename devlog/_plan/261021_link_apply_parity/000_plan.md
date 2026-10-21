# Remote Link parity on apply (OCX-6, #6957)

Status: open. Branch `feat/link-apply-parity`, PR target `dev` (merges after 2.90.0).

## Problem

The hub design (goat-si/goat ADR-0021, devlog 261021_goatclaw_hub §1.4) checks two things on a
Remote Link Child that OpenCodex cannot answer today:

- **P5 runtime freshness**: the Child runtime must have started after the last apply of the Home's
  settings. Nothing records when the Home's settings were applied, and `ocx sync` on a linked Child
  re-applies them without restarting the runtime. `ocx restart` cannot restart a linked Child at
  all: the client listener's `/healthz` answers no attestation challenge and advertises no
  `restartCapability`, so `requestBoundSystemRestart` refuses it (`restart_attestation_failed`).
  Step 2 of the hub repair ladder (`ocx restart` on the device) therefore cannot work.
- **P6 Codex settings**: there is no stable digest of the applied settings to compare between
  Home and Child.

## Contract

- `codexSettingsDigest(settings)`: `sha256:<64 hex>` of the canonical JSON (recursively sorted keys,
  no whitespace) of the `HomeCodexSettings` object. Home name and version are excluded, so a Home
  and its Child agree. Never the content.
- Child record `<configDir>/link/home-codex-settings.json` gains `appliedAt`. A re-apply of the
  same digest for the same link keeps the earlier `appliedAt` (idempotent); a new digest or a
  first apply stamps now. Older records without it read `appliedAt = fetchedAt`.
- The client runtime publishes `startedAt` (ISO, its process start) on `/healthz`.
- `ocx status --json` gains top-level `codexSettings`:
  `{ source: "published" | "home" | "local", digest, appliedAt, runtimeStartedAt }`.
  Home/standalone: `published` with the digest of what it serves Children. Link Child: `home` with
  the record's digest and `appliedAt`, plus the live client runtime's `startedAt`. Hub client or a
  Child with no record: `local`, nulls.
- Home `GET /api/link/status` (and `ocx link status --json`) gains per link
  `parity: null | { appliedAt, runtimeStartedAt, codexSettingsDigest, reportedAt }`, from the
  Child's report. The CLI validator accepts the key absent (older runtime) and normalizes to null.

## Restart (P5)

Reuse the existing bound restart (`ocx restart` -> attested `/healthz` -> capability-signed
`POST /api/system/restart`). The client listener gains:

- `/healthz`: `restartCapability: "v1"`, `startedAt`, and the attestation proof for a challenge,
  keyed by the same secret the runtime already writes to `runtime-port.json`.
- `POST /api/system/restart`: admitted only with the HMAC restart capability bound to this pid and
  port (no GUI session, no admin token). 202 with the standalone body shape; idempotent while one
  restart is in flight (`alreadyDraining: true`).

Client restart executor (`src/client/runtime-restart.ts`), same supervisor rules as the standalone
restart and the client recycle:

1. Desktop-supervised: exit 75, the app starts the replacement.
2. `OCX_SERVICE=1` with a viable service: exit 1, the failure-only supervisor relaunches.
3. Unsupervised: stop the tunnel supervisor, stop the listener gracefully (bounded by the 60 s
   drain), spawn `ocx start` with `replacementStartEnvironment(true)` and `waitForHealth: true`
   (`spawnReplacementStart`). Success: exit 0. Failure: rebind the listener on the same port,
   restart the supervisor, keep serving, and log the failure code. The CLI sees the same pid at its
   deadline and reports the restart as failed (existing fail-closed path); the old runtime stays up.

`ocx sync` on a linked Child: after a successful apply, if a client runtime is live and its
`startedAt` precedes the record's `appliedAt`, run the same `handleProxyRestart` as `ocx restart`
(no start when nothing is running). Unchanged digest + fresh runtime = no restart (idempotent). A
failed restart exits non-zero with a message naming the kept runtime; re-running `ocx sync` or
`ocx restart` retries.

Enrollment (`POST /api/link/apply`) already runs `connect --link` (which records the settings)
then `ocx restart` once, so it gains `appliedAt` with no flow change.

## Child -> Home report

`POST /v1/link-management/child-parity` on the Home's hub-link ingress only, after link-key
admission. Body exactly `{ linkId, appliedAt, runtimeStartedAt, codexSettingsDigest }` (<= 1 KiB,
strict ISO timestamps or null, digest pattern or null, linkId must belong to the admitting key).
Stored in memory per link id (lost on Home restart until the next report), display only, never
used for admission or routing. 204 on accept, 400 on a malformed body, 404 for a key/link mismatch.

The client runtime (link mode) sends it through the connection-bound relay
(`fetchBoundLinkRelay`, same as the settings read): first after start with backoff
(2 s, 5 s, 15 s, 30 s, 60 s), then every 5 minutes; a 404 from an older Home stops it. Unref'd
timers, stopped on shutdown/restart.

## Files

- src/link/codex-settings.ts: digest.
- src/link/child-parity.ts (new): report parse + Home in-memory store.
- src/link/management-routes.ts: report path in the route table.
- src/server/index/link-management.ts: report handler (needs the admitting key id).
- src/server/index/serve-options.ts: pass the admission key id.
- src/link/status-projection.ts, src/server/management/link-routes.ts: `parity` per link.
- src/cli/link.ts: validator accepts `parity`.
- src/client/link-home.ts: `appliedAt`, report send.
- src/client/connect.ts: enrollment write goes through the appliedAt helper.
- src/client/machine-listener.ts: healthz attestation/capability/startedAt, restart route.
- src/client/runtime.ts, src/client/runtime-restart.ts (new), src/client/link-parity-reporter.ts (new).
- src/cli/dispatch.ts, src/cli/link-apply-restart.ts (new): sync -> restart.
- src/cli/status.ts: `codexSettings` block.
- structure/remote-link.md, docs-site CLI reference (status, link, sync, restart).

## Tests (isolated homes only)

- digest: key order / whitespace independence, change detection, Home projection == Child parse.
- record: first apply stamps, same digest keeps appliedAt, new digest restamps, legacy record.
- client listener: healthz proof + capability; restart route refuses without/with wrong capability,
  accepts a valid one once, idempotent second accept.
- restart executor: unsupervised success exits 0; replacement failure rebinds and keeps serving
  (old runtime kept, failure reported); desktop -> 75; service -> 1.
- sync: stale runtime -> restart called; fresh runtime -> not called; restart failure -> exit 1.
- report: Home route accepts a valid report, rejects malformed / foreign link; status shows it.
- JSON shape: `ocx status --json` codexSettings (Home and Child) and `ocx link status --json` parity.

## Verification

typecheck, focused files, test:changed, privacy:scan, structure:check, full suite under the lock.


## Audit round 1 (gpt-6.1-sol, FAIL) and the revision

1. **Not-ready replacement counted as success.** Folded. `spawnReplacementStart` gains
   `notReady: "handoff" | "terminate"` (default `handoff`, standalone unchanged). The client restart
   passes `terminate`: a replacement still unready at the deadline is killed and the call rejects
   with `not_ready`, so rollback starts only once no replacement survives. Test: a replacement that
   stays alive without answering is killed and the old runtime serves again.
2. **Rollback cannot restart the stopped tunnel supervisor; shutdown captured locals.** Folded.
   `startClientRuntime` keeps its resources in module state (`activeServer`, `activeSupervisor`)
   and the signal handlers read that state. Rollback is one transaction in `runtime.ts`: bind a
   fresh listener (port wait capped at 10 s, inside the CLI's observation budget), create a fresh
   supervisor with the same key source, republish pid + runtime record with the same attestation
   secret, and clear the restart latch.
3. **Supervised handoff exits before validating the replacement.** Rebutted, kept as a stated
   residual. Under the desktop app (exit 75) or a viable service (exit 1) the supervisor owns the
   process identity and the port; the old process cannot hand the port back, and both supervisors
   retry the relaunch (desktop on 75, launchd KeepAlive on unsuccessful exit, systemd
   `Restart=on-failure`). This is exactly the standalone `ocx restart` semantics today. Refusing
   instead would leave P5 unrepairable on service-installed Children, which is the common fleet
   shape. A non-viable service falls through to the unsupervised path with rollback, as the
   standalone restart does. Documented in structure/remote-link.md.
4. **Receipt best-effort and independently committed.** Partly folded. The record write now
   returns the committed receipt or throws; `ocx sync` reports a failed receipt write and exits
   non-zero, and enrollment's `connect --link` fails the same way instead of swallowing it. The write
   runs under `withClientLifecycleSync` after `assertClientConnectionUnchanged`. Holding L across
   the injection is not possible: the documented lock order is N -> L -> C and injection takes N
   itself. Residual: two concurrent `ocx sync` runs on one Child that read two different Home
   documents can leave a receipt naming the earlier one; the next sync corrects it, and P6 then
   reports the mismatch rather than hiding it.

Notes folded: the restart route requires the capability principal explicitly (GUI session, admin
token and link key are refused, with tests); it is outside `linkRouteAllowed`. The report POST is
handled before the passive-read dispatch without widening the GET/HEAD table, bound to the stored
link id and its admitted `apiKeyId`, read with a 1 KiB streaming cap and a 5 s deadline; reports for
links no longer in the store are pruned on every write and never projected. `ocx sync` passes a
start callback that never starts a proxy and rechecks connection ownership before restarting; a
live runtime without `startedAt` (older build) counts as stale. Wire names stay camelCase
(`appliedAt`, `runtimeStartedAt`) like every other `ocx ... --json` field; the docs map them to the
brief's `applied_at` / `runtime_started_at`.


Sync restart callback: when discovery first reads absent, start nothing (`skipped`); when an accepted restart left no runtime (`recoveringLiveRestart`), delegate to the ordinary recovery start (`handleRestartStartWhenStopped(true)`) so a vanished Child is brought back.

## Audit round 2 (FAIL) and the revision

1. **Supervised handoff.** Folded by refusal. Under the desktop app or a service supervisor the
   client runtime answers the bound restart with `409 restart_supervised` and keeps serving; the
   CLI reports the restart as not performed and names the supervisor's own restart
   (`ocx service restart` / the desktop app). No supervised exit path exists in the client restart,
   so no code path can leave a supervised Child down. A non-viable service (`OCX_SERVICE=1` without
   viable assets) is treated as unsupervised and uses the rollback path. Consequence: P5 on a
   supervised Child is repaired by the supervisor's restart, not by `ocx sync`; `ocx sync` says so.
   Reported upstream as the open design question (supervisor-coordinated handoff with old-runtime
   fallback would be a separate change in the desktop app and service assets).
2. **Rollback vs CLI recovery.** Folded with one budget. The client restart owns a single deadline
   of 90 s from acceptance: listener drain at most 20 s, replacement readiness until 70 s, then
   termination (SIGTERM, wait for the exit event up to 3 s, SIGKILL, wait up to 2 s; the exit event is
   the confirmation), rebind with a 10 s port wait, publication. The CLI's replacement observation
   runs to about 135 s, so the old pid is back before recovery can become eligible, and the CLI
   then reads the same pid and fails closed. `spawnReplacementStart` takes the shared deadline via
   `io.deadlineAt` and `notReady: "terminate"` returns only after the child's exit is observed.
   Rollback keeps the original `startedAt`.
3. **Concurrent-sync receipt.** Folded by serialization. A link apply (Child `ocx sync` and the
   link branch of `ocx connect`) holds a dedicated apply lock, outermost (before N), from the Home
   read through injection to the receipt write. It reuses the lifecycle lock primitive
   (`withClientLifecycle` with its own `lockPath` under `<configDir>/link/`), `busy_timeout = 0`, so
   a second concurrent apply fails fast with "another apply is in progress" and changes nothing.
4. **Enrollment receipt failure.** Folded as a post-commit warning. `connect --link` keeps the
   committed connection; a failed receipt write is printed as a warning (`Codex settings applied;
   apply record not written; run ocx sync`) and `ocx status` then reports `source: "local"` until a
   sync records it, which P6 shows as missing rather than as parity.


## Audit round 3 (FAIL, two blockers) and the revision

1. **Late acceptance can still overlap rollback with CLI recovery.** Folded with a pre-POST guard.
   `CLIENT_RESTART_BUDGET_MS = 90_000` lives in `src/lib/system-restart-contract.ts`. The client
   `/healthz` advertises `role: "client"`; `requestBoundSystemRestart` refuses to POST to a client
   target (`restart_deadline_expired`, no request sent, runtime untouched) unless
   `deadlineAt - RESTART_REOBSERVE_RESERVE_MS - now >= CLIENT_RESTART_BUDGET_MS + 5_000`. With the
   145 s deadline and 10 s reserve, a client restart is only accepted within the first 40 s, so the
   rollback always finishes before replacement observation ends. The client enforces its own 90 s
   from acceptance. Test: delayed acceptance is refused before POST; an accepted restart with a
   failed replacement is back on the old pid inside the observation window.
2. **409 loses the guidance.** Folded. The client answers
   `409 { error: { code: "restart_supervised", supervisor: "service" | "desktop" } }`.
   `requestBoundSystemRestart` reads that bounded body and returns the validated code
   `restart_supervised_service` / `restart_supervised_desktop`; `src/cli/restart-failure.ts` prints
   "Restart not performed; the running Child runtime was kept. Restart it with `ocx service restart`
   (or from the OpenCodex desktop app)." Any other 409 keeps the existing generic report.


## Contract change from the manager (GOAT H2, goat-si/goat PR #696)

Supersedes the field names and formats above where they differ:

- **OCX-6a**: every link row of the Home's `ocx link status --json` carries `lastApplyAt`, epoch
  **milliseconds** of the Child's last successful settings apply (with `runtimeStartedAt`,
  `appliedCodexSettingsDigest` and `reportedAt` beside it). The Child report uses epoch ms too.
- **OCX-6b**: `ocx status --json` on any device carries top-level `appliedCodexSettingsDigest` =
  lowercase hex SHA-256 (no prefix) of the compact UTF-8 JSON
  `{"version":1,"settings":{"fastMode":…,"multiAgentMode":…,"webSearchSidecarEnabled":…,"subagentDefaults":null|{"model":…,"reasoningEffort":…}}}`
  in exactly that key order, from the values actually applied. Serialized by name, not by a sorting
  canonicalizer. Golden digests for a null and a set `subagentDefaults` are pinned in
  `tests/clients/link-codex-settings-digest.test.ts`. The Child's `lastApplyAt` and
  `runtimeStartedAt` sit beside it as epoch ms.
