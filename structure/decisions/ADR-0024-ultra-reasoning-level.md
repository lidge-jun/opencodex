# ADR-0024 — decision recorded under "Ultra reasoning level"

- Contract owner: [catalog.md](../catalog.md#ultra-reasoning-level)

## Decision record

- 목적과 의도: Xiaomi token-plan에서 image input을 거부하는 `mimo-v2.5-pro`만 vision
  sidecar로 우회하고, 실제 image input을 받는 `mimo-v2.5`는 native vision 경로에 남긴다.
- 기존 구현 및 제약 조건: upstream `/v1/models`는 input modality를 제공하지 않으며,
  `noVisionModels`는 text-only 모델을 sidecar로 보내면서 Codex catalog에는 image input을
  광고하는 provider-scoped 계약이다.
- 검토한 주요 대안: MiMo 전체를 text-only로 분류하기, live discovery에서 modality를
  추측하기, `mimo-v2.5-pro` 하나만 registry에 고정 분류하기.
- 선택한 방식: canonical `mimo` preset의 `noVisionModels`에 `mimo-v2.5-pro`만 추가한다.
- 다른 대안 대신 이 방식을 선택한 이유: live endpoint 검증으로 확인된 최소 범위만
  적용하며, 정상 동작하는 `mimo-v2.5`의 native image 경로를 훼손하지 않는다.
- 장점, 단점 및 영향: Pro image 요청의 404를 sidecar 설명 경로로 바꾸고 base 모델은
  그대로 유지한다. `preserveCustomDestination` guard 때문에 같은 provider id를 다른 host에
  연결한 사용자 설정에는 이 capability 분류가 전파되지 않는다.
