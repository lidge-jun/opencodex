# ADR-0088 — decision recorded under "Model and wire identity"

- Contract owner: [providers/openai-tiers.md](../providers/openai-tiers.md#model-and-wire-identity)

## Decision record

- 목적과 의도: Prevent account-gated native models from being shown or dispatched through a
  ChatGPT account that upstream does not authorize.
- 기존 구현 및 제약 조건: A static global Daybreak row solved clean-install discovery for
  entitled accounts, but Pool accounts can hold different grants and Codex's injected catalog does
  not refresh itself.
- 검토한 주요 대안: Infer grants from plan labels, learn only from prompt failures, bind Daybreak
  permanently to main, or rewrite the wire id to `gpt-5.6-sol`.
- 선택한 방식: Share bounded authenticated per-account model-roster evidence between catalog sync,
  `/v1/models`, and Pool auth selection.
- 다른 대안 대신 이 방식을 선택한 이유: Plan labels and account position do not prove a grant;
  failure-only learning wastes a turn; permanent main binding rejects valid secondary grants; wire
  rewriting changes the requested product identity.
- 장점, 단점 및 영향: Entitled accounts retain clean-install discovery while unentitled accounts
  never receive the gated dispatch. A cold gated request may pay one bounded roster fetch per
  account, and an unavailable discovery temporarily hides the model rather than guessing.
