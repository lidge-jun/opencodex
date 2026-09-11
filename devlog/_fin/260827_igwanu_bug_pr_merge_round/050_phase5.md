# 050 — wp6: contributor remainder — #2740, #2693, #2638

## #2740 — fix(storage): atomically commit cleanup run metadata

Lane **L1**. Head `f07ee36f2`, draft, MERGEABLE, 26 behind, merge CLEAN, tsc OK.
`luvs01`. Only **5 checks** — no `ci`/`test`/`macos` at all, so it has never been
compiled or tested by CI. The merged-tree gate in 000 is its first real evidence.

Touches `src/storage/policy-job.ts` (+18), `src/storage/policy.ts` (+111/-27),
`structure/02_config-and-config-and-codex-home.md` architecture note, and adds
`tests/storage-policy-config-race.test.ts` (+150). No overlap with any in-scope PR.

A metadata write race fixed by atomic commit, with a dedicated race regression.
Needs: the merged-tree focused suite, and confirmation the new test actually fails
without the fix (a race test that passes both ways proves nothing). Then flip
draft -> ready and merge.

## #2693 — fix(google-antigravity): skip_thought_signature_validator fallback

Lane **L4 (author must fix)**. Head `8775d77d6`, draft, 118 behind, merge CLEAN,
tsc OK, 5 checks only. CHANGES_REQUESTED with three reproduced blockers:

1. `src/adapters/google-antigravity-replay.ts:758-770, 811-837` treats mere
   *presence* of `thoughtSignature`/`thought_signature` as a valid turn signature
   instead of the existing `extractSignature()` contract, and sets
   `turnHasSignature` when any *later* sibling gets a cached signature. Reviewer
   reproduced a two-call turn where the first call ends up completely unsigned and
   the required first-call sentinel is skipped.
2. The same presence check mishandles wire shapes the module already supports: a
   valid nested `extra_content.google.thought_signature` gets a *competing* direct
   sentinel added, and a direct short invalid value (`"short"`) suppresses fallback
   entirely.
3. `antigravityUsesReplayCache()` accepts every non-Claude model including
   `gpt-oss-120b-medium`, so the unconditional fallback injects a **Gemini-only
   sentinel into a non-Gemini model** — reproduced.

Plus a non-blocking test defect: the unknown-version snapshot test reuses the
object mutated by the corrupt-snapshot call, so its second assertion is not
load-bearing.

This is a correctness rewrite of the PR's core logic, not a touch-up. The previous
round already recorded #2693 as BLOCKED. Disposition: keep as a **draft awaiting
author revision**, with the three blockers already posted. Re-verify the review is
still current against `dev @ 8b1b65b8d` and confirm the ask is unambiguous.

## #2638 — fix(codex): close drain routing follow-ups

Lane **NEEDS_HUMAN**. Head `b0f328462`, draft, **179 behind**, merge CLEAN
textually, tsc OK, 5 checks with `enforce-target` and `hygiene` FAILING.

1341 insertions across `src/codex/auth-context.ts`, `src/codex/routing.ts` (+334),
`src/codex/subagent-model-fallback.ts` (+86), `src/server/responses/core.ts` (+78)
and three test files.

This is the **request/auth-routing boundary**. The reviewer's position is explicit
and correct: `src/server/responses/core.ts` is modified both by this PR and by the
intervening 179-commit `dev` range, so *GitHub's textual mergeability is not
evidence the combined behavior is still correct*. The reviewer asks that
`maintainer-sponsored` NOT be applied and the waiting fork workflows NOT be
approved until a rebase onto current `dev`.

It also touches `src/server/responses/core.ts` alongside #2745 and #2497 — the
round's hottest contention point.

Disposition: **NEEDS_HUMAN**. Author rebase required first; security sponsorship
is a human decision. Do not land in this round.

## TESTS

- #2740: `tests/storage-policy-config-race.test.ts` — must be shown red without
  the fix.
- #2693: `tests/google-antigravity-replay.test.ts` — needs the two wire-shape
  regressions and a fresh unsigned payload for the version-99 branch.
- #2638: `tests/codex-routing.test.ts`, `tests/codex-auth-context.test.ts`,
  `tests/subagent-fallback-handle-responses.test.ts` — only meaningful after rebase.

## Verification (C)

```bash
bun test tests/storage-policy-config-race.test.ts
bun x tsc --noEmit
```

Only #2740 is verified-to-land in this phase. #2693 and #2638 exit with a recorded
non-merge disposition and the specific unblocking condition stated on the PR.

**Do not reach into `src/lab/` and do not add an `await` between `Bun.serve` and
the `labActivationRequired` check** — #2638 touches `core.ts` and
`subagent-model-fallback.ts`, exactly the synchronous subagent-fallback chain
`AGENTS.md` protects.
