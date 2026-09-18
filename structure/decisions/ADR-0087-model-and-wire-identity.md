# ADR-0087 — decision recorded under "Model and wire identity"

- Contract owner: [providers/openai-tiers.md](../providers/openai-tiers.md#model-and-wire-identity)

## Decision record

- 목적과 의도: Preserve the account-gated Daybreak UX while avoiding shard-dependent selector
  rejection and the unsupported prompt-cache retention parameter.
- 기존 구현 및 제약 조건: The authenticated roster grants Daybreak, but live successful
  responses report `gpt-5.6-sol`; the selector can still fail eight consecutive times.
- 검토한 주요 대안: Increase retries indefinitely, hide Daybreak entirely, or canonicalize only
  the credential-bearing wire model after entitlement selection.
- 선택한 방식: Keep Daybreak for visibility and account authorization, then send the stable
  serving id and remove only the unsupported optional retention hint.
- 다른 대안 대신 이 방식을 선택한 이유: It keeps fail-closed entitlement checks and avoids
  unbounded duplicate requests while preserving the user-facing model choice.
- 장점, 단점 및 영향: Requests become deterministic and cheaper; this relies on the serving id
  observed from successful upstream responses and must be revisited if the roster exposes a
  first-class wire id later.
