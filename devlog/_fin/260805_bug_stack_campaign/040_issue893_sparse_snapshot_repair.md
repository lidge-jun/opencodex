# 040 — Issue #893: sparse lifecycle snapshots Codex clients never commit

core.ts cluster 2/3. Research: explorer batch D.

## Verified current state

- Client SSE composes only image restore + item-ID repair:
  `src/server/responses/core.ts:1967,1971`; rewrite enters eager and tee
  relays (`core.ts:2018,2115`); non-stream JSON is inspected raw then only
  image-restored (`core.ts:2142`).
- The rewrite contract is one-payload-in/one-payload-out and cannot inject
  events: `src/server/sse-payload-rewrite.ts:10`, `src/server/relay-eager.ts:36`.
- Codex does not commit text without closing events (`src/bridge.ts:509`);
  canonical message lifecycle: `output_item.added` → `content_part.added` →
  `output_text.delta` → `output_text.done` → `content_part.done` →
  `output_item.done` → `completed` (`bridge.ts:838,517,1130`).
- The issue fixture (`created → output_item.added → output_text.delta →
  completed`) lacks `content_part.added` and all three closing events.

## Diff-level plan

ADD `src/server/responses-snapshot-repair.ts` — provider-opt-in state
machine: repair lifecycle snapshot fields, track unambiguous open
message/reasoning items + accumulated text, expand one upstream event into
zero-or-more canonical client events.

MODIFY `src/types.ts` — `responsesSnapshotRepair?: boolean` beside
`responsesItemIdRepair`. MODIFY `src/config.ts` — strict optional boolean.
MODIFY `src/server/auth-cors.ts` — permit the option on canonical OpenAI
pool/direct writes without weakening seed/custom-forward restrictions.

MODIFY `src/server/sse-payload-rewrite.ts` — preserve `SsePayloadRewrite`;
add a block/event rewrite contract that can emit multiple SSE blocks with
correct `event:` names; untouched events stay byte-identical.

MODIFY `src/server/relay-eager.ts` — accept the block/event rewriter;
inspection keeps receiving raw chunks pre-rewrite.

MODIFY `src/server/responses/core.ts` — include the opt-in in
`needsClientRewrite`; compose image restore → item-ID repair → lifecycle
repair in both eager and tee branches; JSON snapshot repair only after raw
inspection + continuation persistence.

Synthesis policy: backfill lifecycle snapshot fields (`status`, `output`,
`parallel_tool_calls`, `tool_choice`, `tools` from request values); message
items get `status`/`role`/`content`; reasoning gets `summary`; inject
`content_part.added` after a repaired item-added; inject
`output_text.done`/`content_part.done`/`output_item.done` immediately before
`response.completed`; reconstruct terminal `output` only when absent —
explicit `output: []` is authoritative. Ambiguous/gapped/malformed/oversized
or contradictory shape → fail closed to canonical empty output, release
retained budget. Bounds reuse existing relay collector limits + translator
budget.

## Contributor PR equivalence

- #928 (`6261d3dc`): strong source for config shape, field backfills, JSON
  path, explicit-empty preservation, bounds. NOT equivalent to a proven fix:
  its exact-issue test expects no `output_item.done` and terminal
  `output: []` — normalization, not commitment. Unproven collapse
  hypothesis: if real Codex activation shows a canonical empty terminal
  snapshot commits the stream, the implementation collapses to the narrower
  field-only design.

## Tests / activation

Primary fixture: the exact issue stream → client sees the full canonical
sequence and one committed assistant message `"hello"`, terminal `output[0]`
matching the done item. Feed the repaired stream into the Codex-facing
lifecycle consumer (not JSON-shape assertions only); real Codex CLI/App
against a fake gateway shows the final answer and a successful continuation.

Matrix: opt-in false byte-passthrough; explicit `output: []` preserved;
valid/future fields preserved; missing vs malformed field tables; message /
reasoning / function-call / multi-item streams; ambiguous items fail closed;
duplicate done events don't double-close; bounds/budget release on
completed/failed/incomplete; cancellation; malformed JSON; EOF; eager/tee
parity incl. Windows; composition with image restore + item-ID repair; JSON
mode field repair without altering raw inspection.

ADD `tests/responses-snapshot-repair.test.ts`; extend
`tests/sse-payload-rewrite.test.ts`, `tests/relay-eager.test.ts`,
`tests/config.test.ts`, `tests/management-provider-validation.test.ts`; five
provider-config locale docs.

## Accept criteria

- Primary fixture + Codex lifecycle consumer test pass; eager/tee parity.
- Gates as 030.
