# 031 — Arm the guard before the run lock

Work-phase `wp5`. Closes carry-forward item 1 from `030`. Merged as PR #3507
(`663fdbb0a`).

## What was wrong

`tests/preload.ts` acquired the run lock before arming `OCX_TEST_HOME_GUARD`,
with no `try/finally` between them. Taking the lock resolves a user-scoped path,
which on Windows spawns PowerShell for the effective SID. Under four-shard load
that spawn timed out, the refusal threw straight out of the preload, and every
statement below it — the sandbox, the arming, and the assertion written to catch
exactly this — never ran.

## Why the failure count was the wrong headline

161 red tests looked like the problem. They were the alarm.

`src/lib/windows-elevation.ts` and `src/service.ts` refuse live elevation and
machine-global Task Scheduler mutation ONLY while the guard is armed. An
unguarded worker did not just fail loudly — it quietly gained the ability to do
the things those refusals exist to prevent, and two suites took it: a real
PowerShell process at pid 18144, and real scheduler registration.

A luckier run would have shown FEWER failures and done the same writes.

## The fix, and the part the audit changed

Shipped order: sandbox → arm + assert → lock.

The original plan was arm-then-lock. The plan-audit lane rejected it as
incomplete: arming before the lock while sandboxing after it still leaves a
worker armed-but-unsandboxed, which blocks writes but not reads of the real
home. Putting the lock last closes that.

Arming early is safe because the guard is a deny-list keyed on a path captured
at module import, not a "sandbox is present" flag — its worst case when armed
early is refusing a write to the real home, which is the direction that fails
closed. The lock error stays unswallowed: a run that cannot take the lock must
still fail, it just must not fail while unprotected.

## Testing something with no runtime signature

When the lock succeeds — nearly always — an armed-after-lock preload and an
armed-before-lock preload produce byte-identical environments. There is no
runtime observation that separates them except on the runs where it already went
wrong.

So the regression asserts source ORDER, and was driven red against the old
arrangement (`Expected: < 1931, Received: 3245`) before being accepted. A second
test proves an armed process with a real `HOME` and no lock still refuses the
protected home — the state the timed-out worker was actually in.

Re-verified on the affected host itself, read-only and without contending with
the suite running there: `sandbox 1414, arm 2969, assert 3228, lock 4168`.
