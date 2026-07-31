# 20 — cli-proxy-api (CLIProxyAPI) parity

- repo: `router-for-me/CLIProxyAPI` (Go, MIT)
- 로컬: `devlog/_chase/_cca/` (shallow clone, gitignored)
- **분석 HEAD: `00114be`** (2026-06-29 18:59, `Merge PR #4052 fix/responses-ws-to-sse-4048`)
- 역할: wire/auth/quirks **외부 교차검증 SOT** (2차). 코드 복사 아님, 동작 대조.

## chase MOC

> 상태: 🟡 운영 중 · **의미**: cca 대비 opencodex wire/auth 깊이 **부분 뒤처짐(G2)**
> 상태 어휘: `⬜` 미착수 · `🟡` 부분 · `✅` opencodex 선행/완료 · `—` 범위 밖

### Reviewed through

| cli-proxy-api | opencodex |
|---|---|
| `00114be` (2026-06-29) | oauth 6 provider / `ws-bridge.ts` (worktree) |

### Recent cca deltas

| 항목 | cca fact | opencodex 처리 |
|---|---|---|
| responses WS→SSE | HEAD 머지 #4048 `codex_websockets_executor` | ✅ `ws-bridge.ts` (delta 점검 대상) |
| antigravity replay | `antigravity_reasoning_replay.go` 667줄 | 🟡 `google-antigravity-replay.ts` 136줄 |
| vertex OAuth | `vertex_credentials.go` + vertex auth | ⬜ key/ADC만, OAuth 없음 |
| xai replay/WS | `xai_reasoning_replay.go` + `xai_websockets_executor.go` | ⬜ 전용 어댑터 없음 |
| kiro | (없음) | ✅ 풀세트 (opencodex 선행) |

## 규모 (HEAD 기준, non-test SLOC)

| 영역 | CCA SLOC | opencodex 대응 |
|---|---|---|
| `internal/auth` | 4,755 | `src/oauth/*` (anthropic/chatgpt/google-antigravity/kimi/kiro/xai) |
| `internal/translator` | 18,086 | adapter별 body 변환 (`google.ts`, `openai-*.ts`, `anthropic.ts`) |
| `internal/runtime/executor` | 22,805 | `buildRequest`/`parseStream` + 안정화 + `ws-bridge.ts` |

## auth/executor 커버리지 대조

CCA auth provider: `antigravity, claude, codex, kimi, vertex, xai` (+empty).
opencodex oauth: `anthropic, chatgpt(=codex), google-antigravity, kimi, kiro, xai`.

| provider | CCA | opencodex | 차이 |
|---|---|---|---|
| antigravity | auth + executor + reasoning replay | oauth + `google-antigravity-{wire,replay}.ts` | **양쪽 보유** |
| codex/chatgpt | `codex_executor.go` + `codex_websockets_executor.go` | oauth chatgpt + `ws-bridge.ts` | **양쪽 보유** (WS parity) |
| claude | `claude_executor.go` + `claude_signing.go` | `anthropic.ts` oauth | 양쪽 보유 |
| kimi | `kimi_executor.go` | oauth kimi | 양쪽 보유 |
| vertex | `gemini_vertex_executor.go` + vertex auth | `google` adapter `googleMode:vertex` (**key 기반, OAuth 아님**) | **gap: vertex OAuth 경로 없음** |
| xai | `xai_executor.go` + `xai_websockets_executor.go` + `xai_reasoning_replay.go` | registry `xai`(forward), oauth xai | **gap: xai reasoning replay / WS executor 미확인** |
| kiro | (없음) | `kiro` adapter 풀세트 | opencodex 우위 |

## 핵심 wire quirk 교차검증

| quirk | CCA 위치 | opencodex 위치 | 상태 |
|---|---|---|---|
| Antigravity thoughtSignature replay | `antigravity_reasoning_replay.go` (667줄) | `google-antigravity-replay.ts` (136줄) | opencodex가 훨씬 가벼움 — **replay 캐시 깊이 차이 점검 필요** |
| Antigravity signature validation | `translator/antigravity/claude/signature_validation.go` | `google-antigravity-wire.ts` `isLikelyRealThoughtSignature` | 접근 동일(synthetic id 거부), CCA가 더 세분 |
| Responses WS→SSE | HEAD 머지(#4048) `codex_websockets_executor` | `ws-bridge.ts` | **양쪽 최신, delta 점검 대상** |
| Antigravity translators | gemini/claude/openai 3종 | `google` adapter 단일 | opencodex는 단일 adapter로 흡수 |

## 따라잡을 우선순위

1. **Antigravity reasoning replay 깊이** — CCA 667줄 vs opencodex 136줄. clear-on-invalid,
   캐시 키, 멀티턴 시그니처 보존 로직을 라인 대조해 누락 확인.
2. **vertex OAuth** — opencodex는 key/ADC만. CCA `vertex_credentials.go` 흐름을 참조해
   서비스계정 OAuth 경로 보강 여부 결정.
3. **xai reasoning replay / WS** — CCA에 전용 모듈 존재. opencodex xai는 forward-only인지 확인.

## chase 로그

| 날짜 | CCA HEAD | 분석 내용 | 결과 |
|---|---|---|---|
| 2026-07-01 | 00114be | auth/executor 커버리지 대조, replay 깊이 gap, vertex OAuth/xai WS gap 식별 | 이 문서 |
