# 040 — wp5: #2638 rebase and safety verdict

Head `b0f328462`, `luvs01` fork (`maintainerCanModify: true`), **192 behind**,
merge-tree CLEAN, tsc OK on the merged tree. 1341 insertions across:

- `src/codex/auth-context.ts`
- `src/codex/routing.ts` (+334)
- `src/codex/subagent-model-fallback.ts` (+86)
- `src/server/responses/core.ts` (+78)
- three test files

## Why "merge-tree CLEAN, tsc OK" is not enough here

The reviewer's objection is precise and still stands: `src/server/responses/core.ts`
is modified both by this PR and by the intervening 192-commit `dev` range, and that
file is part of the request/auth-routing boundary the PR changes. **Textual
mergeability is not evidence the combined behavior is correct.** Two changes can
merge cleanly and still contradict each other semantically.

The reviewer also asked that `maintainer-sponsored` NOT be applied and the waiting
fork workflows NOT be approved until a rebase onto current `dev`.

## AGENTS.md invariant at risk

This PR touches `src/server/responses/core.ts` and `src/codex/subagent-model-fallback.ts`
— the synchronous subagent-fallback chain. `AGENTS.md` is explicit: no `await` may be
added between `Bun.serve` and the `labActivationRequired` check in
`src/server/index.ts`, and the protected core files must not reach `src/lab/`.
`tests/core-lab-boundary.test.ts` enforces both and MUST be run on the rebased tree.

## Plan

1. Rebase `pr2638-r3` onto `origin/dev` on a local branch; record every conflict.
2. Run `tests/core-lab-boundary.test.ts` plus the auth, routing, entitlement and
   subagent-fallback suites on the rebased tree.
3. Differentially probe the routing/auth decision functions the PR changes against
   unpatched `dev` — which requests route differently, and is every difference
   intended?
4. Verdict:
   - if the rebase is clean and behavior is provably unchanged except for the
     intended drain fix -> push the rebase to the fork, let CI run, and record that
     it is ready for a second maintainer's security sponsorship;
   - if any conflict requires a judgement call about auth or routing semantics ->
     **NEEDS_HUMAN** with the exact hunk.

Landing it myself is not on the table regardless: `MAINTAINERS.md` requires explicit
security review for this surface, and the reviewer has already withheld sponsorship.

## Verification (C)

```bash
bun x tsc --noEmit
bun test tests/core-lab-boundary.test.ts
bun test tests/codex-auth-context.test.ts
bun test tests/codex-routing.test.ts
bun test tests/subagent-fallback-handle-responses.test.ts
```

One suite at a time. The full suite goes to `lidge` via `ocx-run`.

## Terminal outcome

**NEEDS_HUMAN** in the expected case, with the rebase done and the evidence
attached so the security review has something current to review.
