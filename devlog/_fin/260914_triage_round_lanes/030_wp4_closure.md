# 030 — wp4: Closure sweep

## The finding that shapes this phase

A full cross-reference of 61 open issues and 68 open PRs against every PR merged in
the last ten days produced an empty CLOSE-NOW list. Not one open item could be
closed on merged work alone. Several backlog PRs name an issue in their body while
saying explicitly that they do not close it, and the reported code path is still
present in the tree for every issue examined.

So this phase does not sweep the backlog. It closes only what this loop actually
fixes, and it records the rest honestly.

## Closable by our own merges

| Issue | Closed by | Condition |
|---|---|---|
| #4530 | L2 bottom and top | catalog carries field 5 and the client advertises it |
| #4516 | L3 bottom and top | spare-budget restoration merged with its regressions |
| #4519 | L1 top | destination policy merged; blocked until security review |
| #4501 | #4511 | merged in round 1 |
| #4502 | #4512 | merged in round 1; L4-b adds the live coverage |
| #4522 | L4-a carry | carry merged, original credited |
| #4527 | #4528 | only if #4528 lands |

Each close comment names the merge commit and the file and line that changed. A
close without that pointer is not acceptable here, because the whole reason the
sweep is this narrow is that unverified closes were the failure mode found.

## Partially addressed — leave open, state the residual

#4429 keeps mixed-tool continuation fail-closed at
`src/web-search/passthrough-bridge.ts`:594 even though #4515 armed the non-Ollama
backends; the merged PR body says so itself. #4312 still maps only
`max_output_tokens` to HTTP 200 at `src/server/request-log.ts`:966, so an Anthropic
refusal still reads as a retryable 502. #4191 still carries a 90-second prelude
timeout at `src/server/responses/codex-ws-wire.ts`:22; the WS diagnostics that
landed made the failure observable, not absent. #4311 still refuses paginated
history writes at `src/codex/history-provider.ts`:275 with no native writer behind
it. #3661, #3522, #3506, #4505, #3781, #3376, #3377, #3375 and #3719 are in the
same shape.

For each of these, the action is a comment naming the residual and the evidence
line, not a close. That comment is worth writing because the next triage will
otherwise re-derive the same conclusion from scratch.

## Superseded

No open PR was verified as already fully present on `dev`. The two candidates that
look superseded are not: #2562 and #3283 are overlapping Antigravity pool designs
where neither is on `dev` and a maintainer has to pick, and #4242 was not carried
by the merged #4351, which says as much in its own body.

Therefore this phase closes no PR as superseded. If that changes because a round-2
merge lands something an open PR also contains, the close names the superseding
merge commit and quotes the current-tree evidence.

## Unit closeout

Move this unit to `devlog/_fin/` once the rounds are recorded, with the merge
commits, the CI run ids, and an explicit note of anything merged without observing
CI. Record the deviation list too: the empty CLOSE-NOW result, and any lane that
did not produce its top layer.

