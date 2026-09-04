# 030 — Windows baseline: what the failures actually were

Work-phase `wp3`. Criterion `c-5`. Evidence, not a landed fix.

A full Windows suite was already running on `desktop-c795oh4` when this unit
started (`/c/ocxwin/repo` at `00834d710`, shards `base-1..4`). It was read-only
evidence for this unit and was not disturbed. A second run on Bun `1.4.0`
followed (`v140-1..4`).

## The headline

| run | Bun | fail |
|---|---|---:|
| `base-1..4` | 1.3.14 | 179 |
| `v140-1..4` | 1.4.0 | 25 |

Shard 1 alone went from 100 `(fail)` lines to 2. **The Windows suite was not
telling us about 179 product defects; it was mostly reporting one harness
failure over and over.**

## Why 161 of them were one bug

`tests/preload.ts` calls `acquireTestRunLock` (line 42) BEFORE it arms the guard
with `OCX_TEST_HOME_GUARD=1` (line 64). On Windows the lock path needs the
effective account SID, and under 4-shard load that lookup timed out:

```text
CodexUserIdentityRefusal: Windows effective-account lookup timed out.
  at powershellValue (src/codex/user-identity.ts:252)
  at resolveWindowsSid (src/codex/user-identity.ts:261)
  at resolveDefaultTestRunLockPath (scripts/test-run-lock.ts:227)
  at tests/preload.ts:42
```

The worker then ran with the guard permanently off, and every test that asserts
"this helper is only available under the repository test preload" failed as a
cascade: 44 in `codex-reset-credit-operation-ledger`, 68 in
`codex-reset-credit-recovery`, 49 in `lab-fabric-task`.

**That cascade had teeth.** With the guard down, two suites reached live
machine state instead of being refused:

- `windows-elevation-spawn.test.ts:89` expected `launcherPid: null` and got
  `18144` — a real PowerShell process was launched.
- `service.test.ts:1283`/`:1307` expected "refusing to mutate the
  machine-global Windows Task Scheduler from an armed test process" and instead
  got real scheduler-registration outcomes.

So the ordering in `preload.ts` is not only noisy, it is the difference between
a refused test and one that touches the developer's own Task Scheduler. Worth
fixing on its own merits, independently of the Bun version that exposed it.

## What survives on Bun 1.4.0

25 failures in three groups:

- `multi-account auth store` — 22 of the 25, one file. Not yet diagnosed.
- `ocx v2 keep-native-v1` — 2. Dirac classified the `base` occurrence as a test
  artifact: the product CLI exited 0 and the V2 disable took effect; only the
  spy compares raw argv, and Windows `.cmd` invocation goes through the ComSpec
  wrapper (`src/lib/win-exec.ts:79`), which is correct behaviour.
- `cli wiring > interactiveGuardOk ... when cwd is unlinked` — 1.

## Not fixed here, and why

This unit's authority is the admin-token UX. None of the surviving failures are
in that surface, and each needs its own reproduction on Windows before a fix is
more than a guess — the `base` run's evidence is contaminated by the guard
cascade, so a fix written against it would be written against an artifact.

The honest carry-forward is three separate units:

1. Arm `OCX_TEST_HOME_GUARD` before `acquireTestRunLock`, or make the SID lookup
   fail closed instead of proceeding unguarded. Highest value: it is a safety
   defect, not just a flake.
2. Diagnose `multi-account auth store` on Windows.
3. Decide whether `keep-native-v1` should assert on parsed argv rather than the
   raw ComSpec string.

Issue #3320 (non-ASCII account names misclassifying a valid scheduler task) is
adjacent to (1) — both are Windows identity handling — but it is `needs-info`
and was not reproduced here, so it stays open.
