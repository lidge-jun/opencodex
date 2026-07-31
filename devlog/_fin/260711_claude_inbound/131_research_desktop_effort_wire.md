# 131 — 조사: Desktop 3P effort wire (Parfit, sol high + cxc-search)

요약 (전부 Tier 2 원문 검증, 상세 인용은 서브에이전트 반환 원문):

## 확정 사실
- effort의 Messages API 위치는 `output_config.effort` (adaptive thinking과 독립).
  `effort:"high"`는 **필드 생략과 동일** — 즉 high에서 필드가 없는 것은 정상.
  https://platform.claude.com/docs/en/build-with-claude/effort
- `thinking.budget_tokens`는 구형 manual 방식. Opus/Sonnet 4.6에서 deprecated,
  4.7/4.8은 거부. adaptive+effort가 현행.
- Desktop 3P `inferenceModels` 스키마 필드: `name`, `labelOverride`, `supports1m`,
  `anthropicFamilyTier`(sonnet|opus|haiku|fable|mythos), `isFamilyDefault`,
  그리고 톱레벨 `modelDiscoveryEnabled`. **effort/thinking 선언 필드는 없다.**
  https://claude.com/docs/third-party/claude-desktop/configuration#models
- Desktop effort selector 공식 지원: Opus 4.8/4.7/4.6, Sonnet 4.6 (allowlist 성격).
  https://support.claude.com/en/articles/8664678
- **`/v1/models` 표준 스키마에 capability 선언이 존재**: `capabilities.effort.{low,medium,high,max}`
  (+ `xhigh` nullable), `capabilities.thinking.types.{adaptive,enabled}`, 각 항목 `{supported:boolean}`.
  ModelInfo 필수 필드: `id`, `capabilities|null`, `created_at`(RFC3339), `display_name`,
  `max_input_tokens|null`, `max_tokens|null`, `type:"model"`.
  anthropic-sdk-typescript@9e46760 src/resources/models.ts L60-L245 (로컬 재검증 완료).
- Claude Code changelog: 비표준 model id가 `output_config.effort`를 못 받던 버그를
  수정한 전례 2건 (2026-03-06, 2026-04-28) — id/capability 판정이 effort 전송을 좌우한다는 방증.

## 판정
- `anthropicFamilyTier:"opus"`만으로 effort UI가 열린다는 근거 없음 (현재 우리 상태와 일치:
  high/xhigh만 관측).
- 가장 유망한 개입: **우리 /v1/models 응답을 ModelInfo 전체 형태로 승격**하고 라우팅 모델의
  effort ladder를 `capabilities.effort`로 광고 → Desktop/CLI가 소비하는지 실험 (미확정, 실험 필요).
- 검증 순서: capabilities 광고 → 사용자 Desktop 재시작 → 슬라이더 low→max → B1 캡처 링에서
  `output_config.effort` 원문 확인.

## 미해결
- Desktop이 /v1/models capabilities를 실제 소비하는지 (실험으로 판정).
- 수동 inferenceModels 사용 시 discovery metadata가 무시되는지 여부.
