# 030 — wp3: #1454 / #1465, Windows service install transaction

## The defect (#1454)

On Windows, `ocx service install` stops the proxy and removes opencodex's
injected Codex config keys *before* it discovers it needs elevation. When the
`schtasks /create` call is denied, the teardown is not undone, so a failed
install leaves a previously working setup broken: proxy stopped, Codex routing
un-injected.

## What the contributor did (`681c8821f`)

A two-phase transaction in `src/service.ts`: phase 1 stages a unique ephemeral
task XML and requests registration; phase 2 performs the destructive commit only
after registration succeeds. Also disables the dashboard's 60-second child
timeout for Windows service installation in
`src/server/startup-action-control.ts`.

## Phase-1 non-destructiveness: audited, holds

Each claim checked against code, not the green badge:

| Claim | Result | Evidence |
|---|---|---|
| No manager/proxy stop in phase 1 | holds | stage/register at `src/service.ts:2561-2563`; `prepareServiceInstall()` stops at 2482-2512, called only at 2565-2566 |
| No canonical asset write in phase 1 | holds | writes only `.opencodex-service-task.<uuid>.xml` at 1832-1842; canonical writes at 1821-1829 run in phase 2 at 2567 |
| No Codex routing mutation in phase 1 | holds | no restore/injection call in the phase-1 chain; routing restore lives in stop/uninstall at 3031-3036, 3069-3073 |
| No install-state publication in phase 1 | holds | `writeServiceInstallState()` at 159-177 invoked only after task start at 2568-2570 |
| Phase-2 failure never reported as success | holds | commit exceptions rethrown at 2571-2588; `serviceCommand` sets `exitCode = 1` at 2988-2996; non-serving task exits nonzero at 585-602 |

Only the temporary-XML deletion failure is downgraded to a warning at 2590-2595,
which is correct: a leftover ephemeral file is not a broken install.

## Blocker (ours): cleanup cannot prove it owns the task

The PR states cleanup removes "only a task proven to have been created by this
attempt." It does not. The absence probe at `src/service.ts:2976-2981` is not
atomic with the fixed-name `schtasks /create ... /f` at 1511-1512 and 1857-1871.
Verification at 1664-1694 checks generic action and trigger properties, not an
attempt-specific nonce, and rollback at 1002-1013 (called from 1879, 1894, 1902,
2574) deletes purely by task name.

So between probe, create, verify, and rollback, another process can create or
replace `opencodex-proxy`, and our rollback deletes it. The irony is precise:
this PR exists to stop a failed install from destroying working state, and its
rollback path can destroy a *different* attempt's working state.

## The fix

Give the staged registration an attempt nonce that survives into the registered
task, and make rollback delete only when the currently registered task carries
this attempt's nonce. Where ownership cannot be proven, do not delete: report the
residual scheduler state, which is what the issue thread already asks for
("if cleanup or ownership cannot be proved, the CLI will report the residual
scheduler state instead of claiming that the prior runtime was restored").

### What this does and does not guarantee

Stated precisely, because the first draft of this document overclaimed and an
independent audit caught it (see `004`):

- The **install** paths (`src/service.ts:1941`, `2624`) now prove ownership
  before deleting. That is strictly narrower than upstream, which deleted by
  name unconditionally.
- The **legacy dashboard finalizer** (`1128`, `1262`) still calls
  `rollbackElevatedSchedulerTask()`, which deletes by name with no nonce check.
  That function is upstream's (`origin/dev:src/service.ts:1001`, from
  `0deda7caf`); this unit neither wrote nor widened it.
- Even on the nonce-checked path the query and the elevated delete are **not one
  atomic operation**, so a replacement registered in that window can still be
  deleted. Closing that properly needs an attempt-unique task name or an elevated
  attempt-bound transaction — a user-visible change to how the service registers,
  which needs a real Windows host to validate and belongs in its own unit.

So: a narrowing, not a guarantee.

## Regressions

In `tests/service.test.ts`:

1. rollback with a task whose nonce does not match this attempt leaves the task
   in place and reports residual state instead of claiming restoration;
2. rollback with a matching nonce still deletes, so the fix is not vacuous.

## Platform limitation

This is Windows-only code and `windows N/4` is SKIPPED (#1059). The tests are
seam-level with an injected scheduler, so they run on macOS, but no real
`schtasks` behavior is exercised anywhere in this session. Recorded as a known
verification gap, not as proof.

## Verification

- `bun test tests/service.test.ts tests/startup-action-control-elevation.test.ts`
  (baseline on the contributor head: 135 pass / 0 fail)
- `bun run typecheck`, `bun run privacy:scan`
