# 000 — Grok Build 최신화 + OpenCodex 브리지 마감 로드맵

Date: 2026-07-23
Session: 019f8e74-906b-7430-be5d-5598745922b6 (cxc-loop, docs-first roadmap cycle)

## Loop-spec
- Loop archetype: spec-satisfaction (verifier = Grok headless exit 0 + full test suite green)
- Trigger: user asked to pull `~/Developer/codex/180_grok-build` to latest and stand up a devlog for the bridge follow-through
- Goal: OpenCodex를 로컬 서버로 쓰는 Grok Build 사용자가 **routed 모델 포함** 깨끗한 exit 0을 받는 상태
- Non-goals: push (user approval 필요), Grok Build 소스 수정, `dev` 브랜치 직접 작업
- Verifier: live `grok -p` smoke (exit code + stdout), `bun run typecheck`, `bun run test`

## State refresh (2026-07-23, live)

### grok-build tree
- `origin/main` force-pushed: `b189869` ("Publish harness and TUI open-source") → `a5727c5` ("Synced from monorepo" 연쇄, 상류가 히스토리 재작성)
- 로컬 조치: `backup/pre-260723-pull` 태그로 옛 tip 보존 → `git checkout -B main origin/main`. 로컬 커밋 없음, untracked `analysis/`/`.codexclaw/`는 그대로 보존됨
- `SOURCE_REV`: `30192d2eef5d91a8fff0e53957de5bd05b43398c`
- 로컬 grok 바이너리: `0.2.101 (5bc4b5dfadcf) [stable]` (7/16 스모크 당시 0.2.99)
- user-guide diff (구→신): 21 files, +602/−634 — custom-models 계약 재검증 필요 (Sol 분석 010에 fold)

### OpenCodex 런타임
- 사용자가 재시작 완료: `healthz` → `opencodex 2.7.35`, port 10100
- `/v1/chat/completions` 인바운드 **live 확인**: routed(`cursor/grok-4.5`)·native(`gpt-5.4-mini`) 모두 200 + 정답 텍스트

## Live smoke matrix (2026-07-23, grok 0.2.101 → ocx 2.7.35)

격리 `GROK_HOME=/tmp/grok-ocx-smoke-260723`, `XAI_API_KEY=dummy-loopback` (grok가 비어있지 않은 키를 요구; loopback ocx는 무시).

| grok model | configured backend | ocx model | text | exit | error |
|---|---|---|---|---|---|
| ocx-chat | chat_completions | cursor/grok-4.5 | (없음) | 1 | `missing field 'input_tokens_details'` |
| ocx-native-chat | chat_completions | gpt-5.4-mini | **OCX_NATIVE_OK** | **0** | — |
| ocx-resp | responses | cursor/grok-4.5 | OCX_RESP_OK | 1 | `missing field 'input_tokens_details'` |

### 해석
1. 7/16 블로커 ①(chat/completions 404)은 v2.7.35에서 해소 — 기본 백엔드로 wire가 뚫림.
2. 7/16 블로커 ②(native system 거부)도 chat 인바운드의 instructions 폴딩으로 해소 — native가 이번엔 **유일한 완전 성공**.
3. 남은 단일 블로커는 ③ usage details. 정정(리뷰 반영): grok의 **Chat Completions 디코더 자체는 usage optional로 관대**하다(001 참조). 실패한 ocx-chat 런은 *configured* backend가 chat이었는데도 실제로는 **Responses 이벤트를 소비하다** required `input_tokens_details`에서 죽은 것 — stderr raw_data가 `response.completed`인 것으로 확증. 즉 strict한 것은 Responses 디코더이고, grok 하니스가 chat 설정에서도 Responses 경로를 태우는 조건이 잔여 조사 항목이다.
4. native가 통과한 이유: ChatGPT 상류가 details를 항상 포함하고 ocx가 이를 보존 (`prompt_tokens_details`/`completion_tokens_details` 응답 확인). routed는 upstream이 details를 안 주면 ocx가 필드를 **생략**한다:
   - `src/bridge.ts` `responsesUsage()` — cached/reasoning이 undefined면 `*_tokens_details` 생략
   - `src/chat/outbound.ts` `chatCompletionsUsage()` — 동일하게 조건부 생략
   - live 확인: `POST /v1/responses` (cursor/grok-4.5) usage = `{input_tokens, output_tokens, total_tokens}` 뿐

## Work-phases (decade map)

| id | decade | title | verifier |
|----|--------|-------|----------|
| wp0 | 000-00x | 이 로드맵 + Sol 소스 분석 fold-in | 문서 존재 + FSM D |
| wp1 | 010 | usage details 상시 방출 (bridge.ts + chat/outbound.ts) + 회귀 테스트 | 신규 테스트 + typecheck + full test + live grok exit 0 (3-way matrix) |
| wp2 | 020 | Grok Build 연동 문서화 (docs-site 또는 devlog receipt) + 잔여 스모크 (tool-call turn) | docs 빌드/검증 + smoke receipt |

wp1이 유일한 코드 변경. 예상 diff: `responsesUsage()`가 `input_tokens_details`(cached_tokens=0 기본)와 `output_tokens_details`(reasoning_tokens=0 기본)를 **항상** 포함, `chatCompletionsUsage()`도 `prompt_tokens_details`/`completion_tokens_details` 상시 포함. 위험: 기존 소비자(Codex CLI/App, Claude inbound)는 필드 추가에 관대(additive) — 회귀는 스냅샷 테스트로 커버.

## Residuals / open questions (Sol 분석 대기)
- grok 0.2.101 custom-models 계약 변경점 (신규 필드/기본값)
- usage struct가 정확히 어떤 필드를 required로 두는지 (cache_write? reasoning?)
- models_base_url 카탈로그 fetch의 Bearer 요구가 여전한지
- tool-call turn (function calling) 왕복이 grok chat 백엔드에서 도는지 — wp2 스모크

## Evidence
- 스모크 로그: `/tmp/grok-smoke-{chat,native,resp}.{out,err}`
- grok config: `/tmp/grok-ocx-smoke-260723/config.toml`
- 직전 판정: `devlog/_fin/260716_grok_build_connect/030_feasibility_verdict.md`, `040_live_smoke.md`
