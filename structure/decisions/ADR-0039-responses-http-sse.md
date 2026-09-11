# ADR-0039 — Responses HTTP/SSE

- Contract owner: [transports/responses.md](../transports/responses.md#responses-httpsse)

## Decision record

- 목적과 의도: Keep a session usable after its history crosses backends, instead of wedging it on a
  compaction blob the current upstream cannot decode.
- 기존 구현 및 제약 조건: Compaction handling was binary — `ocx1:` envelopes were ours, everything
  else was treated as a native blob and gated only by the destination, even though multiple backends
  mint mutually incompatible blobs. Response-side field backfill exempted only `compaction`, so its
  two sibling types received synthesized ids the client then replayed.
- 검토한 주요 대안: Tag every compaction item with its minting provider/credential/model identity;
  drop compaction items on any route change; gate relay on the destination that would decode them.
- 선택한 방식: Reuse the thread's recorded serving identity to degrade native blobs after a known
  route change; otherwise retain the destination capability gate, and treat the compact wire family
  as one enumeration so id-bearing passes cannot diverge per type.
- 다른 대안 대신 이 방식을 선택한 이유: Full per-item provenance tagging is unnecessary when the
  existing thread identity proves a route change, while dropping the item would silently discard
  compacted context and widening unknown-identity behavior needs a separate decision.
- 장점, 단점 및 영향: A cross-backend session degrades one compaction summary to a note instead of
  failing every later turn. A self-hosted OpenAI relay keeps its blobs only when explicitly opted in;
  other routed gateways see a note because routed compaction produces an `ocx1:` envelope.
