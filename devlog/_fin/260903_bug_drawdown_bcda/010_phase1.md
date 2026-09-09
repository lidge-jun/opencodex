# 010 — Phase 1 (wp1): PR #3254 — native chat transient send budget

## Item

`fix(chat): share transient retry budget across native recovery legs`, head
`49858a2df56d4c0aa0043d6483d50bf865c58918`, author luvs01, labels `bug` +
`review-ready`, reviewDecision APPROVED, 174 additions / 5 deletions across 2 files.

## Phase class: ADOPTION, not authoring

This phase writes no source. The unit of work is a merge decision on a diff a
contributor already wrote and CI already exercised, so DIFFLEVEL-ROADMAP-01 is
satisfied by naming the exact incoming hunks rather than authoring new ones. The
"before" is `origin/dev` at `529639a57`; the "after" is that tree plus the diff
below, transcribed from `gh pr diff 3254`.

## MODIFY / NEW / DELETE map (incoming diff, verbatim)

MODIFY `src/server/chat-native.ts`, three hunks:

1. `@@ -204,12 +204,24 @@` in `handleNativeChatCompletions` — BEFORE: `send()`
   recomputed `const transientPolicy = transientRetryPolicyFor(activeProvider)` on
   every call. AFTER: the policy is captured once per inbound request as
   `requestTransientPolicy`, with `transientSendsUsed`, `remainingTransientSends()`
   returning `Math.max(0, attempts - used)` (or `Number.POSITIVE_INFINITY` with no
   policy), and `transientSendAvailable()`. `send()` throws
   "native Chat transient send budget exhausted before recovery dispatch" when the
   remainder reaches zero.
2. `@@ -232,7 +244,12 @@` — BEFORE:
   `...(transientPolicy ? { attempts: transientPolicy.attempts } : {})`. AFTER:
   `attempts: remaining` plus
   `onSendsConsumed: (sends) => { transientSendsUsed += Math.max(0, sends); }`.
3. `@@ -245,7 +262,12 @@` with `@@ -263,6 +285,10 @@` — BEFORE the 429 loop read
   `response.status === 429 && retryPolicy && retries < retryPolicy.attempts`.
   AFTER `&& transientSendAvailable()` is appended, and the rotation branch keeps
   the failed key's cooldown bookkeeping while preserving the terminal 429 once
   the request has spent its final send.

MODIFY `tests/chat-completions-endpoint.test.ts` — the only other file in the
diff. BEFORE: the native-chat suite covered the 429 rotation path without
constraining how many upstream sends a single inbound request could produce, so
a rotation that reset the ceiling passed unnoticed. AFTER: a case drives one
inbound request through a 429 plus a key rotation against a provider configured
with a transient policy, counts upstream sends across BOTH legs, and asserts the
total never exceeds the policy's `attempts`, plus that the terminal 429 is
preserved once the budget is spent.

## TESTS — the assertion that is RED before the fix

Contract that fails on `529639a57` without hunk 3: given a transient policy of N
attempts, a request whose upstream returns 429 and whose key then rotates issues
MORE than N upstream sends, because the pre-fix loop is bounded by
`retryPolicy.attempts` alone and rotation mints a fresh ceiling. The PR's
regression counts sends across the rotation boundary and fails on the pre-fix
tree. It is the contributor's test; this phase confirms CI executed it rather
than re-authoring it.

The exact-head rollup is the binding verifier. Captured 2026-09-03 on
`49858a2d`: 31 checks, all SUCCESS or SKIPPED (`test 1..4/4`, `macos`, `gates`,
`storage policy`, `api usage`, `keyring ubuntu/windows/macos`, `npm-global` x3,
`hygiene`, `react-doctor`, `enforce-target` x4, `ci`), CodeRabbit neutral.
`mergeStateStatus: UNSTABLE` reflects that neutral status, not a failure.

## Verification (C)

```
gh pr view 3254 --json headRefOid,statusCheckRollup
gh pr merge 3254 --squash --admin
git fetch origin dev && git merge-base --is-ancestor <merge-sha> FETCH_HEAD
```

Terminal outcome: DONE when the squash sha is an ancestor of `origin/dev`.

