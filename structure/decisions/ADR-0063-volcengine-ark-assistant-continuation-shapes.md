# ADR-0063 — Volcengine Ark assistant continuation shapes

- Contract owner: [providers/chat-compat.md](../providers/chat-compat.md#volcengine-ark-assistant-continuation-shapes)

## Decision record

- 목적과 의도: Preserve multi-turn tool-call continuations across both Ark Chat endpoint families.
- 기존 구현 및 제약 조건: The #796 workaround was host-wide and unverified; live Coding Plan evidence shows its structured placeholder returns HTTP 400 while an empty string succeeds.
- 검토한 주요 대안: Remove the workaround globally, select by model ID, or scope it by endpoint path.
- 선택한 방식: Apply the structured placeholder only to recognized Ark hosts whose normalized base path is exactly `/api/v3`.
- 다른 대안 대신 이 방식을 선택한 이유: Global removal would reopen #796, while model IDs can appear behind multiple Ark products and therefore do not identify the wire contract.
- 장점, 단점 및 영향: Coding Plan regains its accepted continuation shape without changing generic providers; any future Ark endpoint family must provide evidence before inheriting the pay-as-you-go quirk.
