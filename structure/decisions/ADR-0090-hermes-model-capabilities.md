# ADR-0090 — Hermes Model Capabilities

- Contract owner: [clients/integrations.md](../clients/integrations.md#hermes-model-capabilities)

## Decision record

- 목적과 의도: Preserve catalog-backed image routing when Hermes uses OpenCodex as a custom provider.
- 기존 구현 및 제약 조건: A string array preserved model selection but normalized to empty metadata in Hermes, while OpenCodex has authoritative text/image/audio facts but no video fact.
- 검토한 주요 대안: Keep the array; mark every model vision-capable; infer video from model names; emit a per-model metadata map from declared modalities.
- 선택한 방식: Emit a stable per-model map and include only the `supports_vision` boolean that the catalog can prove.
- 다른 대안 대신 이 방식을 선택한 이유: The map is the Hermes-supported capability boundary, while guesses would misroute attachments or advertise unsupported video.
- 장점, 단점 및 영향: Vision-capable custom models route correctly and text-only rows stay explicit; unknown rows remain unknown, and video routing waits for authoritative source metadata.
