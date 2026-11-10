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

- **Work-phase:** wp3. **Depends on:** wp1 ([010](010_foundations.md)), wp2 ([020](020_signals_visibility.md)).
- **Class:** C4. New mutating management routes, remote update execution over the pinned SSH channel,
  a new CLI contract (`link.child-ops/1`). Explicit security review is required before merge
  (`src/AGENTS.md`, `MAINTAINERS.md`; 000 "Work class").
- **Base:** `dev` (61151e3457 at revision 2) plus the wp1 and wp2 merges.

**Outcome.** The Home can run three operations on any Home-initiated Child from the management API and
the CLI: `sync` (the pinned `sync --expect-link` with an optional restart scope), `restart-codex` (the
same pinned sync carrying `--restart-app-server-only` or `--restart-codex`, which works on every full
Child at or above 2.93.0, D13/F2) and `update` (the Child's own `update.orchestrated/1` command,
version-gated inside the remote script, target always the Home's version, followed by a pinned sync,
D12). Every operation is a job in one process-wide engine that serializes work per link, runs at most one
update item and at most three other items at a time across all jobs (engine-wide slots), keeps 32 finished jobs or one
hour, and records each item's summary as `lastOperation` in the observation cache.
`DELETE /api/link/{id}` answers `409 link_operation_in_progress` while a job holds the link. Operators
get `ocx link update|sync|restart-codex`; agents see contract `link.child-ops/1` in `ocx capabilities`.

**IN:** `src/link/child-ops-types.ts`, `src/link/child-ops-engine.ts`, `src/link/child-ops-runners.ts`,
`src/server/management/link-child-ops-routes.ts`, one delegating branch and the DELETE 409 in
`link-routes.ts`, a `childOps` seam on `LinkRouteState`, registry entries, `src/cli/link-child-ops.ts`,
`link.ts` switch arms and usage, three capabilities, the contract string, `registry.ts` help lines,
`skills/ocx` hand pages plus `bun run skill:surface`, docs-site guide and CLI reference (8 languages),
`structure/remote-link.md` and its manifest entry.

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
| wp1 `src/link/ssh-argv.ts` | `remotePinnedSyncArgv(linkId, platform, opts?: { restart?: "app-server" \| "codex" })`, `remoteGatedOcxArgv(cmd: GatedOcxCommand, platform)` | Gate ≥ 2.93.0 for sync (exit 121 + marker); with `restart` exactly one of `--restart-app-server-only` / `--restart-codex` after `--json` (D2). wp3 adds the `launcher` field (A4 below). |
| wp1 `src/link/child-gated-ocx.ts` | `remoteUpdateApplyArgv`, `classifyUpdateApply(result): UpdateApplyVerdict` | `UpdateApplyVerdict = { state: ApplyState; reason; fromVersion?; toVersion?; suppressTarget; reobserve }`; ssh 255 ⇒ `uncertain/ssh-failed`, exit 11 ⇒ `failed` with `suppressTarget: true` (010 mapping table). wp3 adds `viaLauncher` and the `child-node-unavailable` refusal (A4). |
| wp1 `src/link/child-observations.ts` | `ChildOp`, `ChildOperationSummary`, `ChildObservation`, `updateChildObservations`, `patchChildObservation(file, linkId, patch, now: Date)` | Tolerant cache (D4); a write prunes ids absent from `links.json`. |
| wp1 `src/link/sync-fanout-classify.ts` | `classifySyncResult` | 010 moved it; `childSkipHint` was not moved, so wp3 moves it (Section 1, conditional rows). |
| wp2 `src/link/child-observe.ts` | `observeChild(record, deps: ObserveDeps): Promise<ObserveOutcome>` | `ObserveOutcome = { state, reason, observation, probe }`; `probe = { classification: PlanClassification; childNowMs; startedAt; platform } \| null` (020). |
| wp2 `src/link/child-activity.ts` | `LinkActivitySnapshot`, `isLinkIdle(snapshot, now, idleAfterMs)`, `DEFAULT_IDLE_AFTER_MS` | Listener `linkActivity(linkId, now)`; absent ⇒ never idle. |
| wp2 engine, routes, CLI | `createChildOpsEngine` (`submit`, `job`, `activeJob`), `handleLinkChildOpsRoutes`, `attachLinkChildOpsForState`, `runLinkCheck`, `validateChildJob` | wp3 MODIFIES these files (2.2, 2.4, 2.8); `LinkRouteState.childOps` and both registry entries exist already (2.5, 2.7). |

## A4 — Remote apply of npm and pnpm Children through the package launcher

