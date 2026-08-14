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
