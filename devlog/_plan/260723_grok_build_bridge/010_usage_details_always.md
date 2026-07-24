# 010 — wp1: usage details 상시 방출 (diff-level plan)

Goal: routed 모델의 `response.completed` / chat `usage`에 token-detail 오브젝트를 항상 포함시켜 Grok Build(및 여타 strict Responses 클라이언트)의 exit 1을 제거.

## Why (evidence)
- grok 0.2.101 pinned `async-openai` `ResponseUsage`: `input_tokens_details`/`output_tokens_details` required (001 참조).
- live: routed `cursor/grok-4.5` usage = `{input_tokens, output_tokens, total_tokens}`만 방출 → grok `serialization error: missing field 'input_tokens_details'` exit 1 (3-way 매트릭스 000 참조).
- native ChatGPT 경로는 상류가 details를 항상 실어 exit 0 — 목표는 routed를 native와 동일 계약으로.

## Diff plan

### 1. `src/bridge.ts` — `responsesUsage()`
- usage 없음 분기: `{ input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }` 반환.
- 본 분기: `inputDetails.cached_tokens`를 `usage.cachedInputTokens ?? 0`으로 항상 설정 (cache_write_tokens는 기존처럼 있을 때만), `out.input_tokens_details = inputDetails` 무조건 대입. `out.output_tokens_details = { reasoning_tokens: usage.reasoningOutputTokens ?? 0 }` 무조건 대입.
- 주석: grok-build pinned async-openai가 두 details를 required로 역직렬화한다는 근거 명시 (`response_usage.rs:18-28` @ 95b52ebd).

### 2. `src/chat/outbound.ts` — `chatCompletionsUsage()`
- `prompt_tokens_details = { cached_tokens: cached ?? 0 }` 상시 포함.
- `completion_tokens_details = { reasoning_tokens: reasoning ?? 0 }` 상시 포함.

### 3. 회귀 테스트
- bridge 쪽: `responsesUsage()`는 private — 공개 표면인 `bridgeToResponsesSSE()` / `buildResponseJSON()` 경유로 검증. 배치는 `tests/bridge.test.ts` (reviewer 확인: 인접 표면 맞음). 케이스 3종: usage 부재 / usage 있으나 cached·reasoning undefined / 값 있음 — 스트리밍·논스트리밍 모두에서 두 details 키 존재+숫자 확인.
- chat 쪽: `tests/chat-completions-endpoint.test.ts`에 non-stream+stream usage frame의 details 존재 어서션 추가.

### 4. 리스크 점검
- 소비자: Codex CLI/App(관대), Claude inbound(`src/claude/outbound.ts`는 자체 변환 — 영향 경로 typecheck로 확인), request-log 파서(`src/server/request-log.ts:352-375`는 optional 읽기라 무해).
- `cached_tokens: 0` 상시 방출이 GUI 비용 계산에 미치는 영향: 0은 no-op이므로 없음 (확인: `usageDisplayTotalTokens` 경로).

## Verifier
1. `bun run typecheck`
2. `bun run test` (full)
3. **런타임 프로비넌스 (reviewer blocker 반영):** 수정된 체크아웃으로 :10100 프록시를 명시적으로 재기동(`ocx stop` → `ocx start`, 사용자 확인 필요 — 이 프록시가 현재 세션을 서빙 중)하고, `/healthz` version+pid+uptime으로 새 프로세스가 수정 코드를 서빙함을 기록한 뒤에만 매트릭스 실행. stale 프로세스 결과는 무효.
4. live 3-way 매트릭스 재실행 (grok 0.2.101, `GROK_HOME=/tmp/grok-ocx-smoke-260723`): ocx-chat / ocx-native-chat / ocx-resp 모두 **exit 0** + 정답 텍스트.
5. **endpoint 프로비넌스 (reviewer 제안 6 반영):** grok의 ocx-chat 런이 Responses 디코더를 탄 사실이 있으므로, 매트릭스만으로는 `chatCompletionsUsage()` 실행 증명이 안 됨 — 직접 `curl /v1/chat/completions` (stream+non-stream)로 details 상시 존재를 별도 확인.
6. 스모크 receipt는 `011_receipt.md`에 **명령·타임스탬프·stdout·stderr·exit code를 한 세트로** 기록 (reviewer 제안 5).

## Out of scope
- ocx `/v1/models`에 `api_backend`/`context_window` 필드 추가 (zero-config 카탈로그) — 후속 결정 사항.
- push / release (사용자 승인 필요).
