# Home-orchestrated Child updates and operations — roadmap

> **Revision 2 (audit r1).** Folds H1 (test registration rule, "Canonical names"), H2 (A4 is npm/pnpm
> apply only), H4 (Windows Desktop Children, A5), M6 (new "Canonical names" section, authoritative over
> the decade docs), M7 (root cause layer 2 is fixed manually by default), M8 (restart guards, A2), M9
> (Child-clock deadline, D20 paragraph), L12 (base `dev` 61151e3457) and L14 (D20 wording). Audit:
> `.tmp/research/audit-r1.md` (scratch, untracked).

> **Revision 4 (CodeRabbit on #8500).** Folds 4529521916 (A2: sync first, then a fresh activity read, then the
> restart as a second pinned sync; residual recorded), 4529521925 (an identity sync precedes every update),
> 4529521934 (escaped pipe in the phase table), 4529521944 (A1: routing is restored after a failed, rolled-back or
> recovered uncertain update) and 4529522014 (Canonical names rows for `childObservationsPath` and the revision 4
> cache fields). Triage: `.tmp/research/cr-8500-triage.md` (scratch, untracked).

A Remote Link Home cannot see which OpenCodex a Child runs, cannot update it, and
cannot ask it to resync or restart Codex. Children therefore drift: on an
outdated Child, Home models with a 1M context show about 258k in Codex. That is
Codex's 272,000 × 95% fallback for a model slug absent from the catalog it
loaded, because the Child's catalog file and its long-running Codex app-servers
are only refreshed when someone runs `ocx sync` by hand
([context skew research](001_research_context_skew.md)). This unit lets the Home
show each Child's version, install kind and catalog freshness, run the Child's
own updater and sync over the SSH channel it already uses, restart Codex on a
Child on request, fan a changed catalog out automatically, and keep Children on
the Home's version automatically when they are idle. Operators get Remote Link
row badges and actions, `ocx link update|sync|restart-codex|check|policy`, and
two new `ocx sync` flags. No implementation is claimed by this document.

Evidence: [context skew](001_research_context_skew.md),
[update mechanisms](002_research_update_mechanisms.md),
[surface map](003_research_surface_map.md),
[architect proposal](004_design_proposal.md) (decisions D1–D21, cited below).

## Loop specification

- **Archetype and trigger:** satisfy-spec, scoped HOTL. The project owner asked
  on 2026-11-11 for GOAT-style Home-driven Child updates (including Desktop app
  versions), graceful version-skew handling, Child operations from the Home and a
  looser `ocx sync`, shipped through repeated PABCD cycles, merged and released.
- **Work class:** C4. New mutating management routes, a new link-listener write,
  a Desktop updater entry point and remote update execution all need independent
  review and explicit security review (`src/AGENTS.md`, `MAINTAINERS.md`).
- **Goal:** the operator experience in the summary above, on `dev`, released.
- **Non-goals:** updating the owner's real Home or Children or this machine's
  install during development; any change under `src/update/*` (another thread
  owns `codex/auto-update-signed-supply`); signed update envelopes, Home update
  keys or Child-local grants from 261107 060/080; updates for Child-initiated
  links; re-planting `ocx-child`; widening the non-loopback local-control socket.
- **Verifier:** per phase, the focused test files named in its decade doc, run
  failing-first where behaviour changes; `bun run typecheck`; `bun run privacy:scan`;
  `bun run structure:check` when `structure/` or owned sources change;
  `bun run skill:surface:check` when CLI capabilities change; `bun run lint:i18n`
  and the gui test script when `gui/` changes; exact-head required CI on each PR.
  The full root suite is not run locally (shared, loaded host); CI covers it.
- **Stop:** every phase PR squash-merged into `dev` with green exact-head CI and a
  fresh independent review, then a release cut through the Release workflow on a
  `dev` commit with a green manual `lane=all` run.
