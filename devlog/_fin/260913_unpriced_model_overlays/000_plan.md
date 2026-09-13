# 000 — 가격 미등록 모델 전수조사 로드맵 (2026-09-13)

## Objective

src/generated/model-metadata.ts의 cost 필드가 전부 0(또는 absent)인 모델을 전수조사하고,
기존 검증 데이터(devlog/_fin/260720_toks_speed_price_columns/003 등)가 있으면 재사용,
없으면 Aside 브라우저 조사로 공식 출처를 확보해 src/usage/expected-prices.ts의
EXPECTED_PRICE_OVERLAYS / VERIFIED_PRICE_OVERRIDES에 등재한다.
PR 생성 → 호스티드 CI → 머지까지 완료한다.

## Constraints (user-declared)

- 로컬 스위트(bun run test / typecheck / build) 절대 실행 금지. NOT RUN으로 표기한다.
- git push는 --no-verify로 진행한다.
- 검증은 exact-head 호스티드 CI만 신뢰한다.
- 상속 서브에이전트 병렬 파견 무제한 허용.
- unverified 가격은 절대 등재하지 않는다(fail-closed, 003 §4 정책).
- `:free` 접미사 OpenRouter 모델은 $0이 정직한 값 — 별도 조사 없이 유지하거나
  명시적 free 근거를 기록한다.

## Inventory (001 이 확정)

전수 스캔 결과 77행이 all-zero/absent:

| bundle | count | disposition |
|---|---|---|
| zai | 14 | Z.AI 공식 가격 조사 필요 (GLM Coding Plan = 구독, bigmodel.cn = PAYG) |
| openrouter | 48 | 대부분 `:free`($0 정직) + alpha/auto/free 등 비과금 — 소수만 확인 |
| google | 10 | gemini-3.7/3.8-flash는 overlay에 이미 존재(google 표면) — gemma 계열 무료/미공개 확인 |
| cerebras | 2 | Cerebras 공식 가격 조사 |
| mistral | 1 | labs-devstral-small-2512 — Mistral 가격 조사 |
| moonshot | 1 | kimi-k2.5 — KIMI_K25 상수가 이미 존재 (0.6/3/0.1/0.6), moonshot 번들 등재 검토 |
| xai | 1 | grok-composer-2.5-fast — 003에서 not-published 확인, 재검증만 |

## work-phase map

- wp1 (이 문서 + 001): inventory 확정 + 로드맵. docs-only.
- wp2 (010): 벤더별 병렬 조사 → overlay 등재 + 커밋.
- wp3 (020): PR → 호스티드 CI → 머지.

## Out of scope

- model-metadata.source.json 재생성(상류 스냅샷 교체는 별도 단위).
- 구조 변경, 신규 provider 추가.
- 로컬 테스트 스위트 실행(사용자 금지).