**Problem (from 010, verified here).** The gated script prefers the served pair recorded in `serving-runtimes.json`,
`[bun, <root>/src/cli/index.ts]` for a package install (src/link/ssh-argv.ts:203-221). The Node launcher is where
npm/pnpm orchestrated apply lives: `bin/ocx.mjs:1362-1390` runs `applyNodeOrchestratedUpdate` only for
`mode === "apply"` on an npm/pnpm `node_modules` install. The Bun entry never gets there: for a plan that `canApply`
with `installer` npm or pnpm it falls through to `src/update/orchestrated-entry.ts:225-233` and prints a result with
`error: "plan-unavailable"`, exit 10. So without a change every npm/pnpm Child that has a census entry ends
`launcher-bypassed` (010's interim row), which contradicts A4.

**Decision (revision 2, audit H2).** The launcher route is used **only for the apply step** and **only when the parsed
plan says `installer` is `npm` or `pnpm`**. The Home decides from the plan it parsed, not the remote script from a path
pattern: a Bun global install's census root (`~/.bun/install/global/node_modules/@bitkyc08/opencodex`,
src/config/serving-runtimes.ts:50-58) also contains `/node_modules/` and `bin/ocx.mjs`, and sending it through Node
would run the launcher's ordinary bootstrap (`bin/ocx.mjs:1362` excludes Bun global installs from the npm apply).
- **Plan:** always the served entry, as today. The script only *reports* whether a launcher Node exists
  (`ocx-fanout:launcher:available` / `unavailable`) and never exits because Node is missing. The served-entry plan is
  also what the launcher's own apply recomputes before it mutates (its `plan` callback runs `bun --no-env-file <cliPath>
  update --plan --json --version <v>`, bin/ocx.mjs:1367-1368), so the `planToken` the Home holds matches.
- **Apply, installer npm or pnpm:** `<node> <root>/bin/ocx.mjs update --yes --json --version <home> --expect-plan <token>
  --not-after <ms>`, which is what `ocx update --yes --json ...` through the npm shim runs on the Child (package.json
  `"bin": {"ocx": "./bin/ocx.mjs"}`). The launcher's package-manager self-update path (bin/ocx.mjs:1359) requires
  `OCX_UPDATE_ORCHESTRATED_CHILD=1`; the script `unset`s it before `exec`, so the remote apply can only take the
  orchestrated branch (or refuse). No `src/update/*` file changes.
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
  The final lines of the selected-ocx branch become:
  ```sh
  find_launcher_node() {
    case "$1" in */lib/node_modules/@bitkyc08/opencodex)
      n=${1%/lib/node_modules/@bitkyc08/opencodex}/bin/node
      if [ -x "$n" ] && "$n" --version >/dev/null 2>&1; then printf '%s\n' "$n"; return 0; fi;; esac
    n=$(command -v node 2>/dev/null) && [ -x "$n" ] && "$n" --version >/dev/null 2>&1 && printf '%s\n' "$n"
  }
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
- `src/link/child-gated-ocx.ts`: `remoteUpdatePlanArgv` passes `launcher: "report"`. `remoteUpdateApplyArgv`'s input gains
  `viaLauncher: boolean` and passes `launcher: viaLauncher ? "apply" : "none"`. Windows builders ignore the field
  (apply is refused there, D20; a Windows plan reports nothing). `readGatedFraming` learns at most one
  `launcher:(available|unavailable|exec)` line (two ⇒ `invalid`) and returns it as `launcher`; the 121 marker set gains
  `child-node-unavailable`, and `classifyUpdateApply` maps that refusal to `owner-action`/`launcher-node-missing`.
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
| src/link/child-ops-engine.ts | MODIFY (020 file) | Job registry, per-link lock, bulk queue, retention, `lastOperation` write, shared instance | 020 |
| src/link/child-ops-runners.ts | NEW | Item runners for `observe` (020's dispatch moved here), `sync`, `restart-codex`, `update` (D12, D13) | — |
| src/link/ssh-argv.ts, src/link/child-gated-ocx.ts, src/link/child-update-contract.ts | MODIFY (010 files) | A4 launcher field, `viaLauncher`, framing and classifier rows | 010 |
| src/link/sync-fanout-classify.ts | MODIFY (only if wp1 left `childSkipHint` in src/cli) | Export `childSkipHint` | wp1 file |
| src/cli/sync-fanout.ts | MODIFY (same condition) | Re-export `childSkipHint` | :88-97 |
| src/server/management/link-child-ops-routes.ts | MODIFY (020 file) | All ops on `POST /api/link/children/operations`, env builder | 020 |
| src/server/management/link-routes.ts | MODIFY | Delegating branch; DELETE 409 | :201-205, :285-286 |
| src/cli/link-child-ops.ts | MODIFY (020 file) | `ocx link update|sync|restart-codex`, job polling, exit mapping, tolerant job validator | 020 |
| src/cli/link.ts | MODIFY | Usage lines, switch arms, exit passthrough | :36-47, :385-398 |
| src/cli/capabilities-access-remote.ts | MODIFY | Three capabilities | :167-168 |
| src/cli/capability-contracts.ts | MODIFY | `link.child-ops/1` | :2 |
| src/cli/registry.ts | MODIFY | Link help lines | :154-163 |
| skills/ocx/references/01_surface_access-remote.md, 01_management_surface.md | REGENERATE | `bun run skill:surface` | generated |
| skills/ocx/references/05_remote_hub.md, 04_failure_semantics.md, 02_json_shapes.md | MODIFY | Hand pages | :216, :136, :154 |
| docs-site/src/content/docs/guides/remote-link.md + fr, ja, ko, ru, tr, zh-cn, zh-tw | MODIFY | "Operating Children from the Home" section and CLI reference block | :137-148 |
| docs-site/src/content/docs/reference/cli/lifecycle.md + the same 7 locales | MODIFY | `ocx link update|sync|restart-codex` section | before :1398 |
| structure/remote-link.md, structure/manifest.json, structure/INDEX.md | MODIFY / REGENERATE | Ownership of the two new non-`src/link` files; behaviour paragraph | :67-71; manifest :1343 |
| tests/clients/link-child-ops-engine.test.ts, tests/clients/link-child-ops-runners.test.ts, tests/clients/link-child-update-launcher.test.ts, tests/cli/cli-link-child-ops.test.ts | NEW | Section 5 | — |
| tests/server/link-child-ops-routes.test.ts, tests/cli/cli-link-check.test.ts, tests/clients/link-child-update-contract.test.ts, tests/clients/link-gated-ocx-argv.test.ts | MODIFY (020 / 010 files) | Section 5 | — |
| scripts/test-layout/layout-clients.json, tests/fixtures/test-layout-expected.json | MODIFY | Register the four NEW tests | before each closing `}` |

Registration follows 000 "Test registration rule": `scripts/test-layout/layout.json` is 1998 lines on 61151e3457
and the ratchet fails at 2000, so no entry goes there; every new test goes into the `layout-clients.json` shard,
which already maps `cli` and `server` tests (layout-clients.json:14-15, :175) as well as `clients` ones.
`link-child-ops-routes.test.ts` is 020's file and is not registered again.

## 2. Changes

### 2.1 src/link/child-ops-types.ts (NEW, full content)

020 declared the job types inline in its engine; wp3 moves them here and the engine imports them. `ChildOp` is
declared once, in 010's `child-observations.ts` (000 "Canonical names").

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

020's names stay: `activeJob` (not `holder`), `job()` returning `undefined`, one shared instance. The deps that 020
fixed at creation move to `submit(request, env)`, and 020's `observe`/`writeObservation` deps become the `observe`
runner (`runObserveItem`, 2.3).

```ts
import { randomBytes } from "node:crypto";
import type { LinkRecord } from "./store";
import type { ChildOperationSummary } from "./child-observations";
import { CHILD_JOB_SCHEMA, type ChildJob, type ChildJobItem, type ChildOp,
  type ChildOpsEnv, type ChildRestart, type ChildTrigger, type ItemRunner } from "./child-ops-types";
import { runObserveItem, runRestartCodexItem, runSyncItem, runUpdateItem } from "./child-ops-runners";

export interface ChildOpRequest { op: ChildOp; linkIds: readonly string[] | "all"; restart: ChildRestart; trigger: ChildTrigger }
export type SubmitRefusal = "link_not_found" | "link_not_home_initiated" | "link_operation_in_progress" | "no_eligible_links";
export type SubmitResult = { ok: true; job: ChildJob } | { ok: false; code: SubmitRefusal; linkId: string | null };
export interface ChildJobHold { jobId: string; op: ChildOp; state: "queued" | "running" }

export interface ChildOpsEngine {
  /** Synchronous admission: locks are taken before it returns, so a DELETE racing it sees them. */
  submit(request: ChildOpRequest, env: ChildOpsEnv): SubmitResult;
  job(jobId: string): ChildJob | undefined;
  activeJob(linkId: string): ChildJobHold | null;
  /** Resolves when every job submitted so far is done. Tests and shutdown only. */
  settled(): Promise<void>;
}

export interface ChildOpsEngineOptions {
  runners?: Partial<Record<ChildOp, ItemRunner>>;
  newJobId?: () => string;
  retainJobs?: number;        // default 32
  retainMs?: number;          // default 3_600_000
  bulkConcurrency?: number;   // default 3; update is always 1
}

export const CHILD_JOB_ID = /^ljob_[0-9a-f]{16}$/;
const DEFAULT_RUNNERS: Record<ChildOp, ItemRunner> = {
  observe: runObserveItem, sync: runSyncItem, "restart-codex": runRestartCodexItem, update: runUpdateItem,
};
const DONE = new Set(["succeeded", "up-to-date", "busy", "offline", "refused", "owner-action", "unsupported", "failed", "uncertain"]);
const iso = (ms: number): string => new Date(ms).toISOString();

/** Revision 4 (CodeRabbit 4529521982): a counting semaphore. The engine owns one per bound, shared by every job. */
function createSlots(size: number): { take(): Promise<void>; give(): void } {
  let free = size;
  const waiters: Array<() => void> = [];
  return {
    async take() { if (free > 0) { free -= 1; return; } await new Promise<void>(resolve => waiters.push(resolve)); },
    give() { const next = waiters.shift(); if (next) next(); else free += 1; },
  };
}

/** 010's persisted slice; called after finishedAt is set. */
export function summarize(job: ChildJob, item: ChildJobItem): ChildOperationSummary {
  return { op: job.op, jobId: job.jobId, state: item.state, reason: item.reason, finishedAt: item.finishedAt!,
    ...(item.fromVersion ? { fromVersion: item.fromVersion } : {}), ...(item.toVersion ? { toVersion: item.toVersion } : {}) };
}

export function createChildOpsEngine(options: ChildOpsEngineOptions = {}): ChildOpsEngine {
  const runners = { ...DEFAULT_RUNNERS, ...options.runners };
  const newJobId = options.newJobId ?? (() => `ljob_${randomBytes(8).toString("hex")}`);
  const retainJobs = options.retainJobs ?? 32;
  const retainMs = options.retainMs ?? 3_600_000;
  const width = Math.max(1, Math.min(options.bulkConcurrency ?? 3, 3));
  // Process-wide bounds: at most one update item and at most `width` other items run at once, across all jobs.
  const updateSlots = createSlots(1);
  const bulkSlots = createSlots(width);
  const jobs = new Map<string, ChildJob>();
  const holds = new Map<string, string>();          // linkId -> jobId
  const running = new Set<Promise<void>>();

  const prune = (now: number): void => {
    const finished = [...jobs.values()].filter(job => job.state === "done");
    for (const job of finished) if (now - Date.parse(job.finishedAt!) > retainMs) jobs.delete(job.jobId);
    const rest = [...jobs.values()].filter(job => job.state === "done");
    for (const job of rest.slice(0, Math.max(0, rest.length - retainJobs))) jobs.delete(job.jobId);
  };

  const finishItem = (job: ChildJob, item: ChildJobItem, env: ChildOpsEnv): void => {
    item.finishedAt = iso(env.now());
    if (holds.get(item.linkId) === job.jobId) holds.delete(item.linkId);
    // lastOperation survives a Home restart (D4); a cache write failure never fails the item.
    try { env.writeObservation(item.linkId, { lastOperation: summarize(job, item) }); } catch { /* cache only */ }
  };

  const execute = async (job: ChildJob, env: ChildOpsEnv): Promise<void> => {
    const queue = job.items.filter(item => item.state === "queued");
    if (queue.length > 0) job.state = "running";
    let cursor = 0;
    const lanes = job.op === "update" ? 1 : Math.min(width, queue.length);
    const slots = job.op === "update" ? updateSlots : bulkSlots;
    await Promise.all(Array.from({ length: lanes }, async () => {
      for (let item = queue[cursor++]; item; item = queue[cursor++]) {
        await slots.take();                              // the item stays "queued" while another job holds the slot
        try {
        item.state = "running";
        item.startedAt = iso(env.now());
        let record: LinkRecord | undefined;
        try { record = env.readStore().links.find(link => link.id === item.linkId); } catch { record = undefined; }
        if (!record) Object.assign(item, { state: "refused", reason: "link-removed" });
        else {
          try { Object.assign(item, await runners[job.op](record, job, env)); }
          catch { Object.assign(item, { state: "failed", reason: "internal-error" }); }
          if (!DONE.has(item.state)) Object.assign(item, { state: "failed", reason: "internal-error" });
        }
        finishItem(job, item, env);
        } finally { slots.give(); }
      }
    }));
    job.state = "done";
    job.finishedAt = iso(env.now());
  };

  return {
    submit(request, env) {
      const now = env.now();
      prune(now);
      const store = env.readStore();
      let targets: LinkRecord[];
      if (request.linkIds === "all") targets = store.links.filter(link => link.direction === "hub-initiated");
      else {
        targets = [];
        for (const id of request.linkIds) {
          const record = store.links.find(link => link.id === id);
          if (!record) return { ok: false, code: "link_not_found", linkId: id };
          targets.push(record);
        }
        const only = targets.length === 1 ? targets[0]! : null;
        if (only?.direction === "client-initiated") return { ok: false, code: "link_not_home_initiated", linkId: only.id };
        if (only && holds.has(only.id)) return { ok: false, code: "link_operation_in_progress", linkId: only.id };
      }
      if (targets.length === 0) return { ok: false, code: "no_eligible_links", linkId: null };
      const job: ChildJob = { schema: CHILD_JOB_SCHEMA, jobId: newJobId(), op: request.op, trigger: request.trigger,
        restart: request.restart, state: "queued", createdAt: iso(now), finishedAt: null,
        items: targets.map(record => {
          const held = holds.has(record.id);
          const remote = record.direction === "hub-initiated";
          return { linkId: record.id, alias: record.alias,
            state: held ? "busy" : remote ? "queued" : "unsupported",
            reason: held ? "link-operation-in-progress" : remote ? null : "child-initiated",
            startedAt: null, finishedAt: held || !remote ? iso(now) : null };
        }) };
      for (const item of job.items) if (item.state === "queued") holds.set(item.linkId, job.jobId);
      jobs.set(job.jobId, job);
      if (!job.items.some(item => item.state === "queued")) { job.state = "done"; job.finishedAt = iso(now); }
      else {
        const run = execute(job, env).finally(() => { running.delete(run); });
        running.add(run);
      }
      return { ok: true, job: structuredClone(job) };
    },
    job(jobId) {
      const job = jobs.get(jobId);
      return job ? structuredClone(job) : undefined;
    },
    activeJob(linkId) {
      const jobId = holds.get(linkId);
      const job = jobId ? jobs.get(jobId) : undefined;
      const item = job?.items.find(entry => entry.linkId === linkId);
      return job && item && (item.state === "queued" || item.state === "running")
        ? { jobId: job.jobId, op: job.op, state: item.state } : null;
    },
    async settled() { while (running.size > 0) await Promise.all([...running]); },
  };
}

let shared: ChildOpsEngine | null = null;
/** One engine per Home process, shared by routes (wp3) and the scheduler (wp5, wp7). */
export function sharedChildOpsEngine(): ChildOpsEngine {
  return shared ??= createChildOpsEngine();
}
```

The engine imports no server, CLI or update module. It is reached only from
`link-child-ops-routes.ts` (lazy through management-api's `/api/link` import) and from the wp5
scheduler, so `tests/lab/core-link-boundary.test.ts` keeps passing unchanged.

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
    const verdict = classifySyncResult(result);
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

/** 020's observe dispatch as a runner: fresh fields only, so catalogPulledAt, lastOperation and suppressedTarget survive. */
export const runObserveItem: ItemRunner = async (record, _job, env) => {
  const outcome = await env.observe(record);
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

020's `attachLinkChildOpsForState`, the status hook and the job GET stay as 020 wrote them. wp3 replaces the engine
accessor, the env builder, `parseOperation` and the POST handler:

```ts
import { auth, fail, isRecord, knownHostsFile, readStoreFor, runnerFor, type LinkRouteState } from "./link-route-state";
import { readManagementJsonBodyOr } from "./body";
import type { ManagementContext } from "./context";
import { packageVersion } from "../../lib/package-version";
import { projectLinkStatus } from "../../link/status-projection";
import { inspectRemoteChildRuntime } from "../../link/remote-plant";
import { requireRemotePlatform } from "../../link/remote-platform";
import { DEFAULT_IDLE_AFTER_MS, isLinkIdle } from "../../link/child-activity";
import { observeChild } from "../../link/child-observe";
import { CHILD_JOB_ID, sharedChildOpsEngine, type ChildOpsEngine, type SubmitRefusal } from "../../link/child-ops-engine";
import { CHILD_OPS, type ChildOp, type ChildOpsEnv, type ChildRestart } from "../../link/child-ops-types";
// Revision 4 (4529522014): childObservationsPath is exported by src/link/paths.ts (010 file map), not child-observations.
import { childObservationsPath } from "../../link/paths";
import { patchChildObservation, readChildObservations, updateChildObservations } from "../../link/child-observations";

const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const MAX_LINK_IDS = 64;
const NO_STORE = { "cache-control": "no-store" };

/** One engine per process: route state is keyed by the config object (link-routes.ts:54-69), so a per-state engine
 *  would lose its locks on a config reload, and the wp5 scheduler must submit to the instance the routes use. */
export function childOpsEngineFor(state: LinkRouteState): ChildOpsEngine {
  return state.childOps ?? sharedChildOpsEngine();
}

/** The env captures this request's seams for the job's lifetime; every read is live. wp5 swaps idleAfterMs for the policy value. */
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
    observe: record => observeChild(record, { runner, knownHostsFile: hosts, homeVersion,
      peer: linkId => state.listener.peerObservation(linkId),
      platformOf: async link => requireRemotePlatform(runner, link.alias, hosts),
      inspect: inspectRemoteChildRuntime, now: () => new Date(now()) }),
    readObservation: linkId => readChildObservations(childObservationsPath()).children[linkId] ?? null,
    writeObservation: (linkId, patch) => {
      updateChildObservations(file => patchChildObservation(file, linkId, patch, new Date(now())));
    },
    // Revision 4: 020's monitor on LinkRouteState.catalogRevision, created here on first use exactly as 020's status hook
    // creates it (050 later defaults it to sharedCatalogRevisionMonitor()). null when the catalog cannot be read.
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
    case "link_operation_in_progress": return fail(code, "Another Child operation is running on this link.", 409);
    case "no_eligible_links": return fail(code, "No Home-initiated link is available for this operation.", 409);
  }
}

// In handleLinkChildOpsRoutes, the POST branch (020 admitted only op:"observe"):
  if (url.pathname === "/api/link/children/operations" && req.method === "POST") {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    const parsed = parseOperation(await readManagementJsonBodyOr(ctx.req, null));
    if (!parsed) return fail("invalid_body", "op and linkIds are required; restart is app-server or codex; a restart needs explicit linkIds.", 400);
    const result = childOpsEngineFor(state).submit({ ...parsed, trigger: "manual" }, childOpsEnvFor(ctx, state));
    return result.ok ? Response.json({ job: result.job }, { status: 202, headers: NO_STORE }) : refusal(result.code);
  }
```

The `trigger` is always `"manual"` here: no request body can claim `"auto"`, so the idle and suppression bypass in
`runUpdateItem` is reachable only from the wp5/wp7 scheduler. The job GET keeps 020's `/api/link/children/jobs/{jobId}`
matcher; `job()` returning `undefined` answers `404 job_not_found`.

### 2.5 src/server/management/link-route-state.ts (no change in wp3)

020 already added `childOps?` (and `catalogRevision`) to `LinkRouteState`; wp3 only changes what
`childOpsEngineFor` does with it (2.4). The shape 020 lands, for reference. Before 020:
```ts
export interface LinkRouteState {
  pendingHosts: Map<string, PendingLinkHost>;
  operations?: Set<string>;
  confirmedHosts?: Map<string, ConfirmedLinkHost>;
  compensationFailures?: Map<string, { since: string; reason: "compensation_failed" }>;
  supervisor: import("../../link/supervisor").LinkSupervisor;
  listener: LinkRouteListener;
}
```
After 020:
```ts
export interface LinkRouteState {
  pendingHosts: Map<string, PendingLinkHost>;
  operations?: Set<string>;
  confirmedHosts?: Map<string, ConfirmedLinkHost>;
  compensationFailures?: Map<string, { since: string; reason: "compensation_failed" }>;
  supervisor: import("../../link/supervisor").LinkSupervisor;
  listener: LinkRouteListener;
  /** Test seam; production uses the process-wide engine (sharedChildOpsEngine). */
  childOps?: import("../../link/child-ops-engine").ChildOpsEngine;
}
```

### 2.6 src/server/management/link-routes.ts (MODIFY)

020 already added the lazy delegating branch for `/api/link/children/` before the reconnect matcher (020
"link-child-ops-routes.ts and link-routes.ts"); wp3 leaves it and its dynamic import as they are, so
`link-routes.ts` gains no static import of the child-ops module.

DELETE 409, before (:201-205):
```ts
async function remove(ctx: ManagementContext, state: LinkRouteState, id: string): Promise<Response> {
  if (!LINK_ID.test(id)) return fail("invalid_link_id", "The link id is invalid.", 400);
  const current = readStoreFor(ctx);
  const record = current.links.find(link => link.id === id);
  if (!record) return fail("link_not_found", "The link was not found.", 404);
```
After (three lines added after :205; applies to ordinary, `purge` and `force` removal alike):
```ts
  if (!record) return fail("link_not_found", "The link was not found.", 404);
  // A queued or running job would keep opening SSH sessions to a Child this removal disconnects.
  const { childOpsEngineFor } = await import("./link-child-ops-routes");
  if (childOpsEngineFor(state).activeJob(id)) return fail("link_operation_in_progress", "A Child operation is running on this link; wait for it to finish, then remove the link.", 409);
```
The delegating branch sits before the DELETE prefix match (:355), so `DELETE /api/link/children/...` never reaches
`remove()`; the child-ops handler returns `null` for it and the API answers its usual 404.

### 2.7 src/server/management/route-registry.ts (no change in wp3)

020 declared both routes with the parameter spelled `{jobId}`:
`{ method: "POST", path: "/api/link/children/operations", ... mutates: true }` and
`{ method: "GET", path: "/api/link/children/jobs/{jobId}", ... mutates: false, mechanism: "regex" }`. Both are
capability-covered (2.10, which uses the same `{jobId}` spelling), so no exemption is declared.
`tests/server/management-route-registry.test.ts` scans every `src/server/management/*.ts` (:44-51).

### 2.8 src/cli/link-child-ops.ts (MODIFY, 020 file; exported API and core logic after wp3)

```ts
import { CliUsageError, RuntimeApiError, rejectArgs, takeFlag, takeJsonFlag, takeOption, printData } from "./runtime-api";
import type { LinkCliDeps } from "./link";
import { CHILD_JOB_SCHEMA } from "../link/child-ops-types";
import { CHILD_JOB_ID } from "../link/child-ops-engine";

export type LinkChildVerb = "update" | "sync" | "restart-codex";
export type LinkRequest = <T>(path: string, init: RequestInit, deps: LinkCliDeps) => Promise<T>;
export interface LinkChildOpsDeps { sleep?: (ms: number) => Promise<void>; pollIntervalMs?: number; now?: () => number }
export const LINK_CHILD_OPS_USAGE = [
  "  ocx link update (--link-id <id> | --all) [--no-wait] [--json]",
  "  ocx link sync (--link-id <id> | --all) [--no-wait] [--json]",
  "  ocx link sync --link-id <id> (--restart-app-server-only | --restart-codex --yes) [--no-wait] [--json]",
  "  ocx link restart-codex --link-id <id> [--scope app-server|codex] --yes [--json]",
] as const;
const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const POLL_MS = 2_000;
/** The Home keeps finished jobs for one hour; polling longer cannot succeed. */
const POLL_DEADLINE_MS = 3_600_000;
const SUCCESS = new Set(["succeeded", "up-to-date"]);
const FAILED = new Set(["failed", "uncertain"]);

/** What the CLI reads from a Home of any later version: enum fields are open strings (H5). */
export interface ChildJobItemView {
  linkId: string; alias: string; state: string; reason: string | null; hint?: string; fromVersion?: string; toVersion?: string;
  sync?: { state: string; reason: string | null }; restart?: { requested: string; outcome: string };
  startedAt: string | null; finishedAt: string | null;
}
export interface ChildJobView {
  schema: typeof CHILD_JOB_SCHEMA; jobId: string; op: string; trigger: string; restart: string; state: string;
  createdAt: string; finishedAt: string | null; items: ChildJobItemView[];
}

export interface ParsedChildOpArgs { body: { op: LinkChildVerb; linkIds: string[] | "all"; restart?: "app-server" | "codex" }; wait: boolean; json: boolean }

export function parseChildOpArgs(verb: LinkChildVerb, args: string[], usage: string): ParsedChildOpArgs {
  const json = takeJsonFlag(args);
  const noWait = takeFlag(args, "--no-wait");
  const all = takeFlag(args, "--all");
  const linkId = takeOption(args, "--link-id");
  const yes = takeFlag(args, "--yes");
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
  // A2 / M8: a restart names its links, and the codex scope (quit and relaunch the desktop app) needs --yes on every verb.
  if (restart !== undefined && all) throw new CliUsageError(`${verb} with a restart needs one --link-id; --all is refused`, usage);
  if (restart === "codex" && !yes) throw new CliUsageError("--restart-codex quits the Child's Codex app and ends its turns; pass --yes", usage);
  if (yes && restart === undefined) throw new CliUsageError("--yes only confirms a restart", usage);
  if (all === (linkId !== undefined)) throw new CliUsageError(`${verb} requires exactly one of --link-id and --all`, usage);
  if (linkId !== undefined && !LINK_ID.test(linkId)) throw new CliUsageError(`${verb} requires a valid --link-id`, usage);
  return { body: { op: verb, linkIds: all ? "all" : [linkId!], ...(restart ? { restart } : {}) }, wait: !noWait, json };
}

/**
 * Tolerant ocx.link.child-job/1 validation (architect G1, audit H5). Known keys are type-checked; unknown keys at job,
 * item, sync and restart level are dropped; an enum field accepts any lowercase token so a value a later Home adds
 * (a new restart.outcome, item state or reason) is passed through for display. The schema string and jobId stay exact.
 */
const text = (value: unknown, nullable = false): boolean =>
  (nullable && value === null) || (typeof value === "string" && value.length > 0 && value.length <= 256);
const token = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9:_-]{0,79}$/.test(value);
const optional = (o: Record<string, unknown>, key: string): Record<string, string> =>
  key in o && o[key] !== undefined ? (text(o[key]) ? { [key]: o[key] as string } : bad()) : {};
function bad(): never { throw new Error("invalid link API response: job"); }
function object(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : bad();
}
export function validateChildJob(value: unknown): ChildJobView {
  const job = object(value);
  if (job.schema !== CHILD_JOB_SCHEMA || typeof job.jobId !== "string" || !CHILD_JOB_ID.test(job.jobId)
    || !token(job.op) || !token(job.trigger) || !token(job.restart) || !token(job.state)
    || !text(job.createdAt) || !text(job.finishedAt, true) || !Array.isArray(job.items) || job.items.length > 256) bad();
  const items = (job.items as unknown[]).map((raw): ChildJobItemView => {
    const item = object(raw);
    if (!text(item.linkId) || !text(item.alias) || !token(item.state) || !(item.reason === null || token(item.reason))
      || !text(item.startedAt, true) || !text(item.finishedAt, true)) bad();
    let sync: ChildJobItemView["sync"];
    if (item.sync !== undefined) { const s = object(item.sync);
      if (!token(s.state) || !(s.reason === null || token(s.reason))) bad();
      sync = { state: s.state as string, reason: s.reason as string | null }; }
    let restart: ChildJobItemView["restart"];
    if (item.restart !== undefined) { const r = object(item.restart);
      if (!token(r.requested) || !token(r.outcome)) bad();
      restart = { requested: r.requested as string, outcome: r.outcome as string }; }
    return { linkId: item.linkId as string, alias: item.alias as string, state: item.state as string, reason: item.reason as string | null,
      ...optional(item, "hint"), ...optional(item, "fromVersion"), ...optional(item, "toVersion"),
      ...(sync ? { sync } : {}), ...(restart ? { restart } : {}),
      startedAt: item.startedAt as string | null, finishedAt: item.finishedAt as string | null };
  });
  return { schema: CHILD_JOB_SCHEMA, jobId: job.jobId as string, op: job.op as string, trigger: job.trigger as string,
    restart: job.restart as string, state: job.state as string, createdAt: job.createdAt as string,
    finishedAt: job.finishedAt as string | null, items };
}

/** 0 every item succeeded or up-to-date; 1 any failed or uncertain; 6 anything else, including a state this CLI does not know. */
export function childJobExitCode(job: ChildJobView): 0 | 1 | 6 {
  if (job.items.some(item => FAILED.has(item.state))) return 1;
  return job.items.every(item => SUCCESS.has(item.state)) ? 0 : 6;
}

export function renderChildJobHuman(job: ChildJobView): string[] {
  return job.items.map(item => `${item.alias} (${item.linkId}): ${item.state}`
    + (item.reason ? ` (${item.reason})` : "")
    + (item.fromVersion && item.toVersion && item.fromVersion !== item.toVersion ? ` ${item.fromVersion} -> ${item.toVersion}` : "")
    + (item.restart ? ` restart ${item.restart.requested}: ${item.restart.outcome}` : "")
    + (item.hint ? ` — ${item.hint}` : ""));
}

export async function runLinkChildOp(verb: LinkChildVerb, args: string[], deps: LinkCliDeps & LinkChildOpsDeps,
  request: LinkRequest, usage: string): Promise<number> {
  const parsed = parseChildOpArgs(verb, args, usage);
  let job: ChildJobView;
  try {
    const created = await request<{ job: unknown }>("/api/link/children/operations", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(parsed.body) }, deps);
    job = validateChildJob(created?.job);
  } catch (error) {
    // A Home before wp3 answers a bare 404 without a link error code.
    if (error instanceof RuntimeApiError && error.status === 404 && !isLinkNotFound(error.body)) {
      throw new RuntimeApiError("This Home does not support Child operations; update OpenCodex on the Home.", 404, null);
    }
    throw error;
  }
  const sleep = deps.sleep ?? (ms => Bun.sleep(ms));
  const now = deps.now ?? Date.now;
  const deadline = now() + POLL_DEADLINE_MS;
  while (parsed.wait && job.state !== "done" && now() < deadline) {
    await sleep(deps.pollIntervalMs ?? POLL_MS);
    const polled = await request<{ job: unknown }>(`/api/link/children/jobs/${job.jobId}`, {}, deps);
    job = validateChildJob(polled?.job);
  }
  printData(job, parsed.json, renderChildJobHuman(job));
  if (!parsed.wait) return 0;
  return job.state === "done" ? childJobExitCode(job) : 1;   // job_still_running after the deadline
}
```
`isLinkNotFound(body)` reads only `body.error.code === "link_not_found"` from the reduced body
`linkRequest` already produces (`errorCodeBody`, link.ts:257-266). A `404 job_not_found` while polling
(the Home restarted) surfaces through `runCliAction` as exit 4 with the route's message. 020's `runLinkCheck` uses the
same `validateChildJob` and `childJobExitCode` (020 ships them tolerant from the start).

### 2.9 src/cli/link.ts (MODIFY)

Usage, before (:36-47) ends with `  ocx link cleanup [--link-id <id>] [--json]`; after, three lines are
appended inside the template from `LINK_CHILD_OPS_USAGE` and one sentence is added:
```ts
  ocx link cleanup [--link-id <id>] [--json]
${LINK_CHILD_OPS_USAGE.join("\n")}

Forced revoke skips remote cleanup. Run ocx disconnect on the remote client.
Cleanup reports each Child's platform with disconnect guidance; it changes nothing.
Update, sync and restart-codex run on the Child over the link's SSH trust and wait for the job unless --no-wait.`;
```
(wp2's `check` line and wp5's `policy` line sit in the same block.)

Switch, before (:385-398):
```ts
export async function runLinkCommand(rawArgs: string[], deps: LinkCliDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const args = [...rawArgs];
    const command = args.shift();
    ...
    else if (command === "cleanup") await runLinkCleanup(args, deps, LINK_USAGE);
    else throw new CliUsageError("link requires one of: probe, add, port, issue, status, revoke, reconnect, cleanup", LINK_USAGE);
  });
}
```
After:
```ts
export async function runLinkCommand(rawArgs: string[], deps: LinkCliDeps & LinkChildOpsDeps = {}): Promise<number> {
  let jobExit = 0;
  const code = await runCliAction(async () => {
    const args = [...rawArgs];
    const command = args.shift();
    ...
    else if (command === "cleanup") await runLinkCleanup(args, deps, LINK_USAGE);
    else if (command === "update" || command === "sync" || command === "restart-codex") jobExit = await runLinkChildOp(command, args, deps, linkRequest, LINK_USAGE);
    else throw new CliUsageError("link requires one of: probe, add, port, issue, status, revoke, reconnect, cleanup, update, sync, restart-codex", LINK_USAGE);
  });
  return code !== 0 ? code : jobExit;
}
```
`linkRequest` (:239) becomes exported-in-module only through the parameter; nothing else changes.
`src/cli/dispatch.ts:416-417` already forwards every `link` argument, so `src/cli/index.ts` is untouched.

### 2.10 Capabilities, contract and help

`src/cli/capabilities-access-remote.ts`, appended before the closing `];` at :168:
```ts
  {
    command: ["link", "update"], summary: "Update a Home-initiated Child's OpenCodex to this Home's version.",
    usage: "ocx link update (--link-id <id> | --all) [--no-wait] [--json]",
    routes: [{ method: "POST", path: "/api/link/children/operations" }, { method: "GET", path: "/api/link/children/jobs/{jobId}" }],
    flags: [{ name: "--link-id", value: "string", summary: "Home-initiated link to update." }, { name: "--all", value: "boolean", summary: "Every Home-initiated link, one Child at a time." },
      { name: "--no-wait", value: "boolean", summary: "Print the queued job and return." }, { name: "--json", value: "boolean", summary: "Emit the ocx.link.child-job/1 document." }],
    mutates: true, json: "payload",
    details: ["Runs the Child's own ocx update --plan through the served entry, then --yes with --expect-plan and a --not-after 120 s after the plan on the Child's own clock, through the link's pinned SSH trust. npm and pnpm installs apply through their Node launcher; Bun installs stay on Bun. The target is always this Home's version; the Child refuses a downgrade.", "Children below 2.97.0 run nothing and report owner-action legacy-ocx; ocx-child and GOAT-managed Children report unsupported or owner-action; Windows Children are refused orchestrated apply (unsupported windows-apply) and update only through the Desktop request route once Home and Child run the release with it. A manual update ends any turn currently relayed for that Child. A pinned sync runs after every update.", "Exit 0 all succeeded or up-to-date, 6 partial, 1 failed or uncertain, 5 another operation holds the link, 4 the Home lacks Child operations."],
  },
  {
    command: ["link", "sync"], summary: "Run the pinned catalog and settings sync on Home-initiated Children.",
    usage: "ocx link sync (--link-id <id> | --all) [--restart-app-server-only | --restart-codex] [--no-wait] [--json]",
    routes: [{ method: "POST", path: "/api/link/children/operations" }, { method: "GET", path: "/api/link/children/jobs/{jobId}" }],
    flags: [{ name: "--link-id", value: "string", summary: "Home-initiated link to sync." }, { name: "--all", value: "boolean", summary: "Every Home-initiated link, three at a time." },
      { name: "--restart-app-server-only", value: "boolean", summary: "Also restart the Child's Codex app-servers after the sync writes." }, { name: "--restart-codex", value: "boolean", summary: "Also quit and relaunch the Child's Codex desktop app; ends live turns." },
      { name: "--no-wait", value: "boolean", summary: "Print the queued job and return." }, { name: "--json", value: "boolean", summary: "Emit the ocx.link.child-job/1 document." }],
    mutates: true, json: "payload",
    details: ["The same sync --expect-link the ocx sync fan-out runs, gated at 2.93.0. Restart flags are refused on Windows and ignored by ocx-child; the item reports restart unsupported.", "A restart needs one --link-id (--all is refused) and --restart-codex needs --yes. The restart is withheld (restart skipped, reason restart-skipped:link-active) while a relayed model request for that Child is in flight; the sync still runs.", "Exit codes as for ocx link update."],
  },
  {
    command: ["link", "restart-codex"], summary: "Restart Codex on one Home-initiated Child so it reloads the catalog.",
    usage: "ocx link restart-codex --link-id <id> [--scope app-server|codex] --yes [--json]",
    routes: [{ method: "POST", path: "/api/link/children/operations" }, { method: "GET", path: "/api/link/children/jobs/{jobId}" }],
    flags: [{ name: "--link-id", value: "string", required: true, summary: "Home-initiated link." }, { name: "--scope", value: "string", summary: "app-server (default) or codex (also relaunches the desktop app)." },
      { name: "--yes", value: "boolean", required: true, summary: "Confirms that running Codex turns on the Child end." }, { name: "--json", value: "boolean", summary: "Emit the ocx.link.child-job/1 document." }],
    mutates: true, json: "payload",
    details: ["A pinned sync with the restart flag; works on full Children from 2.93.0. app-server scope leaves the Codex desktop app's own app-server running.", "Refused on Windows Children (unsupported windows-restart) and reported unsupported for ocx-child. The codex scope needs a logged-in GUI session on the Child; its outcome is requested, not confirmed."],
  },
