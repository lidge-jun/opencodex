# ADR-0086 — Public provider contract

- Contract owner: [providers/openai-tiers.md](../providers/openai-tiers.md#public-provider-contract)

## Decision record

- 목적과 의도: Keep an explicit healthy main selection from being replaced by an exhausted stored
  account merely because the client supplied main through a request-owned keyring bearer.
- 기존 구현 및 제약 조건: Request-owned credentials are deliberately excluded from stored-account
  entitlement discovery, but shared-state preservation interpreted that exclusion as a dead main login.
- 검토한 주요 대안: Persist the caller credential, read the physical main token for identity, ignore
  the manual pin, or validate the caller independently before stored-Pool selection.
- 선택한 방식: Use only the effective pin, pause state, cached quota, and the caller credential's own
  gated-model check; synthesize shared-state liveness only while main stays request-ineligible.
- 다른 대안 대신 이 방식을 선택한 이유: It preserves credential isolation and explicit operator
  intent without admitting an unentitled model or binding an ephemeral bearer into durable Pool state.
- 장점, 단점 및 영향: Healthy main pins survive keyring requests and model-only detours; cached quota
  remains the only proactive drain evidence available without crossing the physical credential boundary.
