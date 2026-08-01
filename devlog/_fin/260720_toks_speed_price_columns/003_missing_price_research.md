# 003 — 빈 가격 조사 (Luna 스웜, 2026-07-20)

jawcode `models.json`에 없거나(all-zero 포함) alias가 없는 모델의 공식 단가 조사.
Luna 3레인(gpt-5.6-luna explorer, cxc-search 첨부) 결과를 메인이 검수해 정리.
표기: 4튜플 = (input, output, cacheRead, cacheWrite) USD / 1M tokens.
status: `verified`(공식 페이지 직접 열람) / `verified-derived`(suffix→기반 모델 등
유도 매핑, estimated 전파) / `unverified`(lead — 등재 금지) / `not-published`(공식 미공개).

**정책 연결(000 v2 로드맵)**: verified와 verified-derived만 expected 오버레이 테이블
(`src/usage/expected-prices.ts`, WP1)에 넣는다. not-published/unverified는
fail-closed `—`(resolver가 unverified를 반환하지 않음). 오버레이 값은 GUI에서 `~$` 접두 유지.

## 1. Verified — 오버레이 등재 가능

| provider | model | 4튜플 | 소스 | 비고 |
|---|---|---|---|---|
| minimax / minimax-cn | MiniMax-M2.1-highspeed | (0.60, 2.40, 0.03, 0.375) | platform.minimax.io/docs/guides/pricing-paygo (공식) | jawcode 미매칭 2쌍 해소 |
| google (antigravity/vertex 계열) | gemini-3.1-pro (≤200k) | (2, 12, 0.20, —*) | ai.google.dev/gemini-api/docs/pricing (2026-06-18 갱신) | *cache-storage는 시간당 과금이라 cacheWrite 튜플에 직접 매핑 불가 → cacheWrite=0 + 비고 |
| google | gemini-3.1-pro (>200k) | (4, 18, 0.40, —*) | 상동 | 구간별 가격 — 오버레이는 ≤200k 기준 채택, 비고에 구간 명시 |
| google | gemini-3.5-flash | (1.50, 9, 0.15, —*) | 상동 | extra-low/low/mid/high suffix는 기반 모델 가격으로 매핑(공식 명시 없음 → 비고 표기) |
| google | gemini-3-flash | (0.50, 3, 0.05, —*) | 상동 | gemini-3-flash-agent는 Agent API 과금 원칙상 기반 모델 가격 적용(공식 Billing FAQ) |
| deepseek | deepseek-chat | (0.27, 1.10, 0.07, 0) | api-docs.deepseek.com/quick_start/pricing-details-usd | 2026-07-24 V4 Flash alias 전환 예정 — 재검증 필요 비고 |
| deepseek | deepseek-reasoner | (0.55, 2.19, 0.14, 0) | 상동 | 상동 |
| xiaomi | MiMo-V2.5-Pro | (¥3, ¥6, ¥0.025, 0) CNY | mimo.mi.com/docs/news/billing | CNY → USD 환산 필요: 오버레이는 USD 고정이므로 환산율 명시 필요 → 보류(unverified-usd) |

## 2. Not published — 공식 미공개, 오버레이 불가 (`—` 유지)

