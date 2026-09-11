# 004 — 자문·감사 라운드 원문 기록

## 라운드 1 — 아키텍트 (grok-4.6, 읽기 전용)

판정: `ALIGNED if Main keeps the six slices below, keeps #4258 out of scope, and treats (i)/(ii) as the two judgment calls rather than as new subsystems. MISALIGNED if Main seeds noStructuredOutputModels as a registry field, invents live-id facts, or reopens landed transport/cache work.`

핵심 반박 (main 수용):

> Treat the community report as "users are disabling structured output entirely to escape a json_schema 400," not as proof that json_object is also rejected. … Live probe: impossible in this unit. Therefore we must not promote a full structured-output ban into the seed tables.

main 처분: **수용.** 010을 `noJsonSchemaModels` 좁은 계약으로 다시 썼다. 다만 아키텍트가 제안한 "어댑터에서 provider id로 분기" 방식은 채택하지 않았다 — 이 저장소의 관용은 프로바이더 설정 필드가 어댑터 동작을 구동하는 것이고, 어댑터에 프로바이더 id를 박으면 새 결합이 생긴다.

## 라운드 2 — 독립 감사 2레인

두 레인 모두 `VERDICT: near-pass`.

### 레인 A (상속 모델)

- 배선: `선례가 noPenaltyModels로 완결돼 있다: registry.ts:323 → router.ts:351 병합 + router.ts:475 emit → openai-chat.ts:134`
- 지적: `142는 delete 후 downgrade가 다시 넣지 않도록 else-if 순서를 명시해야 한다 — 계획에 순서 언급이 없다`
- 지적: `라인 드리프트: 실제 게이트는 registry.ts:1773, 사다리는 1753(문서의 1755/1771 아님)`
- 지적: `G2 — 판단이 약하다. 같은 엔트리 registry.ts:3076이 이미 "같은 게이트웨이·같은 로스터"를 근거로 free에 공유 text-only 목록 전체를 싣는 선례(#1043)다`
- 지적: `000_plan 첫 문단 "세 프리셋은 로스터를 live /models로 받지만" — liveModels는 free만(registry.ts:3049)`

### 레인 B (grok-4.6)

- 지적: `010 상단 파일지도는 구설계(noStructuredOutputModels 시드)라 수정절과 충돌한다`
- 반대 의견: `G2 타당. live 로스터에 paid id 증거가 없고, zen처럼 paid id를 넣으면 없는 모델을 광고한다`
- 두 레인 공통: `#4258 교집합 없음`

## 불일치 처분 — G2

레인 B의 "없는 모델을 광고한다"는 부정확하다. 능력 표는 카탈로그 로스터를 만들지 않는다: `applyProviderConfigHints`는 이미 로스터로 들어온 id만 장식한다(`src/codex/catalog/provider-fetch.ts:766,799`). 로스터는 live `/models` 또는 정적 `models:` 배열에서 나오고, 세 프리셋은 정적 배열이 없다. 따라서 등장하지 않는 id를 능력 표에 시드해도 광고는 발생하지 않는다.

레인 A의 선례가 더 강하다. main은 레인 A를 채택한다.

## 실패한 레인 기록

GitHub 트리아지 레인과 1차 리뷰어 레인은 grok-4.6에서 턴이 `completed` 로 끝나면서 최종 메시지가 비는 증상으로 각각 두 번 실패했다(중간 commentary만 남음). 은퇴시키고 해당 작업은 main이 직접 수행했다. 같은 모델의 아키텍트·감사 레인은 한 번 재촉 후 정상 산출했으므로 모델 전면 배제는 하지 않았다.
