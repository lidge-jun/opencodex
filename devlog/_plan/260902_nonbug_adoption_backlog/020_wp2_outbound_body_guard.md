# wp2 — PR #3142 oversized outbound body refusal (+ #2511)

PR #3142 by @olddonkey, head `df94500b6`, `CHANGES_REQUESTED`, CONFLICTING with
`dev`, base 121 commits behind. Issue #2511 (score 55) is the adjacent request.

## The blocker is real and it is the one our own criteria care about

@Ingwannu's live review asks for the implicit 15 MiB default to apply only to the
canonical OpenAI forward Responses destination, because `passthrough` is not
synonymous with the measured ChatGPT backend — Azure and custom key-auth Responses
adapters use it too (`src/adapters/registry.ts:78`, `src/adapters/azure.ts:5`).

Independent investigation confirms it and finds the failure is worse than scope
creep. The default is applied whenever the key is omitted:

```
const maxUpstreamBodyBytes = config.maxUpstreamBodyBytes ?? DEFAULT_MAX_UPSTREAM_BODY_BYTES;
```

### It regresses requests that work today

`#2473` (merged, in tree) does **not** refuse oversized turns. It sizes the WS
`response.create` frame against `CODEX_WS_CREATE_FRAME_LIMIT_BYTES` = 16 MiB − 64 KiB
and **falls back to HTTP SSE** (`src/server/responses/ws-upstream.ts:152-167,199-201`).
`tests/ws-upstream.test.ts:692` records the measured backend close at ~16,777,300 B
with 16,777,000 B completing.

So with the PR's default and no configuration:

| Body size | Today | After #3142 |
|-----------|-------|-------------|
| 15 MiB — 16 MiB−64 KiB | WS-eligible, succeeds | local 413 |
| 16 MiB−64 KiB — ~16.7 MB | HTTP SSE fallback, succeeds | local 413 |
| > ~16.7 MB (ChatGPT) | upstream failure | local 413 (better message) |

The first two rows are **working requests that start failing**. That is a
regression for users who configured nothing, and it directly violates the
standing criterion that every capability is opt-in and defaults to today's
behavior.

### The refusal shape may also be worse than today

`#3177` (in tree, not in the PR's base) rewrites a provider HTTP 413 on a
streaming Responses turn into `response.failed` / `context_length_exceeded`
(`src/server/responses/context-overflow.ts:19-26`, `core.ts:4529-4533`), so Codex
treats it as terminal overflow and compacts. The PR returns
`formatErrorResponse(413, ...)` JSON instead, which for a streaming client is a
retryable transport error — Codex may resend the same oversized body. The PR's
stated goal is to stop exactly that loop.

### It does not close #2511

#2511 asks for a **per-provider, default-off** budget that **downscales** images
then **prunes** oldest-first with a visible marker. #3142 is top-level,
default-on, and refusal-only. `closingIssuesReferences` is empty and the PR body
never mentions #2511 — correctly. These are different products; #3142 must not
be recorded as closing it.

## Disposition: reimplement, default-off

The measurement, the local 413 shape, the image diagnostics, the body-observation
release and the lease fix are all good work and are kept. One thing changes: the
guard is **off unless configured**.

That is a stronger answer than the requested canonical-only default, and it
resolves @Ingwannu's blocker a fortiori:

- no destination — canonical, Azure, or custom — inherits a ceiling measured
  somewhere else;
- the #2473 HTTP fallback band keeps working;
- it matches the shape #2511 actually asked for, so the two stop contradicting;
- an operator who has hit the wall sets one integer and gets the diagnostic.

The cost is that the diagnostic is not on by default. That is the correct trade:
a default that breaks working requests to improve an error message is not a
default, it is a regression with a nicer string.

## File change map

| File | Action | Change |
|------|--------|--------|
| `src/server/responses/outbound-body-guard.ts` | NEW | `checkOutboundBodySize`, `describeOutboundBodyRefusal`, image diagnostics. `limitBytes` undefined or 0 admits without measuring. No `DEFAULT_MAX_UPSTREAM_BODY_BYTES`. |
| `src/types/config.ts` | MODIFY | `maxUpstreamBodyBytes?: number` with JSDoc naming the native-Responses-passthrough scope and the default-off contract |
| `src/config.ts` | MODIFY | zod: optional non-negative integer |
| `src/server/responses/core.ts` | MODIFY | `refuseOversizedOutboundBody` inside the passthrough branch; guard at initial build, `rebuildAndRefetch`, OAuth-refresh rebuild, alternate-account retry, **and the 401 replay rebuild the PR missed** (`core.ts:4071-4080` on PR head); release body observation, host admission and probe lease; release `firstAuthCtx` when `deferFirstOutcome` |
| `src/server/request-log.ts` | MODIFY | `outbound_body_too_large` error code |
| `docs-site/.../providers.md` | MODIFY | document the key, default-off, and the passthrough-only scope |
| `tests/outbound-body-guard.test.ts` | NEW | threshold crossing, UTF-8 byte counting, unparseable body, undefined and 0 both admit |
| `tests/empty-completion-core.test.ts` | MODIFY | integration: configured limit refuses with 0 fetches and 1 observation release; **omitted key sends a 20 MiB body upstream unrefused** |

## Scope boundary

IN: the guard, its activation sites including the missed 401 replay, default-off,
docs, focused tests.

OUT: image downscaling and oldest-first pruning (#2511's actual request) — a
separate feature that mutates request content and needs its own cycle. OUT:
changing the refusal into a `streamingContextOverflowResponse`; worth doing but
it is #3177's contract and belongs with that code, and with the guard off by
default the retry-loop concern no longer rides on this change.

## Accept criteria

1. **Omitted config sends an oversized body upstream.** Activation: integration
   test with no `maxUpstreamBodyBytes` and a body far above 15 MiB asserting the
   fetch happened. This is the regression the PR would have shipped.
2. Configured limit refuses with a local 413, zero upstream fetches, and the body
   observation released. Activation: existing integration case.
3. `0` admits without measuring.
4. Refusal names the image count and approximate decoded megabytes when the body
   parses. Activation: unit assertion on the message.
5. Every rebuild site is guarded, including the 401 replay.

## Verifier

`bun x tsc --noEmit` (exit 0 baseline confirmed) plus
`bun test tests/outbound-body-guard.test.ts tests/empty-completion-core.test.ts`.
Full suite forbidden by the operator.
