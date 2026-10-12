# 121 — #2108 phase 1 implementation record

Shipped: PR [#2121](https://github.com/lidge-jun/opencodex/pull/2121), commit
`18a383e8e`, branch `fix/native-main-gate-reason` stacked on
`fix/cursor-abort-teardown` (#2118).

Issue disposition posted:
[#2108 comment 5343287759](https://github.com/lidge-jun/opencodex/issues/2108#issuecomment-5343287759).
`Refs`, not `Closes` — this makes the next occurrence diagnosable, it does not
stop the fence sticking.

## What the plan audit changed

Draft 1 of `120` proposed a response header `x-ocx-native-main-gate-reason`
alongside the log line. The A-gate audit returned **fail**, and the header was
dropped entirely. The refutation is worth keeping because it is not obvious:

- The header cannot reach the caller without editing the five zero-arg
  `codexMainProfileDrainingResponse()` call sites — and `core.ts`/`compact.ts`
  are both edited by #2101, so the collision the whole design existed to avoid
  came straight back.
- Having the response builder re-read the gate instead *looks* like a one-file
  fix, but `completeNativeMainRecovery()` can flip the snapshot to `ready`
  between throw and catch. The header would go blank or wrong exactly when
  recovery is racing, which is the scenario #2108 is about.
- It would not reach the Claude surface anyway: `claude-messages.ts:823-829`
  rebuilds its response with a hand-written header object.

The audit also caught a third throw site the plan had missed (`:326`,
turn-drain), that the `console.warn` assertion — phase 1's entire purpose — was
absent from the test plan, and that `privacy:scan` was missing from a cycle
whose only product is a log statement.

Round 2 returned **pass**, and the reviewer went further than asked: it copied
`src`/`tests` to a scratch tree and mutated them there. Removing the
`console.warn` body goes red (2 fail); removing the dedup check goes red. That
is stronger evidence than my own red-drive, because it tests the assertions
rather than the fix.

## The shipped shape

`src/codex/auth-context.ts:115-166` only, plus a derived type export in
`native-profile-startup.ts` and the tests.

`CodexMainProfileDrainingError` reads `nativeMainStartupGateSnapshot()` in its
constructor, records `reason` when the gate is `blocked`, and warns once per
distinct reason. Every call site — 3 constructions, 5 response builders — is
byte-identical.

The `:326` turn-drain site stays silent by construction (early return on
`status !== "blocked"`), which makes a reasonless 503 mean "not the startup
fence". That distinction did not exist before and the reporter could not make it.

## Collision outcome

`git diff -U0` puts this change at old-file lines 15 and 118-124. #2101's
`auth-context.ts` hunks are 23-28, 237-242, 260-267, 273-278, 302-308, 312-318,
325-330. Zero overlap, no adjacency. `native-profile-startup.ts` is not among
#2101's 20 files. In the test file both PRs add imports around lines 59-63,
which merges cleanly.

## Verification

204 pass / 0 fail / 903 expect() across the five native-main gate suites plus
`chat-completions-endpoint` and `claude-messages-endpoint`. `tsc --noEmit`
exit 0. `privacy:scan` exit 0.

Red-drive: with the fix staged as a no-op export, 2 fail on
`reason === undefined` and the silence case passed — the assertions were doing
the work, not a module-load error.

**Coverage caveat, stated in the PR too:** macOS only. `owner-unavailable` is a
Windows icacls path, and nothing in the suite asserts it — it is produced at
`native-profile-startup.ts:139` and asserted nowhere. The branch the reporter
most likely hit is the one with no coverage, which is the argument for shipping
the diagnostic before the mechanism.

## Stack correction worth recording

The commit first landed on `fix/cursor-abort-teardown` itself rather than a new
branch. Corrected by `git switch -c fix/native-main-gate-reason` followed by
`git branch -f fix/cursor-abort-teardown origin/fix/cursor-abort-teardown` —
resetting the local branch to its already-pushed head, no force-push, no
contributor branch touched. Caught by reading `git log` after the commit rather
than assuming the branch was where I left it.

## What phase 2 needs

A field report that names a reason. Phase 2 makes a boot-time `unknown`
retryable while `OCX_SERVICE=1` instead of a process-lifetime fence, keeping
genuine `foreign` fail-closed with a retry cap. Two narrower fixes stand on
their own: a timed-out `sc.exe query` with WinSW xml and exe both absent must
not mark the machine `unknown`, and a second ACL `ETIMEDOUT` should back off
and retry so a warm icacls reopens the gate without `ocx restart`.