- **Memory:** this unit (public) and the bound Codexclaw goalplan
  `outcome-ship-home-orchestrated-child-updates-and`. Security working notes go to
  `.tmp/`, never here.
- **Outcomes:** DONE as above; NOOP if a phase already exists on `dev`; BLOCKED
  after three cycles of the same CI or infrastructure failure; NEEDS_HUMAN if
  publication is held or a repository setting or secret must change; UNSAFE if a
  step would require touching real user machines.
- **Escalation and bounds:** decisions outside the granted authority go to the
  coordinator. No token or wall-time bound stated; host limits apply.

## Root cause and what fixes it

The Child copies `/v1/catalog` verbatim into `opencodex-catalog.json` and
`models_cache.json`; no field, schema or parser changed between v2.93.0 and
`dev` (001 §2). Two layers go stale:

1. **The Child's catalog file.** Only a manual sync refreshes it. The Home's
   automatic catalog refresh syncs only its own local clients
   (`src/server/background-lifecycle.ts:91-107`) and no Child re-pulls on a timer.
   Phase 050 fans every Home catalog change out to eligible Children by default.
   That is the fix for layer 1, and only for layer 1.
2. **A running Codex app-server's in-memory copy.** It keeps its startup catalog
   (`src/codex/catalog-auto-refresh-sources.ts:57`). This is the layer the
   reported symptom came from (001 §3), and **by default it is fixed manually**.
   Phase 080's row badge shows "Codex restart needed" from the Child's own report;
   the operator clears it with the Restart Codex action (phase 030, dashboard in
   060) or `ocx sync --restart-children` (phase 040). The automatic policy
   `childCodexRestart` defaults to `never` because an app-server restart ends
   every running turn on that Child, and the Home relays model requests but cannot
   see the Child's composer state (a turn being typed, a tool awaiting approval).
   The policy offers `app-server-when-idle` for operators who accept that; it
   restarts only after a fan-out sync and only when the link is idle (050).

## Architect consultation

- **Proposal:** design task `lcu-wp0-architect-1` (inherited model
  `anthropic/claude-opus-5-5`, high effort), [004_design_proposal.md](004_design_proposal.md),
  decisions D1–D21 and phases P1–P9.
- **Reflection:** requested from the same architect on this revision; its
  verdict (MISALIGNED, two gaps, both folded) is recorded in the [consultation record](005_consultation.md).

| Decision | Main disposition |
| --- | --- |
| D1 module map | Accept. Engine and scheduler live under `src/link/`, loaded only when links exist; no core-path import. |
| D2 gated remote ocx | Accept. It closes the F1 hazard: `ocx update` before v2.97.0 ignores its arguments and updates, so the version gate runs inside the remote script. |
| D3 observe op | Accept. One SSH call per Child; client-initiated and `ocx-child` rows branch before any probe. |
| D4 observation cache | Accept. Tolerant `<configDir>/link/child-observations.json`; `links.json` is untouched. |
| D5 per-link idle | Accept. Data-plane requests only; restart starts the idle clock. |
| D6 catalog freshness | Accept. Pull time per link against a Home catalog revision; no edit to `serve-options.ts`. |
| D7 Child Codex-state report | Accept in phase 080 as a separate display-only report with its own feature id. |
| D8 `?children=1` | Accept. Opt-in query, so older CLIs keep validating rows. |
| D9 Desktop update request | Accept in phase 080. File request, signed Tauri artifact, version must equal the Home's. Security review required. |
| D10 `ocx-child` version | Accept. `--version` stays the 2.98.0 protocol constant; `build-info --json` adds the crate version. Update stays unsupported. |
| D11–D13 job model and ops | Accept. |
| D14 routes | Accept. |
| D15 CLI | Accept. |
| D16 `ocx sync` flags | Accept with amendment A2. |
| D17 automatic defaults | Amend (A1). |
| D18 policy file | Accept. |
| D19 no `src/update/*` change | Accept. |
| D20 security and Windows | Accept. Windows restart and orchestrated update are explicitly refused. |
| D21 compatibility | Accept. |
| P9 hardening phase | Amend (A3). |

