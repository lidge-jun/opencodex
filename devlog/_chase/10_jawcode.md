# 10 — jawcode parity

- repo: `lidge-jun/jawcode`  ·  로컬: `/Users/jun/Developer/new/700_projects/jawcode`
- **분석 HEAD: `27311f6`** (2026-07-01 04:35, `fix(ai): type DeepInfra tokenizer test cases as TokenizerFamily (10.062)`)
- 역할: opencodex 어댑터의 **직접 포팅 출처** (1차 SOT). provider 레이어가 여기 산다.

## chase MOC

> 상태: 🟡 운영 중 · **의미**: jawcode 대비 opencodex **뒤처짐(G1)**
> 상태 어휘: `⬜` 미착수 · `🟡` 부분 · `✅` opencodex 선행/완료 · `—` 범위 밖

### Reviewed through

| jawcode | opencodex |
|---|---|
| `27311f6` (code, 2026-07-01) | registry 48 provider / adapter 6종 (worktree) |

### Recent jawcode deltas

| 항목 | jawcode fact | opencodex 처리 |
|---|---|---|
| deepinfra | HEAD `27311f6` 신규 provider + tokenizer family 라우팅 (10.062) | ⬜ registry 미반영 |
| cursor | `cursor.ts` ~2.6k줄 agent 프로토콜 | ⬜ 어댑터 없음 |
| amazon-bedrock | `amazon-bedrock.ts` + `aws-sigv4.ts` 직접 경로 | 🟡 kiro adapter로 Bedrock-on-Kiro만 |
| google-gemini-cli | `google-gemini-cli.ts` OAuth | — 레거시. opencodex migration 대상에서 제외 |
| kiro | `kiro.ts` + 4 모듈 | ✅ 9 모듈로 분화 (opencodex 선행) |
| models.json | 3758 모델 엔트리 | 🟡 카탈로그 주기 동기화 필요 |

## 규모 대조 (HEAD 기준)

| 지표 | jawcode | opencodex |
|---|---|---|
| provider 모듈 (`packages/ai/src/providers/*.ts`, non-test) | 47 | adapter 24개 파일 |
| registry/카탈로그 provider | `models.json` **48** provider, **3758** 모델 엔트리 | registry **48** provider |
| 모델 카탈로그 소스 | `packages/ai/src/models.json` (81k줄) | `src/codex-catalog.ts` + `src/providers/*-models.ts` |

jawcode는 멀티-API 클라이언트 패키지(google-generative-ai / openai-completions /
openai-responses / anthropic-messages / kiro 등 `api` 필드로 분기)이고, opencodex는
그 API 패밀리를 **6개 adapter**로 압축했다: `openai-chat`×37, `anthropic`×4,
`google`×3, `openai-responses`×2, `kiro`×1, `azure-openai`×1.

## provider 커버리지 diff (exact-id 기준, 39 공유)

jawcode에만 있고 opencodex registry에 같은 id로 없는 것:
`alibaba-coding-plan`(opencodex는 `alibaba`로 보유), `amazon-bedrock`,
`cursor`, `deepinfra`, `google-gemini-cli`(legacy/out-of-scope), `minimax-code`, `minimax-code-cn`,
`openai-codex`, `opencode`.

opencodex에만 있는 것: `kimi`, `lm-studio`, `neuralwatt`, `openai-apikey`,
`parallel`, `umans`, `vllm`, `ollama`(jawcode는 `ollama-cloud`), `alibaba`.

### 의미 있는 gap (id 차이가 아닌 실제 미포팅)

| jawcode provider | 상태 | 메모 |
|---|---|---|
| `cursor` | **미포팅** | jawcode `cursor.ts`는 ~2.6k줄 agent 프로토콜. opencodex에 adapter 없음. 가장 큰 단일 gap |
| `deepinfra` | **미포팅** | HEAD에서 막 추가된 신규(10.062). tokenizer family 라우팅 포함 |
| `amazon-bedrock` | 부분 | opencodex는 `kiro` adapter로 Bedrock-on-Kiro만. 직접 Bedrock(sigv4) 경로는 없음 |
| `google-gemini-cli` | — | 레거시 경로. opencodex는 ai-studio/vertex/cloud-code-assist만 유지하고 gemini-CLI OAuth는 migration하지 않음 |

## API 변환 1:1 대조 포인트

| 영역 | jawcode | opencodex |
|---|---|---|
| Google generate | `google.ts` `streamGenerateContent?alt=sse`, `x-goog-api-key` | `src/adapters/google.ts` (동일 엔드포인트, vertex/cca 분기 추가) |
| Google 공통 | `google-shared.ts` `buildGoogleGenerateContentParams` | `google.ts` + `google-tool-schema.ts` + `google-truncation.ts` |
| Antigravity | `google.ts` cloud-code 분기 | `google-antigravity-wire.ts`(100), `google-antigravity-replay.ts`(136) |
| Kiro | `kiro.ts` + `kiro-{thinking,truncation,usage,tool-fallback}.ts` | `kiro.ts` + `kiro-{events,images,retry,thinking,tool-fallback,tools,truncation,wire,errors}.ts` (더 분화) |

opencodex는 Kiro를 jawcode보다 더 잘게 쪼갰고(9 모듈 vs 5), Antigravity는 thought-signature
replay를 별도 모듈로 뺐다. 즉 **포팅 후 opencodex가 더 하드닝된 영역**(kiro/antigravity)과
**아직 안 따라온 영역**(cursor/deepinfra/direct-bedrock)이 공존한다.

## 따라잡을 우선순위

1. `deepinfra` — HEAD 신규, 가벼운 openai-chat 계열이라 포팅 저비용.
2. `cursor` — 고비용/고가치. agent 프로토콜이라 별도 work-phase 필요.
3. `models.json` delta — 3758 엔트리 중 opencodex 카탈로그에 없는 신규 모델·컨텍스트 윈도우 주기 동기화.

## chase 로그

| 날짜 | jawcode HEAD | 분석 내용 | 결과 |
|---|---|---|---|
| 2026-07-01 | 27311f6 | provider 48/모델 3758 baseline, 커버리지 diff, cursor/deepinfra gap 식별 | 이 문서 |
