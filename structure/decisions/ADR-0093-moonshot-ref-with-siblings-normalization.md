# ADR-0093 — Moonshot `$ref`-with-siblings normalization

- Contract owner: [adapters/registry.md](../adapters/registry.md#moonshot-ref-with-siblings-normalization)

## Decision record

- 목적과 의도: Codex가 내보내는 `$ref` + 형제 키워드 스키마를 Moonshot이 받아들이는 형태로
  바꾸되, 도구가 실제로 요구하는 제약을 잃지 않는다.
- 기존 구현 및 제약 조건: JSON Schema 2020-12에서 `$ref`는 in-place applicator라 형제
  키워드와 함께 적용된다. Moonshot은 이를 거부하므로 참조 대상을 노드 아래로 인라인해야 하고,
  재귀 스키마는 유한해야 하며, 어댑터는 요청 경로에 있으므로 지연이 그대로 사용자에게 간다.
- 검토한 주요 대안: (1) 형제 키워드를 버리고 순수 `$ref`만 남긴다. (2) 참조를 인라인하되
  형제 키워드가 대상을 덮어쓴다. (3) 인라인하되 집합형 어서션은 합집합으로 합치고 나머지는
  좁히는 쪽이 이긴다. (4) `allOf`로 감싼다.
- 선택한 방식: (3). `required`는 합집합, `properties`는 병합, 나머지 키워드는 노드가 이긴다.
  해석 불가능한 참조는 순수 `$ref`로 남기고, 깊이·노드·확장 예산을 각각 둔다.
- 다른 대안 대신 이 방식을 선택한 이유: (1)은 노드가 좁힌 제약을 통째로 버린다. (2)는 대상이
  요구하던 `a`를 형제의 `b`가 덮어써서, 양쪽 어느 쪽도 요청하지 않은 더 약한 계약을 조용히
  내보냈다 — 리뷰가 지적한 정확한 결함이다. (4)는 Moonshot이 `allOf`를 어떻게 다루는지
  확인된 근거가 없어 검증되지 않은 가정을 계약으로 만든다.
- 장점, 단점 및 영향: 도구 계약이 보존된 채 Moonshot을 통과한다. 인라인은 대상을 복제하므로
  큰 정의를 여러 노드가 참조하면 출력이 커질 수 있고, 예산이 소진되면 해당 노드는 빈 객체나
  순수 `$ref`로 닫힌다 — 약해진 스키마를 절반만 내보내는 것보다 낫다. Moonshot 계열
  `openai-chat` baseUrl에만 적용되고 다른 provider는 손대지 않는다.