| provider | models | 근거 |
|---|---|---|
| kimi / moonshot | k3, k3[1m], kimi-k2.7-code(-highspeed), kimi-k2.6, kimi-k2.5, kimi-for-coding | platform.kimi.ai/docs/pricing/* 페이지에 가격표 미표시 (공식 페이지 직접 열람). 구독(Kimi Code membership) quota 기반 |
| xai | grok-composer-2.5-fast | docs.x.ai/developers/pricing 미등재; Grok Build 무료 제공 발표(x.ai/news/composer-2-5) |
| openrouter | openai/gpt-5.6 | openrouter.ai/models에 해당 정확 ID 미등재 |
| google-antigravity | claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium | Antigravity 구독 quota 포함 제공, 모델별 토큰 단가 미공개 (antigravity.google/pricing) |
| kimi-code | (kimi-for-coding 계열) | 구독 quota, API 단가 미공개 |

## 3. Unverified / 구조적 미확정 — 후속 재조사 대상

| provider | 상태 | 비고 |
|---|---|---|
| zai / GLM | unverified | z.ai 가격 URL 오류, bigmodel.cn 확정 불가 — 재조사 시 도메인 리다이렉트 추적 필요 |
| alibaba-token-plan | unverified | Token Plan 북경 전용 단가 공식 확인 불가 — Model Studio 일반 가격과 혼용 금지(메모리: 별도 제품 계약) |
| zenmux | 구조 다름 | flow/구독 quota 중심($20 Builder~), 모델별 토큰 정가표 없음. free 모델은 $0 실비 — "free" 라벨이 정직 |
| cerebras | unverified | 최신 공식 페이지가 PAYG 충전/Code 구독($50/24M/day) 중심, 모델별 단가표 비노출 |
| mistral | unverified | mistral.ai/pricing 페이지에서 모델별 수치 추출 실패(동적 렌더) — 브라우저 재조사 대상 |
| cursor | 구조 다름 | 구독+usage pool. MAX Mode만 provider API 정가 기준 — cursor 로그는 estimated usage라 어차피 ~$ |
| kiro | 구조 다름 | credit 단위($0.04/credit 초과분). 토큰 단가 등가 없음 — expected 환산 불가, `—` |
| github-copilot | 부분 가능 | AI Credits 1=$0.01 + 모델별 credit 환산표(docs.github.com) — 후속 재조사로 모델별 환산표 확보 시 오버레이 가능 |

## 4. 오버레이 등재 결정 (WP1 입력)

즉시 등재 **11쌍** (provider는 registry의 실제 로그 provider id — `google`이 아니라
`google-antigravity`; 010 §5 주석의 exact key 목록이 구현 SSOT):

- verified(4): `minimax`/`minimax-cn` × MiniMax-M2.1-highspeed,
  `deepseek` × deepseek-chat/deepseek-reasoner.
- verified-derived(7): `google-antigravity` × gemini-3.1-pro-low/high(기반 gemini-3.1-pro
  ≤200k), gemini-3.5-flash-extra-low/low/mid/high(기반 gemini-3.5-flash),
  gemini-3-flash-agent(기반 gemini-3-flash + Agent 과금 원칙).

suffix→기반 모델 매핑은 `status: "verified-derived"`로 구분(공식이 suffix 동일가를
명시하지 않음; estimate는 `estimated=true`로 전파).

보류(`—` 유지): Kimi 전 계열, grok-composer-2.5-fast, openrouter/openai-gpt-5.6,
Antigravity의 claude/gpt-oss, zai, alibaba-token-plan, cerebras, mistral, xiaomi(CNY),
kiro, github-copilot(환산표 미확보), gemini-pro-agent(모델 ID 자체 미확인),
gemini-3-pro(가격표에 별도 항목 없음 — 3.1-pro와 동일시 금지).

비율로 보면: 미매칭 26쌍 + all-zero 3쌍 중 이번 조사로 verified 오버레이 가능
**11쌍**(verified 4 + verified-derived 7), 나머지는 not-published/unverified로 fail-closed.

## 5. 재조사 백로그

1. mistral/cerebras/zai — 브라우저 렌더 기반 재조사 (Luna 텍스트 추출 한계).
2. github-copilot 모델별 credit 환산표 파싱.
3. deepseek 2026-07-24 V4 Flash 전환 후 가격 재확인.
4. xiaomi CNY→USD 환산 정책 결정(환산율 고정 vs 미등재).

---

# 2026-07-20 오후 2차 조사 (WP5, sol 3레인 병렬)

사용자 정보로 Kimi 가격이 공개됨을 확인해 재조사. 글로벌 Kimi 공식 가격표가 실제로
없던 상태에서 공개로 바뀐 것을 확인했다 (1차 조사 당시에는 가격표 미게재였음).

## 2차 등재 (총 35키, 기존 11 + 신규 24)

| 구분 | 키 | 4튜플(input/output/cacheRead/cacheWrite) | 상태 |
|---|---|---|---|
| Kimi 공식 | kimi/k3, k3[1m], kimi-k2.7-code(-highspeed), kimi-k2.6, kimi-k2.5, kimi-for-coding + moonshot 5키 + kimi-code 7키 (19키) | K3 (3/15/0.3/3), K2.7-code (0.95/4/0.19/0.95), highspeed (1.9/8/0.38/1.9), K2.6 (0.95/4/0.16/0.95), K2.5 (0.6/3/0.1/0.6) | verified-derived — 공식표에 cacheWrite 미게재(Kimi 자동캐시, 별도 쓰기 과금 없음)라 cacheWrite=input 매핑 부분만 derived |
| Antigravity | claude-sonnet-4-6 (3/15/0.3/3.75), claude-opus-4-6-thinking (5/25/0.5/6.25) | verified-derived — anthropic 공식가 (구독 quota 제품이라 기반 정가 환산) |
| Antigravity | gpt-oss-120b-medium (0.03/0.15/0/0) | verified-derived — 오픈웨이트, OpenRouter 공시 최저가 |
| Antigravity | gemini-3.1-pro-preview (2/12/0.2/0) | verified — Google 공식표 |
| Cursor | auto (1.25/6/0.25/1.25) | verified — Cursor 공시 고정 단가 (2025-08 가격 개정) |

등재 제외 1건: `openrouter/openai/gpt-5.6-sol`은 jawcode openrouter 번들에 이미 동일한
nonzero 가격(5/30/0.5/6.25)이 있어 오버레이가 무의미 — resolver가 jawcode가로
이미 처리한다. 단 현재 스키마는 ≤272K 단가 하나만 담아서, 272K 초과 컨텍스트는
(10/45/1/12.5) 구간 차이를 표현하지 못하는 한계가 있다 (백로그).

Cursor는 `auto`만 등재한다. 나머지 cursor 모델(composer 등)은 Cursor가 모델별 단가를
공개하지 않고(MAX Mode만 provider 정가 전달) 정확한 모델-가격 매핑이 불가하므로
정책대로 `—`를 유지한다.

## 2차 조사에서도 미등재 (fail-closed 유지)

- kiro: credit 단위 과금, 공식 토큰 등가 없음.
- xai grok-composer-2.5-fast: 공식 가격표 미등재 (Grok Build 묣료 제공).
- openrouter/openai/gpt-5.6: 정확 ID가 OpenRouter 카탈로그에 없음.
- google-vertex gemini-3-pro: preview 종료(retired), 가격표에서 제거됨.
- gemini-pro-agent: 공개 Google 모델 ID 아님, 공식 매핑 미확인.
- alibaba-token-plan qwen3.8-max-preview: Token Plan은 크레딧 차감 구독(¥39~499/월)이고
  토큰→크레딧 환산식 미공개. 일반 Model Studio PAYG 대입 금지.
- zai glm-4.6: 조사된 것은 glm-4.7 가격(0.6/2.2/0.11) — registry는 4.6이라 매칭 안 됨.
- cerebras/mistral/xiaomi/zenmux: 해당 provider에 registry 모델 없음(cerebras/mistral/xiaomi)
  또는 동적 과금(zenmux는 모델·공급자별 가격이 API로만 조회됨, 정적 등재 부적합).
- opencode-go/kimi-k3: opencode-go 자체 과금 체계가 별개라 Moonshot 정가 대입 불가.
- umans/neuralwatt/ollama-cloud/mimo-free: 미조사(no-alias, 자체 과금 추정).

## 남은 백로그

1. deepseek 2026-07-24 V4 Flash 전환 후 가격 재확인(기존 deepseek-chat/reasoner 행 갱신).
2. zenmux 동적 모델 가격 API 연동 검토(정적 오버레이 대신 live 조회).
3. openrouter의 gpt-5.6-terra/luna 엔드포인트 가격 확인 시 등재.

---

# 2026-07-20 3차 — 모델 레벨 공식가 fallback (사용자 정책 변경)

정책 변경: 프로바이더별 개별 과정 대신 **모델은 어느 프로바이더를 통하든 공식가를
따른다** (예: kiro의 claude-opus-4.6 → anthropic 정가). 이에 따라
`resolveMatchedPrice`에 3단계 fallback 추가:

1. jawcode exact (provider bundle, status verified)
2. expected 오버레이 exact (verified/verified-derived)
3. **jawcode 벤더 번들 모델 레벨 검색** (`findJawcodeCostByModelId`) — 벤더 우선순위
   (anthropic → openai → google → moonshot → minimax → deepseek → xai → zai → mistral
   → cerebras → azure-openai → amazon-bedrock → xiaomi), exact modelId + dot→dash
   정규화 1회(kiro `claude-opus-4.6` ↔ anthropic `claude-opus-4-6`), status
   verified-derived, `jawcodeProvider`에 매칭된 벤더 번들 기록.

이 변경으로 openai(OAuth) 프로바이더의 gpt-5.x 계열이 openai 벤들 가격으로 집계되기
시작한다 (이전에는 registry에 jawcodeBundle 미설정으로 전부 미매칭).

재측정 커버리지(정적 registry 198 후보): **127쌍 가격 확보(64%)**, 미확보 71쌍 —
cursor 자체 명명 변형(claude-4-sonnet 등), composer 계열, umans/neuralwatt/
ollama-cloud/zenmux 자체 과금, zai GLM-5.x, alibaba-token-plan, kiro-auto,
github-copilot/claude-sonnet-4, openrouter/openai/gpt-5.6, google-vertex/gemini-3-pro,
gemini-pro-agent. 실사용 표면(openai OAuth, kiro/cursor의 anthropic·gpt, kimi 전 계열,
deepseek, minimax, AG gemini/claude)은 모두 커버됨.
