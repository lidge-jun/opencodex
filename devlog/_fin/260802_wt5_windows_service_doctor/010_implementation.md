# wt5 — Implementation roadmap

Branch `codex/wt5-windows-service`. Working checkout: `/Users/jun/.codex/worktrees/bdbb/opencodex`.

**P-phase stale check (2026-08-02, tree at `478354ee8`).** Both bugs were re-verified against the
current tree by independent sol-medium explorers. Neither is a NOOP, and the line anchors below are
measured rather than copied from the PR bodies. Baseline before any change: `bun run typecheck`
exit 0; `bun run test` 6918 pass / 8 skip / 5 fail, where all five failures were
`Cannot find package 'react'` from an uninstalled `gui/node_modules` — resolved by running
`bun install` inside `gui/`, so the real pre-change baseline is a green suite.

## Bug A — #868: scheduler verification settle

**Measured root cause.** `applyElevatedSchedulerResult()` verifies exactly once and rolls back
immediately (`src/service.ts:1005-1022`). After a successful elevated `/create` + `/run`, the
non-elevated `/query /tn` and the CSV fallback can both miss the just-created task, so
`probeWindowsSchedulerTask()` returns `absent` (`src/service.ts:763-774`),
`windowsSchedulerTaskInstalled()` collapses every non-`present` result to `false`
(`src/service.ts:783-785`), and the evaluator reports `ok: false` /
"Task Scheduler task is not installed." (`src/service.ts:817-820`). A healthy registration is
rolled back milliseconds before Task Scheduler would have exposed it.

Precision note (audit): "rolls back immediately" is the failure path only. A healthy registration
with unknown SCM status is already preserved without writing state (`src/service.ts:1007-1021`), and
create/run/protocol failures exit before verification entirely (`:985-1003`).

Already present on this tree (do NOT re-add): tri-state probe (`src/service.ts:662`, `:759-780`),
`resolveWindowsSchedulerTaskProbe()` (`:916`), the pure evaluator (`:800`), the on-disk XML fallback
for an empty `/query /xml` view (`:844-856`), and ownership fencing — `attemptStillOwned()` is
defined at `:971`, the entry guard is `:980-982`, and the pre-write guard is `:1036-1041`.

Genuinely missing: bounded post-create retries, a retry-eligibility classifier, an injectable settle
delay for tests, and an ownership guard before rollback.

File map:

- MODIFY `src/service.ts` — add a retry-eligibility predicate that permits a delayed recheck ONLY
  when assets are healthy, WinSW is proven absent, there is no conflict, and task presence or
  registration health is still incomplete. Add a bounded settle loop (initial verification plus at
  most four delayed rechecks; delays `[50, 150, 300, 600]` ms, 1.1 s total) with an ownership check
  before and after every await, plus an ownership guard before rollback (`:1022`).
- MODIFY the `FinalizeHooks` seam (`src/service.ts:894`) — add a test-only injectable `settleDelay`.
- Tests: `tests/windows-elevation-spawn.test.ts` for the settle cases, alongside the existing
  contracts in `tests/windows-scheduler-install-verification.test.ts` and
  `tests/startup-action-control-elevation.test.ts`.

Scope note: an empty `/query /xml` view is already mitigated by the disk fallback, and permanently
malformed XML is not transient — retrying only delays the same rollback there. The load-bearing case
is task-visibility lag, plus a non-empty but temporarily unhealthy XML view.

Acceptance + activation:

1. Transient post-create invisibility settles: scripted `absent` → `present but unhealthy` →
   healthy, then install state is written. Activation: fault-injection test with an injected
   `settleDelay`.
2. Confirmed conflict receives ZERO retries and rolls back. Activation: adversarial test counting
   probe invocations.
3. Missing assets fail immediately with no retry. Activation: adversarial test.
4. Unknown SCM status still fails closed without claiming conflict and without rollback — the
   existing contract at `tests/windows-elevation-spawn.test.ts:718` must stay green.
5. Persistent unhealthy registration exhausts the budget (five probes, four delays) and then rolls
   back. Activation: counting test.
6. Ownership lost DURING a settle delay stops with no rollback and no state write. Activation:
   interleaving test.
7. Ownership lost AFTER the final verification but before the caller resumes from `await` also
   stops. Activation: a test flipping ownership from the final `verify` hook. This is the edge the
   upstream PR's own tests miss, and it is why this lane re-implements rather than cherry-picks.
8. **(audit blocker 2)** Ownership lost around a NON-RETRYABLE final failure must skip rollback too.
   Acceptance 7 alone only re-proves the existing pre-write guard at `:1036-1041`, because a
   successful final verify has no await after it. Activation: a dedicated test where `verify` returns
   a non-retryable failure AND revokes ownership, asserting zero rollback launches and zero state
   writes. This is the only test that actually fires the new pre-rollback guard.
9. **(audit blocker 3)** "WinSW proven absent" must be proven as an INDEPENDENT retry-rejection
   condition. Because `conflict` requires `taskInstalled` (`src/service.ts:812-817`), the conflict
   case in acceptance 2 activates `conflict:true` and `nativeServiceAbsent:false` together and cannot
   distinguish a predicate that only checks `!conflict`. Activation: an isolated case with
   `taskInstalled:false`, healthy assets, and `nativeStatus:"started"` — assert exactly one
   verification, zero delays, and immediate fail-closed handling.

Live Windows validation is not available in this session, so the PR body's startup-protection smoke
claim is covered by the fault-injection contracts above. Anything that genuinely requires a real
Windows host is reported as such rather than claimed.

## Bug B — #861/#848: Bun runtime provenance

