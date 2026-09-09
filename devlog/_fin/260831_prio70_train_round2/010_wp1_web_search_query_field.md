# 010 — wp1: carry singular `query` on every web_search_call action (#3071)

Score 73/80. Branch: `codex/3071-web-search-query`, based on `dev`. One PABCD cycle.

PR #3069 already implements this correctly. wp1 is a review-and-land phase, not a
reimplementation: rebase, close the two gaps the tools lane found, merge.

## What changes

`webSearchAction()` (`src/bridge.ts:164`) currently returns `{type, queries}` for a
batch and `{type, query, queries}` for a single. It becomes unconditional:

```
const first = queries[0] ?? "";
return { type: "search", query: first, queries: queries.length > 0 ? queries : [first] };
```

`backfillWebSearchQueries()` (`src/adapters/openai-responses.ts:916`) currently repairs
only `query` → `queries`. It becomes bidirectional: an action with `queries` and no
`query` gains `query = queries[0]`; an action with `query` and no `queries` gains
`queries = [query]`; an action with both is returned by reference.

## The trade this makes, stated plainly

The comment at `src/bridge.ts:149-168` says the omission is load-bearing: codex-rs
renders "<first> ..." only when `query` is ABSENT and `queries.len() > 1`. Adding
`query` to a batch collapses that plural ellipsis to a single-query label.

That is a real regression in native rendering, and it is the right trade — a cosmetic
label change against a conversation that 400s on every subsequent turn. The comment
must be rewritten to say so, because the next reader will otherwise "restore" the
asymmetry and reopen #3071. PR #3069 does rewrite it.

## Three gaps to close before merge

1. `src/adapters/openai-responses.ts:904-910` still describes the old one-way
   contract. Same class of stale comment as above.
2. `:927-928` reads `action.queries[0]` without a type check. Unknown input items use
   a loose schema (`src/responses/schema.ts:106`), so a non-string first element would
   be copied into `query` and fail the same validator this fix exists to satisfy.
   Require `typeof action.queries[0] === "string"`.
3. Added by audit round 1 (`002`, blocker 6): the PR head's own first summary line at
   `src/bridge.ts:149` still says a batch carries no singular `query`, contradicting
   the body of its rewritten comment and the code below it. The head's review state is
   `CHANGES_REQUESTED`, not merely "review required" — the plan understated where the
   PR stands.

Also undefined at the head: an action whose `queries` is `[]`. The loose input schema
admits it, and the current expression would produce `query: ""` with `queries: []`,
which satisfies neither validator's intent. Canonicalize `[]` to the empty-single form
(`{query: "", queries: [""]}`) and assert it.

## Regressions

Both already exist in the PR and both are RED against `dev`:

- `tests/bridge.test.ts:1078` — a batched search carries `query: "rust async"`
  alongside `queries`. Currently asserts `action.query` is undefined.
- `tests/openai-responses-passthrough.test.ts:1298` — a replayed batch gains the
  singular `query`. Currently asserts the batch is untouched.

Two to add:

- gap 2: an input item whose `action.queries` is `[42]` is returned unchanged rather
  than gaining `query: 42`.
- empty array: an action with `queries: []` canonicalizes to `{query: "", queries: [""]}`
  rather than passing an empty array through.

## Verification

Focused locally: `bun test tests/bridge.test.ts tests/openai-responses-passthrough.test.ts`.
Suite, typecheck and privacy scan on `ssh lidge` at the pushed head.

## Close-out

`Closes #3071`. Close #3068 as a duplicate with a comment naming #3071 and PR #3069.
Both close manually — PRs here target `dev`, not the default branch.
