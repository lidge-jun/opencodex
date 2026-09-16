# ADR-0085 — decision recorded under "Public provider contract"

- Contract owner: [providers/openai-tiers.md](../providers/openai-tiers.md#public-provider-contract)

## Decision record

- 목적과 의도: Keep Desktop reconnects on the account selected for the App task without persisting
  or exposing its session and thread identifiers.
- 기존 구현 및 제약 조건: Pool affinity used only `x-codex-parent-thread-id`; Desktop requests can
  omit it while stable `session-id` and `thread-id` headers remain available. Exact account
  selectors must stay outside automatic Pool affinity.
- 검토한 주요 대안: Leave reconnects unbound, persist a plain hash, bind from either header alone,
  delete App turn metadata, or derive one process-local key from the complete pair.
- 선택한 방식: Preserve the parent-thread key when present; otherwise HMAC the two bounded headers
  under a random per-process key and carry that opaque value through selection, subagent preview,
  and outcome handling.
- 다른 대안 대신 이 방식을 선택한 이유: A complete pair avoids weak partial identities, a
  process-local HMAC prevents durable correlation or dictionary recovery, and no upstream metadata
  needs to be mutated before the first-403 cause is proven.
- 장점, 단점 및 영향: Reconnects stop rotating among Pool accounts and failure accounting clears
  the correct binding. Affinity intentionally resets on process restart, and requests missing either
  component retain the prior unbound behavior.