**A1 — updates default to `auto-when-idle`.** The architect proposed `notify`,
citing 261107 AU-002 (manual activation) and a Home-side idle signal. The owner
asked for GOAT-style automatic updates, and GOAT updates managed OpenCodex
Children Home first, one at a time, when idle, by default (002 §4). Every Child
in this design belongs to the operator who holds its SSH key, and the guards
bound the risk: target is always the Home's own version (never newer, never a
downgrade); only a stable Home auto-updates; the Home must have served its version
for 10 minutes; a Child is updated only when the Home has relayed no model
request for it for `idleAfterMs` (default 10 minutes) and its plan says
`canApply`; a target that rolled back is never retried automatically; an
uncertain outcome is re-observed, never re-applied; and the pinned
`--expect-link` sync runs after every update to restore routing: after a success, after a failed or rolled-back
apply, and after an uncertain one once a re-observe shows no update in flight (030, 070). GOAT-managed
Children stay with GOAT. `notify` and `off` remain one click away in the
Remote Link policy panel and `ocx link policy`. Catalog fan-out defaults to
`auto` and Child Codex restart to `never`, as proposed.

**A2 — every restart respects running turns.** 261102's fan-out unit
removed this flag because the Home could not see running turns on a Child. The
owner now asks for it explicitly. With D5 the Home sees every relayed turn, so
`--restart-children` skips the restart (not the sync) for a Child with a model
request in flight and reports `restart-skipped:link-active`. The same rule binds
every restart the Home sends, manual or automatic: the 030 runners read the
link's activity when the item runs (not when the job is queued) and withhold the
restart with reason `restart-skipped:link-active` while a relayed model request is
in flight. Revision 4: every restart path syncs first without a restart, reads the activity after that sync, and
only then sends the restart as a second pinned sync, so the gap between the read and the restart is one SSH round
trip. A request that starts inside that gap is still cut; the Home cannot fence it, because the restart runs on the
Child and holding the request at the Home would not save a turn whose app-server is restarting (030 Section 10,
040 "Enforcement bypass record"). A request that carries a restart (`sync` with `restart`, or
`restart-codex`) through the API route or the `ocx link` verbs must name its links (ocx sync --restart-children and the automatic restart policy select links themselves and apply the same activity check): `linkIds: "all"` is a usage error at the
route and in the CLI. Scope `codex` (quit and relaunch the desktop app) also
requires `--yes` on every CLI verb that can send it.

**A3 — no separate hardening phase.** The end-to-end catalog oracle moves into
phase 050. Windows restart and orchestrated update stay refused with a named
reason. A real-fleet soak needs the owner's machines, which this unit may not touch.

**A4 — npm and pnpm Children apply through their own launcher.** Phase 010
found that the served-runtime census records a package install as the pair
`bun <root>/src/cli/index.ts`, which bypasses the Node launcher
(`bin/ocx.mjs:1362-1390`) where npm and pnpm orchestrated apply lives; the Bun
entry then refuses with `plan-unavailable` (`src/update/orchestrated-entry.ts:225-233`).
Remote update of npm and pnpm Children is a core requirement, so phase 030 sends
the **apply** step, and only the apply step, to `<node> <root>/bin/ocx.mjs` when
the parsed plan says `installer` is `npm` or `pnpm`. The plan probe always runs
through the served entry and never exits because Node is missing; it only reports
whether a launcher Node exists. Bun installs (the census pair of a Bun global
install also sits under a `node_modules` directory) plan and apply through the
served Bun entry exactly as today. Fixtures prove an npm global layout, a pnpm
layout and a Bun global layout. Phase 010's `launcher-bypassed` owner action is
the interim mapping until 030 lands, never the final state.

