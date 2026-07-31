# chase — 갭 인벤토리 (횡단)

> **reviewed through**: jawcode `27311f6` (code) · cli-proxy-api `00114be` · litellm `be4d0d8` (2026-07-01)
> 상태: `⬜` 미착수 · `🟡` 부분/설계 · `✅` opencodex 선행/포팅 완료 · `—` 범위 밖
> 기록: `10_jawcode.md` · `20_cli-proxy-api.md` · `30_litellm.md`

## 요약 (축별 앞섬/뒤처짐)

| 축 | opencodex가 **앞서거나 유일** | opencodex가 **뒤처지거나 약함** |
|---|---|---|
| **jawcode** | kiro 9-모듈 분화, antigravity replay 분리, codex WS, 구독 IDE provider | `cursor`(미포팅), `deepinfra`(HEAD 신규), 직접 `amazon-bedrock` sigv4 |
| **cca** | kiro 풀세트, codex WS bridge, 단일 google adapter 흡수 | antigravity replay 깊이(136 vs 667), vertex OAuth, xai reasoning-replay/WS |
| **litellm** | OAuth/구독 IDE 백엔드, 코딩 에이전트 특화 라우팅 | chat 롱테일 provider 폭(cohere·databricks·ai21 등), 모델 가격/컨텍스트 맵 |

## 항목별 (G-tag)

| 갭 | 종류 | 상태 | upstream 근거 | opencodex 위치 |
|---|---|---|---|---|
| cursor 어댑터 | G1 | ⬜ | jawcode `cursor.ts` (~2.6k줄 agent 프로토콜) | `src/adapters/`에 없음 |
| deepinfra provider | G1 | ⬜ | jawcode HEAD `27311f6` 신규(10.062) | `registry.ts`에 없음 |
| 직접 amazon-bedrock | G1 | 🟡 | jawcode `amazon-bedrock.ts` + `aws-sigv4.ts` | kiro adapter로 Bedrock-on-Kiro만 (`eventstream-decoder.ts`는 kiro용) |
| google-gemini-cli OAuth | G1 | — | jawcode `google-gemini-cli.ts` | 레거시. opencodex migration 대상에서 제외 |
| models.json delta | G1 | 🟡 | jawcode 3758 모델 엔트리 | `codex-catalog.ts` + `*-models.ts` 주기 동기화 |
| antigravity replay 깊이 | G2 | 🟡 | cca `antigravity_reasoning_replay.go` (667줄) | `google-antigravity-replay.ts` (136줄) |
| vertex OAuth | G2 | ⬜ | cca `vertex_credentials.go` + vertex auth | `google` adapter는 key/ADC만, OAuth 없음 |
| xai reasoning-replay/WS | G2 | ⬜ | cca `xai_reasoning_replay.go` + `xai_websockets_executor.go` | xai 전용 어댑터 없음 (registry forward) |
| responses WS→SSE | G2 | ✅ | cca HEAD 머지 #4048 | `ws-bridge.ts` (양쪽 최신, delta 점검) |
| chat 롱테일 provider | G3 | ⬜ | litellm cohere·databricks·ai21·friendliai 등 | registry에 없음 (대부분 openai-호환, 한 줄 추가 가능) |
| 모델 가격/컨텍스트 맵 | G3 | 🟡 | litellm `model_prices_and_context_window_backup.json` (2910) | 카탈로그 컨텍스트 윈도우 교차검증 소스 |
| 멀티모달(embedding/tts/image/rerank) | G3 | — | litellm mode 분포 | opencodex 범위 밖 (chat/responses 프록시) |
| kiro 풀세트 | G4 | ✅ | (upstream에 없거나 약함) | `kiro*.ts` 9 모듈 |
| codex WebSocket | G4 | ✅ | cca codex WS와 동급 | `ws-bridge.ts` + `codex-websocket-registry.ts` |
| 구독 IDE provider | G4 | ✅ | — | umans·opencode-go·neuralwatt·zai 등 |

## 다음에 볼 경로

- G1 deepinfra: `jawcode/packages/ai/src/providers/` (HEAD `27311f6` 신규 파일) → opencodex registry 한 줄 + 모델 시드
- G2 replay: `devlog/_chase/_cca/internal/runtime/executor/antigravity_reasoning_replay.go` line 대조
- G3 catalog: `devlog/_chase/_litellm/litellm/model_prices_and_context_window_backup.json` 컨텍스트 윈도우 값

실행 우선순위는 `03_follow_index.md`.
