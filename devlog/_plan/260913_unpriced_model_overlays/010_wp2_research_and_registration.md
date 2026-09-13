# 010 — wp2: 병렬 조사 + overlay 등재

## 목표

001 inventory의 각 모델에 대해 verified/verified-derived 출처를 확보하거나
not-published/unverified 사유를 기록하고, 확보된 것만 expected-prices.ts에 등재.

## 서브에이전트 레인 (병렬, 상속)

| lane | 대상 | 방법 |
|---|---|---|
| zai | GLM 14종 + glm-5.3-flash | Aside repl/exec로 docs.z.ai + bigmodel.cn 가격 페이지 열람 |
| google-gemma | gemma 8종(gemma-3-27b-it + gemma-4 계열 7종) | 공식 Gemini API pricing에서 Gemma 과금 여부 확인 |
| cerebras | qwen-3-coder-480b, zai-glm-4.6 | cloud.cerebras.ai pricing 열람 |
| mistral | labs-devstral-small-2512 | mistral.ai pricing / docs 열람 |
| xai | grok-composer-2.5-fast | docs.x.ai pricing 재검증 |
| openrouter | auto/alpha/free 7종 | openrouter.ai 모델 페이지 확인 |

## 등재 규칙 (003 정책 계승)

- verified: 공식 페이지 직접 열람한 4튜플.
- verified-derived: 검증된 기반 모델 가격의 매핑(estimated 전파).
- unverified/not-published: 등재 금지, devlog에 사유만.
- 구독 전용 표면(zai coding plan 등)은 벤더 정가가 있으면 verified-derived로
  "list price estimate" 등재 가능 — 003의 anthropic→antigravity 선례.
- source 문자열에 URL + 확인 날짜 + 주의사항.
- per-provider 등재: overlay lookup은 exact provider+model이라 zai bundle에 등재해도
  zhipu-bigmodel / zhipu-bigmodel-coding / zhipu-bigmodel-responses 표면은 커버되지 않는다.
  kimi/moonshot/kimi-code 선례처럼 노출하는 provider id마다 행을 둔다.
  PROVIDER_ALIASES에 zai/cerebras/mistral 키가 없어 이들 provider는 bundle exact lookup에
  도달하지 못하므로 overlay가 유일한 가격 소스다.

## 파일 변경

- MODIFY src/usage/expected-prices.ts — 상수 + EXPECTED_PRICE_OVERLAYS 행 추가.
- MODIFY tests/usage/usage-cost.test.ts — "16. shipped overlay membership" 카운트 갱신
  + 신규 키 멤버십 추가.
- MODIFY devlog/_plan/260913_unpriced_model_overlays/ — 조사 결과 evidence.

## 검증

- 로컬 스위트 실행 금지(사용자 지시). 검증은 호스티드 CI exact-head.
- 등재 후 node .tmp/scan-unpriced2.mjs 재실행으로 all-zero 감소분 확인(읽기 전용).
