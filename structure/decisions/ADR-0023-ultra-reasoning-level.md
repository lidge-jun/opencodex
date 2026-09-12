# ADR-0023 — decision recorded under "Ultra reasoning level"

- Contract owner: [catalog.md](../catalog.md#ultra-reasoning-level)

## Decision record

- 목적과 의도: Xiaomi MiMo의 공식 OpenAI Chat endpoint가 실제로 받지 않는 `max`/
  `ultra` reasoning tier를 catalog에 노출하지 않도록 한다.
- 기존 구현 및 제약 조건: `xiaomi`는 Anthropic endpoint, `mimo`는 token-plan endpoint를
  소유하며, 공식 `https://api.xiaomimimo.com/v1`은 generic custom provider로 처리됐다.
- 검토한 주요 대안: 기존 `xiaomi`/`mimo` contract를 확장하기, 모든 custom provider의 ladder를
  일괄 축소하기, 공식 public endpoint만을 별도 registry row로 소유하기.
- 선택한 방식: `xiaomi-mimo`를 고정 목적지의 `openai-chat` preset으로 등록하고
  `low`/`medium`/`high`만 노출하며 높은 direct request는 `high`로 clamp한다.
- 다른 대안 대신 이 방식을 선택한 이유: 서로 다른 auth/wire/host를 하나의 preset으로
  합치지 않으면서 upstream error로 확인된 계약만 적용할 수 있다.
- 장점, 단점 및 영향: 공식 endpoint에서 안전한 picker/wire 계약을 제공하고,
  `preserveCustomDestination`으로 같은 이름의 다른 host/key를 보호한다. 대신 새 preset 표면을
  문서와 registry parity에서 함께 유지해야 한다.
