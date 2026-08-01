# 000 — Claude Code 경로 transient 5xx 하드닝 로드맵

상태: WP0 P-phase 초안 (A 감사 전) / 세션 019f6835-16d8-7f92-8d33-daa81df702cd
근거: devlog/260716_ocx_claude_sol_502_midstream/01,02 (sol 빌더 사망 포렌식 + 병렬 분석)

## Objective

ChatGPT Codex 백엔드의 transient 5xx(502/503/504/520류)가 `ocx claude` 경유
Claude Code Task 에이전트를 즉사시키는 구조를 제거한다. 세 겹 방어:
(1) 프록시가 pre-stream 5xx를 직접 재시도, (2) 재시도 소진분은 Claude Code가
스스로 재시도하도록 529 `overloaded_error`로 분류, (3) 다음 사건을 위해 실패
항목을 판별 가능한 형태로 영속화.

## Loop-spec (C3)

- Archetype: spec-satisfaction repair (verifier = 유닛테스트 + 전체 스위트 + 스모크)
- Trigger: 2026-07-15 sol 빌더 72콜 유실 사건, 48h 내 sol 502 42건
- Goal: transient 5xx 1회당 Task 즉사 → 프록시/클라이언트 재시도로 흡수
- Non-goals: mid-stream blind replay·커서 resume(업스트림 커서 부재로 불안전,
  relay.ts fail-closed 계약 유지), WebSocket 전송 전환, 라이브 ocx 재시작, git push
- Verifier: `bun test --isolate ./tests/` exit 0 + 신규 activation 테스트 + 임시 포트 스모크
- Stop: 5개 수락 기준(goalplan cr1~cr5) 충족 or BLOCKED/NEEDS_HUMAN/BUDGET_EXHAUSTED
- Memory artifact: 이 devlog 유닛 + goalplan ledger
- Bounds: repo-local 쓰기(src/, tests/, devlog/), 신규 외부 의존성 금지, ~3h wall-clock

## Phase map (dependency-ordered)

| Phase | Doc | 내용 | 의존 |
|---|---|---|---|
| WP1 | 010_prestream_retry.md | upstream-retry.ts에 transient-5xx 분류/재시도 헬퍼 추가 + responses.ts passthrough 적용 | — (foundations: 분류 헬퍼가 020의 입력) |
| WP2 | 020_529_mapping.md | claude-messages.ts 에러 봉투 + outbound.ts SSE fail을 transient일 때 529/overloaded_error로 | 010의 `isTransientUpstreamStatus` 재사용 |
| WP3 | 030_5xx_persistence.md | request-log→usage.jsonl 영속 항목에 실패 진단 필드 추가 | 없음 (010/020과 독립, 순서상 후행) |
| WP4 | 040_integration_verification.md | 전체 스위트 + activation 증거 + 임시 포트 스모크 + NEEDS_HUMAN 보고 | 010–030 |

각 WP = 한 번의 완전한 PABCD 사이클. 두 decade doc를 한 B에서 구현하지 않는다.

## 사실 기반 앵커 (P에서 검증한 현재 코드)

- `src/lib/upstream-retry.ts`: 연결 리셋 전용 재시도. `retryBackoffDelayMs`는 이미
  Retry-After 지원, `cancelResponseBodyBestEffort`/`sleepWithAbort` 존재 → 010은 재조립이다.
- `src/server/responses.ts` passthrough 분기(~line 697): `fetchWithResetRetry(() =>
  fetchWithHeaderTimeout(...))` 후 상태 무검사로 헤더/quota 처리 진행.
- `src/server/claude-messages.ts` `if (!response.ok)`(~line 449): OpenAI 봉투를
  `anthropicErrorBody(response.status, message)`로 재조립, status 보존.
- `src/claude/outbound.ts` `anthropicErrorType`: 529→overloaded_error, 504→timeout_error,
  기타 5xx→api_error. SSE `response.failed`/EOF 트렁케이션은 `fail(502|500, msg)`.
- `src/server/request-log.ts` `addRequestLog`(~line 83): 링버퍼 push +
  `appendUsageEntry`(usage.jsonl). errorCode/terminalStatus/closeReason/upstreamError는
  링버퍼 항목에만 있고 영속 항목에서 탈락 — 260716 사건 판별 불가의 직접 원인.
- 테스트: `bun test --isolate ./tests/`, 기존 `tests/claude-messages-endpoint.test.ts`,
  `tests/claude-outbound.test.ts`, `tests/claude-native-passthrough.test.ts` 참조 패턴.

## 검증 매트릭스 (C-ACTIVATION-GROUNDING-01)

| 조건 경로 | 발화 시나리오 | 관측 |
|---|---|---|
| pre-stream 5xx 재시도 | mock upstream: 1회차 502 → 2회차 200 SSE | 클라이언트 200 수신 + fetch 호출 수 2 assertion |
| 재시도 소진 | mock upstream: 연속 502 × attempts | 클라이언트 529 + overloaded_error 봉투 |
| 비-transient 비재시도 | mock 400/401 | 1회 호출, 원 status 보존 |
| SSE fail transient 매핑 | mock 200 SSE 후 response.failed(status 502) | Anthropic error 이벤트 type=overloaded_error |
| 실패 영속화 | 502 항목 addRequestLog | usage.jsonl 라인에 errorCode/upstreamError 존재 |