```
`src/cli/capability-contracts.ts:2`:
```ts
export const CAPABILITY_CONTRACTS = ["sync.home-fanout/1", "update.orchestrated/1", "link.child-ops/1"] as const;
```
`src/cli/registry.ts:154-163`: the `link` entry's usage becomes
`ocx link <port|issue|status|revoke|reconnect|cleanup|update|sync|restart-codex>` and gains three detail
lines copied from the capability usages plus "Update, sync and restart-codex need loopback admin
authority on the Home and act only on Home-initiated links."

## 3. Deviations from 004

1. **Runners split from the engine.** D1 puts the runners inside `child-ops-engine.ts`. They live in
   `child-ops-runners.ts` with the types in `child-ops-types.ts`, so the engine stays a small, fully
   fake-runner-testable registry and the runner file has no lock state. Same layer, same imports.
2. **Restart outcome gains `"not-run"`.** D11 has `requested | unsupported`. When the pinned sync does not
   reach `synced` the restart never ran; reporting `requested` would be false. `"not-run"` is added.
3. **CLI exit codes follow `runCliAction`.** D15 says "1 any failed/uncertain or API error". The existing
   wrapper maps a `RuntimeApiError` 404 to exit 4 and 409 to exit 5 (src/cli/runtime-api.ts:553-555), and
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
   An unknown code already renders `remoteLink.error.generic` (gui/src/pages/RemoteLink.tsx:128), and the
   gui parity test only checks codes that are in `LINK_ERROR_CODES` (gui/tests/remote-link.test.tsx:60-73),
   so the build stays green with no gui diff. 060 adds the code, its `ERROR_TKEY` entry and 11 locale keys,
   and must add `"link-child-ops-routes"` to that test's scanned file list (:61) for `job_not_found`,
   `invalid_job_id` and `no_eligible_links`.
6. **Test registration in a shard.** r3 suggests `layout.json` `explicit`; it is 1998 lines with the ratchet at 2000,
   so the `layout-clients.json` shard is used (000 "Test registration rule").
7. **Apply deadline on the Child's clock (audit M9).** D12 sends `now + 120 s` from the Home's clock, which the Child
   evaluates on its own clock. The plan probe now prints `ocx-fanout:child-now`; `--not-after` is that value plus
   120 s, the apply is not sent with less than 15 s left (`busy/plan-expired`), and a missing marker falls back to the
   Home clock with a `clock-skew` hint on a `deadline-passed` refusal.
8. **Windows Desktop ordering (audit H4).** D20 refuses Windows update before any SSH; the runner now observes a
   Windows Child and refuses `windows-apply` only after the `desktop-request` branch, which 080 fills in.

## 4. Field chains (PLAN-FIELD-CHAIN-01)

| Field / value | Created | Serialized | Deserialized | Consumers |
|---|---|---|---|---|
| `ChildJob` (all keys) | `createChildOpsEngine().submit` (2.2) | `Response.json({ job })` in link-child-ops-routes.ts (2.4), `structuredClone` snapshots | `validateChildJob` (2.8) | CLI human/JSON output; GUI parser in 060 (`gui/src/remote-link-child-ops-api.ts`); scheduler reads jobs in-process (050/070, no serialization) |
| `ChildJob.trigger` `auto` | Only the wp5/wp7 scheduler (in-process `submit`) | wire as above | `validateChildJob` accepts both | `runUpdateItem` idle and suppression branch; GUI label in 060 |
| `ChildJobItem.state` values | runners (2.3), engine (`busy`, `unsupported`, `refused/link-removed`, `failed/internal-error`) | job document | `CHILD_ITEM_STATES` check | `childJobExitCode`; `lastOperation`; `?children=1` row `lastOperation` (020 attacher); GUI badges (060) |
| `reason` vocabulary | runners: `tunnel-<wire>`, `link-not-in-runtime`, `ssh-timeout`, `ssh-failed`, `ssh-runner-failed`, `platform-probe-failed`, `deadline-exceeded`, sync classifier reasons, `windows-restart`, `windows-apply`, `ephemeral`, `ephemeral-restart`, `update-in-flight`, `link-active`, `restart-skipped:link-active`, `target-failed-before`, `plan-expired`, `deadline-passed`, `launcher-node-missing`, `rolled-back`, `legacy-ocx`, `desktop-app`, `post-update-sync-failed`, plan reasons; engine: `link-operation-in-progress`, `child-initiated`, `link-removed`, `internal-error` | job document | lowercase token ≤ 80, unknown values passed through (CLI, H5) | human output; GUI reason text (060, unknown reason ⇒ raw code shown) |
| `restart.outcome` `not-run`, `skipped` | `runSyncItem`, `runRestartCodexItem`, `runUpdateItem` post-sync | job document | CLI token, unknown values passed through | CLI human line; GUI (060) |
| `ocx-fanout:child-now` → `ObserveProbe.childNowMs` | gated plan script (010) | SSH stderr | `readGatedFraming` | `runUpdateItem` `--not-after` |
| `ChildObservation.lastOperation` | `finishItem` (2.2) via `env.writeObservation` | `child-observations.json` (wp1 writer) | wp1 tolerant reader | `?children=1` `child.lastOperation` (020); 070 re-observe scheduler reads `uncertain` |
| `ChildObservation.suppressedTarget` set / cleared | `runUpdateItem` on `rolled-back` / manual update | same file | same reader | `runUpdateItem` auto branch; 070 skip rule; GUI hint (060) |
| `installedVersion`, `updateRoute` after success | `runUpdateItem` | same file | same reader | `?children=1` `versionSkew` (020) |
| `link_operation_in_progress` (409) | `remove()` in link-routes.ts and `refusal()` | `fail()` envelope | `errorCodeBody` (link.ts:257) / GUI `LinkApiError` | CLI exit 5; GUI generic text until 060 adds the key |
| `job_not_found` (404), `invalid_job_id` (400), `no_eligible_links` (409) | link-child-ops-routes.ts | `fail()` | same | CLI exit 4/2... via `runCliAction`; GUI generic until 060 |
| contract `link.child-ops/1` | capability-contracts.ts:2 | `ocx capabilities --json` (capabilities-command.ts:63) | GOAT and agents | `tests/cli/cli-capabilities-arguments.test.ts:36-45` (derived) |
| `LinkRouteState.childOps` | tests only | N/A (in-memory) | N/A | `childOpsEngineFor` |

## 5. Tests

Four files are new (engine, runners, launcher fixture in A4, CLI); each fails before implementation because its import
target does not exist. Register them per 000 "Test registration rule": one line each before the closing `}` of
`scripts/test-layout/layout-clients.json` and of `tests/fixtures/test-layout-expected.json`:
`"link-child-ops-engine.test.ts": "clients"`, `"link-child-ops-runners.test.ts": "clients"`,
`"link-child-update-launcher.test.ts": "clients"`, `"cli-link-child-ops.test.ts": "cli"`. `link-child-ops-routes.test.ts`
(020) and `cli-link-check.test.ts` (020) are MODIFY and already registered.
`tests/server/link-management-routes.test.ts` (1137 lines) is not grown; its new DELETE case lives in the
routes sibling file.

**tests/clients/link-child-ops-engine.test.ts** — engine with stub runners and a fake env (in-memory store,
`now` stepped by the test).
- `single link held ⇒ submit refuses link_operation_in_progress`: submit a `sync` whose stub runner awaits a
  deferred; a second single-link submit returns `{ ok:false, code:"link_operation_in_progress" }`; `activeJob()`
  reports `running`.
- `bulk all skips held link as busy`: hold link A, submit `linkIds:"all"` for A,B ⇒ A item `busy/link-operation-in-progress`
  with `finishedAt` set, B runs.
- `all expands only hub-initiated` and `explicit client-initiated id in a list ⇒ unsupported/child-initiated`;
  `single client-initiated id ⇒ link_not_home_initiated`; `unknown id ⇒ link_not_found`; `no links ⇒ no_eligible_links`.
- `update runs one at a time; sync runs three at a time`: five links, stub runner records max concurrency ⇒ 1 for
  `update`, 3 for `sync`.
- `record removed before its turn ⇒ refused/link-removed`: the stub removes link B from the store while A runs.
- `runner throws ⇒ failed/internal-error` and `runner returns non-terminal state ⇒ failed/internal-error`.
- `lastOperation written per item` (spy `writeObservation`) and `write failure does not fail the item`.
- `retention`: 34 finished jobs ⇒ the two oldest are gone; a job finished 61 min ago is pruned on the next submit.
- `locks released`: after `settled()`, `activeJob()` is null for every link.

**tests/clients/link-child-ops-runners.test.ts** — runners with a fake `runner.run` keyed by argv content, the
real wp1 builders and classifiers, a stubbed `observeChild` (`mock.module` on `../../src/link/child-observe`).
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
- Job tolerance (H5): a job with an extra top-level key, an item with an extra key and `restart.outcome: "deferred"`
  (a value this CLI does not know) validates, renders `restart app-server: deferred` and exits 6; an item state this CLI
  does not know exits 6; `jobId: 7`, `items: {}` or `schema: "ocx.link.child-job/2"` ⇒ exit 1.
- `poll deadline`: a job that never reaches `done` (fake clock past 1 h) prints the job and exits 1.
- `ocx capabilities --json lists link.child-ops/1`.
Existing suites that must stay green: `tests/cli/cli-capabilities.test.ts`, `cli-capabilities-arguments.test.ts`,
`tests/ci-workflows/skill-ocx.test.ts`, `tests/cli/cli-link.test.ts`, `tests/server/link-management-routes.test.ts`,
`tests/lab/core-link-boundary.test.ts`, `gui/tests/remote-link.test.tsx`.

## 6. Docs and source-of-truth sync

- **structure/remote-link.md** — "Tunnels, management and CLI" (:67-71): one paragraph naming the engine
  (`src/link/child-ops-engine.ts`: process-wide, per-link lock, update one at a time, others three, 32 jobs /
  1 h, `lastOperation` in `child-observations.json`), the three ops and their SSH commands, the DELETE 409, the
  Windows and ocx-child refusals, and that the route always submits `trigger:"manual"`. Add
  `ocx link update|sync|restart-codex` to the CLI sentence (:71). In `structure/manifest.json` (:1343 entry)
  add `src/server/management/link-child-ops-routes.ts` and `src/cli/link-child-ops.ts` to `documents`
  (`src/link/` is already owned). Then `bun run structure:index` and `bun run structure:check` with the new
  files staged (structure/AGENTS.md).
- **docs-site English** — `guides/remote-link.md`: new `## Operating Children from the Home` after the
  "Home and Child versions" subsection (:162-180): what each op runs, version floors (sync and restart 2.93.0,
  update 2.97.0), "the target is always this Home's version", Windows and ocx-child limits, exit codes, and
  the sentence "Do not link a machine you do not own: the Home runs commands there with your SSH key."
  CLI reference block (:137-148) gains the three usage lines. `reference/cli/lifecycle.md`: new
  `## Child operations from the Home` before "Forced link revoke" (:1398) with the `ocx.link.child-job/1`
  shape and the exit table.
