# 001 — Inventory: all-zero cost rows (전수 스캔, 2026-09-13)

스캔: .tmp/scan-unpriced2.mjs — src/generated/model-metadata.ts의 DATA를 파싱해
cost 4필드가 전부 0이거나 absent인 행을 추출. 총 77행.

## zai (14) — 핵심 조사 대상

glm-4.5, glm-4.5-air, glm-4.5-flash, glm-4.5v, glm-4.6, glm-4.6v, glm-4.7,
glm-4.7-flash, glm-5, glm-5-turbo, glm-5.1, glm-5.2, glm-5.3, glm-5v-turbo

기존 근거:
- 003 §3: zai/GLM = unverified (z.ai 가격 URL 오류, bigmodel.cn 확정 불가).
- 003 §5 백로그 1: mistral/cerebras/zai 브라우저 렌더 재조사 대상.
- registry의 `zai` provider는 GLM Coding Plan(구독) — 단가 미공개가 불릴 수 있음.
- zhipu-bigmodel(PAYG, open.bigmodel.cn)이 jawcodeBundle:"zai"를 씀 — PAYG 단가가
  공개돼 있으면 bigmodel 쪽은 verified 가능.
- glm-5.3-flash는 DATA에 없음(registry 수동 시드) — 77행 inventory 밖이지만 overlay는 provider+model exact라 등재 대상에 포함.

## google (10)

gemini-3.7-flash, gemini-3.8-flash — EXPECTED_PRICE_OVERLAYS에 google 표면 verified
행이 이미 존재(2026-08-14/2026-09-03). 번들 all-zero는 overlay가 커버 → 추가 조치 불요.
gemma-3-27b-it + gemma-4 계열 7종(26b, 26b-a4b-it, 26b-it, 31b, 31b-it, E2B-it, E4B-it) — Gemma는 Google 무료/오픈 모델로 과금 단가가 없을
가능성. 확인 후 not-published 기록.

## cerebras (2)

qwen-3-coder-480b, zai-glm-4.6 — 003: cerebras unverified (PAYG 충전/구독 중심,
모델별 단가표 비노출). 재조사.

## mistral (1)

labs-devstral-small-2512 — 003: mistral 동적 렌더로 추출 실패. Aside로 재조사.

## moonshot (1)

kimi-k2.5 — KIMI_K25 = (0.6, 3, 0.1, 0.6) 상수가 이미 존재하고 kimi/kimi-code/moonshot
오버레이에 등재돼 있음. moonshot 번들 행이 all-zero인 것은 overlay가 커버.
→ 조치 불요 또는 번들 등재 검토.

## xai (1)

grok-composer-2.5-fast — 003 §2: not-published (docs.x.ai 미등재, Grok Build 무료).
재검증만.

## openrouter (48)

- `:free` 접미사 41종 — OpenRouter free tier는 $0. 정직한 값. 별도 조사 없이 유지.
- openrouter/auto — all-zero 행은 id auto 하나. -1000000 sentinel은 별개 id openrouter/auto와 auto-beta(77행 밖). 동적 라우팅이라 조사 대상 아님.
- openrouter/free, aurora/elephant/healer/hunter/owl-alpha — OpenRouter 자체
  무료/알파 모델. $0 또는 미공개.