**A5 — Desktop Children join automatic updates.** The architect's plan never
updated a Desktop Child automatically, even after phase 080 adds the request
path. The owner asked for Home-driven updates "even of the app version", so
from phase 080 on the automatic sweep admits route `desktop-request` under the
same idle, Home-first and suppressed-target rules, and the Desktop app still
installs only its own signed update whose version equals the Home's. This
includes Windows Desktop Children: `desktop-request` is the one update route a
Windows Child can take, so 030's update runner evaluates the Desktop branch
before its Windows refusal, and 070's candidate rule admits a Windows Child only
when its observed route is `desktop-request`. Orchestrated apply and restart on
Windows stay refused (D20).

## Relationship to 261107 060 and 080

For Home-initiated links this unit supersedes the transport and authority design
of [060](../261107_auto_update_parity/060_linked_updates.md): the Home runs the
Child's own published `update.orchestrated/1` command through the pinned channel
that already runs sync, disconnect and planting with the user's SSH key. That
channel already grants arbitrary command execution as the Child user, so running
the Child's own updater adds no credential, artifact source or trust root;
the binding is split between the two sides (D20). The Child's own updater
verifies the plan token (`--expect-plan`), the deadline (`--not-after`, a
120-second window counted on the Child's own clock from the plan probe, phase
010/030), its update mutex and its downgrade refusal. Version equality with the
Home and link identity are not checked by the Child's updater: the Home enforces
the first by only ever passing its own version as `--version`, and the
pinned `sync --expect-link <linkId>` enforces the second, both before the plan probe (Revision 4: a mismatch refuses
the update before anything mutates) and after the update. The gap between the first check and the apply (the plan
probe, at most 60 s, plus the apply) stays open: closing it needs the Child's updater to hold its link lifecycle lock,
a `src/update/*` change this unit excludes.
Signed envelopes, a Home update key and Child-local grants are not built.
The consenting principal is the operator holding the SSH key, which fits one
owner's fleet; the docs say not to link a machine you do not own.
[080](../261107_auto_update_parity/080_child_initiated_updates.md) stays the path for
Child-initiated links, which get status and an owner action only.

## Work phases

Dependency order (foundations, signals, core operations, integration,
automation, Child-side release). One PR per phase.

| Phase | Doc | Depends on | Outcome |
| --- | --- | --- | --- |
| wp1 | [010](010_foundations.md) | — | Gated remote-ocx builder (POSIX, Windows), sync builder options, strict `update.orchestrated/1` parser and exit mapping, observation cache, shared sync classifier in `src/link`. |
| wp2 | [020](020_signals_visibility.md) | wp1 | Per-link activity, catalog pull and revision signals, observe op, `?children=1` rows, `ocx link status` columns and `ocx link check`. |
| wp3 | [030](030_child_operations.md) | wp2 | Job engine, sync / restart-codex / update ops, `/api/link/children/*` routes, CLI verbs, capabilities, skill surface. |
| wp4 | [040](040_sync_loosening.md) | wp1, wp2 | `ocx sync --child <linkId>` and `--restart-children[=app-server\|codex]`, busy and active-link skips. |
| wp5 | [050](050_auto_catalog_fanout.md) | wp3, wp4 | Policy file and routes, `ocx link policy`, automatic catalog fan-out (fix for root-cause layer 1), catalog oracle test. |
| wp6 | [060](060_dashboard.md) | wp3, wp5 | Remote Link badges, actions, Update all, policy panel, 11 locales. |
| wp7 | [070](070_auto_updates.md) | wp5 | `notify` sweep and `auto-when-idle` updates, suppression and re-observe. |
| wp8 | [080](080_child_side_release.md) | wp3 | Child Codex-state report, restart outcome marker, `ocx-child build-info`, Desktop update request (CLI + Tauri). |
| wp9 | [090](090_release.md) | wp1–wp8 | Batch `lane=all` CI on `dev`, Release workflow, published version. |

## Compatibility summary

