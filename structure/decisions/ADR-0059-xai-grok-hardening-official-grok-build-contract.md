# ADR-0059 — decision recorded under "xAI Grok hardening (official Grok Build contract parity)"

- Contract owner: [providers/xai-grok.md](../providers/xai-grok.md#xai-grok-hardening-official-grok-build-contract-parity)

## Decision record

- 목적과 의도: Prevent Grok Build from classifying a visibly streamed answer as empty and replaying
  the same billable turn when the terminal snapshot is sparse.
- 기존 구현 및 제약 조건: OpenCodex already reconstructed missing terminal output for provider
  opt-ins, but preserved explicit empty arrays; Grok Build discarded ordinary completed-item events
  when constructing its final conversation response.
- 검토한 주요 대안: Change every caller's empty-array semantics; accept a turn merely because a
  text delta was visible; reuse the provider's broader lifecycle synthesis; add a strict repair at
  the generated Grok client boundary.
- 선택한 방식: Use the existing generated client marker to opt Grok into a terminal-only repair and
  backfill only from unique, contiguous, bounded real done items whose raw semantics are valid.
- 다른 대안 대신 이 방식을 선택한 이유: A global rewrite would alter valid provider semantics,
  while accepting deltas without durable items would leave persistence and continuation empty. The
  marker is already the client-specific compatibility boundary; keeping the provider repair separate
  also prevents synthesized or permissively normalized items from overriding an explicit empty terminal.
- 장점, 단점 및 영향: Grok receives one durable completed answer without a paid retry; ordinary
  clients remain byte-semantics compatible. The proxy retains bounded item state for marked streams
  and intentionally refuses ambiguous reconstruction.
