# 030 — Wave 3: Cursor Fixes

선행: Wave 1 (#1680, #1673 머지 필수)
이슈: #1388, #1527, #1661
PR: #1634 (분할), #1623 (분할)

## 목표

Cursor tool/continuation/edit 경로의 correctness fix를
대형 architecture PR에 묶이지 않게 단계적으로 고정한다.

## 실행 순서

### Step 1: #1634 분할 PR 1 - path/envelope normalization

- 원본 PR #1634에서 추출
- 변경:
  - MODIFY: src/adapters/cursor/ (path normalization)
    - structured-edit의 envelope/path normalization만 추출
  - NEW: tests/cursor-envelope-normalization.test.ts
- 검증: Cursor focused suite green

### Step 2: #1634 분할 PR 2 - sequential edit folding

- 변경:
  - MODIFY: src/adapters/cursor/ (edit folding)
    - sequential multi_edit fold
  - NEW: tests/cursor-sequential-edit.test.ts
- 검증: Cursor focused suite green

### Step 3: #1634 분할 PR 3 - recoverable converter rejection

- 변경:
  - MODIFY: src/adapters/cursor/ (converter rejection)
    - recoverable converter rejection
  - NEW: tests/cursor-converter-rejection.test.ts
- 검증: Cursor focused suite green
- 주의: #1388은 계속 열어 둔다 (host exact-match/mid-turn drift recovery 미해결)

### Step 4: #1527 조사

- 바로 코드부터 넣지 않는다
- official Cursor와 OpenCodex의 동일 thread request shape 비교
- 측정 항목:
  - serialized prompt bytes
  - cache reuse
  - per-turn upstream 비용
- teardown 문제 (정상 완료를 aborted/expectedClose:false로 기록)는
  별도 작은 PR로 먼저 고친다

2026-08-18 로컬 조사/prototype 메모 (fix/cursor-checkpoint-continuation, 아직 upstream PR 아님):

- 병목의 1차 원인은 JSON 포맷 자체가 아니라, 매 턴 rootPromptMessages/conversationTurns로
  과거 대화를 다시 만드는 full replay semantics다.
- ConversationStateStructure checkpoint를 다음 conversationState로 재사용하면 no-tool
  follow-up에서 로컬 rootBytes가 history와 같이 커지지 않는다. grok-4.6 live 3턴에서
  2·3턴이 continuationMode=checkpoint였고 ALPHA-7을 기억했다.
- 공식 cursor-agent 같은 계정 대조: 1턴 cacheReadTokens 0 / input 18937, 같은 세션 2턴
  cacheReadTokens 18816 / 새 input 331 / 답 ALPHA-7. OpenCodex Cursor wire는 usedTokens만
  주므로 이쪽 usage로 cache hit를 주장하면 안 된다.
- tool-result는 마지막 정상 완료 턴 checkpoint + suffix replay가 live에서 동작했다.
  client-tool suspend 턴 자체는 온전한 checkpoint가 없어 commit하지 않는다.
- 아직 미해결: 큰 context / 429 / kimi-k3 premature completion 재현, stateful live MCP
  bridge, 정상 완료 teardown을 aborted로 분류하는 별건.

### Step 5: #1623 분할 (behavior fix 안정화 후)

1. refactor/adapter-registry-authority
   - behavior 변화 없는 registry/factory authority 정리
2. test/adapter-conformance-harness
   - registry-derived generic conformance
3. fix/apply-patch-production-hardening
   - 실제 apply_patch production hardening

이 단계는 Step 1-3의 behavior fix가 dev에 안정된 뒤에 시작한다.

## 이 Wave 완료 조건

- #1634의 3개 분할 PR 모두 dev에 머지됨
- #1527 조사 결과 + teardown fix PR 머지됨
- #1623의 3개 분할 PR 모두 dev에 머지됨
- #1388은 열린 상태로 유지 (host exact-match recovery는 이 Wave 범위 밖)
- Cursor 전체 focused suite green
