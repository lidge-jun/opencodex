# 040 — Round 1 outcome

Thirteen pull requests landed on dev and ten issues closed against them.

## Merged

| PR | Merge commit | What it was |
|---|---|---|
| #4573 | 3fcf75eaa3 | this roadmap unit |
| #4451 | e0e1c089b0 | escape catalog diagnostics at the terminal boundary |
| #4517 | 774afb0339 | keep hub invite grants off the agent path |
| #4565 | 961958bc99 | bound completed entitlement version misses per account |
| #4139 | 018a585a5f | replace a wall-clock lock oracle with a deterministic one |
| #4298 | d45a7e7494 | zero-copy stream chunking in the bridge |
| #4383 | 4bf30709a3 | stop connect runtime discovery after a valid selection |
| #4452 | 2102b88c30 | open hub management on its bound IPv4 address |
| #4574 | 1b6518f818 | catalog per-key enrichment and positive modality declarations |
| #4578 | c66709f31c | cursor data-policy surfacing and real catalog names in exec refusals |
| #4577 | 44027ae5ad | responses terminal, history projection, content_filter, image append |
| #4575 | 000c0f1be6 | devin tenant host during the rekey window, antigravity quota classification |
| #4581 | 1de91840af | cache-safe quota rebinds and honest pooled-routing status |

## Issues closed

#4570, #4505, #4508, #4542, #4469, #4311, #4312, #4532, #4503, #3781.

#4546 and #4550 stay open with the landed scope recorded on them, because the
merge closed the cache spiral and the status claim but not the Phase 1 drain or
the WebSocket bypass. #4582 was opened for the provider-definition residual that
#4311 carried alongside its projection bug.

## What the round actually taught

**The contributor queue was not blocked on review.** Every fork pull request in
it was sitting with Cross-platform CI and React Doctor in `action_required`.
The green checks visible on each one were the hygiene, labeler and target gates;
the suite had never run at those heads. Approving the workflow runs at the exact
current head was the whole unblock. Two of the nine then failed real tests, which
is the point — the approval is what made that knowable.

**The hygiene gate reads commit messages, not just the description.** This unit's
own roadmap pull request failed `missing_coauthor_credit` twice before the cause
was clear: the gate resolves every `#NNNN` token in the body *and* in the branch
commits, and a docs commit that cites a contributor pull request by number looks
exactly like an uncredited carry. Round 2's lane instructions tell the lanes to
write "issue 4204" in prose instead.

**A security review that returns FAIL is worth more than the merge it delays.**
The devin tenant fix looked correct and its tests passed. The review found that
the fallback keyed off a missing or invalid `apiBaseUrl` rather than an absent
credential, and since the rekey refuses an occupied destination slot, two slots
can hold two different accounts — so one account's key could go to the other
account's EU or FedStart host. Narrowing the trigger then broke the lane's own
test, because `getCredential` returns `null` rather than `undefined` for an
empty slot. Both corrections are in the merged commit.

**Every lane PR was held at least once by its reviewer.** None was held for style.
Three test regressions in the catalog lane, a collapsed image-position store in
the responses lane, a documentation string that tripped the `empty_catch` scan.
The lanes fixed their own CI; the reviews caught what CI did not phrase clearly.

## Dispatch note

`kimi/k3[1m]` could not create a thread. Two attempts returned a client thread id
and then never materialised a task, while the same call with
`anthropic/claude-opus-5` succeeded immediately in the same worktree slot. The
round-1 orchestrator split was supposed to be opus-5 and kimi; it ran entirely on
opus-5 instead. Worth diagnosing before a round depends on that model.