Older CLIs see identical status rows (new data only under `?children=1`).
Children 2.93–2.96 get sync, restart and automatic catalog fan-out but never an
update command (owner action `legacy-ocx`). Children ≥ 2.97 with npm, pnpm or Bun
installs get remote updates (npm and pnpm apply through their launcher, Bun through
its served entry, A4). Desktop Children, Windows included, get the request route from the
first release that ships phase 080 on both Home and Child; older Desktop Children
show "Check for Updates in OpenCodex Desktop on <alias>". `ocx-child` and
Child-initiated links show status with an owner action. A downgraded Home ignores
the two new files under `<configDir>/link/`. Details: D21.
A CLI from any phase reads job documents from a Home of any later phase: the
job validator type-checks known keys, ignores unknown keys and passes unknown
enum strings through for display (030 2.8).

## Canonical names (authoritative over the decade docs)

Where a decade doc's code or prose names something differently, this table
wins and the phase PR uses the name below. "Owner" is the phase that creates the
file or symbol; later phases MODIFY it.

| Kind | Canonical name | Module | Owner |
| --- | --- | --- | --- |
| file | `ssh-argv.ts`: `remoteGatedOcxArgv`, `GatedOcxCommand`, `remoteGatedScript` (holds `find_launcher_node` and the `child-now` marker), `remotePinnedSyncArgv` | `src/link/ssh-argv.ts` | 010 (030 adds the `launcher` field; `remoteUpdateApplyArgv` gains `viaLauncher`) |
| file | `remote-windows.ts`: `windowsGatedOcxArgv` (holds the PowerShell `child-now` marker) | `src/link/remote-windows.ts` | 010 |
| file | `child-gated-ocx.ts`: `remoteUpdatePlanArgv`, `remoteUpdateApplyArgv`, `readGatedFraming`, `classifyUpdatePlanProbe`, `classifyUpdateApply` | `src/link/child-gated-ocx.ts` | 010 |
| file | `child-update-contract.ts`: `parseChildUpdatePlan`, `parseChildUpdateResult`, `classifyChildUpdatePlan`, `mapUpdateApplyExit`, `PlanClassification`, `UpdateApplyVerdict` | `src/link/child-update-contract.ts` | 010 |
| file | `child-observations.ts`: `ChildObservation`, `ChildOperationSummary`, `readChildObservations`, `updateChildObservations`, `patchChildObservation(file, linkId, patch, now: Date)` | `src/link/child-observations.ts` | 010 |
| function | `childObservationsPath(configDir?)` lives in `paths.ts`, not `child-observations.ts`; every importer takes it from there | `src/link/paths.ts` | 010 |
| field | revision 4 cache fields `catalogPulledEtag` (020 recorder), `catalogSyncedEtag` (030 writes, 050 reads), `autoUpdateAttempts` (070), `pendingUpdateRecovery` (030 writes, 070 clears); `CARRIED_OBSERVATION_FIELDS` and `withoutCarriedFields` | `src/link/child-observations.ts` | 010 |
| constant | `UNCERTAIN_RECOVERY_WINDOW_MS` (sets `pendingUpdateRecovery.until`; 070 reads `until` and has no copy) | `src/link/child-ops-runners.ts` | 030 |
| type | `ChildOp` is declared once, here; every server module imports it. The only other copy is the GUI wire mirror in `gui/src/remote-link-child-ops-api.ts` (060), which cannot import `src/`. | `src/link/child-observations.ts` | 010 |
| file | `child-activity.ts`: `LinkActivitySnapshot`, `isLinkIdle(snapshot, now, idleAfterMs)`, `DEFAULT_IDLE_AFTER_MS` | `src/link/child-activity.ts` | 020 |
| file | `child-catalog-freshness.ts`: `createCatalogPullRecorder`, `createCatalogRevisionMonitor`, `catalogVerdict`; the shared monitor is `sharedCatalogRevisionMonitor()` | `src/link/child-catalog-freshness.ts` | 020 (050 adds the shared monitor) |
| function | `observeChild(record, deps: ObserveDeps): Promise<ObserveOutcome>`; `ObserveOutcome.probe` carries the plan classification and the Child clock | `src/link/child-observe.ts` | 020 |
| file | `child-ops-types.ts`: `ChildJob`, `ChildJobItem`, `ChildItemState`, `ChildOpsEnv`, `ItemRunner`, `ItemOutcome` | `src/link/child-ops-types.ts` | 030 (moves the job types out of 020's engine) |
| file | `child-ops-engine.ts`: `createChildOpsEngine`, `sharedChildOpsEngine`; methods `submit`, `job` (`ChildJob \| undefined`), `activeJob`, `whenDone` (050), `settled` | `src/link/child-ops-engine.ts` | 020 (030, 050 extend) |
| file | `child-ops-runners.ts`: `runSyncItem`, `runRestartCodexItem`, `runUpdateItem`, `pinnedSync` | `src/link/child-ops-runners.ts` | 030 |
| file | `child-ops-scheduler.ts`: `createChildOpsScheduler`, `createLinkBackoff` (shared by 050 and 070) | `src/link/child-ops-scheduler.ts` | 050 |
| file | `child-policy.ts`, `child-ops-host.ts` (`startChildOpsHost`) | `src/link/` | 050 |
| file | `child-update-sweep.ts` | `src/link/child-update-sweep.ts` | 070 |
| file | `link-child-ops-routes.ts`: `handleLinkChildOpsRoutes`, `childOpsEngineFor`, `childOpsEnvFor`, `parseOperation`, `attachLinkChildOpsForState` | `src/server/management/link-child-ops-routes.ts` | 020 (030, 050 extend) |
| file | `link-child-ops.ts`: `runLinkCheck` (020), `validateChildJob` (020, tolerant from 030), `runLinkChildOp` (030), `ocx link policy` (050) | `src/cli/link-child-ops.ts` | 020 |
| file | `link-status-child.ts`: `validateChildOps` | `src/cli/link-status-child.ts` | 020 |
| route | `POST /api/link/children/operations`, `GET /api/link/children/jobs/{jobId}`, `GET/PUT /api/link/children/policy`; the registry, capabilities and docs spell the parameter `{jobId}` | route-registry.ts | 020, 050 |
| error code | `invalid_body`, `link_not_found`, `link_not_home_initiated`, `link_operation_in_progress`, `no_eligible_links`, `invalid_job_id`, `job_not_found`, `policy_write_failed` | management routes | 020, 030, 050 |
| item reason | added by revision 2: `restart-skipped:link-active`, `launcher-node-missing`, `plan-expired`, `deadline-passed` (hint `clock-skew`), `update-attempts-exhausted`, `desktop-window-invalid` | runners, sweep, 080 | 030, 070, 080 |
| item field | `restart.outcome` adds `skipped` (A2); `ObserveProbe.platform` (020) | 030, 020 | 030 |

## Test registration rule (every phase)

No entry goes into `scripts/test-layout/layout.json`: it is 1998 lines and the
file-size ratchet fails a file at 2000 lines (`THRESHOLD = 2000`,
`scripts/file-size-ratchet.ts:4`). Every new test file of this unit is registered
in the existing `scripts/test-layout/layout-clients.json` shard, whatever its
domain: shards are loaded through `layout.json` `explicitShards`
(`scripts/test-layout/schema.ts:45-60`), the value is the file's domain directory,
and the shard already maps `cli` and `server` tests (`layout-clients.json:14-15`,
`:175`). Each entry is one new line before the shard's closing `}` (183 lines
today). The same entry goes on one new line before the closing `}` of
`tests/fixtures/test-layout-expected.json` (1651 lines; the only expected fixture,
read at `tests/test-layout-tooling.test.ts:28`). A duplicate key across shards
throws (`schema.ts:60`), so a file is registered by exactly one phase: the one that
creates it (Canonical names, "Owner"). No new shard file is needed.

