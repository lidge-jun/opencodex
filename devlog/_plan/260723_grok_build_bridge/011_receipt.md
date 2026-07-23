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
