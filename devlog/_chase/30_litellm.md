# 30 — litellm parity

- repo: `BerriAI/litellm` (Python, MIT)
- 로컬: `devlog/_chase/_litellm/` (shallow clone, gitignored)
- **분석 HEAD: `be4d0d8`** (2026-06-30 12:25, `fix(redis): re-establish async cluster connections after a node restart (#31577)`)
- 역할: 모델 카탈로그 / provider 커버리지 폭 **참조** (3차). 직접 포팅 출처 아님.

## chase MOC

> 상태: 🟡 운영 중 · **의미**: litellm 대비 opencodex 카탈로그 폭 **부분 뒤처짐(G3)**, 범위는 다름
> 상태 어휘: `⬜` 미착수 · `🟡` 부분 · `✅` opencodex 선행/완료 · `—` 범위 밖

### Reviewed through

| litellm | opencodex |
|---|---|
| `be4d0d8` (2026-06-30) | registry 48 provider (worktree) |

### Recent litellm deltas

| 항목 | litellm fact | opencodex 처리 |
|---|---|---|
| 모델 가격/컨텍스트 맵 | `model_prices_and_context_window_backup.json` 2910 모델 | 🟡 교차검증 소스로 활용 |
| chat 롱테일 provider | cohere·databricks·ai21·friendliai 등 130 폴더 | ⬜ openai-호환 후보 미추가 |
| 멀티모달 (embedding/tts/image/rerank/ocr) | mode 분포 chat 2247 외 ~660 | — opencodex 범위 밖 |
| OAuth/구독 IDE 백엔드 | (litellm 약함) | ✅ kiro·antigravity·umans 등 (opencodex 선행) |

## 규모 (HEAD 기준)

| 지표 | litellm | opencodex |
|---|---|---|
| provider 폴더 (`litellm/llms/*/`) | 130 | adapter 6종 / registry 48 provider |
| 모델 맵 엔트리 (`model_prices_and_context_window_backup.json`) | 2,910 | registry/카탈로그 기반 (provider별 동적) |
| distinct `litellm_provider` | 121 | 48 |

## 결정적 차이: 범위(scope)가 다르다

litellm 모델 맵 mode 분포: `chat` 2247, `image_generation` 203, `embedding` 124,
`responses` 82, `audio_transcription` 61, `completion` 36, `image_edit` 31,
`audio_speech` 27, `rerank` 25, `video_generation` 25, `search` 18, `ocr` 13,
`moderation` 5, `realtime` 2.

opencodex는 **코딩 에이전트용 chat/responses 라우팅 프록시**다. litellm의
embedding/tts/stt/image/rerank/ocr/moderation은 opencodex 범위 밖 — parity 대상이 아니다.
의미 있는 교집합은 litellm의 **chat(2247) + responses(82)** 약 2.3k 모델뿐이다.

## chat-relevant provider 교집합

litellm chat provider 중 opencodex와 겹치는 것:
`openai, anthropic, azure, azure_ai, bedrock, cerebras, cohere, deepseek,
fireworks_ai, gemini, groq, mistral, together_ai, vertex_ai, xai` 등.

opencodex에 있고 litellm 표준 provider에 없는 것(IDE/구독 프록시 특화):
`kiro`, `google-antigravity`, `umans`, `opencode-go`, `neuralwatt`, `cursor`(미포팅),
`zai`, `qwen-portal`, `kimi-code` 등 — opencodex의 차별점은 **OAuth/구독 기반 IDE 백엔드**다.

litellm에 있고 opencodex가 안 다루는 chat provider(폭): `cohere`, `databricks`,
`ai21`, `baseten`, `friendliai`, `featherless_ai`, `galadriel`, `gradient_ai` 등
롱테일. 대부분 openai-호환이라 필요 시 `openai-chat` adapter + registry 한 줄로 추가 가능.

## 따라잡을 표면 (좁게)

1. **모델 가격/컨텍스트 윈도우 맵** — litellm `model_prices_and_context_window_backup.json`은
   2910 모델의 컨텍스트 윈도우·가격의 사실상 업계 레퍼런스. opencodex 카탈로그의 컨텍스트
   윈도우 값 교차검증 소스로 유용.
2. **롱테일 openai-호환 provider** — registry 한 줄 추가로 커버 가능한 후보 목록.
3. **provider별 endpoint/헤더 quirk** — `litellm/llms/<provider>/`의 transformation 로직을
   opencodex가 새 provider 추가 시 wire 레퍼런스로 사용.

범위가 다르므로 litellm 전체 parity는 목표 아님. **카탈로그 정확도 + openai-호환 롱테일**만 따라간다.

## chase 로그

| 날짜 | litellm HEAD | 분석 내용 | 결과 |
|---|---|---|---|
| 2026-07-01 | be4d0d8 | 130 provider/2910 모델 맵, mode 분포로 scope 차이 확정, chat 교집합·카탈로그 활용처 식별 | 이 문서 |
