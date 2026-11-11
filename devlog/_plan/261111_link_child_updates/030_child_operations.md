# 030 — wp3: Child operations (job engine, sync, restart-codex, update, routes, CLI)

> **Revision 2 (audit r1).** Folds H1 (registration per 000 "Test registration rule"), H2 (A4: launcher for npm/pnpm
> apply only; plan always on the served entry; Bun stays on Bun; Bun and pnpm fixtures), H4 (`runUpdateItem` observes
> Windows Children and takes the Desktop branch before the Windows refusal), H5 (tolerant `validateChildJob`, open
> enum strings), M6 (Section 2 uses the canonical names; the reconciliation list is folded in; `activeJob`,
> `{jobId}`, `ChildOp` from 010), M8 (restart requests refuse `"all"`, run-time activity check with
> `restart-skipped:link-active`, `--yes` for scope `codex`), M9 (`--not-after` on the Child's clock, `plan-expired`,
> `clock-skew` hint) and L12 (base and verifier facts).

> **Revision 4 (CodeRabbit on #8500).** Folds 4529521916 (a restart is sent as a second pinned sync after the plain
> sync and a fresh activity read; the remaining gap is recorded), 4529521925 (an identity sync precedes every update),
> 4529521944 (a failed or rolled-back apply resyncs; an uncertain one is recorded for 070's recovery),
> 4529521956 (the R5 `launcher` check lands here with its field), 4529521968 (a synced item records
> `catalogSyncedEtag`), 4529521982 (engine-wide slots), 4529521993 (the `ocx-child` marker decides the restart
> outcome), 4529522000 (an `ocx-child` observe ends `unsupported`/`ephemeral`), 4529522006
> (`post-update-sync-failed` exits 6), 4529522014 (`childObservationsPath` from `paths.ts`), 4529522063 (an
> automatic sync rechecks eligibility when its item starts) and 4529522112 (`pendingUpdateRecovery`).
> Also 4529521950: on a non-loopback Home the CLI verbs name the loopback requirement instead of a bare 403 (Section 10).

> **Revision 5 (wp3 P re-verification on dev 87e005f93c, wp1 #8505 and wp2 #8508 merged).** Every before-code snippet,
> anchor and name was rechecked against the merged code; Section 2 now edits what wp2 shipped instead of what 020
> planned. The engine keeps wp2's single engine-wide queue (three items across all jobs, plus at most one update item),
> busy items still write no `lastOperation`, and `"all"` still means every link (so `no_eligible_links` stays "this
> Home has no links"). The CLI keeps wp2's `validateChildJob`, `linkCheckExitCode`, JSON output and conflict messages,
> and its wait deadline no longer runs while items are queued. `childSkipHint` moves (wp1 left it in src/cli), the
> restarting sync passes `expectSelectedKind`, a Windows gated `update` without `--plan` is refused, and the legacy
> activity limit is documented. Full list: "wp3 P re-verification (base dev 87e005f93c)" at the end.

- **Work-phase:** wp3. **Depends on:** wp1 ([010](010_foundations.md)), wp2 ([020](020_signals_visibility.md)).
- **Class:** C4. New mutating management routes, remote update execution over the pinned SSH channel,
  a new CLI contract (`link.child-ops/1`). Explicit security review is required before merge
  (`src/AGENTS.md`, `MAINTAINERS.md`; 000 "Work class").
- **Base:** `dev` 87e005f93c (revision 5), which contains wp1 (#8505) and wp2 (#8508).

**Outcome.** The Home can run three operations on any Home-initiated Child from the management API and
the CLI: `sync` (the pinned `sync --expect-link` with an optional restart scope), `restart-codex` (the
same pinned sync carrying `--restart-app-server-only` or `--restart-codex`, which works on every full
Child at or above 2.93.0, D13/F2) and `update` (the Child's own `update.orchestrated/1` command,
version-gated inside the remote script, target always the Home's version, followed by a pinned sync,
D12). Every operation is a job in one process-wide engine that serializes work per link, runs at most three
items at a time across all jobs (wp2's single engine-wide queue) of which at most one is an update item, keeps 32
finished jobs or one hour, and records each item that ran as `lastOperation` in the observation cache.
`DELETE /api/link/{id}` answers `409 link_operation_in_progress` while a job holds the link. Operators
get `ocx link update|sync|restart-codex`; agents see contract `link.child-ops/1` in `ocx capabilities`.

**IN:** `src/link/child-ops-types.ts`, `src/link/child-ops-engine.ts`, `src/link/child-ops-runners.ts`,
`src/server/management/link-child-ops-routes.ts`, one delegating branch and the DELETE 409 in
`link-routes.ts`, the `childOps` comment on `LinkRouteState`, `src/cli/link-child-ops.ts`,
`link.ts` switch arms and usage, three capabilities, the contract string, `registry.ts` help lines,
`skills/ocx` hand pages plus `bun run skill:surface`, docs-site guide and CLI reference (8 languages),
`structure/remote-link.md` (its manifest entry already owns both non-`src/link` files since wp2).

**OUT:** automatic triggers (policy, scheduler, fan-out: [050](050_auto_catalog_fanout.md); automatic
updates and re-observe: [070](070_auto_updates.md)); GUI buttons, the GUI `LinkErrorCode` entry and its
11 locale keys ([060](060_dashboard.md)); the Desktop `desktop-request` route and the restart outcome
marker ([080](080_child_side_release.md)); widening the local-control socket allowlist; any file under
`src/update/` (D19); `src/cli/index.ts`, `src/server/index.ts`, `serve-options.ts`, `src/types/config.ts`
(no line is added to any of them).

## Interfaces this phase consumes (revision 2: canonical names)

Names follow 000 "Canonical names", which is authoritative. Revision 1 carried an assumed-name table and an
eight-item reconciliation list here; revision 2 folds every item into Section 2, so the code below is the code
the wp3 PR writes. (Item map: 1 → 2.2, 2.4, 2.5, 2.7; 2 → 2.1; 3 and 7 → 2.4 env builder; 4 → 2.3; 5 → 020's
`ObserveOutcome.probe` and 2.3; 6 → Section 1 rows; 8 → 2.2.)

| Producer | Symbol | Behaviour wp3 relies on |
|---|---|---|
| wp1 `src/link/ssh-argv.ts` | `remotePinnedSyncArgv(linkId, platform = "posix", opts: PinnedSyncOptions = {})` (:440), `remoteGatedOcxArgv(cmd: GatedOcxCommand, platform = "posix")` (:421), `GatedOcxCommand` (:328-341: `minVersion`, `lacksMarker`, `acceptEphemeral`, `reportEntry`, `reportClock`, `reportSelectedKind?`, `args`), `assertGated` (:348-353) | Gate ≥ 2.93.0 for sync (exit 121 + marker); with `restart` exactly one of `--restart-app-server-only` / `--restart-codex` after `--json` and `reportSelectedKind: true` (D2); a Windows restart throws `unsupported:windows-restart` (:443). The Windows branch refuses `update` only when it carries `--yes` (:424-425); wp3 tightens it (A4). wp3 adds the `launcher` field (A4 below). |
| wp1 `src/link/child-gated-ocx.ts` | `SshResult` (:6), `remoteUpdatePlanArgv(homeVersion, platform)` (:26), `remoteUpdateApplyArgv({ homeVersion, planToken, notAfter }, platform)` (:37), `readGatedFraming` (:55), `classifyUpdatePlanProbe` (:88), `classifyUpdateApply(result): UpdateApplyVerdict` (:105) | `UpdateApplyVerdict = { state: ApplyState; reason; fromVersion?; toVersion?; suppressTarget; reobserve }` (child-update-contract.ts:32); ssh 255 ⇒ `uncertain/ssh-failed`, exit 11 ⇒ `failed` with `suppressTarget: true`. A token starting with `-` drops `--expect-plan` (:44). wp3 adds `viaLauncher` and the `child-node-unavailable` refusal (A4). |
| wp1 `src/link/child-observations.ts` | `ChildOp` (:20), `ChildOperationSummary` (:22), `ChildObservation` (:26), `withoutCarriedFields` (:123), `readChildObservations(path = childObservationsPath())` (:146), `updateChildObservations` (:167), `patchChildObservation(file, linkId, patch, now: Date)` (:195) | Tolerant cache (D4); a write prunes ids absent from `links.json`; `CARRIED_OBSERVATION_FIELDS` (:46) survive an observe. |
| wp1 `src/link/sync-fanout-classify.ts` | `classifySyncResult(result, options: { expectSelectedKind?: boolean } = {})` (:51), `ChildVerdict` (:14, carries `executable?: "ocx-child"`) | The `selected-kind` marker is read only with `expectSelectedKind: true`, so the restarting sync must pass it (2.3). `childSkipHint` was NOT moved: it is a private function at src/cli/sync-fanout.ts:13-23, so wp3 moves it (Section 1). |
| wp2 `src/link/child-observe.ts` | `observeChild(record, deps: ObserveDeps): Promise<ObserveOutcome>` (:63), `ObserveDeps` (:15-19: `runner`, `knownHostsFile`, `homeVersion`, `peer`, `platformOf`, `inspect`, `now: () => Date`) | `ObserveOutcome = { state: "succeeded" \| "owner-action" \| "unsupported" \| "offline" \| "failed"; reason; observation; probe }`; `probe = { classification; childNowMs; startedAt; platform } \| null` (:25). A client-initiated record returns `unsupported/child-initiated` with a peer-only observation and no SSH (:64-68); an `ocx-child` returns `succeeded` with `probe: null`. |
| wp2 `src/link/child-activity.ts` | `LinkActivitySnapshot` (:6), `isLinkIdle(snapshot, now, idleAfterMs)` (:22), `DEFAULT_IDLE_AFTER_MS` (:4) | Listener `linkActivity(linkId, now)` (link-route-state.ts:39); absent ⇒ never idle. A legacy key admission counts only once its response status is known and below 400 (src/server/index/link-relay-sessions.ts:136-153); see Section 10. |
| wp2 `src/link/child-ops-engine.ts` | `createChildOpsEngine(deps: { readStore; observe; writeObservation; now?: () => Date; jobId?; concurrency? })` (:43), `submit({ op: "observe", linkIds, trigger })`, `job`, `activeJob`, `settled`; constants `CHILD_JOB_SCHEMA`, `CHILD_OPS_CONCURRENCY` (3), `CHILD_JOB_RETENTION_MS`, `CHILD_JOB_RETENTION_COUNT` (:28-31); job types declared inline (:8-17) | One engine-wide `pending` queue pumped while `active < concurrency` (:58-60, :108-119); a held link makes a single-link submit 409 and a multi-link item `busy` with `ran = false`, which writes no `lastOperation` (:75-84); `"all"` is every link in the store and `no_eligible_links` is returned only when the store is empty (:126-128); retention is applied on submit and on `job()` (:66-72). wp3 rewrites this file (2.2). |
| wp2 `src/server/management/link-child-ops-routes.ts` | `catalogRevisionForRoutes` (:27), `parseOperation` (:41), `childOpsEngineFor(ctx, state)` (:51-66, `state.childOps ??= createChildOpsEngine(...)`), `attachLinkChildOpsForState` (:69-86, flushes deferred catalog pulls first), `handleLinkChildOpsRoutes` (:88-116: `auth(ctx, "either")` first, `409 runtime_role_client` on a Child, `503 link_unavailable` when the store read throws) | wp3 rewrites the engine accessor, `parseOperation` and the POST branch, and adds `childOpsEnvFor` (2.4). |
| wp2 `src/cli/link-child-ops.ts` | `validateChildJob` (:33, already tolerant: unknown keys dropped, enum fields kept as any string ≤ 256), `linkCheckExitCode` (:73: 0 success, 6 `busy`/`offline`/`refused`/`owner-action`/`unsupported`, 1 anything else including an unknown state), `runLinkCheck` (:90), `OLD_HOME_MESSAGE`, `NO_ELIGIBLE_LINKS_MESSAGE`, `RUNTIME_ROLE_CLIENT_MESSAGE` (:14-16), deadline `ceil(items/3) × 120 s + 30 s` from submission (:125) | The validator keeps only `sync.state` / `restart.outcome` plus `reason` (:51-58), so it drops `restart.requested`; wp3 extends it (2.8). |
| wp2 `src/lib/catalog-etag.ts` | `catalogEtag(body)` | Pure; `createCatalogRevisionMonitor` hashes with it, so `current()?.etag` is what `/v1/catalog` serves. |

## A4 — Remote apply of npm and pnpm Children through the package launcher

**Problem (from 010, verified here).** The gated script prefers the served pair recorded in `serving-runtimes.json`,
`[bun, <root>/src/cli/index.ts]` for a package install (`REMOTE_SERVED_RUNTIME` and `remoteServedRuntimeAttempt`,
src/link/ssh-argv.ts:152-200; the pair is what `currentServingCommand` records, src/config/serving-runtimes.ts:55-58).
The Node launcher is where npm/pnpm orchestrated apply lives: `bin/ocx.mjs:1362-1393` runs `applyNodeOrchestratedUpdate` only for
`mode === "apply"` on an npm/pnpm `node_modules` install. The Bun entry never gets there: for a plan that `canApply`
with `installer` npm or pnpm it falls through to `src/update/orchestrated-entry.ts:224-233` and prints a result with
`error: "plan-unavailable"`, exit 10. So without a change every npm/pnpm Child that has a census entry ends
`launcher-bypassed` (010's interim row, child-update-contract.ts:129), which contradicts A4.

**Decision (revision 2, audit H2).** The launcher route is used **only for the apply step** and **only when the parsed
plan says `installer` is `npm` or `pnpm`**. The Home decides from the plan it parsed, not the remote script from a path
pattern: a Bun global install's census root (`~/.bun/install/global/node_modules/@bitkyc08/opencodex`) also contains
`/node_modules/` and `bin/ocx.mjs`, and sending it through Node would run the launcher's ordinary bootstrap (the npm
apply at `bin/ocx.mjs:1362-1363` excludes it through `isBunGlobalInstall`, :109-111).
- **Plan:** always the served entry, as today. The script only *reports* whether a launcher Node exists
  (`ocx-fanout:launcher:available` / `unavailable`) and never exits because Node is missing. The served-entry plan is
  also what the launcher's own apply recomputes before it mutates (its `plan` callback runs `bun --no-env-file <cliPath>
  update --plan --json --version <v>`, bin/ocx.mjs:1367-1368), so the `planToken` the Home holds matches.
- **Apply, installer npm or pnpm:** `<node> <root>/bin/ocx.mjs update --yes --json --version <home> --expect-plan <token>
  --not-after <ms>`, which is what `ocx update --yes --json ...` through the npm shim runs on the Child (package.json
  `"bin": {"ocx": "./bin/ocx.mjs"}`). The launcher's package-manager self-update path (bin/ocx.mjs:1359) requires
  `OCX_UPDATE_ORCHESTRATED_CHILD=1`; the script `unset`s it before `exec`, so the remote apply can only take the
  orchestrated branch (or refuse). No `src/update/*` file changes.
  (Revision 5: the self-update branch is `bin/ocx.mjs:1359-1361`; `childArgs` is parsed only when the variable is
  `"1"`, :1351-1352.)
- **Apply, installer bun (or any other):** the served entry, unchanged.

**Node resolution, in order** (the npm shim relies on `env node`, which a non-interactive SSH shell often lacks, for
example with nvm): (1) npm global layout: root ends in `/lib/node_modules/@bitkyc08/opencodex` ⇒ `<prefix>/bin/node`;
(2) `command -v node` on the script's extended PATH (pnpm global and other layouts); (3) neither answers `--version` ⇒
plan: `launcher:unavailable` and the plan still runs; apply: `ocx-fanout:child-node-unavailable`, exit 121, nothing ran.

**Changes to wp1 files (MODIFY in wp3).**
- `src/link/ssh-argv.ts` (where `remoteGatedScript` lives, 010 deviation 1): `GatedOcxCommand` gains
  `launcher: "none" | "report" | "apply"` (`remotePinnedSyncArgv` passes `"none"`), and `assertGated` gains the
  audit r2 R5 check in the same diff (Revision 4: it cannot land in wp1, which has no such field):
  `if (cmd.launcher !== "none" && cmd.launcher !== "report" && cmd.launcher !== "apply") throw new LinkSshArgumentError("invalid gated ocx launcher");`
  Revision 5 placement against the merged script (`remoteGatedScript`, ssh-argv.ts:360-419): `launcher=<none|report|apply>` and the
  `find_launcher_node` definition go at the top of the script, after `umask 077` (:375) and before `try_ocx()`
  (:379), so the function is defined once; the two lines that end `try_ocx` (:414-415, `printf ... stdout-begin` and
  `exec "$c" ${ocx_entry:+"$ocx_entry"} "$@"`) are replaced by the block below. Inside `try_ocx`, `"$@"` is already
  the command's arguments (`c=$1; shift`, :380), and the `rm -rf "$dir"; trap - ...` cleanup (:412) still runs first.
  Top of script:
  ```sh
  launcher=<none|report|apply>
  find_launcher_node() {
    case "$1" in */lib/node_modules/@bitkyc08/opencodex)
      n=${1%/lib/node_modules/@bitkyc08/opencodex}/bin/node
      if [ -x "$n" ] && "$n" --version >/dev/null 2>&1; then printf '%s\n' "$n"; return 0; fi;; esac
    n=$(command -v node 2>/dev/null) && [ -x "$n" ] && "$n" --version >/dev/null 2>&1 && printf '%s\n' "$n"
  }
  ```
  End of `try_ocx`:
  ```sh
  root=; [ -n "$ocx_entry" ] && root=${ocx_entry%/src/cli/index.ts}
  case "$root" in */node_modules/*) [ -f "$root/bin/ocx.mjs" ] || root=;; *) root=;; esac
  if [ -n "$root" ] && [ "$launcher" = report ]; then
    if [ -n "$(find_launcher_node "$root")" ]; then printf '%s\n' 'ocx-fanout:launcher:available' >&2
    else printf '%s\n' 'ocx-fanout:launcher:unavailable' >&2; fi
  fi
  if [ -n "$root" ] && [ "$launcher" = apply ]; then
    node_bin=$(find_launcher_node "$root")
    [ -n "$node_bin" ] || { printf '%s\n' 'ocx-fanout:child-node-unavailable' >&2; exit 121; }
    printf '%s\n' 'ocx-fanout:launcher:exec' >&2
    printf '%s\n' 'ocx-fanout:stdout-begin'
    unset OCX_UPDATE_ORCHESTRATED_CHILD
    exec "$node_bin" "$root/bin/ocx.mjs" "$@"
  fi
  printf '%s\n' 'ocx-fanout:stdout-begin'
  exec "$c" ${ocx_entry:+"$ocx_entry"} "$@"
  ```
  `launcher=<none|report|apply>` is a constant spliced from the closed union (like the version literals); no
  Home-supplied value enters the script except `"$@"`, as today. A `launcher=apply` run without a census pair (the
  `ocx` shim was selected) falls through to `exec "$c"`, which already is the launcher under the shim's Node.
  The template literal escapes `$` and backslashes as the existing script does (`\${...}`, `\\n`).
- `src/link/ssh-argv.ts` `remoteGatedOcxArgv` Windows branch (Revision 5, carried item d), before (:424-425):
  `if (cmd.args[0] === "update" && cmd.args.includes("--yes")) throw new LinkSshArgumentError("unsupported:windows-apply");`
  After: any `update` that is not a plan is refused, so an apply spelled without `--yes` (or a future mutating flag)
  can never be built for Windows:
  `if (cmd.args[0] === "update" && (!cmd.args.includes("--plan") || cmd.args.includes("--yes"))) throw new LinkSshArgumentError("unsupported:windows-apply");`
  Cases in `tests/clients/link-gated-ocx-argv.test.ts` (MODIFY): Windows `["update", "--json", "--version", "2.100.0"]`
  and `["update", "--plan", "--yes", "--json"]` throw `unsupported:windows-apply`; `remoteUpdatePlanArgv(v, "windows")`
  still builds; POSIX `update` without `--plan` still builds.
- `src/link/child-gated-ocx.ts`: `remoteUpdatePlanArgv` passes `launcher: "report"`. `remoteUpdateApplyArgv`'s input gains
  `viaLauncher: boolean` and passes `launcher: viaLauncher ? "apply" : "none"`. Windows builders ignore the field
  (apply is refused there, D20; a Windows plan reports nothing). `readGatedFraming` learns at most one
  `launcher:(available|unavailable|exec)` line (two ⇒ `invalid`) and returns it as `launcher`; the 121 marker set gains
  `child-node-unavailable`, and `classifyUpdateApply` maps that refusal to `owner-action`/`launcher-node-missing`.
  Revision 5 anchors: `UPDATE_GATE` (:17) gains `launcher: "none"`; `GatedFraming`'s `ran` arm (:11) gains
  `launcher: "available" | "unavailable" | "exec" | null`; `GatedRefusal` (:7) and the `REFUSAL` pattern (:47) gain
  `child-node-unavailable`; in `classifyUpdateApply` (:110-112) the refused arm checks it before the `legacy-ocx`
  fallback; `classifyUpdatePlanProbe` (:100-102) passes `launcher: framing.launcher === "exec" ? null : framing.launcher`
  into the classifier ctx (a plan never execs the launcher).
- `src/link/child-update-contract.ts`: `classifyChildUpdatePlan`'s ctx gains `launcher: "available" | "unavailable" | null`;
  the `launcher-bypassed` row becomes three rows for `canApply`, `installer ∈ {npm, pnpm}`, `entry: "pair"`:
  `launcher: "available"` ⇒ `orchestrated`; `"unavailable"` ⇒ `owner-action`/`launcher-node-missing` with the hint
  "Install Node.js where the npm or pnpm that installed OpenCodex on <alias> can find it, or update there with ocx
  update"; `null` ⇒ `owner-action`/`launcher-bypassed` (a pair root without a launcher; not reachable for npm/pnpm).
  `installer: "bun"` ignores the launcher report.
- `src/link/child-ops-runners.ts` (2.3) sets `viaLauncher: plan.installKind === "npm" || plan.installKind === "pnpm"`.

**Proof — tests/clients/link-child-update-launcher.test.ts (NEW, POSIX; `test.skipIf(process.platform === "win32")`
because the script is POSIX and Windows apply is refused).** Each case builds a fake install under a temp HOME and runs
the real script with `sh -c <script> ocx-gated <args...>` (the argv `buildExecArgv` would send, minus ssh): stub `bun`
answers `--version` with `opencodex 2.98.0` and logs every other argv to `bun.log`; stub `node` logs its argv to
`node.log`; `$OPENCODEX_HOME/serving-runtimes.json` is written with `recordServingRuntime` as `[<bun>, <root>/src/cli/index.ts]`.
- `npm global: apply runs <prefix>/bin/node <root>/bin/ocx.mjs` — layout `<prefix>/lib/node_modules/@bitkyc08/opencodex`,
  apply argv with `viaLauncher: true`; `node.log` holds `<root>/bin/ocx.mjs update --yes --json --version 2.100.0
  --expect-plan T --not-after N`; `bun.log` has no `update`; stderr carries `launcher:exec`.
- `npm global: plan stays on the pair and reports the launcher` — plan argv: `bun.log` holds `<entry> update --plan --json
  --version 2.100.0`, stderr `launcher:available`, `node.log` empty.
- `plan never exits on a missing Node` (H2) — same npm layout, no node anywhere: exit 0, `bun.log` holds the plan,
  stderr `launcher:unavailable`, no `child-node-unavailable`.
- `Bun global: plan and apply stay on the served Bun entry` (H2) — root `<tmp>/.bun/install/global/node_modules/@bitkyc08/opencodex`
  with `bin/ocx.mjs` present and a stub `node` first on PATH; apply argv with `viaLauncher: false` (what the runner builds
  for `installer: "bun"`): `bun.log` holds the apply argv, `node.log` empty, exit 0. Repeat with no node anywhere: plan
  and apply both exit 0 on Bun.
- `pnpm layout uses PATH node` — root `<tmp>/pnpm/global/5/node_modules/@bitkyc08/opencodex`, no prefix node, stub
  `node` first on PATH, `viaLauncher: true` ⇒ `node.log` holds the apply argv. (A real pnpm global install is NOT VERIFIED,
  see residual risk.)
- `apply without Node ⇒ 121 child-node-unavailable, nothing ran` — npm layout, `viaLauncher: true`; both logs free of `update`.
- `OCX_UPDATE_ORCHESTRATED_CHILD is cleared` — set in the parent env; the stub node logs it absent.
- `a 2.96 pair never reaches either entry` — stub `bun --version` prints `opencodex 2.96.0` ⇒ exit 121 lacks marker, both
  logs empty (F1).
- `source checkout pair keeps the Bun entry` — root without `node_modules`, `viaLauncher: true` ⇒ `bun.log` gets the apply
  argv (its plan is `owner-action`, so the Home never sends this; the case pins the guard).
Unit rows in `link-child-update-contract.test.ts` (010's file, MODIFY): the three launcher rows above plus
`installer bun with launcher unavailable ⇒ orchestrated`. Runner rows in `link-child-ops-runners.test.ts`:
`installer bun ⇒ apply argv without launcher=apply` and `installer npm ⇒ launcher=apply`.
Registration: `"link-child-update-launcher.test.ts": "clients"` per 000 "Test registration rule".

**Residual risk and what is not proven.** The fixture proves which program receives which arguments; it does not run
a real npm apply (that would mutate an install). The launcher's own installer detection on a pnpm realpath root
(`installOwnership`, bin/ocx.mjs:100-110) is assumed to match what the pnpm shim sees, because the shim also executes
the real `bin/ocx.mjs`; NOT VERIFIED on a real pnpm global install. Acceptance criterion 4 is restated: on a 2.97+ npm
Child with a census pair, the apply argv goes to the launcher (fixture), the plan stays on the Bun entry, and a Bun
global Child never touches Node.

## 1. File change map

| Path | Kind | Purpose | Current anchor |
|---|---|---|---|
| src/link/child-ops-types.ts | NEW | Job, item, env and runner types; closed op and state vocabularies | — |
| src/link/child-ops-engine.ts | MODIFY (020 file, rewritten) | Job registry, per-link lock, wp2's engine-wide queue plus one update slot, retention, `lastOperation` write, shared instance and its test reset | whole file (162 lines) |
| src/link/child-ops-runners.ts | NEW | Item runners for `observe` (020's dispatch moved here), `sync`, `restart-codex`, `update` (D12, D13) | — |
| src/link/ssh-argv.ts, src/link/child-gated-ocx.ts, src/link/child-update-contract.ts | MODIFY (010 files) | A4 launcher field, `viaLauncher`, framing and classifier rows; Windows `update` without `--plan` refused | ssh-argv.ts:328-353, :360-419, :424-425; child-gated-ocx.ts:7-19, :37-52, :100-112; child-update-contract.ts:118, :129 |
| src/link/sync-fanout-classify.ts | MODIFY | Export `childSkipHint(reason, alias): string`, moved byte for byte | wp1 left it private in src/cli/sync-fanout.ts:13-23 |
| src/cli/sync-fanout.ts | MODIFY | Delete the private copy; import it from `../link/sync-fanout-classify` for :70 | :13-23, :70 |
| src/server/management/link-child-ops-routes.ts | MODIFY (020 file) | All ops on `POST /api/link/children/operations`, env builder, shared engine accessor | :41-66, :84, :88-116 |
| src/server/management/link-route-state.ts | MODIFY (comment only) | `childOps` becomes the test seam for the shared engine | :53 |
| src/server/management/link-routes.ts | MODIFY | DELETE 409 (the delegating branch exists since wp2) | :201-205; branch :352-356 |
| src/cli/link-child-ops.ts | MODIFY (020 file) | `ocx link update|sync|restart-codex`, shared wait loop with the queued-aware deadline, partial reasons in the exit mapping, `restart.requested` in the validator, 403 and no-links messages | :14-21, :33-70, :73-82, :90-136 |
| src/cli/link.ts | MODIFY | Usage lines, switch arms, exit passthrough | :38-51, :393-410 |
| src/cli/capabilities-access-remote.ts | MODIFY | Three capabilities; the `link check` detail's no-links wording | :168-177 (check entry), before `];` at :178 |
| src/cli/capability-contracts.ts | MODIFY | `link.child-ops/1` | :2 |
| src/cli/registry.ts | MODIFY | Link help lines | :153-166 |
| skills/ocx/references/01_surface_access-remote.md, 01_management_surface.md | REGENERATE | `bun run skill:surface` | generated |
| skills/ocx/references/05_remote_hub.md, 04_failure_semantics.md, 02_json_shapes.md | MODIFY | Hand pages | 05: "Checking Children from the Home" :330-345; 04: exit table row 6 :17, check paragraph :32, "A pinned sync that refuses" :143; 02: "Remote Link Child block and job document" :401-419 |
| docs-site/src/content/docs/guides/remote-link.md + fr, ja, ko, ru, tr, zh-cn, zh-tw | MODIFY | "Operating Children from the Home" section and CLI reference block | CLI reference :139-152 (check line :149); "Home and Child versions" :165-193 |
| docs-site/src/content/docs/reference/cli/lifecycle.md + the same 7 locales | MODIFY | `ocx link update|sync|restart-codex` section | after the check paragraph (:1369), before "Remote Link Child attestations" (:1377) |
| structure/remote-link.md, structure/INDEX.md | MODIFY / REGENERATE | Rewrite wp2's job paragraph for all four ops (manifest :1356 already lists both files, INDEX.md :261, :463) | :73 |
| tests/clients/link-child-ops-engine.test.ts, tests/clients/link-child-ops-runners.test.ts, tests/clients/link-child-update-launcher.test.ts, tests/cli/cli-link-child-ops.test.ts | NEW | Section 5 | — |
| tests/server/link-child-ops-routes.test.ts, tests/cli/cli-link-check.test.ts, tests/clients/link-child-update-contract.test.ts, tests/clients/link-gated-ocx-argv.test.ts | MODIFY (020 / 010 files) | Section 5 | — |
| scripts/test-layout/layout-clients.json, tests/fixtures/test-layout-expected.json | MODIFY | Register the four NEW tests | after the last entries (layout-clients.json:191, test-layout-expected.json:1662), before each closing `}` |

Registration follows 000 "Test registration rule": `scripts/test-layout/layout.json` is 1999 lines on 87e005f93c
(one line from the ratchet), so no entry goes there; every new test goes into the `layout-clients.json` shard (192
lines), which already maps `cli` and `server` tests (layout-clients.json:14-15, :190-191) as well as `clients` ones.
The last entry gains a comma; the new lines follow it.
`link-child-ops-routes.test.ts` is 020's file and is not registered again.
None of the files this phase touches is in `tests/fixtures/file-size-baseline.json` (checked on 87e005f93c).

## 2. Changes

### 2.1 src/link/child-ops-types.ts (NEW, full content)

020 declared the job types inline in its engine; wp3 moves them here and the engine imports them. `ChildOp` is
declared once, in 010's `child-observations.ts` (000 "Canonical names").
Revision 5: wp2's inline declarations are child-ops-engine.ts:8-17 and `CHILD_JOB_SCHEMA` at :28; wp2's
`ChildJobItem` has no `sync` or `restart` and its `ChildJob.restart` is always `"none"`. The only importer of those
types outside the engine is src/cli/link-child-ops.ts:1, which switches its import to `../link/child-ops-types`
(2.8). The engine re-exports `CHILD_JOB_SCHEMA` so its existing import sites keep compiling.

```ts
import type { LinkRecord, LinkStore } from "./store";
import type { SshRunner } from "./ssh-runner";
import type { LinkWireState } from "./status-projection";
import type { ChildObservation, ChildOp } from "./child-observations";
import type { ObserveOutcome } from "./child-observe";

export type { ChildOp } from "./child-observations";
export const CHILD_JOB_SCHEMA = "ocx.link.child-job/1" as const;
export const CHILD_OPS = ["observe", "sync", "restart-codex", "update"] as const satisfies readonly ChildOp[];
export type ChildRestart = "none" | "app-server" | "codex";
export type ChildTrigger = "manual" | "auto";
export const CHILD_ITEM_STATES = ["queued", "running", "succeeded", "up-to-date", "busy", "offline",
  "refused", "owner-action", "unsupported", "failed", "uncertain"] as const;
export type ChildItemState = typeof CHILD_ITEM_STATES[number];
/** "skipped": withheld because a relayed model request was in flight (A2, reason restart-skipped:link-active). */
export type ChildRestartOutcome = "requested" | "unsupported" | "not-run" | "skipped";
export const RESTART_SKIPPED = "restart-skipped:link-active";

export interface ChildJobItem {
  linkId: string;
  alias: string;
  state: ChildItemState;
  /** Closed reason vocabulary (Section 4). Never remote output. */
  reason: string | null;
  hint?: string;
  fromVersion?: string;
  toVersion?: string;
  /** executable: set only when 010's selected-kind marker reported ocx-child (Revision 4). */
  sync?: { state: "synced" | "skipped" | "failed" | "timed-out"; reason: string | null; executable?: "ocx-child" };
  restart?: { requested: "app-server" | "codex"; outcome: ChildRestartOutcome };
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ChildJob {
  schema: typeof CHILD_JOB_SCHEMA;
  jobId: string;                       // "ljob_" + 16 lowercase hex
  op: ChildOp;
  trigger: ChildTrigger;
  restart: ChildRestart;
  state: "queued" | "running" | "done";
  createdAt: string;
  finishedAt: string | null;
  items: ChildJobItem[];
}

export type ItemOutcome = Omit<ChildJobItem, "linkId" | "alias" | "startedAt" | "finishedAt">;

/** Everything an item needs from the Home process; built per submit by the route (2.4) or the wp5 host. */
export interface ChildOpsEnv {
  readStore(): LinkStore;
  runner: Pick<SshRunner, "run">;
  knownHostsFile: string;
  wireState(linkId: string): LinkWireState | null;
  /** idle = isLinkIdle(snapshot, now, idleAfterMs); null when the listener has no activity book (never idle). */
  activity(linkId: string): { idle: boolean; inFlight: number } | null;
  homeVersion: string;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** observeChild(record, ObserveDeps) bound to this env's runner, known hosts, Home version and peer reports. */
  observe(record: LinkRecord): Promise<ObserveOutcome>;
  readObservation(linkId: string): ChildObservation | null;
  /** updateChildObservations(file => patchChildObservation(file, linkId, patch, new Date(now()))). */
  writeObservation(linkId: string, patch: Partial<ChildObservation>): void;
  /** Revision 4: the Home catalog etag now (020 monitor); a synced item records it as catalogSyncedEtag. */
  catalogEtag(): string | null;
  /** Revision 4: 050's host sets it for automatic jobs; a sync item re-asks it when the item starts. Absent ⇒ allowed. */
  autoSyncAllowed?(linkId: string): boolean;
}

export type ItemRunner = (record: LinkRecord, job: Readonly<Pick<ChildJob, "op" | "trigger" | "restart">>,
  env: ChildOpsEnv) => Promise<ItemOutcome>;
```

### 2.2 src/link/child-ops-engine.ts (MODIFY, 020 file; full content after wp3)

Revision 5: this is wp2's engine (src/link/child-ops-engine.ts on 87e005f93c) generalised, not 020's planned one. What
stays from wp2: one engine-wide `pending` queue pumped while fewer than three items run, held links make a single-link
submit 409 and a multi-link item `busy` that writes no `lastOperation` (it never touched the link; its holder owns
that field), `"all"` is every link in the store so `no_eligible_links` means "this Home has no links", an all-held
multi-link job finishes at once with every item `busy` (202, no 409), retention is applied on `submit` and `job()` with
no timer, `activeJob` reports the job's state, the observation-write failure is logged by error name only, and the
option names `jobId` and `concurrency`. What changes: the deps fixed at creation become the per-job `ChildOpsEnv` passed
to `submit(request, env)` (every timestamp and retention check of a job uses its env's clock), wp2's `observe` dispatch
becomes `runObserveItem` (2.3), at most one update item runs at a time (it also uses one of the three places, and a
waiting update does not hold up the items queued behind it), the three other ops answer a client-initiated link
without running anything, and one shared instance exists per process. The job types move to `child-ops-types.ts`.

```ts
import { randomBytes } from "node:crypto";
import type { ChildObservation, ChildOperationSummary } from "./child-observations";
import { CHILD_JOB_SCHEMA, type ChildJob, type ChildJobItem, type ChildOp, type ChildOpsEnv, type ChildRestart,
  type ChildTrigger, type ItemOutcome, type ItemRunner } from "./child-ops-types";
import { runObserveItem, runRestartCodexItem, runSyncItem, runUpdateItem } from "./child-ops-runners";
import type { LinkRecord } from "./store";

export { CHILD_JOB_SCHEMA } from "./child-ops-types";
export const CHILD_OPS_CONCURRENCY = 3;
/** Update items run one at a time across the engine; each also takes one of the CHILD_OPS_CONCURRENCY places. */
export const CHILD_OPS_UPDATE_CONCURRENCY = 1;
export const CHILD_JOB_RETENTION_MS = 60 * 60 * 1000;
export const CHILD_JOB_RETENTION_COUNT = 32;

export interface ChildOpRequest { op: ChildOp; linkIds: readonly string[] | "all"; restart: ChildRestart; trigger: ChildTrigger }
export type SubmitRefusal = "link_not_found" | "link_not_home_initiated" | "link_operation_in_progress" | "no_eligible_links";
export type SubmitResult = { ok: true; job: ChildJob } | { ok: false; code: SubmitRefusal; linkId: string | null };
export interface ChildJobHold { jobId: string; op: ChildOp; state: "queued" | "running" }

export interface ChildOpsEngine {
  /** Synchronous admission: locks are taken before it returns, so a DELETE racing it sees them. */
  submit(request: ChildOpRequest, env: ChildOpsEnv): SubmitResult;
  /** A structuredClone snapshot. */
  job(jobId: string): ChildJob | undefined;
  activeJob(linkId: string): ChildJobHold | null;
  /** Resolves once no job of this engine is queued or running. Tests and shutdown only. */
  settled(): Promise<void>;
}

export interface ChildOpsEngineOptions {
  runners?: Partial<Record<ChildOp, ItemRunner>>;
  jobId?: () => string;
  /** Default and maximum CHILD_OPS_CONCURRENCY. */
  concurrency?: number;
}

const DONE: ReadonlySet<string> = new Set(["succeeded", "up-to-date", "busy", "offline", "refused", "owner-action", "unsupported", "failed", "uncertain"]);
const errorName = (error: unknown): string => error instanceof Error ? error.name : "unknown";
const iso = (env: ChildOpsEnv): string => new Date(env.now()).toISOString();

/** 010's persisted slice; called after finishedAt is set. */
export function summarize(job: ChildJob, item: ChildJobItem): ChildOperationSummary {
  return { op: job.op, jobId: job.jobId, state: item.state, reason: item.reason, finishedAt: item.finishedAt!,
    ...(item.fromVersion ? { fromVersion: item.fromVersion } : {}), ...(item.toVersion ? { toVersion: item.toVersion } : {}) };
}

/**
 * The D11 job model: one in-memory registry, one lock per link per Home process, at most three items running across
 * every job and at most one of them an update, finished jobs kept one hour and at most 32. A Home restart loses the
 * jobs only; the observation cache keeps each Child's last result. Items carry closed tokens, never remote text.
 */
export function createChildOpsEngine(options: ChildOpsEngineOptions = {}): ChildOpsEngine {
  const runners: Record<ChildOp, ItemRunner> = { observe: runObserveItem, sync: runSyncItem, "restart-codex": runRestartCodexItem,
    update: runUpdateItem, ...options.runners };
  const newJobId = options.jobId ?? (() => `ljob_${randomBytes(8).toString("hex")}`);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? CHILD_OPS_CONCURRENCY, CHILD_OPS_CONCURRENCY));
  const jobs = new Map<string, { job: ChildJob; env: ChildOpsEnv }>();
  const locks = new Map<string, string>();           // linkId -> jobId
  const idle = new Set<() => void>();
  // One engine-wide FIFO: the bound is on SSH sessions from this Home, not per job.
  const pending: Array<{ job: ChildJob; item: ChildJobItem; env: ChildOpsEnv }> = [];
  let active = 0;
  let activeUpdates = 0;

  const write = (env: ChildOpsEnv, linkId: string, patch: Partial<ChildObservation>): void => {
    try { env.writeObservation(linkId, patch); } catch (error) {
      // The file is a cache and the job document already carries the result.
      console.warn(`[link] child observation write failed linkId=${linkId} error=${errorName(error)}`);
    }
  };
  const running = (): boolean => [...jobs.values()].some(({ job }) => job.state !== "done");
  const prune = (): void => {
    const finished = [...jobs.values()].filter(({ job }) => job.state === "done");
    for (const { job, env } of finished) if (Date.parse(job.finishedAt!) < env.now() - CHILD_JOB_RETENTION_MS) jobs.delete(job.jobId);
    const kept = finished.filter(({ job }) => jobs.has(job.jobId)).sort((a, b) => Date.parse(a.job.finishedAt!) - Date.parse(b.job.finishedAt!));
    for (const { job } of kept.slice(0, Math.max(0, kept.length - CHILD_JOB_RETENTION_COUNT))) jobs.delete(job.jobId);
  };
  /** ran = false: the item never touched its link (busy, child-initiated), so it writes no lastOperation. */
  const finishItem = (job: ChildJob, item: ChildJobItem, env: ChildOpsEnv, outcome: ItemOutcome, ran = true): void => {
    Object.assign(item, outcome);
    item.finishedAt = iso(env);
    if (!ran) return;
    if (locks.get(item.linkId) === job.jobId) locks.delete(item.linkId);
    write(env, item.linkId, { lastOperation: summarize(job, item) });
  };
  const finishJob = (job: ChildJob, env: ChildOpsEnv): void => {
    if (job.state === "done" || job.items.some(item => item.state === "queued" || item.state === "running")) return;
    job.state = "done";
    job.finishedAt = iso(env);
    if (!running()) { for (const resolve of idle) resolve(); idle.clear(); }
  };
  const runItem = async (job: ChildJob, item: ChildJobItem, env: ChildOpsEnv): Promise<void> => {
    item.state = "running";
    item.startedAt = iso(env);
    if (job.state === "queued") job.state = "running";
    let record: LinkRecord | undefined;
    try { record = env.readStore().links.find(link => link.id === item.linkId); } catch { record = undefined; }
    if (!record) { finishItem(job, item, env, { state: "refused", reason: "link-removed" }); return; }
    let outcome: ItemOutcome;
    try { outcome = await runners[job.op](record, job, env); } catch (error) {
      console.warn(`[link] child ${job.op} failed linkId=${item.linkId} error=${errorName(error)}`);
      outcome = { state: "failed", reason: "internal-error" };
    }
    finishItem(job, item, env, DONE.has(outcome.state) ? outcome : { state: "failed", reason: "internal-error" });
  };
  const pump = (): void => {
    // FIFO across jobs; an update waiting for the update place does not hold up the items behind it.
    for (let index = 0; index < pending.length && active < concurrency;) {
      const entry = pending[index]!;
      const update = entry.job.op === "update";
      if (update && activeUpdates >= CHILD_OPS_UPDATE_CONCURRENCY) { index += 1; continue; }
      pending.splice(index, 1);
      active += 1;
      if (update) activeUpdates += 1;
      void runItem(entry.job, entry.item, entry.env).finally(() => {
        active -= 1;
        if (update) activeUpdates -= 1;
        finishJob(entry.job, entry.env);
        pump();
      });
    }
  };

  return {
    submit(request, env) {
      prune();
      const store = env.readStore();
      let records: LinkRecord[];
      if (request.linkIds === "all") {
        records = store.links;
        if (records.length === 0) return { ok: false, code: "no_eligible_links", linkId: null };
      } else {
        records = [];
        for (const linkId of request.linkIds) {
          const record = store.links.find(link => link.id === linkId);
          if (!record) return { ok: false, code: "link_not_found", linkId };
          records.push(record);
        }
        const only = records.length === 1 ? records[0]! : null;
        // observe answers a client-initiated link itself without SSH (020); the other ops need the Home's SSH trust.
        if (only && request.op !== "observe" && only.direction === "client-initiated") return { ok: false, code: "link_not_home_initiated", linkId: only.id };
        if (only && locks.has(only.id)) return { ok: false, code: "link_operation_in_progress", linkId: only.id };
      }
      const job: ChildJob = { schema: CHILD_JOB_SCHEMA, jobId: newJobId(), op: request.op, trigger: request.trigger,
        restart: request.restart, state: "queued", createdAt: iso(env), finishedAt: null,
        items: records.map(record => ({ linkId: record.id, alias: record.alias, state: "queued" as const, reason: null,
          startedAt: null, finishedAt: null })) };
      jobs.set(job.jobId, { job, env });
      job.items.forEach((item, index) => {
        if (locks.has(item.linkId)) finishItem(job, item, env, { state: "busy", reason: "link-operation-in-progress" }, false);
        else if (request.op !== "observe" && records[index]!.direction === "client-initiated") {
          finishItem(job, item, env, { state: "unsupported", reason: "child-initiated" }, false);
        } else { locks.set(item.linkId, job.jobId); pending.push({ job, item, env }); }
      });
      pump();
      finishJob(job, env);
      return { ok: true, job: structuredClone(job) };
    },
    job(jobId) {
      prune();
      const entry = jobs.get(jobId);
      return entry ? structuredClone(entry.job) : undefined;
    },
    activeJob(linkId) {
      const jobId = locks.get(linkId);
      const job = jobId ? jobs.get(jobId)?.job : undefined;
      if (!job || job.state === "done") return null;
      return { jobId: job.jobId, op: job.op, state: job.state };
    },
    settled() {
      if (!running()) return Promise.resolve();
      return new Promise<void>(resolve => { idle.add(resolve); });
    },
  };
}

let shared: ChildOpsEngine | null = null;
/** One engine per Home process, shared by the routes (wp3) and the scheduler (wp5, wp7). */
export function sharedChildOpsEngine(): ChildOpsEngine {
  return shared ??= createChildOpsEngine();
}
/** Tests that reach the routes through handleManagementAPI cannot set LinkRouteState.childOps; they await
 *  sharedChildOpsEngine().settled() and call this in afterEach. Precedent: resetQuotaResetActivationForTests. */
export function resetSharedChildOpsEngineForTests(): void {
  shared = null;
}
```

The engine imports no server, CLI or update module. It is reached only from
`link-child-ops-routes.ts` (lazy through management-api's `/api/link` import) and from the wp5
scheduler, so `tests/lab/core-link-boundary.test.ts` keeps passing unchanged. A submit for `observe` keeps wp2's
behaviour exactly: client-initiated items run `runObserveItem`, which answers without SSH and writes the peer-only
observation (wp2 test "second job on a held link", link-child-ops-routes.test.ts:148-167, keeps passing).

### 2.3 src/link/child-ops-runners.ts (NEW, full content)

```ts
import { buildExecArgv, remotePinnedSyncArgv } from "./ssh-argv";
import { classifyUpdateApply, remoteUpdateApplyArgv } from "./child-gated-ocx";
import { requireRemotePlatform } from "./remote-platform";
import { SshRunnerError, type SshRunResult } from "./ssh-runner";
import { classifySyncResult, childSkipHint } from "./sync-fanout-classify";
import type { LinkRecord } from "./store";
import { RESTART_SKIPPED, type ChildJobItem, type ChildOpsEnv, type ChildRestart, type ItemOutcome,
  type ItemRunner } from "./child-ops-types";
import { withoutCarriedFields } from "./child-observations";

export const SYNC_TIMEOUT_MS = 180_000;
/** The --not-after window, counted on the Child's clock from the plan probe (M9). */
export const APPLY_NOT_AFTER_MS = 120_000;
/** Less than this left of the window when the apply would be sent ⇒ do not send; the next run re-plans. */
export const APPLY_MIN_REMAINING_MS = 15_000;
export const APPLY_GRACE_MS = 120_000;
export const POST_UPDATE_SYNC_RETRY_MS = 30_000;
/** Revision 4: how long an uncertain update stays recorded for recovery (070 imports it from here). */
export const UNCERTAIN_RECOVERY_WINDOW_MS = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
type Platform = "posix" | "windows";
type SyncResult = NonNullable<ChildJobItem["sync"]>;
type RestartReport = NonNullable<ChildJobItem["restart"]>;

function unreachable(record: LinkRecord, env: ChildOpsEnv): ItemOutcome | null {
  const wire = env.wireState(record.id);
  if (wire === null) return { state: "offline", reason: "link-not-in-runtime" };
  return wire === "connected" ? null : { state: "offline", reason: `tunnel-${wire}` };
}

async function platformOf(record: LinkRecord, env: ChildOpsEnv): Promise<Platform | ItemOutcome> {
  if (record.remotePlatform) return record.remotePlatform;
  try { return await requireRemotePlatform(env.runner, record.alias, env.knownHostsFile); }
  catch (error) {
    return error instanceof SshRunnerError && error.code === "timeout"
      ? { state: "offline", reason: "ssh-timeout" } : { state: "failed", reason: "platform-probe-failed" };
  }
}

/** A2 / M8: read when the item runs, not when the job was queued. Unknown activity counts as in flight (020). */
function linkBusy(record: LinkRecord, env: ChildOpsEnv): boolean {
  return (env.activity(record.id)?.inFlight ?? 1) > 0;
}

export async function pinnedSync(record: LinkRecord, platform: Platform, restart: ChildRestart,
  env: ChildOpsEnv): Promise<SyncResult> {
  const argv = remotePinnedSyncArgv(record.id, platform, restart === "none" ? {} : { restart });
  // Revision 4 (4529521968): read the etag before the sync. If the catalog changes during the sync, the recorded etag
  // is the older one, so the fan-out sees the Child as behind and syncs again; it is never credited with a newer one.
  const etag = env.catalogEtag();
  try {
    const result = await env.runner.run(buildExecArgv({ alias: record.alias, knownHostsFile: env.knownHostsFile, argv }),
      { timeoutMs: SYNC_TIMEOUT_MS });
    // Revision 5: wp1's classifier reads the selected-kind marker only when asked (sync-fanout-classify.ts:47-51), and
    // remotePinnedSyncArgv prints it only for a restarting sync; without the option executable is never set.
    const verdict = classifySyncResult(result, { expectSelectedKind: restart !== "none" });
    // Only a synced Home-run sync proves the Child applied the catalog; a GET of /v1/catalog proves only a fetch.
    if (verdict.state === "synced" && etag !== null) {
      try { env.writeObservation(record.id, { catalogSyncedEtag: etag }); } catch { /* cache only */ }
    }
    return verdict;
  } catch (error) {
    return error instanceof SshRunnerError && error.code === "timeout"
      ? { state: "timed-out", reason: "deadline-exceeded" } : { state: "failed", reason: "ssh-runner-failed" };
  }
}

/**
 * The pinned sync with an optional restart that obeys A2: unsupported where it cannot run, withheld while busy.
 * Revision 4 (4529521916): the catalog sync runs first without a restart; activity is read after it; the restart then
 * goes out as a second pinned sync, which is close to a no-op sync. The gap between the activity read and the restart is
 * one SSH round trip instead of a whole sync (up to SYNC_TIMEOUT_MS). It cannot be closed from the Home: the restart
 * executes on the Child, and holding a relayed request at the Home would not save a turn whose app-server is restarting.
 */
async function syncWithRestart(record: LinkRecord, platform: Platform, requested: ChildRestart,
  env: ChildOpsEnv): Promise<{ sync: SyncResult; restart?: RestartReport }> {
  if (requested === "none") return { sync: await pinnedSync(record, platform, "none", env) };
  const sync = await pinnedSync(record, platform, "none", env);
  if (platform !== "posix" || record.childKind === "ephemeral") return { sync, restart: { requested, outcome: "unsupported" } };
  if (sync.state !== "synced") return { sync, restart: { requested, outcome: "not-run" } };
  if (linkBusy(record, env)) return { sync, restart: { requested, outcome: "skipped" } };
  const second = await pinnedSync(record, platform, requested, env);
  // 4529521993: a record without childKind can still select ocx-child, which ignores the flag (010 selected-kind marker).
  if (second.executable === "ocx-child") return { sync, restart: { requested, outcome: "unsupported" } };
  if (second.state === "synced") return { sync, restart: { requested, outcome: "requested" } };
  // The restart was sent but its result is unknown: the item reports the second sync, so it ends uncertain.
  if (second.state === "timed-out") return { sync: second, restart: { requested, outcome: "requested" } };
  return { sync, restart: { requested, outcome: "not-run" } };
}

export function syncOutcome(sync: SyncResult, alias: string): ItemOutcome {
  if (sync.state === "synced") return { state: "succeeded", reason: null, sync };
  if (sync.state === "timed-out") return { state: "uncertain", reason: "deadline-exceeded", sync };
  if (sync.state === "skipped") {
    const reason = sync.reason ?? "child-sync-skipped";
    const hint = childSkipHint(reason, alias);
    if (reason === "child-updating") return { state: "busy", reason, hint, sync };
    if (reason === "child-ocx-lacks-expect-link") return { state: "owner-action", reason, hint, sync };
    if (reason === "child-platform-unsupported") return { state: "unsupported", reason, hint, sync };
    return { state: "refused", reason, hint, sync };          // child-link-mismatch:*, version unknown
  }
  return sync.reason === "ssh-failed" ? { state: "offline", reason: "ssh-failed", sync }
    : { state: "failed", reason: sync.reason ?? "child-sync-failed", sync };
}

/** wp2's observe dispatch (child-ops-engine.ts:91-106 on 87e005f93c) as a runner: fresh fields only, so every carried field survives. */
export const runObserveItem: ItemRunner = async (record, _job, env) => {
  let outcome: Awaited<ReturnType<ChildOpsEnv["observe"]>>;
  // wp2 reports a throwing observe as failed/observe-error, not the engine's internal-error; keep that reason.
  try { outcome = await env.observe(record); } catch { return { state: "failed", reason: "observe-error" }; }
  // Revision 4: every carried field (010 CARRIED_OBSERVATION_FIELDS) survives, including the three revision 4 added.
  if (outcome.observation) env.writeObservation(record.id, withoutCarriedFields(outcome.observation));
  return { state: outcome.state, reason: outcome.reason };
};

export const runSyncItem: ItemRunner = async (record, job, env) => {
  // 4529522063: the scheduler checked idle and the settings digest when it queued the job; the item may have waited
  // behind other Children since. Re-ask at item start; a no answer is busy with no SSH, retried at the next poll.
  if (job.trigger === "auto" && env.autoSyncAllowed?.(record.id) === false) return { state: "busy", reason: "link-active" };
  const offline = unreachable(record, env);
  if (offline) return offline;
  const platform = await platformOf(record, env);
  if (typeof platform !== "string") return platform;
  const { sync, restart } = await syncWithRestart(record, platform, job.restart, env);
  const outcome = syncOutcome(sync, record.alias);
  if (restart) outcome.restart = restart;
  // The sync is the job's purpose here; a withheld restart is reported, not a failure (A2).
  if (restart?.outcome === "skipped" && outcome.state === "succeeded") outcome.reason = RESTART_SKIPPED;
  return outcome;
};

export const runRestartCodexItem: ItemRunner = async (record, job, env) => {
  const requested = job.restart === "codex" ? "codex" : "app-server";
  const refused = (reason: string): ItemOutcome =>
    ({ state: "unsupported", reason, restart: { requested, outcome: "unsupported" } });
  if (record.remotePlatform === "windows") return refused("windows-restart");   // D20, no SSH at all
  const offline = unreachable(record, env);
  if (offline) return offline;
  const platform = await platformOf(record, env);
  if (typeof platform !== "string") return platform;
  if (platform === "windows") return refused("windows-restart");
  if (record.childKind === "ephemeral") {
    // ocx-child accepts and ignores the restart flags (F2): sync without them, report unsupported.
    const sync = await pinnedSync(record, platform, "none", env);
    const outcome = syncOutcome(sync, record.alias);
    return outcome.state === "succeeded" ? { ...refused("ephemeral-restart"), sync } : { ...outcome, restart: { requested, outcome: "not-run" } };
  }
  // A2 / M8: the restart is the purpose of this op, so a busy link runs nothing (no SSH) and reports partial (exit 6).
  if (linkBusy(record, env)) return { state: "busy", reason: RESTART_SKIPPED, restart: { requested, outcome: "skipped" } };
  // Revision 4: same two-step path as sync with a restart, so activity is read again just before the restart goes out.
  const { sync, restart } = await syncWithRestart(record, platform, requested, env);
  if (restart!.outcome === "unsupported") return syncOutcome(sync, record.alias).state === "succeeded"
    ? { ...refused("ephemeral-restart"), sync } : { ...syncOutcome(sync, record.alias), restart: { requested, outcome: "not-run" } };
  if (restart!.outcome === "skipped") return { state: "busy", reason: RESTART_SKIPPED, sync, restart };
  return { ...syncOutcome(sync, record.alias), restart };
};

export const runUpdateItem: ItemRunner = async (record, job, env) => {
  if (record.childKind === "ephemeral") return { state: "unsupported", reason: "ephemeral" };     // D10
  const offline = unreachable(record, env);
  if (offline) return offline;
  // Revision 4 (4529521925): bind the Child's identity before anything can mutate it. The pinned sync is the Child's own
  // check (sync --expect-link, under its lifecycle lock, src/client/sync-expectation.ts:109): a Child that disconnected or
  // linked to another Home answers child-link-mismatch:* and nothing below runs. It precedes the plan probe, so the
  // probe's 120 s window is not spent on it; the gap left before apply is the probe itself (at most 60 s).
  const identityPlatform = await platformOf(record, env);
  if (typeof identityPlatform !== "string") return identityPlatform;
  const identity = await pinnedSync(record, identityPlatform, "none", env);
  if (identity.state !== "synced") return syncOutcome(identity, record.alias);
  // D3: a fresh plan every time. Windows Children are observed too: desktop-request is the one route they can take (H4, A5).
  const observed = await env.observe(record);
  if (observed.observation) env.writeObservation(record.id, withoutCarriedFields(observed.observation));
  const probe = observed.probe;
  // 4529522000: observe step 4 ends "succeeded" with probe null for a record without childKind whose Child runs
  // ocx-child (020). Nothing was updated, so this is unsupported, never a success.
  if (observed.state === "succeeded" && probe === null) return { state: "unsupported", reason: "ephemeral" };
  if (observed.state !== "succeeded" || probe === null) return { state: observed.state, reason: observed.reason };
  const plan = probe.classification;
  const target = env.homeVersion;
  const versions = { ...(plan.installedVersion ? { fromVersion: plan.installedVersion } : {}), toVersion: target };
  if (plan.updateRoute === "none") return plan.updateReason === "up-to-date"
    ? { state: "up-to-date", reason: null, ...(plan.installedVersion ? { fromVersion: plan.installedVersion, toVersion: plan.installedVersion } : {}) }
    : { state: "refused", reason: plan.updateReason ?? "plan-unavailable", ...versions };
  if (plan.updateRoute === "owner-action" || plan.updateRoute === "replant")
    return { state: "owner-action", reason: plan.updateReason, ...versions };
  if (plan.updateInFlight) return { state: "busy", reason: "update-in-flight", ...versions };
  const suppressed = env.readObservation(record.id)?.suppressedTarget ?? null;
  if (job.trigger === "auto") {
    if (suppressed === target) return { state: "refused", reason: "target-failed-before", ...versions };
    if (env.activity(record.id)?.idle !== true) return { state: "busy", reason: "link-active", ...versions };
  } else if (suppressed !== null) {
    env.writeObservation(record.id, { suppressedTarget: null });    // a manual update clears it (D12 step 2)
  }
  // H4: the Desktop branch precedes the Windows refusal. 080 replaces this line with
  // `return runDesktopRequestItem(record, probe, versions, env);` (080 "Runner").
  if (plan.updateRoute === "desktop-request") return { state: "owner-action", reason: "desktop-app", ...versions };
  if (probe.platform === "windows") return { state: "unsupported", reason: "windows-apply", ...versions }; // D20
  // updateRoute === "orchestrated" on POSIX.
  // M9: --not-after is evaluated on the Child's clock. childNowMs was printed at the start of the plan probe, so the
  // window counts from the plan; what is left of it is the window minus the Home's own elapsed time since the probe.
  const remaining = APPLY_NOT_AFTER_MS - (env.now() - probe.startedAt);
  if (remaining < APPLY_MIN_REMAINING_MS) return { state: "busy", reason: "plan-expired", ...versions };
  const homeClock = probe.childNowMs === null;       // marker missing (should not happen): fall back to the Home clock
  const notAfter = homeClock ? env.now() + remaining : probe.childNowMs! + APPLY_NOT_AFTER_MS;
  const viaLauncher = plan.installKind === "npm" || plan.installKind === "pnpm";      // A4 (H2): apply only, npm/pnpm only
  const argv = remoteUpdateApplyArgv({ homeVersion: target, planToken: plan.planToken!, notAfter, viaLauncher }, "posix");
  let result: SshRunResult;
  try {
    result = await env.runner.run(buildExecArgv({ alias: record.alias, knownHostsFile: env.knownHostsFile, argv }),
      { timeoutMs: plan.mutationBoundMs + APPLY_GRACE_MS });
  } catch (error) {
    // The Child's update keeps running or has finished; only a re-observe can tell (R2 hazard 4).
    // Revision 4 (4529522112, 4529521944): recorded apart from lastOperation, which the next observe replaces; 070
    // re-observes it, never re-applies, and resyncs once the Child reports no update in flight.
    env.writeObservation(record.id, { pendingUpdateRecovery: { target, since: iso(env.now()),
      until: iso(env.now() + UNCERTAIN_RECOVERY_WINDOW_MS) } });
    return { state: "uncertain", reason: error instanceof SshRunnerError && error.code === "timeout"
      ? "deadline-exceeded" : "ssh-runner-failed", ...versions };
  }
  const verdict = classifyUpdateApply(result);
  if (verdict.suppressTarget) env.writeObservation(record.id, { suppressedTarget: target });
  const verdictVersions = { ...versions, ...(verdict.fromVersion ? { fromVersion: verdict.fromVersion } : {}),
    ...(verdict.toVersion ? { toVersion: verdict.toVersion } : {}) };
  if (verdict.state === "refused" && verdict.reason === "deadline-passed") return { state: "refused", reason: "deadline-passed",
    ...(homeClock ? { hint: `The clocks of this Home and ${record.alias} differ (clock-skew); correct the Child's clock or run the update again.` } : {}),
    ...verdictVersions };
  if (verdict.state === "up-to-date") return { state: "up-to-date", reason: null, ...verdictVersions };
  if (verdict.state === "uncertain") env.writeObservation(record.id, { pendingUpdateRecovery: { target,
    since: iso(env.now()), until: iso(env.now() + UNCERTAIN_RECOVERY_WINDOW_MS) } });
  // 4529521944: a failed or rolled-back apply may already have stopped the proxy unsupervised, which removes routing.
  // Resync without a restart; the verdict (and any suppressedTarget written above) stands, the sync is reported beside it.
  if (verdict.state === "failed") return { state: "failed", reason: verdict.reason, ...verdictVersions,
    sync: await pinnedSync(record, "posix", "none", env) };
  if (verdict.state !== "succeeded") return { state: verdict.state, reason: verdict.reason, ...verdictVersions };
  // Always resync: an unsupervised stop removed routing and start alone does not reapply it. The restart obeys A2.
  let { sync, restart } = await syncWithRestart(record, "posix", job.restart, env);
  if (sync.state === "skipped" && sync.reason === "child-updating") {
    await env.sleep(POST_UPDATE_SYNC_RETRY_MS);
    ({ sync, restart } = await syncWithRestart(record, "posix", job.restart, env));
  }
  env.writeObservation(record.id, { installedVersion: target, targetVersion: target, updateRoute: "none",
    updateReason: "up-to-date", observedAt: new Date(env.now()).toISOString(), source: "plan" });
  const extra = { ...verdictVersions, sync, ...(restart ? { restart } : {}) };
  return sync.state === "synced"
    ? { state: "succeeded", reason: restart?.outcome === "skipped" ? RESTART_SKIPPED : null, ...extra }
    // Revision 4 (4529522006): the update stands, but routing may be gone; the CLI exits 6 for this reason (Section 3).
    : { state: "succeeded", reason: "post-update-sync-failed", hint: `${childSkipHint(sync.reason, record.alias) ?? ""} Run \`ocx link sync ${record.alias}\` to restore routing.`.trim(), ...extra };
};
```

Exit 255 from ssh is reported by `classifyUpdateApply` as `uncertain` (it cannot tell a dropped channel from a failed
apply), never as `offline`; an `SshRunnerError` `output_limit` or `decode` maps to `uncertain` / `ssh-runner-failed` for
the same reason. `plan-expired` sends nothing: (defensive, audit r2 R3: the 60 s probe bound and the absence of queueing between observe and apply make it unreachable today; it guards a future queue or a slower probe) the 60 s plan probe plus queueing can eat the 120 s window, and a stale
token would only be refused by the Child. `ObserveProbe.platform` is the platform `observeChild` resolved in its step 3
(020), so no second platform probe runs.

### 2.4 src/server/management/link-child-ops-routes.ts (MODIFY, 020 file; target content of the parts wp3 changes)

Revision 5 base: wp2's file (116 lines on 87e005f93c). `catalogRevisionForRoutes` (:27-38) and the job GET matcher
(:106-114) stay; `attachLinkChildOpsForState` (:69-86) keeps its pull flush and changes one line (`activeJob` reads the
shared engine, so a job the wp5 scheduler started shows on a status read that never submitted); wp3 replaces
`parseOperation` (:40-49), `childOpsEngineFor` (:51-66) and the POST branch (:93-104), and adds `childOpsEnvFor` and
`refusal`. The handler keeps wp2's order: `auth(ctx, "either")` for every path, then `409 runtime_role_client` on a
Child, then the body, then `503 link_unavailable` when the store read throws inside `submit`.

```ts
import { DEFAULT_IDLE_AFTER_MS, isLinkIdle } from "../../link/child-activity";
import { createCatalogRevisionMonitor, type CatalogRevisionMonitor } from "../../link/child-catalog-freshness";
import { observeChild } from "../../link/child-observe";
import { patchChildObservation, readChildObservations, updateChildObservations } from "../../link/child-observations";
import { sharedChildOpsEngine, type ChildOpsEngine, type SubmitRefusal, type SubmitResult } from "../../link/child-ops-engine";
import { CHILD_OPS, type ChildOp, type ChildOpsEnv, type ChildRestart } from "../../link/child-ops-types";
import { requireRemotePlatform } from "../../link/remote-platform";
import { inspectRemoteChildRuntime } from "../../link/remote-plant";
import { attachLinkChildOps, projectLinkStatus, type LinkStatusDto } from "../../link/status-projection";
// ... the remaining wp2 imports (:9-14) are unchanged; `isRecord` joins the link-route-state import.

const NO_STORE = { "cache-control": "no-store" };

/** One engine per Home process (Revision 5). wp2 kept one per route state, which link-routes.ts keys by the config
 *  object (:30, :54-70), so a config reload started a second engine without the first one's locks, and the wp5
 *  scheduler must submit to the engine the routes read. state.childOps stays the seam a direct test can set. */
export function childOpsEngineFor(state: LinkRouteState): ChildOpsEngine {
  return state.childOps ??= sharedChildOpsEngine();
}

/** The env captures this request's seams for the job's lifetime; every read is live. wp5 passes the policy idleAfterMs. */
export function childOpsEnvFor(ctx: ManagementContext, state: LinkRouteState, idleAfterMs = DEFAULT_IDLE_AFTER_MS): ChildOpsEnv {
  const now = ctx.deps.now ?? Date.now;
  const runner = runnerFor(ctx);
  const hosts = knownHostsFile(ctx);
  const homeVersion = packageVersion("0.0.0");
  return {
    readStore: () => readStoreFor(ctx),
    runner, knownHostsFile: hosts, homeVersion, now,
    wireState: linkId => projectLinkStatus(readStoreFor(ctx), state.supervisor.status(), state.listener.status(), ctx.config)
      .links.find(link => link.id === linkId)?.state ?? null,
    activity: linkId => {
      const snapshot = state.listener.linkActivity?.(linkId, now());
      return snapshot ? { inFlight: snapshot.inFlight, idle: isLinkIdle(snapshot, now(), idleAfterMs) } : null;
    },
    sleep: ms => Bun.sleep(ms),
    // wp2's observe deps (:55-63), unchanged: the peer and activity listeners are optional on LinkRouteListener.
    observe: record => observeChild(record, { runner, knownHostsFile: hosts, homeVersion,
      peer: linkId => state.listener.peerObservation?.(linkId) ?? { observed: null, refused: null },
      platformOf: link => requireRemotePlatform(runner, link.alias, hosts),
      inspect: inspectRemoteChildRuntime, now: () => new Date(now()) }),
    // readChildObservations defaults to childObservationsPath() (child-observations.ts:146), as wp2 calls it.
    readObservation: linkId => readChildObservations().children[linkId] ?? null,
    // Never throws into a runner: a cache write failure is logged by error name, as wp2's engine did (:62-67).
    writeObservation: (linkId, patch) => {
      try { updateChildObservations(file => patchChildObservation(file, linkId, patch, new Date(now()))); }
      catch (error) { console.warn(`[link] child observation write failed linkId=${linkId} error=${error instanceof Error ? error.name : "unknown"}`); }
    },
    // Revision 4: wp2's monitor on LinkRouteState.catalogRevision (catalogEtag hashing, src/lib/catalog-etag.ts);
    // 050 later defaults it to sharedCatalogRevisionMonitor(). null when the catalog cannot be read.
    catalogEtag: () => (state.catalogRevision ??= catalogRevisionForRoutes()).current()?.etag ?? null,
  };
}

export interface ParsedOperation { op: ChildOp; linkIds: string[] | "all"; restart: ChildRestart }

/**
 * Exactly {op, linkIds, restart?}. A2 / M8: any request that carries a restart (sync with restart, or restart-codex,
 * whose restart defaults to app-server) must name its links; "all" is accepted only when restart is "none".
 * Scope (audit r2 R6): this rule binds this API route and the ocx link verbs only; ocx sync --restart-children (040)
 * and the automatic restart policy (050) select links themselves and apply the same run-time activity check.
 */
export function parseOperation(body: unknown): ParsedOperation | null {
  if (!isRecord(body) || Object.keys(body).some(key => key !== "op" && key !== "linkIds" && key !== "restart")) return null;
  if (!(CHILD_OPS as readonly unknown[]).includes(body.op)) return null;
  const op = body.op as ChildOp;
  if (body.restart !== undefined && body.restart !== "app-server" && body.restart !== "codex") return null;
  if (body.restart !== undefined && op === "observe") return null;
  const restart: ChildRestart = op === "restart-codex" ? (body.restart as ChildRestart | undefined) ?? "app-server"
    : (body.restart as ChildRestart | undefined) ?? "none";
  const ids = body.linkIds;
  let linkIds: string[] | "all";
  if (ids === "all" && restart === "none") linkIds = "all";
  else if (Array.isArray(ids) && ids.length >= 1 && ids.length <= MAX_LINK_IDS
    && ids.every(id => typeof id === "string" && LINK_ID.test(id)) && new Set(ids).size === ids.length) linkIds = [...ids as string[]];
  else return null;
  return { op, linkIds, restart };
}

function refusal(code: SubmitRefusal): Response {
  switch (code) {
    case "link_not_found": return fail(code, "The link was not found.", 404);
    case "link_not_home_initiated": return fail(code, "Only a Home-initiated link can be operated from this computer.", 409);
    case "link_operation_in_progress": return fail(code, "Another operation is running on this link.", 409);
    // Returned only when links.json has no link at all (2.2), so the message says exactly that (carried item a).
    case "no_eligible_links": return fail(code, "This Home has no links.", 409);
  }
}

// In handleLinkChildOpsRoutes (after wp2's auth(ctx, "either") at :91-92), the POST branch:
  if (url.pathname === "/api/link/children/operations" && req.method === "POST") {
    if (ctx.config.runtimeRole === "client") return fail("runtime_role_client", "A Child runtime does not operate other Children.", 409);
    const operation = parseOperation(await readManagementJsonBodyOr(req, null));
    if (!operation) return fail("invalid_body", "The body must be exactly {op, linkIds, restart?}; restart is app-server or codex and needs explicit linkIds.", 400);
    let result: SubmitResult;
    try { result = childOpsEngineFor(state).submit({ ...operation, trigger: "manual" }, childOpsEnvFor(ctx, state)); }
    catch { return fail("link_unavailable", "The link store could not be read.", 503); }
    return result.ok ? Response.json({ job: result.job }, { status: 202, headers: NO_STORE }) : refusal(result.code);
  }
// The job GET (:106-114) reads childOpsEngineFor(state).job(jobId) instead of state.childOps?.job(jobId), and
// attachLinkChildOpsForState's activeJob source (:84) becomes linkId => childOpsEngineFor(state).activeJob(linkId).
```

The `trigger` is always `"manual"` here: no request body can claim `"auto"`, so the idle and suppression bypass in
`runUpdateItem` is reachable only from the wp5/wp7 scheduler. As in revision 4, an
`update` with explicit `linkIds` may carry a `restart` for its post-update sync (the CLI never sends one). The job GET keeps wp2's `/api/link/children/jobs/{jobId}` matcher; `job()` returning
`undefined` answers `404 job_not_found`.

### 2.5 src/server/management/link-route-state.ts (comment only)

The field exists since wp2 (:53-54). Before:
```ts
  /** Created on the first Child-operations request (link-child-ops-routes.ts). */
  childOps?: import("../../link/child-ops-engine").ChildOpsEngine;
```
After:
```ts
  /** The process-wide engine (sharedChildOpsEngine), cached on first use; a direct test may set its own. */
  childOps?: import("../../link/child-ops-engine").ChildOpsEngine;
```

### 2.6 src/server/management/link-routes.ts (MODIFY)

wp2 added the lazy delegating branch for `/api/link/children/` before the reconnect matcher (link-routes.ts:352-356);
wp3 leaves it and its dynamic import as they are, so
`link-routes.ts` gains no static import of the child-ops module.

DELETE 409, before (:201-205):
```ts
async function remove(ctx: ManagementContext, state: LinkRouteState, id: string): Promise<Response> {
  if (!LINK_ID.test(id)) return fail("invalid_link_id", "The link id is invalid.", 400);
  const current = readStoreFor(ctx);
  const record = current.links.find(link => link.id === id);
  if (!record) return fail("link_not_found", "The link was not found.", 404);
```
After (three lines added after :205, before the body read at :206; applies to ordinary, `purge` and `force` removal alike):
```ts
  if (!record) return fail("link_not_found", "The link was not found.", 404);
  // A queued or running job would keep opening SSH sessions to a Child this removal disconnects.
  const { childOpsEngineFor } = await import("./link-child-ops-routes");
  if (childOpsEngineFor(state).activeJob(id)) return fail("link_operation_in_progress", "A Child operation is running on this link; wait for it to finish, then remove the link.", 409);
```
The delegating branch sits before the DELETE prefix match (:365), so `DELETE /api/link/children/...` never reaches
`remove()`; the child-ops handler returns `null` for it and the API answers its usual 404.

### 2.7 src/server/management/route-registry.ts (no change in wp3)

wp2 declared both routes (route-registry.ts:440-442) with the parameter spelled `{jobId}`:
`{ method: "POST", path: "/api/link/children/operations", ... mutates: true }` and
`{ method: "GET", path: "/api/link/children/jobs/{jobId}", ... mutates: false, mechanism: "regex" }`. Both are
capability-covered (2.10, which uses the same `{jobId}` spelling), so no exemption is declared.
`tests/server/management-route-registry.test.ts` scans every `src/server/management/*.ts`.

### 2.8 src/cli/link-child-ops.ts (MODIFY, 020 file; the parts wp3 changes)

Revision 5 base: wp2's file (136 lines on 87e005f93c). Kept as merged: `validateChildJob` (tolerant since wp2, audit H5;
it already drops unknown keys and keeps any enum string ≤ 256 for display), `readJob`, `OLD_HOME_MESSAGE`,
`RUNTIME_ROLE_CLIENT_MESSAGE`, `CONFLICT_MESSAGES`, `LINK_CHECK_POLL_MS` (2 s), the always-JSON output (`--json` is
accepted and changes nothing), and `--no-wait` returning the verdict of a job already done. wp3 changes six things.

1. **Types** come from `../link/child-ops-types` (2.1) instead of `../link/child-ops-engine` (:1).
2. **No-links message** (carried item a). `no_eligible_links` is returned only when links.json is empty (2.2), so:
   `export const NO_ELIGIBLE_LINKS_MESSAGE = "This Home has no links.";` (was "This Home has no Home-initiated links to
   operate on.", :15). `tests/cli/cli-link-check.test.ts:127` compares against the constant and keeps passing.
3. **Validator keeps `restart.requested`.** In the nested loop (:51-58) the `restart` object also reads
   `requested` with the same `text(...)` check as `outcome` (a wrong type throws, any string ≤ 256 is kept); a wp3 Home
   always sends it. `sync.executable` stays
   dropped (display needs only state and reason).
4. **Exit mapping** (Revision 3 R2 and Revision 4 4529522006 on wp2's `linkCheckExitCode`, :73-82). An unknown item
   state still exits 1 as wp2 shipped it (D15); a success that carries a reason, or whose requested restart did not
   happen, is partial:
   ```ts
   /** D15: 0 every item succeeded or up-to-date with nothing withheld; 6 any item needs the operator; 1 any failure or an unknown state. */
   export function linkCheckExitCode(job: ChildJob): number {
     let code = 0;
     for (const item of job.items) {
       if (SUCCESS.has(item.state)) {
         // restart-skipped:link-active, post-update-sync-failed, or a restart reported unsupported / not-run / skipped.
         if (item.reason !== null || (item.restart !== undefined && item.restart.outcome !== "requested")) code = Math.max(code, 6);
         continue;
       }
       if (PARTIAL.has(item.state)) code = Math.max(code, 6);
       else return 1;
     }
     return code;
   }
   ```
   Observe items never carry a reason on success (child-observe.ts), so `ocx link check`'s exits do not change.
5. **Wait deadline** (carried item b). wp2 sets `deadline = now() + ceil(items/3) × 120 s + 30 s` once, at submission
   (:125), so a job queued behind another job's items spends its budget waiting and exits 1 `job_still_running` while it
   has not started. wp3 moves the loop into one helper both verbs use, with a per-op item budget, and keeps moving the
   deadline while any item is still `queued`:
   ```ts
   /** How long one item may run once it has started: the sum of its runner's own SSH bounds plus a margin. */
   export const CHILD_ITEM_WAIT_MS: Readonly<Record<ChildOp, number>> = {
     observe: 120_000,                 // wp2's value: one 60 s plan probe, one read-only inspection
     sync: 420_000,                    // platform probe 30 s + two pinned syncs of SYNC_TIMEOUT_MS (180 s)
     "restart-codex": 420_000,
     update: 2_100_000,                // probe 30 s + identity sync 180 s + plan 60 s + apply 900 s + 120 s grace
                                       // + post-update sync with retry 2 × 360 s + 30 s
   };
   /** Never poll longer than this from submission, queued or not; the Home keeps a finished job one hour. */
   export const CHILD_JOB_WAIT_CAP_MS = 10_800_000;

   async function waitForChildJob(job: ChildJob, deps: LinkCheckDeps, request: LinkRequest): Promise<{ job: ChildJob; done: boolean }> {
     const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
     const now = deps.now ?? Date.now;
     const cap = now() + CHILD_JOB_WAIT_CAP_MS;
     const perItem = Object.hasOwn(CHILD_ITEM_WAIT_MS, job.op) ? CHILD_ITEM_WAIT_MS[job.op] : CHILD_ITEM_WAIT_MS.update;
     const lanes = job.op === "update" ? 1 : 3;
     const budget = (current: ChildJob): number =>
       Math.ceil(current.items.filter(item => item.finishedAt === null).length / lanes) * perItem + 30_000;
     let deadline = now() + budget(job);
     while (job.state !== "done") {
       // A queued item has not started its SSH work: while one waits behind another job, the deadline moves with it.
       if (job.items.some(item => item.state === "queued")) deadline = Math.max(deadline, now() + budget(job));
       if (now() >= Math.min(deadline, cap)) return { job, done: false };
       await sleep(LINK_CHECK_POLL_MS);
       job = readJob(await request<unknown>(`/api/link/children/jobs/${encodeURIComponent(job.jobId)}`, {}, deps));
     }
     return { job, done: true };
   }
   ```
   The 35-minute update budget (2 040 s of runner bounds plus a margin) is finite because every runner step has its own
   timeout, so a queued item always starts;
   `mutationBoundMs` is the fixed `ORCHESTRATED_MUTATION_BOUND_MS` (900 000, src/update/orchestrated-plan.ts:5). A later
   Child with a larger bound can outlast the CLI's budget; the CLI then exits 1 with the existing
   `job_still_running` message, which names the GET that reads the job again. wp2's deadline test
   (cli-link-check.test.ts:97-107: one `running` item, 60 s steps) still sees 150 s and four calls.
6. **Shared submit, the 403 and the new verbs.** `runLinkCheck`'s body after its argument parsing (:107-135) becomes
   `submitChildJob(body, wait, deps, request)`, which `runLinkChildOp` calls too. It keeps wp2's 404 and 409 mapping and
   adds the Revision 4 (4529521950) 403 mapping:
   ```ts
   export const LOOPBACK_REQUIRED_MESSAGE = "Child operations from the CLI need a Home bound to loopback; use the Remote Link page in the dashboard.";
   // in submitChildJob's catch, beside the 404 and 409 branches:
   if (error instanceof RuntimeApiError && error.status === 403) throw new RuntimeApiError(LOOPBACK_REQUIRED_MESSAGE, 403, error.body);
   ```
   `runCliAction` maps a 403 to exit 1 (src/cli/runtime-api.ts:555). The verbs:
   ```ts
   export type LinkChildVerb = "update" | "sync" | "restart-codex";
   export const LINK_CHILD_OPS_USAGE = [
     "  ocx link update (--link-id <id> | --all) [--no-wait] [--json]",
     "  ocx link sync (--link-id <id> | --all) [--no-wait] [--json]",
     "  ocx link sync --link-id <id> (--restart-app-server-only | --restart-codex --yes) [--no-wait] [--json]",
     "  ocx link restart-codex --link-id <id> [--scope app-server|codex] --yes [--no-wait] [--json]",
   ] as const;

   export function parseChildOpArgs(verb: LinkChildVerb, args: string[], usage: string): { body: { op: LinkChildVerb; linkIds: string[] | "all"; restart?: "app-server" | "codex" }; wait: boolean } {
     takeJsonFlag(args);
     const noWait = takeFlag(args, "--no-wait");
     const all = takeFlag(args, "--all");
     const yes = takeFlag(args, "--yes");
     // Repeatable like ocx link check (:94-98); a restart needs exactly one.
     const linkIds: string[] = [];
     for (let id = takeOption(args, "--link-id"); id !== undefined; id = takeOption(args, "--link-id")) {
       if (!LINK_ID.test(id)) throw new CliUsageError(`${verb} requires valid --link-id values`, usage);
       if (!linkIds.includes(id)) linkIds.push(id);
     }
     let restart: "app-server" | "codex" | undefined;
     if (verb === "sync") {
       const narrow = takeFlag(args, "--restart-app-server-only");
       const full = takeFlag(args, "--restart-codex");
       if (narrow && full) throw new CliUsageError("choose one of --restart-app-server-only and --restart-codex", usage);
       restart = narrow ? "app-server" : full ? "codex" : undefined;
     }
     if (verb === "restart-codex") {
       const scope = takeOption(args, "--scope") ?? "app-server";
       if (scope !== "app-server" && scope !== "codex") throw new CliUsageError("--scope must be app-server or codex", usage);
       if (!yes) throw new CliUsageError("restart-codex ends running Codex turns on the Child; pass --yes", usage);
       restart = scope;
     }
     rejectArgs(args, usage);
     if (all === (linkIds.length > 0)) throw new CliUsageError(`${verb} requires --link-id <id> or --all, not both`, usage);
     if (linkIds.length > 64) throw new CliUsageError(`${verb} accepts at most 64 --link-id values`, usage);
     // A2 / M8: a restart names one link, and the codex scope (quit and relaunch the desktop app) needs --yes on every verb.
     if (restart !== undefined && (all || linkIds.length !== 1)) throw new CliUsageError(`${verb} with a restart needs exactly one --link-id; --all is refused`, usage);
     if (restart === "codex" && !yes) throw new CliUsageError("--restart-codex quits the Child's Codex app and ends its turns; pass --yes", usage);
     if (yes && restart === undefined) throw new CliUsageError("--yes only confirms a restart", usage);
     return { body: { op: verb, linkIds: all ? "all" : linkIds, ...(restart ? { restart } : {}) }, wait: !noWait };
   }

   export async function runLinkChildOp(verb: LinkChildVerb, args: string[], deps: LinkCheckDeps, request: LinkRequest, usage: string): Promise<number> {
     const parsed = parseChildOpArgs(verb, args, usage);
     return submitChildJob(parsed.body, parsed.wait, deps, request);
   }
   ```
   `submitChildJob` prints the final job with `console.log(JSON.stringify(job))` exactly as `runLinkCheck` does (:121,
   :134), prints the `job_still_running` error when the wait returns `done: false`, and returns `linkCheckExitCode(job)`.
   A `404 job_not_found` while polling (the Home restarted) surfaces through `runCliAction` as exit 4 with the route's
   message.

### 2.9 src/cli/link.ts (MODIFY)

Usage, before (:38-51):
```ts
  ocx link cleanup [--link-id <id>] [--json]
  ocx link check (--link-id <id> | --all) [--no-wait] [--json]

Forced revoke skips remote cleanup. Run ocx disconnect on the remote client.
Cleanup reports each Child's platform with disconnect guidance; it changes nothing.
Check reads each Home-initiated Child's installed version and update route; it changes no install.`;
```
After (the four `LINK_CHILD_OPS_USAGE` lines after `check`, one sentence added; wp5's `policy` line joins the same block):
```ts
  ocx link cleanup [--link-id <id>] [--json]
  ocx link check (--link-id <id> | --all) [--no-wait] [--json]
${LINK_CHILD_OPS_USAGE.join("\n")}

Forced revoke skips remote cleanup. Run ocx disconnect on the remote client.
Cleanup reports each Child's platform with disconnect guidance; it changes nothing.
Check reads each Home-initiated Child's installed version and update route; it changes no install.
Update, sync and restart-codex run on the Child over the link's SSH trust and wait for the job unless --no-wait.`;
```

Switch, before (:393-410): wp2 already threads a verb's own exit beside `runCliAction`'s through `verdictExit`.
```ts
    else if (command === "check") verdictExit = await runLinkCheck(args, deps, linkRequest, LINK_USAGE);
    else throw new CliUsageError("link requires one of: probe, add, port, issue, status, revoke, reconnect, cleanup, check", LINK_USAGE);
```
After:
```ts
    else if (command === "check") verdictExit = await runLinkCheck(args, deps, linkRequest, LINK_USAGE);
    else if (command === "update" || command === "sync" || command === "restart-codex") verdictExit = await runLinkChildOp(command, args, deps, linkRequest, LINK_USAGE);
    else throw new CliUsageError("link requires one of: probe, add, port, issue, status, revoke, reconnect, cleanup, check, update, sync, restart-codex", LINK_USAGE);
```
The import at :13 becomes `import { LINK_CHILD_OPS_USAGE, runLinkCheck, runLinkChildOp } from "./link-child-ops";`.
`runLinkCommand(rawArgs, deps: LinkCliDeps = {})` keeps its signature: `LinkCheckDeps` only adds optional seams, so the
tests pass a `LinkCheckDeps` as wp2's `cli-link-check.test.ts` already does. `linkRequest` (:247) and
`errorCodeBody` (:265) are unchanged. `src/cli/dispatch.ts` already forwards every `link` argument, so
`src/cli/index.ts` is untouched.

### 2.10 Capabilities, contract and help

`src/cli/capabilities-access-remote.ts`, appended after wp2's `link check` entry (:168-177) before the closing `];` at :178
(Revision 5: the file writes `routes` and `flags` as JSON-style literals; either spelling typechecks):
```ts
  {
    command: ["link", "update"], summary: "Update a Home-initiated Child's OpenCodex to this Home's version.",
    usage: "ocx link update (--link-id <id> | --all) [--no-wait] [--json]",
    routes: [{ method: "POST", path: "/api/link/children/operations" }, { method: "GET", path: "/api/link/children/jobs/{jobId}" }],
    flags: [{ name: "--link-id", value: "string", summary: "Home-initiated link to update; repeatable, up to 64." }, { name: "--all", value: "boolean", summary: "Every link in the Home's store, one Child at a time; Child-initiated links report unsupported." },
      { name: "--no-wait", value: "boolean", summary: "Print the queued job and return." }, { name: "--json", value: "boolean", summary: "Emit the ocx.link.child-job/1 document." }],
    mutates: true, json: "payload",
    details: ["Runs the Child's own ocx update --plan through the served entry, then --yes with --expect-plan and a --not-after 120 s after the plan on the Child's own clock, through the link's pinned SSH trust. npm and pnpm installs apply through their Node launcher; Bun installs stay on Bun. The target is always this Home's version; the Child refuses a downgrade.", "Children below 2.97.0 run nothing and report owner-action legacy-ocx; ocx-child and GOAT-managed Children report unsupported or owner-action; Windows Children are refused orchestrated apply (unsupported windows-apply) and update only through the Desktop request route once Home and Child run the release with it. A manual update ends any turn currently relayed for that Child. A pinned sync runs after every update.", "Exit 0 all succeeded or up-to-date, 6 partial (including a kept update whose follow-up sync failed), 1 failed, uncertain or an unknown state, 5 another operation holds the link, the Home has no links or the command ran on a Child, 4 the link is unknown or the Home lacks Child operations. On a Home not bound to loopback it exits 1 and names the dashboard."],
  },
  {
    command: ["link", "sync"], summary: "Run the pinned catalog and settings sync on Home-initiated Children.",
    usage: "ocx link sync (--link-id <id> | --all) [--restart-app-server-only | --restart-codex --yes] [--no-wait] [--json]",
    routes: [{ method: "POST", path: "/api/link/children/operations" }, { method: "GET", path: "/api/link/children/jobs/{jobId}" }],
    flags: [{ name: "--link-id", value: "string", summary: "Home-initiated link to sync; repeatable, up to 64, exactly one with a restart." }, { name: "--all", value: "boolean", summary: "Every link in the Home's store, three at a time; refused with a restart." },
      { name: "--restart-app-server-only", value: "boolean", summary: "Also restart the Child's Codex app-servers after the sync writes." }, { name: "--restart-codex", value: "boolean", summary: "Also quit and relaunch the Child's Codex desktop app; ends live turns." },
      { name: "--yes", value: "boolean", summary: "Confirms --restart-codex." }, { name: "--no-wait", value: "boolean", summary: "Print the queued job and return." }, { name: "--json", value: "boolean", summary: "Emit the ocx.link.child-job/1 document." }],
    mutates: true, json: "payload",
    details: ["The same sync --expect-link the ocx sync fan-out runs, gated at 2.93.0. Restart flags are refused on Windows and ignored by ocx-child; the item reports restart unsupported.", "A restart needs one --link-id (--all is refused) and --restart-codex needs --yes. The restart is withheld (restart skipped, reason restart-skipped:link-active) while a relayed model request for that Child is in flight; the sync still runs.", "Exit codes as for ocx link update."],
  },
  {
    command: ["link", "restart-codex"], summary: "Restart Codex on one Home-initiated Child so it reloads the catalog.",
    usage: "ocx link restart-codex --link-id <id> [--scope app-server|codex] --yes [--no-wait] [--json]",
    routes: [{ method: "POST", path: "/api/link/children/operations" }, { method: "GET", path: "/api/link/children/jobs/{jobId}" }],
    flags: [{ name: "--link-id", value: "string", required: true, summary: "Home-initiated link." }, { name: "--scope", value: "string", summary: "app-server (default) or codex (also relaunches the desktop app)." },
      { name: "--yes", value: "boolean", required: true, summary: "Confirms that running Codex turns on the Child end." },
      { name: "--no-wait", value: "boolean", summary: "Print the queued job and return." }, { name: "--json", value: "boolean", summary: "Emit the ocx.link.child-job/1 document." }],
    mutates: true, json: "payload",
    details: ["A pinned sync with the restart flag; works on full Children from 2.93.0. app-server scope leaves the Codex desktop app's own app-server running.", "Refused on Windows Children (unsupported windows-restart) and reported unsupported for ocx-child. The codex scope needs a logged-in GUI session on the Child; its outcome is requested, not confirmed."],
  },
```
`src/cli/capability-contracts.ts:2`:
```ts
export const CAPABILITY_CONTRACTS = ["sync.home-fanout/1", "update.orchestrated/1", "link.child-ops/1"] as const;
```
`src/cli/registry.ts:153-167`: the `link` entry's usage (:155) becomes
`ocx link <port|issue|status|revoke|reconnect|cleanup|check|update|sync|restart-codex>`, it gains three detail
lines copied from the capability usages after the `Check:` line (:164), and the closing sentence (:165) becomes
"Issue, status, revoke, reconnect, check, update, sync and restart-codex use the running proxy's loopback management
API and admin token; update, sync and restart-codex act only on Home-initiated links."

wp2's `link check` capability (details at :176) says a 409 means "--all found no Home-initiated link"; wp3 changes that clause to
"the Home has no links" (carried item a), the only edit to that entry.

## 3. Deviations from 004

1. **Runners split from the engine.** D1 puts the runners inside `child-ops-engine.ts`. They live in
   `child-ops-runners.ts` with the types in `child-ops-types.ts`, so the engine stays a small, fully
   fake-runner-testable registry and the runner file has no lock state. Same layer, same imports.
2. **Restart outcome gains `"not-run"`.** D11 has `requested | unsupported`. When the pinned sync does not
   reach `synced` the restart never ran; reporting `requested` would be false. `"not-run"` is added.
3. **CLI exit codes follow `runCliAction`.** D15 says "1 any failed/uncertain or API error". The existing
   wrapper maps a `RuntimeApiError` 404 to exit 4 and 409 to exit 5 (src/cli/runtime-api.ts:555), and
   every link verb already relies on that. wp3 keeps it: job verdict 0/6/1, an older Home 4 (with the
   D21 message), a held link 5. Revision 4 (4529522006): an item that ends `succeeded` with reason
   `post-update-sync-failed` counts as partial (exit 6) like `restart-skipped:link-active`: the update is kept and
   reported, and the hint names the manual `ocx link sync <alias>` that restores routing. D21's "exit 1" for an old
   Home is superseded.
4. **Every restart request names its links (A2, audit M8).** D14 accepts `"all"` for every op; any request that
   carries a restart (`restart-codex`, or `sync` with `restart`) is `400 invalid_body` with `"all"` and a usage error in
   the CLI, and `--restart-codex` needs `--yes` on `ocx link sync` as on `restart-codex`. Every runner reads the
   link's activity when the item runs and withholds the restart (`restart.outcome: "skipped"`, reason
   `restart-skipped:link-active`) while a relayed model request is in flight; `restart-codex` then sends nothing.
5. **The GUI part of the new error code lands in 060.** `link_operation_in_progress` is server-only here.
   An unknown code already renders `remoteLink.error.generic` (gui/src/pages/RemoteLink.tsx:129; `link_not_home_initiated`
   is already a GUI code, :73, from reconnect), and the gui parity test only checks codes that are in `LINK_ERROR_CODES`
   (gui/tests/remote-link.test.tsx:60-73),
   so the build stays green with no gui diff. 060 adds the code, its `ERROR_TKEY` entry and 11 locale keys,
   and must add `"link-child-ops-routes"` to that test's scanned file list (:61) for `job_not_found`,
   `invalid_job_id` and `no_eligible_links`.
6. **Test registration in a shard.** r3 suggests `layout.json` `explicit`; it is 1999 lines on 87e005f93c with the ratchet at 2000,
   so the `layout-clients.json` shard is used (000 "Test registration rule").
7. **Apply deadline on the Child's clock (audit M9).** D12 sends `now + 120 s` from the Home's clock, which the Child
   evaluates on its own clock. The plan probe now prints `ocx-fanout:child-now`; `--not-after` is that value plus
   120 s, the apply is not sent with less than 15 s left (`busy/plan-expired`), and a missing marker falls back to the
   Home clock with a `clock-skew` hint on a `deadline-passed` refusal.
8. **Windows Desktop ordering (audit H4).** D20 refuses Windows update before any SSH; the runner now observes a
   Windows Child and refuses `windows-apply` only after the `desktop-request` branch, which 080 fills in.
9. **wp2's engine model wins (Revision 5).** 020 planned a semaphore engine with a per-state instance; wp2 shipped one
   engine-wide queue, busy items without `lastOperation`, and `"all"` as every link. wp3 keeps all three and adds the
   update place, per-job envs and the shared instance (2.2). Consequence: `ocx link update --all` and `sync --all` list
   Child-initiated links as `unsupported/child-initiated` items instead of omitting them, and `no_eligible_links` means an
   empty links.json.
10. **Shared engine instead of one per route state (Revision 5).** wp2's `state.childOps ??= createChildOpsEngine(...)`
    is replaced by `state.childOps ??= sharedChildOpsEngine()`, because route state is keyed by the config object and a
    reload would otherwise drop every lock. Route tests reset it with `resetSharedChildOpsEngineForTests()`.
11. **CLI output and exits follow wp2's `check` (Revision 5).** Revision 4 planned human lines and "unknown state ⇒ 6";
    wp2 shipped always-JSON output and "unknown state ⇒ 1" (D15). The new verbs share `check`'s output and its
    `linkCheckExitCode`, extended with the two partial-success reasons and a withheld restart (2.8 item 4).
12. **Queued time does not spend the CLI's wait budget (Revision 5, carried item b).** The deadline is per op and moves
    while any item is `queued`, under a 3-hour cap from submission (2.8 item 5).
13. **Windows gated `update` needs `--plan` (Revision 5, carried item d).** wp1 refused only `--yes`; any other non-plan
    `update` argv is now refused as `unsupported:windows-apply` (A4).

## 4. Field chains (PLAN-FIELD-CHAIN-01)

| Field / value | Created | Serialized | Deserialized | Consumers |
|---|---|---|---|---|
| `ChildJob` (all keys) | `createChildOpsEngine().submit` (2.2) | `Response.json({ job })` in link-child-ops-routes.ts (2.4), `structuredClone` snapshots | `validateChildJob` (wp2, tolerant; 2.8 adds `restart.requested`) | CLI human/JSON output; GUI parser in 060 (`gui/src/remote-link-child-ops-api.ts`); scheduler reads jobs in-process (050/070, no serialization) |
| `ChildJob.trigger` `auto` | Only the wp5/wp7 scheduler (in-process `submit`) | wire as above | `validateChildJob` accepts both | `runUpdateItem` idle and suppression branch; GUI label in 060 |
| `ChildJobItem.state` values | runners (2.3), engine (`busy`, `unsupported/child-initiated`, `refused/link-removed`, `failed/internal-error`) | job document | `validateChildJob` keeps any string ≤ 256 | `linkCheckExitCode` (unknown ⇒ 1); `lastOperation` for items that ran; `?children=1` row `lastOperation` (020 attacher); GUI badges (060) |
| `reason` vocabulary | runners: `tunnel-<wire>`, `link-not-in-runtime`, `ssh-timeout`, `ssh-failed`, `ssh-runner-failed`, `platform-probe-failed`, `deadline-exceeded`, sync classifier reasons, `windows-restart`, `windows-apply`, `ephemeral`, `ephemeral-restart`, `update-in-flight`, `link-active`, `restart-skipped:link-active`, `target-failed-before`, `plan-expired`, `deadline-passed`, `launcher-node-missing`, `rolled-back`, `legacy-ocx`, `desktop-app`, `post-update-sync-failed`, plan reasons; engine: `link-operation-in-progress`, `child-initiated`, `link-removed`, `internal-error`; observe runner: `observe-error` (wp2) | job document | any string ≤ 256 kept for display (wp2 validator, H5) | human output; GUI reason text (060, unknown reason ⇒ raw code shown) |
| `restart.outcome` `not-run`, `skipped` | `runSyncItem`, `runRestartCodexItem`, `runUpdateItem` post-sync | job document | CLI token, unknown values passed through | CLI human line; GUI (060) |
| `ocx-fanout:child-now` → `ObserveProbe.childNowMs` | gated plan script (010) | SSH stderr | `readGatedFraming` | `runUpdateItem` `--not-after` |
| `ChildObservation.lastOperation` | `finishItem` (2.2) via `env.writeObservation`, only for an item that ran (never `busy` or an admission-time `unsupported`) | `child-observations.json` (wp1 writer) | wp1 tolerant reader | `?children=1` `child.lastOperation` (020); 070 re-observe scheduler reads `uncertain` |
| `ChildObservation.suppressedTarget` set / cleared | `runUpdateItem` on `rolled-back` / manual update | same file | same reader | `runUpdateItem` auto branch; 070 skip rule; GUI hint (060) |
| `installedVersion`, `updateRoute` after success | `runUpdateItem` | same file | same reader | `?children=1` `versionSkew` (020) |
| `link_operation_in_progress` (409) | `remove()` in link-routes.ts and `refusal()` | `fail()` envelope | `errorCodeBody` (link.ts:257) / GUI `LinkApiError` | CLI exit 5; GUI generic text until 060 adds the key |
| `job_not_found` (404), `invalid_job_id` (400), `no_eligible_links` (409, links.json empty), `runtime_role_client` (409), `link_unavailable` (503) | link-child-ops-routes.ts | `fail()` | same | CLI: 404 ⇒ exit 4, 409 ⇒ exit 5 with `CONFLICT_MESSAGES` text, 503 ⇒ exit 1 via `runCliAction`; GUI generic until 060 |
| contract `link.child-ops/1` | capability-contracts.ts:2 | `ocx capabilities --json` (capabilities-command.ts:63) | GOAT and agents | `tests/cli/cli-capabilities-arguments.test.ts:36-45` (derived) |
| `LinkRouteState.childOps` | `childOpsEngineFor` caches `sharedChildOpsEngine()`; a direct test may set it | N/A (in-memory) | N/A | `childOpsEngineFor`, the DELETE 409, `attachLinkChildOpsForState` |
| `catalogSyncedEtag` | `pinnedSync` from `env.catalogEtag()` read before the sync (wp2 monitor, `catalogEtag` in src/lib/catalog-etag.ts) | `child-observations.json` | wp1 reader | `catalogVerdict` (020), fan-out eligibility (050) |

## 5. Tests

Four files are new (engine, runners, launcher fixture in A4, CLI); each fails before implementation because its import
target does not exist. Register them per 000 "Test registration rule": one line each after the last entry
(`"cli-link-check.test.ts": "cli"`, which gains a comma) of `scripts/test-layout/layout-clients.json` (:191) and of
`tests/fixtures/test-layout-expected.json` (:1662):
`"link-child-ops-engine.test.ts": "clients"`, `"link-child-ops-runners.test.ts": "clients"`,
`"link-child-update-launcher.test.ts": "clients"`, `"cli-link-child-ops.test.ts": "cli"`. `link-child-ops-routes.test.ts`
(020) and `cli-link-check.test.ts` (020) are MODIFY and already registered.
`tests/server/link-management-routes.test.ts` (1137 lines) is not grown; its new DELETE case lives in the
routes sibling file.

**tests/clients/link-child-ops-engine.test.ts** — engine with stub runners and a fake env (in-memory store,
`now` stepped by the test). wp2 has no engine test file; its engine cases live in the routes file and stay there.
- `single link held ⇒ submit refuses link_operation_in_progress`: submit a `sync` whose stub runner awaits a
  deferred; a second single-link submit returns `{ ok:false, code:"link_operation_in_progress" }`; `activeJob()`
  reports `running`.
- `bulk all skips held link as busy`: hold link A, submit `linkIds:"all"` for A,B ⇒ A item `busy/link-operation-in-progress`
  with `finishedAt` set and no `writeObservation` call for A, B runs (wp2 rule).
- `all lists every link` (Revision 5): a `sync` over a hub-initiated and a client-initiated link ⇒ the client item ends
  `unsupported/child-initiated` at admission with no runner call and no `lastOperation`; the same store with `observe` ⇒
  the observe runner runs for both (wp2 behaviour). `explicit client-initiated id in a list ⇒ unsupported/child-initiated`;
  `single client-initiated id ⇒ link_not_home_initiated` for `sync`, `restart-codex`, `update`, and a 202 job for
  `observe`; `unknown id ⇒ link_not_found`; `links.json empty ⇒ no_eligible_links`; `only client-initiated links,
  sync all ⇒ 202, every item unsupported`; `every link held ⇒ 202, job done at once, every item busy`.
- `a waiting update does not block a sync` (Revision 5): an update runner held on a deferred, a second update job and
  then a sync job ⇒ the sync item runs while the second update item stays `queued`.
- `update runs one at a time; sync runs three at a time`: five links, stub runner records max concurrency ⇒ 1 for
  `update`, 3 for `sync`.
- `record removed before its turn ⇒ refused/link-removed`: the stub removes link B from the store while A runs.
- `runner throws ⇒ failed/internal-error` and `runner returns non-terminal state ⇒ failed/internal-error`.
- `lastOperation written per item` (spy `writeObservation`) and `write failure does not fail the item`.
- `retention`: 34 finished jobs ⇒ the two oldest are gone; a job finished 61 min ago on its env's clock is pruned on
  the next submit or `job()` read.
- `shared instance`: `sharedChildOpsEngine()` returns one object until `resetSharedChildOpsEngineForTests()`.
- `locks released`: after `settled()`, `activeJob()` is null for every link.

**tests/clients/link-child-ops-runners.test.ts** — runners with a fake `runner.run` keyed by argv content, the
real wp1 builders and classifiers, and a scripted `env.observe` (Revision 5: the runners reach observe only through
the env, so no `mock.module` is needed; bun's module mocks leak across files).
- Revision 5: `observe runner` ⇒ the observation is written without carried fields; `env.observe` throws ⇒
  `failed/observe-error`; `restarting sync passes expectSelectedKind` ⇒ a second sync whose stderr carries
  `ocx-fanout:selected-kind:ocx-child` after the selection marker yields restart `unsupported`, and the same stderr on a
  plain sync is ignored.
- sync: `posix restart app-server ⇒ argv ends with --json --restart-app-server-only`; `windows restart ⇒ no flag,
  restart unsupported`; `ephemeral restart ⇒ no flag`; `exit 7 ⇒ busy/child-updating with hint`; `exit 5 mismatch
  ⇒ refused/child-link-mismatch:other_link`; `exit 121 lacks-expect-link ⇒ owner-action`; `exit 255 ⇒ offline/ssh-failed`;
  `runner timeout ⇒ uncertain/deadline-exceeded`; `tunnel reconnecting ⇒ offline/tunnel-reconnecting, zero SSH calls`;
  `no remotePlatform ⇒ platform probe first`.
- restart-codex: `recorded windows ⇒ unsupported/windows-restart with zero SSH calls`; `probed windows ⇒ unsupported
  after one probe`; `codex scope ⇒ --restart-codex`; `sync failed ⇒ restart not-run`.
- sync restart guard (A2, M8): `inFlight 1 ⇒ argv has no restart flag, restart skipped, reason restart-skipped:link-active,
  state succeeded`; `activity null ⇒ skipped` (unknown counts as in flight); `inFlight 0 ⇒ flag sent`; the activity stub
  changes between submit and run and the run-time value wins.
- restart-codex guard: `inFlight 1 ⇒ busy/restart-skipped:link-active with zero SSH calls` (manual trigger too).
- Revision 4 cases (runners file):
  - `restart after sync` (4529521916): with a restart requested, the first SSH call carries no restart flag and the
    second does; the activity stub turns `inFlight 1` between the two calls ⇒ one SSH call, restart `skipped`, item
    `succeeded` with `restart-skipped:link-active`; the second call times out ⇒ item `uncertain`, restart `requested`.
  - `ocx-child without childKind` (4529521993): second sync verdict `executable: "ocx-child"` ⇒ restart `unsupported`.
  - `identity before update` (4529521925): the first SSH call of an update is the pinned sync; a
    `child-link-mismatch:other_link` verdict ⇒ `refused`, and `env.observe` and the apply are never called.
  - `observe ocx-child` (4529522000): observe `succeeded` with `probe: null` ⇒ `unsupported/ephemeral`, no apply.
  - `failed apply resyncs` (4529521944): exit 1 with a rolled-back result ⇒ `failed`, `suppressedTarget` written, one
    pinned sync with no restart flag after the apply, its result on `item.sync`.
  - `uncertain apply recorded` (4529522112): runner timeout ⇒ `pendingUpdateRecovery` written with `until` one hour later.
  - `synced records etag` (4529521968): `catalogEtag` "A" before the sync, "B" after ⇒ `catalogSyncedEtag` "A".
  - `auto sync rechecks` (4529522063): `autoSyncAllowed` false at item start ⇒ `busy/link-active`, zero SSH calls.
- engine, `engine-wide slots` (4529521982): four single-link `sync` jobs on four links with deferred stub runners ⇒ at
  most three runners in flight and the fourth item `queued` until one resolves; two single-link `update` jobs ⇒ the
  second runner starts only after the first resolves.
- CLI, `post-update sync failed exits 6` (4529522006): one item `succeeded/post-update-sync-failed` ⇒ exit 6.
- update, one case per D12 row, each asserting the observable item and the SSH call list (`env.observe` stubbed with
  scripted `ObserveOutcome` values): `ephemeral`, `observe outcome passthrough`, `up-to-date`, `owner-action goat`,
  `desktop route ⇒ owner-action/desktop-app`, `updateInFlight ⇒ busy`, `auto + suppressed ⇒ refused/target-failed-before`,
  `auto + not idle ⇒ busy/link-active`, `manual clears suppressedTarget`, `apply timeout = mutationBoundMs+120000`,
  `exit 0 applied ⇒ succeeded + post-sync`, `post-sync exit 7 ⇒ sleep(30000) then one retry`, `post-sync failed ⇒
  succeeded/post-update-sync-failed`, `exit 0 not applied ⇒ up-to-date`, `exit 10 update-in-flight ⇒ busy`, `exit 10 other ⇒
  refused`, `exit 11 ⇒ failed/rolled-back + suppressedTarget written`, `exit 12 ⇒ uncertain`, `exit 255 mid-apply ⇒
  uncertain`, `runner throws ⇒ uncertain`, `exit 121 ⇒ owner-action/legacy-ocx`, `exit 121 child-node-unavailable ⇒
  owner-action/launcher-node-missing`, `exit 127 ⇒ failed`.
- Windows (H4): `windows orchestrated plan ⇒ one observe call, then unsupported/windows-apply, no apply argv`;
  `windows desktop-request plan ⇒ owner-action/desktop-app (080 replaces with the request), never windows-apply`;
  `recorded windows record is observed` (the early refusal is gone).
- launcher selection (H2): `installKind bun ⇒ remoteUpdateApplyArgv viaLauncher false`; `npm and pnpm ⇒ true`.
- Child clock (M9): `childNowMs C, startedAt S, now S+5000 ⇒ --not-after C+120000` (not the Home clock);
  `childNowMs null ⇒ --not-after now+remaining` and an exit-10 `deadline-passed` answer ⇒ `refused/deadline-passed` with the
  `clock-skew` hint; the same answer with a Child clock carries no hint; `now S+110000 ⇒ busy/plan-expired, no apply`.
- `a fake 2.96 Child never receives update --yes`: the fake runner executes the real POSIX gated script under `sh`
  with a stub `ocx` printing `opencodex 2.96.0` and recording its argv; the stub's log stays empty (POSIX only;
  skipped on Windows with `test.skipIf(process.platform === "win32")` because the script is POSIX).

**tests/server/link-child-ops-routes.test.ts** — `handleLinkRoutes(ctx, state)` with `state.childOps` set to an engine
whose runners are stubs.
- Auth: `admin token on loopback ⇒ 202`, `current loopback dashboard session ⇒ 202`, `tailscale identity ⇒ 403`,
  `no principal ⇒ 403`, `GET job with each principal`.
- Body: unknown key, unknown op, `restart` on observe, `restart:"bogus"`, empty list, 65 ids, duplicate ids, malformed
  id ⇒ 400 `invalid_body`; `restart-codex` without restart ⇒ job `restart:"app-server"`.
- Restart scope (M8): `{op:"restart-codex", linkIds:"all"}`, `{op:"sync", restart:"app-server", linkIds:"all"}` and
  `{op:"update", restart:"codex", linkIds:"all"}` ⇒ 400 `invalid_body`; `{op:"sync", linkIds:"all"}` ⇒ 202.
- `404 link_not_found`, `409 link_not_home_initiated`, `409 link_operation_in_progress`.
- `GET /api/link/children/jobs/ljob_…` 200 with the same job; unknown id 404 `job_not_found`; `bad id` 400.
- `DELETE /api/link/{id} answers 409 while held, and removes the link once the job is done` (stub runner gated on a
  deferred; the SSH runner fake records the `disconnect` call only after release).
- `trigger is manual even when the body says auto`: body with `trigger` ⇒ 400 (unknown key).
- Revision 5: `no links ⇒ 409 no_eligible_links with message "This Home has no links."`; `{op:"sync", linkIds:[CLIENT]} ⇒
  409 link_not_home_initiated` while wp2's `{op:"observe", linkIds:[CLIENT]}` still answers 202; a Child runtime still
  answers `409 runtime_role_client` for every op. The harness reaches the routes through `handleManagementAPI`, so
  `afterEach` awaits `sharedChildOpsEngine().settled()` and calls `resetSharedChildOpsEngineForTests()`; wp2's cases keep
  passing because each harness uses a fresh config object and every case polls its job to `done`.
- `registry`: covered by the existing `tests/server/management-route-registry.test.ts` after 2.7.

**tests/cli/cli-link-child-ops.test.ts** — `runLinkCommand` with `baseUrl` and a fetch fake.
- Usage exit 2: neither or both of `--link-id`/`--all`, bad id, both restart flags, `restart-codex` without `--yes`,
  `restart-codex --all`, `--scope foo`, stray argument.
- Bodies: `sync --restart-codex` posts `restart:"codex"`; `restart-codex` default posts `restart:"app-server"`.
- `--no-wait` prints the queued job and exits 0 without polling; default polls every `pollIntervalMs` until `done`.
- Exits: all succeeded ⇒ 0; one `owner-action` ⇒ 6; one `uncertain` ⇒ 1; 409 ⇒ 5; bare 404 ⇒ 4 with "does not support
  Child operations"; 404 `link_not_found` ⇒ 4 with the route message; poll 404 `job_not_found` ⇒ 4.
- Restart flags (M8): `sync --all --restart-app-server-only` ⇒ exit 2; `sync --link-id A --restart-codex` without `--yes` ⇒
  exit 2; `sync --link-id A --restart-codex --yes` posts `restart:"codex"`; `--yes` without a restart ⇒ exit 2.
- Job tolerance (H5, Revision 5 exits): a job with an extra top-level key, an item with an extra key and a `succeeded`
  item whose `restart.outcome` is `"deferred"` (a value this CLI does not know) validates, prints the job with
  `restart.requested` kept and exits 6; an item state this CLI does not know exits 1 (wp2's D15 rule); `jobId: 7`,
  `items: {}` or `schema: "ocx.link.child-job/2"` ⇒ exit 1.
- Partial successes: `succeeded/restart-skipped:link-active` ⇒ 6; `succeeded/post-update-sync-failed` ⇒ 6; a
  `succeeded` item with `restart.outcome: "requested"` and reason null ⇒ 0.
- Wait deadline (carried item b): a job whose only item stays `queued` for 20 polls of 60 s, then `running`, then
  `done` ⇒ exit 0 (the queued time spent no budget); the same job never leaving `running` ⇒ exit 1 `job_still_running`
  after the `sync` budget (420 s + 30 s) counted from the first poll without a queued item; an `update` job uses 2 100 s;
  a job queued forever ⇒ exit 1 at the 3 h cap.
- 403 (Revision 4, 4529521950): the POST answers 403 ⇒ stderr carries `LOOPBACK_REQUIRED_MESSAGE`, exit 1.
- Repeatable `--link-id` for `update` and plain `sync`; two ids with a restart flag ⇒ exit 2.
- `ocx capabilities --json lists link.child-ops/1`.
**tests/cli/cli-link-check.test.ts** (MODIFY, wp2 file) — a `check` job whose item stays `queued` past wp2's 150 s
budget, then finishes ⇒ exit 0; a 403 ⇒ the loopback message, exit 1; :127 already compares through
`NO_ELIGIBLE_LINKS_MESSAGE`, so the new text needs no edit there.

**tests/clients/link-gated-ocx-argv.test.ts** (MODIFY, wp1 file) — the A4 Windows cases (non-plan `update` refused),
the `launcher` field validation and the framing `launcher:` line (two lines ⇒ `invalid`).

Existing suites that must stay green: `tests/cli/cli-capabilities.test.ts`, `cli-capabilities-arguments.test.ts`,
`tests/ci-workflows/skill-ocx.test.ts`, `tests/cli/cli-link.test.ts`, `tests/server/link-management-routes.test.ts`,
`tests/lab/core-link-boundary.test.ts`, `gui/tests/remote-link.test.tsx`.

## 6. Docs and source-of-truth sync

Revision 5 anchors are on 87e005f93c, where wp2 already documented `ocx link check` in every surface below; wp3 extends
those passages instead of adding parallel ones.

- **structure/remote-link.md** — rewrite wp2's job paragraph (:73, "Child operations run as jobs") for four ops: the
  body becomes `{op, linkIds, restart?}` with `restart` refused on `observe` and with `"all"`; `409
  link_not_home_initiated` for a single Child-initiated link outside observe; `no_eligible_links` means links.json is
  empty; the engine is one per process (`sharedChildOpsEngine`), three items across all jobs with at most one update;
  the runners' SSH commands (pinned sync, the restart as a second pinned sync after a fresh activity read, the identity
  sync, plan and apply with the launcher route, post-update sync); the DELETE 409; the Windows and ocx-child refusals;
  the route always submits `trigger:"manual"`. Add the activity limit from Section 10 (a legacy key admission counts from
  its response headers only). The manifest entry (:1356) already lists `link-child-ops-routes.ts` and
  `link-child-ops.ts` (wp2; INDEX.md :261, :463) and `src/link/` is owned, so no manifest or INDEX change is needed; run
  `bun run structure:check` with the new files staged (structure/AGENTS.md).
- **docs-site English** — `guides/remote-link.md`: new `## Operating Children from the Home` after the "Home and Child
  versions" subsection (:165-193): what each op runs, version floors (sync and restart 2.93.0, update 2.97.0), "the
  target is always this Home's version", Windows and ocx-child limits, that a restart waits while the Child has a model
  request in flight and that a Child older than 2.69 is seen only once its response starts for a non-streaming request,
  exit codes, the loopback requirement for the CLI, and the sentence "Do not link a machine you do not own: the Home
  runs commands there with your SSH key." The check paragraph (:193) changes its exit-5 clause to "5 when another
  operation is running on that link or the Home has no links". The CLI reference block (:139-152) gains the four usage
  lines after the `check` line (:149). `reference/cli/lifecycle.md`: new `## Child operations from the Home` after the
  `ocx link check` paragraph (:1369-1376), before "Remote Link Child attestations" (:1377), with the
  `ocx.link.child-job/1` shape and the exit table.
- **docs-site translations** — the same edits in the `fr`, `ja`, `ko`, `ru`, `tr`, `zh-cn`, `zh-tw` copies of
  `guides/remote-link.md` and `reference/cli/lifecycle.md` (14 files); command lines and codes verbatim, prose
  translated, nothing that contradicts English. Validate with `cd docs-site && bun run build`.
- **skills/ocx** — `bun run skill:surface` regenerates `01_surface_access-remote.md` (its `link check` block at :700
  picks up the no-links wording) and `01_management_surface.md`; hand edits: `05_remote_hub.md` gains "Operating
  Children from the Home" after "Checking Children from the Home (`ocx link check`)" (:330-345): when to use `sync` vs
  `restart-codex` vs `update`, `--yes` semantics, never run `update --all` without the operator's request.
  `04_failure_semantics.md`: the exit table's 6 row (:17) adds the new verbs and the two partial-success reasons; the
  check paragraph (:32-37) replaces "`--all` found no Home-initiated link" (:36) with "the Home has no links" and
  covers all four verbs; "A pinned sync that refuses (exit 5)" (:143) gains `link_operation_in_progress`.
  `02_json_shapes.md` "Remote Link Child block and job document" (:401-419) gains `sync` and `restart` item fields.
  `bun run skill:surface:check` and `tests/ci-workflows/skill-ocx.test.ts` verify.
- **CLI help** — `registry.ts` and `LINK_USAGE` (2.9, 2.10).
- **GUI** — none in this phase (Deviation 5).

## 7. Enforcement bypass record (PLAN-BYPASS-NAMED-01)

| Guard | Tier | Executing surface | Known bypass | Residual risk | Wording |
|---|---|---|---|---|---|
| Per-link lock in the engine | Runtime, in-process | `ChildOpsEngine.submit` | `ocx sync` fan-out, a manual SSH session, GOAT, or a second Home process do not consult it | Two writers on one Child; the Child's sync/update mutex (`src/update/sync-update-mutex.mjs`) serializes them and returns exit 7 / `update-in-flight` | "serializes this Home's operations per link", never "exclusive access to the Child" |
| DELETE 409 while held | Runtime | `remove()` | Restarting the Home drops the job and its hold; a job submitted after `remove()` passed its check (the check is synchronous with `activeJob`, the removal that follows awaits) | The job's next SSH step finds the record gone (`link-removed`) or the Child refuses with `child-link-mismatch` (exit 5) | "refuses removal while this Home runs an operation on the link" |
| Version gate before `update` | Remote script (wp1) | `remoteGatedOcxArgv` | An operator running `ocx update` on the Child directly | None added | "never sends an update command to a Child below 2.97.0" |
| Windows builds only `update --plan` | Argv builder | `remoteGatedOcxArgv` Windows branch (A4, Revision 5) | A caller building PowerShell argv without `remoteGatedOcxArgv` | None in this unit; `windowsGatedOcxArgv` has no other caller that passes `update` | "never builds a Windows apply" |
| `trigger:"auto"` only from the scheduler | Code path | `parseOperation` rejects unknown keys | A local process with the admin token cannot set it; it can only request manual ops it is already authorized for | None | "the management API submits manual operations only" |
| Windows refusals | Runtime | runners | None from the Home; the operator can act on the Child | Windows Children stay manual | "refused on Windows (reason windows-restart / windows-apply)" |

## 8. Verifiers (PLAN-VERIFIER-REAL-01)

Run on 00680193cb while writing revision 1; facts refreshed by audit r1 on 61151e3457 where noted:

| Command | Exit | Reads this phase's target? |
|---|---|---|
| `bun run typecheck` | 0 (2,379 files, no errors) | Yes after implementation: `bun check --noEmit` covers every `src/**` and `tests/**` file the phase adds |
| `bun test tests/lab/core-link-boundary.test.ts tests/cli/cli-link.test.ts tests/cli/sync-fanout.test.ts tests/cli/cli-capabilities-arguments.test.ts` | see 8.1 | core-link-boundary walks `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts` (it would catch an engine import from core); cli-link covers `runLinkCommand`; capabilities-arguments reads `CAPABILITY_CONTRACTS` |
| `bun test tests/server/management-route-registry.test.ts` | see 8.1 | Yes: scans every `src/server/management/*.ts` (test :44-51) |
| `bun run skill:surface:check` | see 8.1 | Yes: regenerates from `src/cli/capabilities.ts` |
| `bun run structure:check` | see 8.1 | Yes: manifest `documents` and new `src/` files |
| `bun run privacy:scan` | not run (PR gate) | Yes: `devlog/`, `src/` |
| `cd docs-site && bun run build` | not run (PR gate) | Yes: the 16 doc files |
| `bun test tests/clients/link-child-ops-engine.test.ts tests/clients/link-child-ops-runners.test.ts tests/server/link-child-ops-routes.test.ts tests/cli/cli-link-child-ops.test.ts` | new; fails before implementation (missing modules) | Yes |
| `bun run test:changed` | PR gate | follows the import graph from the changed files |

### 8.1 Results

Revision 5, on 87e005f93c (wp1 and wp2 merged, no wp3 code), 2026-11-11:

- `bun run typecheck` — exit 0, "No type errors in 2,397 files".
- `bun test tests/server/link-child-ops-routes.test.ts tests/cli/cli-link-check.test.ts tests/clients/link-gated-ocx-argv.test.ts
  tests/clients/link-child-update-contract.test.ts tests/clients/link-child-observe.test.ts tests/clients/link-child-activity.test.ts
  tests/lab/core-link-boundary.test.ts tests/cli/cli-link.test.ts tests/cli/sync-fanout.test.ts
  tests/cli/cli-capabilities-arguments.test.ts tests/server/management-route-registry.test.ts` — exit 0, 215 pass, 0 fail
  across 11 files. These are the existing suites wp3 modifies or must keep green; the four new files do not exist yet.
- `bun run skill:surface:check` — exit 0, "All 9 generated management surface files are current."
- `bun run structure:check` — exit 0, "structure/ SSOT checks passed".
- `wc -l scripts/test-layout/layout.json` — 1999.
- NOT RUN: `bun run privacy:scan`, `cd docs-site && bun run build`, `bun run test:changed`, the full suite (a
  plan-only change; the wp3 PR runs them).

Earlier revisions:

Run on 00680193cb (before any wp1–wp3 code exists), 2026-11-11:

- `bun run typecheck` — exit 0, "No type errors in 2,379 files".
- `bun test tests/lab/core-link-boundary.test.ts tests/cli/cli-link.test.ts tests/cli/sync-fanout.test.ts
  tests/cli/cli-capabilities-arguments.test.ts tests/codex-integration/catalog-auto-refresh-client-fanout.test.ts` —
  exit 0, 46 pass, 0 fail across 5 files.
- `bun test tests/server/management-route-registry.test.ts` — exit 0, 29 pass, 0 fail.
- `bun run skill:surface:check` — exit 0, "All 9 generated management surface files are current."
- `bun run structure:check` — revision 1 saw exit 1 on 00680193cb (a 603-line `anthropic-account-pool.md`); audit r1 on
  61151e3457: exit 0. The wp3 PR must keep it at 0.
- `wc -l scripts/test-layout/layout.json` — 1998 on 61151e3457 (ratchet fails at 2000), so no registration goes there.
- NOT RUN: `bun run privacy:scan`, `cd docs-site && bun run build`, `bun run test:changed`, the full suite
  (shared, loaded host; PR CI covers them).

## 9. Acceptance criteria

1. `POST /api/link/children/operations {op:"sync",linkIds:[A]}` with the admin token on loopback answers 202 with
   an `ocx.link.child-job/1` document whose item ends `succeeded` when the fake Child exits 0 with a synced fan-out
   document (routes test).
2. `ocx link restart-codex --link-id A --yes` against a POSIX full Child sends a plain pinned sync, then one SSH command
   whose remote argv contains `--restart-app-server-only` after `--json`, and prints a job whose item carries
   `restart: {requested: "app-server", outcome: "requested"}`; exit 0 (runners + CLI tests).
3. The same command for a Windows Child makes no SSH call and ends `unsupported (windows-restart)`; exit 6.
4. `ocx link update --link-id A` on a 2.97+ npm Child with `canApply` runs the plan on the served entry, the apply through
   `<node> <root>/bin/ocx.mjs` with `--version <home> --expect-plan <token> --not-after <childNow+120000>`, then the pinned
   sync; exit 0. A Bun global Child plans and applies on Bun (A4 fixtures).
5. A Child at 2.96 receives no `update --yes` argv; the item ends `owner-action (legacy-ocx)` (gated-script test).
6. Exit 11 sets `suppressedTarget` to the Home version; a later manual update clears it before applying.
7. Exit 12, ssh 255 during apply, or the runner deadline end `uncertain` and never trigger a second apply in the
   same job.
8. With a job holding link A, a second single-link submit for A answers 409 `link_operation_in_progress`, and
   `DELETE /api/link/A` answers the same 409; after the job finishes the DELETE proceeds.
9. `ocx link update --all` over five links never runs two items at once; `ocx link sync --all` runs at most three.
10. `ocx capabilities --json` lists `link.child-ops/1`; `bun run skill:surface:check` passes after regeneration.
11. A Home without these routes makes `ocx link update` exit 4 with wp2's `OLD_HOME_MESSAGE` ("This Home does not
    support Child operations; update the Home.").
12. `bun run typecheck`, `bun run structure:check` and the management-route-registry test pass with the two new routes.
13. A restart request with `linkIds:"all"` answers 400; a restart sent while a relayed request is in flight is withheld
    with `restart-skipped:link-active`; `ocx link sync --restart-codex` without `--yes` exits 2 (A2, M8).
14. A Windows Child whose plan routes `desktop-request` never ends `windows-apply` (H4).
15. A job document with an unknown key and an unknown `restart.outcome` validates in this CLI (H5).
16. `--not-after` is computed from the Child's clock marker (M9).
17. (Revision 5) A job whose items wait `queued` behind another job does not exit 1 `job_still_running` before its
    items have run for their op's budget (carried item b).
18. (Revision 5) `remoteGatedOcxArgv` throws `unsupported:windows-apply` for any Windows `update` argv without `--plan`
    (carried item d); `ocx link sync --all` with no links exits 5 with "This Home has no links." (carried item a).
19. (Revision 5) The wp2 suites `tests/server/link-child-ops-routes.test.ts` and `tests/cli/cli-link-check.test.ts`
    keep passing with the shared engine and the extended exit mapping.

## 10. Security review notes, risks and Windows

- **Trigger for review:** two new mutating `/api/link` routes and remote execution of the Child's updater. Review
  focus: auth (`either` = dashboard session or loopback admin token; Tailscale identity refused, link-route-state.ts:104-111),
  no new credential, artifact source or trust root (D20), body strictness (unknown keys rejected, ≤ 64 ids), no
  remote output stored or logged (items carry closed reason codes and `boundHint`-bounded hints only), `--not-after`
  120 s and `--expect-plan` binding, the pre-update and post-update `--expect-link` syncs as identity checks.
- **Identity residual (Revision 4, 4529521925):** the identity sync runs before the plan probe, so a relink on the Child
  during the probe (at most 60 s) or the apply is not caught before mutation; the post-update sync reports it. Closing
  that gap needs the Child's updater to hold the Child's link lifecycle lock through the apply, a `src/update/*`
  change this unit excludes (000 non-goals, D19). Both sides of that race are the same operator.
- **Restart residual (Revision 4, 4529521916):** a relayed request that starts during the restart's own SSH round trip
  (after the second activity read) is cut by the restart. The Home cannot fence it: the restart runs on the Child, and
  delaying the request at the Home would not save a turn whose app-server is being restarted.
- **Legacy activity (Revision 5, carried item c):** activity is counted at the Home's relay
  (src/server/index/link-relay-sessions.ts:136-153). A relay-session request counts from session validation, but a
  legacy key admission, which is how a Child older than 2.69 reaches the Home, counts only once its response status is
  known and below 400, that is from its response headers. For a non-streaming model request the headers arrive when
  the model has finished, so while such a request is still running the link reads `inFlight` 0: the restart guard
  (`linkBusy`) and the automatic idle check cannot see it, and a restart sent then can end that turn. Streaming requests
  are seen from their first response bytes. A refused or unauthenticated legacy request never counts. The fix is on the
  Child (update it to 2.69 or later, which uses relay sessions); the docs and skills page state the limit (Section 6).
- **Consenting principal:** the operator holding the SSH key. The docs say not to link a machine you do not own.
- **Risks:** (1) An update stops the Child's runtime and ends relayed turns; manual updates do not check idle by
  design (the operator asked), automatic ones do (070). (2) The env captures one request's `ctx` for the job
  lifetime; a config reload during a job keeps the old object for wire-state projection only. (3) A Home restart
  loses running jobs; the Child's update continues and the next observe reports it. (4) Non-loopback Homes: the
  CLI's POST reaches the TCP listener, which refuses the admin token there (403, as for revoke); the dashboard path
  works; widening the local-control socket is out of scope. Revision 4 (4529521950): this configuration is explicitly
  unsupported for the CLI. `runLinkChildOp` and `runLinkCheck` catch a `RuntimeApiError` 403 and exit 1 with
  "Child operations from the CLI need a Home bound to loopback; use the Remote Link page in the dashboard." (050's
  `ocx link policy` write does the same.) Test in `cli-link-child-ops.test.ts`: a stub answering 403 ⇒ that message,
  exit 1. The docs-site CLI reference and `skills/ocx` hand page state the limit.
- **Clock skew (M9):** the deadline uses the Child's own clock from the plan probe (seconds resolution), so a skewed
  Child clock no longer turns every apply into `deadline-passed`. If the marker is missing the Home clock is used and a
  `deadline-passed` refusal carries a `clock-skew` hint. Nothing ran in either refusal.
- **Windows:** observe and sync are supported (existing pinned script). `restart-codex` is refused with
  `unsupported/windows-restart` until a native OpenSSH fixture proves the SSH logon session can signal the user's
  app-servers; orchestrated `update` is refused with `unsupported/windows-apply` because a dropped channel kills the
  Job-contained parent (remote-windows.ts, kill-on-close) and Windows candidates are `ocx.exe` only. The Home side runs
  on Windows unchanged: no new process spawning beyond the existing `SshRunner`.
  The update runner observes Windows Children (read-only plan) because `desktop-request` is the one update route a Windows
  Child can take (A5, H4); 080 makes that route act. Orchestrated apply stays refused after the Desktop branch.


## Revision 3 (audit r2 residuals)

- R2: ocx link sync with a restart that was withheld (restart-skipped:link-active) exits 6, matching ocx sync --restart-children (040); the item state stays succeeded because the sync ran. CLI exit rule: exit 6 if any item is non-success or carries reason restart-skipped:link-active. Test added beside the sync restart guard case. (Revision 5: implemented as "a success with a reason or a restart that was not requested is 6; an unknown state is 1", 2.8 item 4.)
- R3: the plan-expired branch is defensive (see the comment at the apply step); its unit test drives it with an injected clock, the only activation today.
- R6: see the scope note on parseOperation.


## wp3 P re-verification (base dev 87e005f93c)

Re-verified on 2026-11-11 against `dev` 87e005f93c (wp1 #8505, wp2 #8508 and #8509 merged), reading the merged wp1
modules (`ssh-argv.ts`, `child-gated-ocx.ts`, `child-update-contract.ts`, `remote-windows.ts`, `sync-fanout-classify.ts`,
`child-observations.ts`) and wp2 modules (`child-ops-engine.ts`, `child-observe.ts`, `child-activity.ts`,
`child-catalog-freshness.ts`, `status-projection.ts`, `link-child-ops-routes.ts`, `link-child-ops.ts`,
`link-status-child.ts`, `src/lib/catalog-etag.ts`, `link-relay-sessions.ts`). Changes made to this document:

1. **Interfaces table** rewritten with the merged signatures and line anchors, including wp2's engine, routes and CLI,
   which revision 4 described as planned.
2. **Engine (2.2)** rebuilt on wp2's code: single engine-wide queue (three items across jobs) plus one update place
   that does not block items queued behind it; busy and admission-time `unsupported` items write no `lastOperation`;
   `"all"` is every link, so `no_eligible_links` stays "links.json is empty"; an all-held multi-link job finishes busy
   with 202; per-job `ChildOpsEnv` (retention uses the job's own clock); `link_not_home_initiated` only outside
   `observe`; wp2's option names `jobId` and `concurrency` and its log-by-error-name rule kept;
   `sharedChildOpsEngine()` plus `resetSharedChildOpsEngineForTests()` for the route tests.
3. **Runners (2.3):** `pinnedSync` passes `{ expectSelectedKind: restart !== "none" }` to `classifySyncResult`
   (without it the ocx-child restart outcome could never be detected); `runObserveItem` keeps wp2's
   `failed/observe-error` for a throwing observe.
4. **Routes (2.4, 2.5):** kept wp2's auth-first order, `409 runtime_role_client`, `503 link_unavailable` and the
   pull flush; `childOpsEngineFor(state)` caches the shared engine (wp2 created one per config-keyed route state);
   `childOpsEnvFor` uses the optional listener seams, `readChildObservations()`'s default path and a never-throwing
   `writeObservation`; the job GET and the status `activeJob` read the shared engine; `link-route-state.ts` changes its
   comment only.
5. **CLI (2.8, 2.9):** extends wp2's `validateChildJob` (keeps `restart.requested`), `linkCheckExitCode` (a success with a
   reason or a restart that was not requested exits 6; an unknown state stays 1 as wp2 shipped), JSON output and
   conflict messages; `runLinkChildOp` and `runLinkCheck` share one submit-and-wait helper with the 403 loopback
   message; `--link-id` is repeatable as in `check` except with a restart; `link.ts` reuses wp2's `verdictExit`.
6. **Carried item (a):** `NO_ELIGIBLE_LINKS_MESSAGE`, the route message, the `link check` capability detail and the
   skills page say "This Home has no links" (2.4, 2.8, 2.10, Section 6).
7. **Carried item (b):** per-op item budgets (observe 120 s, sync and restart-codex 420 s, update 2 100 s) with the
   deadline moved forward while any item is `queued`, under a 3-hour cap (2.8 item 5); tests in Section 5.
8. **Carried item (c):** Section 10 "Legacy activity" and Section 6 document that a legacy key admission (a Child
   before 2.69, `relay-auth/2` in src/link/compatibility.ts:25) counts as activity only from its response headers.
9. **Carried item (d):** the Windows branch of `remoteGatedOcxArgv` refuses any `update` argv without `--plan` (or with
   `--yes`); tests and a Section 7 row added.
10. **A4:** stale anchors fixed (ssh-argv.ts:152-200 and :360-419, bin/ocx.mjs:1351-1393 and :109-111,
    orchestrated-entry.ts:224-233, child-update-contract.ts:129); the Bun-global claim no longer cites
    serving-runtimes.ts; `find_launcher_node` and `launcher=` are placed at the top of `remoteGatedScript`; framing,
    refusal and classifier anchors added.
11. **File map, registration and docs:** `childSkipHint` rows made unconditional (wp1 left it at
    src/cli/sync-fanout.ts:13-23); `link-route-state.ts` added; every anchor refreshed (link.ts, link-routes.ts,
    capabilities-access-remote.ts, registry.ts, skills pages, docs-site guide and lifecycle reference, structure);
    `layout.json` is 1999 lines, so registration stays in `layout-clients.json` after its :191 entry; the manifest
    needs no change because wp2 already owns both files.
12. **Kept unchanged:** canonical names (000 table updated only for the engine, routes and CLI rows), the test
    registration rule, no `src/update/*` change, the C4 class and the explicit security review before merge, D12/D13
    runner logic, A2/M8 restart guards, M9 Child clock, H4 Desktop-before-Windows, H5 tolerance, and every Revision 3
    and 4 decision. Deviations 9-13 record the Revision 5 changes.


## Revision 6 (wp3 plan audit, base 87e005f93c)

Audit verdict GO-WITH-FIXES (blockers 5; F5 fix-or-waive). All findings accepted; binding on the implementation:

1. **F1 (High).** `tests/clients/link-child-observe.test.ts` is MODIFY: its seven `createChildOpsEngine({...})` calls move to the
   process-wide engine with a per-job env (or the test reset function); refusal assertions use the new shape including
   `linkId`; the test env's `writeObservation` is a guarded writer (logs and swallows), so the cache-write test still sees two
   warnings and a `succeeded` item. `runObserveItem` and every runner call `env.writeObservation` only through that
   never-throwing contract. Line ~1280's claim that engine cases live in the routes file is corrected: they stay in
   `link-child-observe.test.ts` (observe) and a new `link-child-ops-runners.test.ts` (sync/restart/update), registered per rule.
2. **F2 (Medium).** The second, restarting sync maps to `restart.outcome: "not-run"` only when the result is `skipped` or a
   pre-selection refusal (exit 121/125/127 with no selection marker). Any other non-synced result after selection
   (`ssh-failed` exit 255, `child-sync-failed`, timeout) reports `restart.outcome: "requested"` and ends the item
   `uncertain` with reason `restart-result-unknown`. Runner test: exit 255 on the second sync.
3. **F3 (Medium).** The CLI maps a `400 invalid_body` answer to a non-observe op (a Home that has wp2 but not wp3) to
   `OLD_HOME_MESSAGE` and exit 4, like the 404 case. Test for update and sync.
4. **F4 (Medium).** `find_launcher_node` runs `node --version` under the same 10 s watchdog pattern as `try_ocx`; a stuck or
   failing Node means `launcher: unavailable` in the report and never fails the plan probe. The capability text and docs say
   that observe on an npm/pnpm Child also probes Node, read-only.
5. **F5 (Medium), fixed.** `ocx link update` requires `--yes` (single link or `--all`), like `restart-codex`: an update stops the
   Child runtime and ends relayed turns. Missing `--yes` is a usage error (exit 2). The API route is unchanged (the GUI asks in
   its confirmation dialog, 060). Capability, registry, skill pages and docs updated.
6. **F6 (Low/Medium).** `tests/server/link-child-ops-routes.test.ts` is MODIFY: the `{op:"sync"}` → 400 assertion (`:128`) now
   expects 202 with a job; route tests drive operations through the harness's SSH `gate` (real runners, fake SSH), not stub
   runners. Acceptance criterion 19 lists the wp2 assertions that change.
7. **F7 (Low).** `tests/clients/link-gated-ocx-argv.test.ts` literals (`:243`, `:270-273`) gain `launcher`; `assertGated` checks
   version, lacks marker, args, then launcher, so the existing message assertion holds.
8. **F8 (Low).** The apply argv is built before the apply `try`; a builder error ends the item `failed/ssh-argument-invalid`
   without writing `pendingUpdateRecovery`.
9. **F9 (Low).** `ChildOpsEnv.writeObservation` carries a doc comment on the type: it never throws (logs and drops).
10. **F10 (Low).** DELETE /api/link/{id} re-checks `engine.activeJob(linkId)` immediately before the store write, after the
    awaited body read and remote cleanup; a job that took the link in that gap makes DELETE answer 409.