**Measured root cause.** The repeated instruction comes from one unguarded branch in doctor:
`if (d.platform === "win32" && d.eagerRelay?.reason === "auto-known-bad")`
(`src/cli/doctor.ts:657`), which always emits "…or set `OPENCODEX_BUN_PATH` to a runtime you trust"
(`:658-660`). The payload it reads carries no runtime-origin field at all —
`src/server/management/system-routes.ts:77-82` goes straight from `bunRevision` to `platform` — so
the branch cannot distinguish an active override from bundled or process execution.

`durableBunRuntime()` already returns the three-value source (`src/lib/bun-runtime.ts:55-60`), but it
resolves in the CALLING process: `src/cli/status.ts:170` calls it inside the status process, which
says nothing about how the running service was launched. That is exactly why the marker has to be
stamped at launch instead of inferred at report time.

File map:

- MODIFY `src/lib/bun-runtime.ts` — export one marker env-var name, the shared source type, and an
  allowlisted `reportedBunRuntimeSource(env)` returning `undefined` for missing or invalid values.
  It must never call `durableBunRuntime()`.
- MODIFY the launcher entry (`cliEntry()` at `src/service.ts:46-50`) so the executable path and its
  source come from ONE `durableBunRuntime()` call, then stamp that paired source into all five
  launchers: npm child env (`bin/ocx.mjs:415-418`), scheduler batch env (`src/service.ts:1265-1278`
  — today the source is only logged at `:1283-1286`), WinSW `<env>` (`src/lib/winsw.ts:95-103`, entry
  shape `:65-68`), launchd `EnvironmentVariables` (`src/service.ts:276-281`), and systemd
  `Environment=` (`src/service.ts:1860-1867`).
- **(audit blocker 1)** Two further REAL launch paths must be covered or the marker is erased on the
  most common Windows start:
  - Codex autostart shim — it selects its own runtime at `src/codex/shim.ts:123-127` (called at
    `:604`) and reaches the daemon through `ocx ensure` (`src/codex/shim.ts:409`, `:465`, `:500`),
    which spawns with inherited env at `src/cli/index.ts:383-389`. Tests: `tests/codex-shim.test.ts`.
  - Windows tray — `src/tray/windows.ts:83-90` only builds an entry; the child environment is built
    at `:491-510` and autostart arguments at `:129-177`, while tray proxy actions actually spawn Bun
    from `src/tray/windows-tray.ps1:84-95` (today setting only `CODEX_HOME` and `OPENCODEX_HOME`).
    Pass the paired source through the tray arguments and stamp it into
    `ProcessStartInfo.EnvironmentVariables`. Tests: `tests/windows-tray.test.ts`.
- MODIFY `src/server/management/system-routes.ts:77-82` — serialize only the allowlisted marker
  beside `bunRevision`; `undefined` omits the field entirely for legacy payloads.
- MODIFY `src/cli/doctor.ts` — carry the scalar through the client type (`:523-537`) and payload
  normalization (`:573-606`), then branch under the existing guard: `override` states the override is
  already active and never re-emits the setup instruction; `undefined` states legacy/unknown without
  guessing; `bundled` keeps today's remediation; `process` names process provenance instead of
  implying bundled.
- DOCS: `structure/05_gui-and-management-api.md:81` — provenance trust + backward-compat rule.
- DO NOT TOUCH: `src/lib/bun-stream-caps.ts` (`MIN_FIXED_BUN_VERSION` `:20-24`, canary conservatism
  `:52-67`, the `auto-known-bad` decision `:79-88`, the `config-eager` opt-in `:84-85`,
  `selectEagerPath()` `:98-111`) or `src/server/responses/core.ts:1769-1778`.

Acceptance + activation:

1. Override marker present → doctor never emits "set `OPENCODEX_BUN_PATH`". Activation: doctor test
   with a payload carrying `override`.
2. Legacy payload with no marker → unknown wording, no shell guess. Activation: fixture with the old
   payload shape.
3. `bundled` keeps today's remediation and `process` gets its own wording. Activation: two doctor
   tests.
4. Each launcher stamps the source PAIRED with the Bun path it actually selected, not merely "some
   source is present". Activation: per-launcher artifact assertions covering all seven paths (five
   named launchers plus the Codex shim and the tray).
5. Endpoint serialization matrix: `override`, `bundled`, and `process` serialize; invalid and unset
   both omit the field. Activation: five input states; invalid and unset may share one test provided
   both are asserted.
6. Canary `auto-known-bad` and the eager-relay policy stay unchanged. Activation:
   `tests/bun-stream-caps.test.ts` stays green untouched AND — **(audit blocker 4)** — a diff receipt
   showing `src/lib/bun-stream-caps.ts` and `src/server/responses/core.ts` do not appear in the
   implementation diff at all. A green test alone does not prove the source is unchanged.

Known-fixture impact (audit, plan for it rather than discovering it at B): making the paired `source`
required breaks fixture literals at `tests/service.test.ts:79`, `:496-499`, `:508`, `:522-525`,
`:546-549`, `:1336` and the shared WinSW entry at `tests/winsw.test.ts:10`. Artifact assertions that
should gain marker checks: `tests/service.test.ts:538-560`, `:575-589`, `tests/winsw.test.ts:38-48`.
The currently green doctor test at `tests/doctor.test.ts:404-409` WILL fail unless its `baseData`
fixture gains `bundled` (legacy/unknown must stop printing the override instruction) — add a separate
legacy fixture rather than weakening that test; `tests/doctor.test.ts:411-426` stays unchanged.

## Verification gate

`bun run typecheck` exit 0, focused doctor/runtime/service/watchdog/winsw/elevation tests shown
red-then-green, and a full `bun run test` compared against the green baseline recorded at the top of
this document. Commit per bug locally; pushing stays gated on explicit user approval.
