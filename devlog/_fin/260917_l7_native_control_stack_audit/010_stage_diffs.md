# 010 — what each stage actually adds

## Why the GitHub diff is misleading

All four pull requests declare base `dev`, and none of them uses the stacked-child
workflow described in `AGENTS.md`. Each therefore shows its parents' commits in
its own diff. #4858 is the extreme case: against `dev` it reads as 120 files and
`+6441/-1004`, because its branch also carries a pinned-`dev` merge
(`9c411a1048`) that drags in unrelated integration work. Its own feature delta is
39 files.

The ranges below are the parent-relative deltas. Each one is reproducible:

```bash
git fetch origin pull/4782/head:pr4782 pull/4858/head:pr4858 \
                 pull/4861/head:pr4861 pull/4864/head:pr4864
git diff --stat "$(git merge-base origin/dev pr4782)" pr4782   # L7.1
git diff --stat 9c411a1048 pr4858                              # L7.2
git diff --stat de600be5f3 pr4861                              # L7.3
git diff --stat b00654b368 pr4864                              # L7.4
```

## Per-stage delta

| Stage | PR | Range | Total | `src/` | `tests/` | `structure/` + `docs-site/` |
|---|---|---|---|---|---|---|
| L7.1 | #4782 | merge-base → `76d7452afb` | 40 files, +1278/-33 | 15 files, +669/-31 | 3 files, +478/-1 | 21 files, +129 |
| L7.2 | #4858 | `9c411a1048` → `7a9a6d28dd` | 39 files, +1165/-71 | 16 files, +495/-52 | 5 files, +519/-19 | 17 files, +150 |
| L7.3 | #4861 | `de600be5f3` → `59a1d6357e` | 29 files, +621/-58 | 7 files, +230/-38 | 5 files, +292/-3 | 16 files, +98/-17 |
| L7.4 | #4864 | `b00654b368` → `7b548ad85e` | 25 files, +496/-41 | 5 files, +121/-39 | 3 files, +275/-1 | 16 files, +98 |

The `structure/` rows are almost entirely ownership-table lines required by
`structure:check`, not new architecture prose.

## L7.1 — #4782, native WebSocket steering

New modules: `native-steering.ts` (the channel: envelope validation, parent/steer
bookkeeping, settings pinning by digest, chain and byte caps),
`native-steering-replay.ts` (connection-local journal where only a
`response.created` successor commits queued input), `native-steering-log.ts`
(per-response usage aggregation that never samples control frames).

Wiring: `codexNativeSteering` in the config schema and `OcxConfig`; the inbound
WS handler recognizes `response.steer` and routes `response.create` through
`continue()`; `ws-upstream` skips the idle-socket pool when a control channel is
present; `codex-ws-exchange` attaches the channel and owns control sends;
`passthrough-delivery` keeps the bounded upstream as the sole reader of a
multi-terminal stream; `ws-bridge` gains `untilEof` so one SSE body may carry
several response terminals.

One refactor rides along: `markBodyNonPersistable` moves from `responses/state.ts`
to a new `responses/state/body-policy.ts` so the dispatch path can also read it.

## L7.2 — #4858, multi-agent function-result injection

New modules: `native-injection.ts` (a second, separate owner with a FIFO of at
most one in-flight frame, because the acknowledgement names the response rather
than the injection), `native-injection-protocol.ts`, `native-injection-replay.ts`,
`native-response-control.ts` (the `NativeResponseControl` interface, the
eligibility predicate and the mode selector).

This is the stage that widens the route surface. `nativeResponseControlEligible`
keeps canonical ChatGPT forwarding for both modes and additionally admits, for
injection only, an `openai-responses` provider pinned to exactly
`https://api.openai.com/v1` with `upstreamWebsocket: true` and a non-forward auth
mode; on that route `ws-upstream` appends `responses_multi_agent=v1` to
`openai-beta` without discarding configured tokens. Mode selection reads the
frame, never the model name: a request carrying `multi_agent.enabled: true` can
only obtain the injection channel, and the steering channel's constructor rejects
it outright.

## L7.3 — #4861, typed result continuations and hosted output

New modules: `native-tool-results.ts` (the wider saved-result schema —
`custom_tool_call_output`, `mcp_approval_response`, rich content parts with
bounded image/file references, and caller provenance reduced to a digest) and
`native-response-output.ts` (merges completed `response.output_item.done` items
with a sparse terminal `output`, preserving relative order and failing on a
contradiction instead of dropping items).

Two later commits on this branch are corrections, and they matter to L7.4:
`4670525d48` rejects a continuation that *omits* a pinned setting — before it,
only a changed setting was caught, so dropping a key bypassed the pin — and
`59a1d6357e` refunds the exact reserved byte count of an injection batch instead
of recomputing it from a possibly different serialization.

## L7.4 — #4864, bounded waits and sparse replay output

Replaces the steering channel's single re-armable `wait()` with absolute
deadlines. Before this stage each control re-armed a fresh 90-second window, so a
client that kept sending controls could hold the socket indefinitely, and late
wire activity could win a race against an expired-but-unfired timer. After it,
every stage carries its own absolute deadline (`nextDeadline` takes the earliest,
`armTimer` never extends one, `assertTimely` settles on arrival, `expire` settles
exactly once and reports unknown delivery rather than retrying).

It also extracts `native-response-json.ts` so the JSON record/fingerprint helpers
no longer live in the injection protocol module, and routes the steering replay's
terminal output through `nativeResponseOutput` — previously it took the terminal
`output` whenever non-empty and silently dropped observed items a sparse terminal
omitted.

## The divergence a reviewer must see

#4864 is based on `b00654b368`, which is #4861's *feature* commit, not #4861's
head. The two corrections above are not in #4864's branch, so nothing has been
built or tested on the combination `dev` will actually receive. A squash merge in
#4861 → #4864 order does not revert them, because neither correction touches a
line #4864 edits, but the combined behavior is unverified. #4864 should be rebased
onto #4861's head before it is treated as the stack tip.
