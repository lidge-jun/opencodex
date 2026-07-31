# 011 — wp1 receipt: usage details 상시 방출 검증

Date: 2026-07-23 (KST), branch `codex/260723-grok-build-bridge`, commit `7d83deaf`

## External source proof (Sol/priority cxc-search subagent, Tier-2 opened sources, 2026-07-23)

- Claim 1 **PROVEN**: grok-build `a5727c5` Cargo.toml pins `async-openai = { git = "https://github.com/our-forks/async-openai.git", rev = "95b52ebd..." }` (fork org는 `our-forks`). 해당 rev의 `response_usage.rs`에서 `input_tokens_details: InputTokenDetails` / `output_tokens_details: OutputTokenDetails` — non-Option, serde default 없음, 중첩 `cached_tokens`/`reasoning_tokens`도 required. 원문 blob 열람 증명.
- Claim 2 **부분 반박(정밀화)**: OpenAI 공식 openapi (`openai/openai-openapi` @ `f9400172`)는 `Response.usage` 자체를 required로 두지 않지만, usage가 존재하면 `ResponseUsage` 스키마상 두 details는 required. → 상시 방출(zero defaults)은 **스펙 적합 정규화**이며 unknown-field 확장이 아님. 단 "항상 존재 보장"은 공식 계약보다 강한 우리 쪽 보증임을 문서에 명시.

## Code change (7d83deaf)

- `src/bridge.ts` `responsesUsage()`: no-usage 분기 포함 두 details 상시 방출 (cached_tokens/reasoning_tokens 기본 0, cache_write_tokens는 기존처럼 조건부).
- `src/chat/outbound.ts` `chatCompletionsUsage()`: `prompt_tokens_details`/`completion_tokens_details` 상시 방출.
- 테스트: `tests/bridge.test.ts` 신규 케이스(usage 부재/미보고/보고 3종 × SSE/JSON), `tests/chat-completions-endpoint.test.ts` `chatCompletionsUsage` 유닛 3종.

## Verifier 결과

1. `bun run typecheck` — pass (worktree에 `bun install` 선행 필요했음)
2. `bun run test` — **3702 pass / 1 fail**. 실패 1건은 `tests/anthropic-thinking-signature.test.ts` "sanitize strips ocxr1..." — **stash 후 미수정 트리에서도 동일 실패** (full-run 한정, 단독 실행 시 pass — 테스트 격리/캐시 간섭으로 보이는 기존 이슈, 본 변경과 무관 확증). 변경 파일 3종 단독 실행 70 pass 0 fail.
3. 런타임 프로비넌스: 임시 스택 `OPENCODEX_HOME=/tmp/ocx-wp1-home` + `--port 10190`으로 **수정 체크아웃에서 직접 기동** (healthz pid 40465, version 2.7.34-dev). :10100 프로덕션 프록시(이 세션 서빙 중)는 건드리지 않음 — 리뷰어 blocker의 취지(수정 코드 서빙 증명)를 재시작 대신 격리 기동으로 충족.
4. endpoint 프로비넌스 (curl → :10190):
   - `POST /v1/responses` (cursor/grok-4.5): usage에 `input_tokens_details:{cached_tokens:0}` / `output_tokens_details:{reasoning_tokens:0}` 포함 확인
   - `POST /v1/chat/completions` non-stream + stream 마지막 usage frame: `prompt_tokens_details`/`completion_tokens_details` 포함 확인 → `chatCompletionsUsage()` 실행 경로 증명
5. live 3-way grok 매트릭스 (grok 0.2.101, `GROK_HOME=/tmp/grok-ocx-smoke-wp1` → :10190, 2026-07-23 19:5x KST):

| model | configured backend | ocx model | exit | stdout |
|---|---|---|---|---|
| ocx-chat | chat_completions | cursor/grok-4.5 | **0** | OCX_WP1_OK |
| ocx-native-chat | chat_completions | gpt-5.4-mini | **0** | OCX_WP1_OK |
| ocx-resp | responses | cursor/grok-4.5 | **0** | OCX_WP1_OK |

수정 전 baseline(000)은 chat=1/native=0/resp=1이었음 → 블로커 ③ 해소 확인. 로그: `/tmp/grok-wp1-ocx-{chat,native-chat,resp}.{out,err}`.

## Round 2 — 리뷰어 blocker 반영 (provenance 보존)

Sol(priority) 리뷰어 Dalton 1라운드 FAIL: wire의 synthetic zero details를 `request-log`가 실측값으로 재파싱 → GUI가 cache read=0/reasoning=0으로 표시하고 `cache_detail_missing` 억제 (provenance 손실).

반영 (커밋 2건째):
- `src/bridge.ts`: `bridgeToResponsesSSE`/`buildResponseJSON`에 `onUsage` 콜백 추가 — 터미널 이벤트(done/max_tokens/incomplete/error-with-usage)에서 **정규화 전 raw adapter usage**를 보고.
- `src/server/responses.ts`: 4개 호출부(스트림 2, JSON 2) + web-search 루프에 `onUsage` 배선, `logCtx.usageFromBridge` 마킹.
- `src/server/request-log.ts`: `applyResponseLogMetadata`가 `usageFromBridge`일 때 wire 재파싱으로 usage를 덮어쓰지 않음 (native passthrough는 기존 동작 유지).
- `src/web-search/loop.ts`: `WebSearchLoopDeps.onUsage` 추가.
- 테스트: bridge `onUsage` raw-vs-wire 검증, incomplete/failed 터미널 details 검증(제안 3), `applyResponseLogMetadata` provenance guard(제안 2). 대상 5파일 129 pass.

재검증 (2026-07-23 20:3x KST, 새 :10190 프로세스 pid 44898):

| model | exit | stdout |
|---|---|---|
| ocx-chat | 0 | OCX_WP1B_OK |
| ocx-native-chat | 0 | OCX_WP1B_OK |
| ocx-resp | 1회차 1(히트비트, 하단), 재시도 3/3 **exit 0** | OCX_WP1B_OK |

## 신규 잔여 발견: `response.heartbeat` vs grok strict 디코더

ocx의 keep-alive `response.heartbeat` 프레임(코덱스는 unknown event 무시)은 grok 0.2.101 Responses 디코더의 **closed enum**에서 즉사(`unknown variant response.heartbeat`). upstream이 2초(heartbeatMs) 이상 침묵한 턴에서만 발생 — 이번 1회 재현, 재시도 3회는 히트비트 미발화로 전부 통과. wp2 문서화에 known-limitation으로 기재하고, 필요시 별도 결정(예: chat 백엔드 권장, 또는 Responses 클라이언트 UA 감지 시 히트비트 억제)은 후속 작업.
