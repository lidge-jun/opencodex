# ADR-0092 — ZCode Runtime Metadata

- Contract owner: [clients/integrations.md](../clients/integrations.md#zcode-runtime-metadata)

## Decision record

- 목적과 의도: Allow ZCode's documented runtime normalization without turning genuine provider or connection edits into refreshable drift.
- 기존 구현 및 제약 조건: The classifier hashed the whole `provider.opencodex` fragment. That was safe for ordinary JSON clients but made every ZCode save a permanent foreign edit. Refresh and disable both depend on the same ownership proof.
- 검토한 주요 대안: Ignore all model metadata; compare only the provider connection envelope; hard-code a ZCode branch directly in `state.ts`; store explicit operation-scoped mutable paths and a protected fingerprint.
- 선택한 방식: Keep the strict generated contribution hash, add a separate protected fingerprint, and persist the exact ZCode-derived paths with each ownership record through a client-scoped policy module.
- 다른 대안 대신 이 방식을 선택한 이유: Ignoring all model metadata would allow user model edits to be overwritten. Comparing only the connection envelope would stop protecting model membership and capabilities. A state-only special case would disagree with writer behavior. Operation-scoped paths preserve the original grant across later catalog changes.
- 장점, 단점 및 영향: Normal ZCode saves become refreshable, connection edits still fail closed, and later catalog refreshes remain possible. Legacy records with simultaneous catalog drift still require a conservative manual recovery because the old schema did not store enough evidence.
