# L4 — Responses terminal, reasoning payload and media

Delivery lane R1-L4. One branch (`codex/260914-l4-responses-media`), one PR against `dev`.

## Units

| Unit | Issue | Write scope |
|---|---|---|
| U1 | #4469 reasoning `encrypted_content` not issued to this caller | `src/server/responses/core.ts`, `tests/responses/responses-opaque-blob-recovery.test.ts` |
| U2 | #4312 Anthropic content_filter terminal reported as retryable | `src/adapters/anthropic.ts`, `tests/adapters/anthropic/anthropic-error-stop-reason.test.ts` |
| U3 | #4532 image downscaling on append busts the prefix cache | `src/adapters/anthropic-image-codec.ts`, `src/adapters/anthropic-image-normalize.ts`, `tests/adapters/anthropic/anthropic-image-normalize.test.ts` |
| U4 | #4311 paginated Codex history stops projecting | `src/codex/history-provider.ts`, `tests/codex-integration/codex-history-provider.test.ts` |
| U5 | `structure/` SSOT sync for the source areas U1-U4 touch | `structure/*.md` |

Write scopes are disjoint so concurrent subagents never share a file. No new test
files: each regression lands in the existing domain test file, which keeps
`scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`
untouched and avoids a shared-file collision.

## U1 — #4469

`isSelfIdentifiedOpaqueBlobRejection` in `core.ts` recognises three rejection
identities: the nested `invalid_encrypted_content` code, one exact code-less
ChatGPT "could not be verified" message, and two xAI `invalid-argument` decoder
strings. The reported body is none of them — it is
`invalid_request_error` carrying "reasoning \`encrypted_content\` was not issued to
this caller". The detector returns false, `attemptOpaqueBlobRecovery` skips, and the
caller sees a hard error for replay state the backend will never accept.

Fix: add that identity to the detector so the existing recovery
(`prepareOpaqueBlobRecovery` → rebuild → single replay) engages. Recovery machinery,
the one-attempt guard, and the rejection memo are unchanged.

## U2 — #4312

`src/adapters/anthropic.ts` maps stop_reason `refusal`/`content_filter` to a
`done` event with `stopReason: "content_filter"`. The bridge turns that into
`response.incomplete` with no `retryable` field, so Codex reads a disconnected
stream and retries a request that can never succeed.

Fix: emit an explicit `incomplete` adapter event with `reason: "content_filter"`
and `retryable: false`. The bridge's `incomplete` case already forwards
`retryable` into `incomplete_details` — the same mechanism a prior fix used for
`cyber_policy`. Partial output survives because the bridge emits the retained
finished items. The provider's refusal stays explicit; nothing is rerouted and no
false success is reported.

## U3 — #4532

`initialPosition(newestFirstIndex, bias)` derives an image's ladder position from
its RELATIVE recency, so appending an image pushes every older image one slot
toward the tail. Crossing a tier boundary re-encodes already-sent bytes and
invalidates Anthropic's prompt prefix cache.

Fix: pin the ladder position to image identity. A bounded store keyed by
`hash:mediaType` records the position an image was last emitted at; later turns
start from that recorded position instead of recomputing it from age. Positions
only ever move down the ladder (aggregate demotion, 413 tier bias), so the store is
monotonic and cannot flap. The age-tier pyramid still assigns a FIRST position, the
byte budget still binds, and the 413 retry path is untouched.

## U4 — #4311

The external-append guard landed on `dev` in `7f76d736c2`: `updateSessionMeta`
and `assertLegacyHistoryWritable` refuse a rollout whose record carries an
`ordinal` or `history_mode: "paginated"`. Verify the refusal actually covers every
append path this issue names and close the remaining gap; do not allocate an
ordinal, and do not rewrite a live rollout.

## Proof

Hosted CI at the exact final head. Local suite, typecheck, install and GUI build are
NOT RUN for this unit by explicit instruction.