- **docs-site translations** — the same two edits in `fr`, `ja`, `ko`, `ru`, `tr`, `zh-cn`, `zh-tw` copies of
  `guides/remote-link.md` and `reference/cli/lifecycle.md` (14 files); command lines and codes verbatim,
  prose translated, nothing that contradicts English. Validate with `cd docs-site && bun run build`.
- **skills/ocx** — `bun run skill:surface` regenerates `01_surface_access-remote.md` and
  `01_management_surface.md`; hand edits: `05_remote_hub.md` "Commands" (:216) gains a "Child operations"
  subsection (when to use `sync` vs `restart-codex` vs `update`, `--yes` semantics, never run `update --all`
  without the operator's request), `04_failure_semantics.md` near "A pinned sync that refuses (exit 5)" (:136)
  gains the 0/6/1/5/4 table and `link_operation_in_progress`, `02_json_shapes.md` near "Error shape" (:154)
  gains `ocx.link.child-job/1`. `bun run skill:surface:check` and `tests/ci-workflows/skill-ocx.test.ts` verify.
- **CLI help** — `registry.ts` and `LINK_USAGE` (2.9, 2.10).
- **GUI** — none in this phase (Deviation 5).

## 7. Enforcement bypass record (PLAN-BYPASS-NAMED-01)

| Guard | Tier | Executing surface | Known bypass | Residual risk | Wording |
|---|---|---|---|---|---|
| Per-link lock in the engine | Runtime, in-process | `ChildOpsEngine.submit` | `ocx sync` fan-out, a manual SSH session, GOAT, or a second Home process do not consult it | Two writers on one Child; the Child's sync/update mutex (`src/update/sync-update-mutex.mjs`) serializes them and returns exit 7 / `update-in-flight` | "serializes this Home's operations per link", never "exclusive access to the Child" |
| DELETE 409 while held | Runtime | `remove()` | Restarting the Home drops the job and its hold; a job submitted between the 409 check and `holdLink` | The job's next SSH step finds the record gone (`link-removed`) or the Child refuses with `child-link-mismatch` (exit 5) | "refuses removal while this Home runs an operation on the link" |
| Version gate before `update` | Remote script (wp1) | `remoteGatedOcxArgv` | An operator running `ocx update` on the Child directly | None added | "never sends an update command to a Child below 2.97.0" |
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
2. `ocx link restart-codex --link-id A --yes` against a POSIX full Child sends one SSH command whose remote argv
   contains `--restart-app-server-only` after `--json`, and prints `restart app-server: requested` (runners + CLI tests).
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
11. A Home without these routes makes `ocx link update` exit 4 with "This Home does not support Child operations".
12. `bun run typecheck`, `bun run structure:check` and the management-route-registry test pass with the two new routes.
13. A restart request with `linkIds:"all"` answers 400; a restart sent while a relayed request is in flight is withheld
    with `restart-skipped:link-active`; `ocx link sync --restart-codex` without `--yes` exits 2 (A2, M8).
14. A Windows Child whose plan routes `desktop-request` never ends `windows-apply` (H4).
15. A job document with an unknown key and an unknown `restart.outcome` validates in this CLI (H5).
16. `--not-after` is computed from the Child's clock marker (M9).

## 10. Security review notes, risks and Windows

- **Trigger for review:** two new mutating `/api/link` routes and remote execution of the Child's updater. Review
  focus: auth (`either` = dashboard session or loopback admin token; Tailscale identity refused, link-route-state.ts:94-101),
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

- R2: ocx link sync with a restart that was withheld (restart-skipped:link-active) exits 6, matching ocx sync --restart-children (040); the item state stays succeeded because the sync ran. CLI exit rule: exit 6 if any item is non-success or carries reason restart-skipped:link-active. Test added beside the sync restart guard case.
- R3: the plan-expired branch is defensive (see the comment at the apply step); its unit test drives it with an injected clock, the only activation today.
- R6: see the scope note on parseOperation.
