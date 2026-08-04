# WP2: #223 Reasoning Clamp → dev cherry-pick + fix

## 배경
PR #223 (Bricol1982, base: main). Codex 0.133.0 strict enum 깨짐 수정.

## Sol 발견 문제점
1. 전부 unsupported ladder일 때 원본 보존 → unsafe
2. probe 실패 시 no-op

## 계획
1. dev catalog.ts에 직접 구현: codexSupportedReasoningEfforts, clampEntryToCodexSupportedEfforts, clampCatalogModelsToCodexSupport
2. loadCatalogForSync deep-clone 수정
3. safe fallback: 전부 unsupported시 low/medium/high 유지
4. syncCatalogModels + /v1/models 양쪽 boundary에 clamp
5. 테스트 추가
6. PR #223 close with credit

## 변경: src/codex/catalog.ts, tests/codex-catalog.test.ts
