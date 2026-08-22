# 020 — Fix #1024: Custom-provider vision capability 3-state

## 문제
custom provider의 vision 능력이 모호할 때:
- catalog normalization이 unknown → ["text"]로 변환 (parsing.ts:313)
- request-time은 noVisionModels만 봄 (vision/index.ts:271)
- 같은 모델이 catalog에서는 text-only, runtime에서는 native-vision 취급

## 코드 경로 (6개 레이어)
1. routing/capability.ts:162 — 이미 tri-state 지원 (true/false/undefined)
2. generated/model-metadata.ts — custom provider는 metadata 없음
3. catalog/provider-fetch.ts:940 — live discovery에서 undefined 유지
4. catalog/parsing.ts:313 — ⚠️ unknown → ["text"]로 폴딩
5. vision/index.ts:271 — noVisionModels만 체크
6. vision/eligibility.ts:112 — sidecar용 tri-state는 있음

## 수정 계획 (최소 범위)
### 핵심: parsing.ts:313의 폴딩 제거
- preserveExactInputModalities 옵션이 아닌 경우에도 unknown을 보존
- 대신 catalog serialization 시에만 default 적용

### vision/index.ts 수정
- noVisionModels 대신 modelInputModalities도 참조
- unknown일 때는 보수적으로 이미지 전달 (기존 동작 유지)

### 검증
- tests/vision-eligibility.test.ts
- tests/catalog-vision-sidecar-modalities.test.ts

