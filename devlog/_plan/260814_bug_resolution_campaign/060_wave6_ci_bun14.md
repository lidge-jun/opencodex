# 060 — Wave 6: CI and Bun 1.4 Readiness

선행: 전체 Wave 1-5 안정화
이슈: #1059, #1302, #1419, #1608
PR: #1608

## 목표

Bun 1.4 승격을 단순 version bump가 아닌 검증된 release gate로 준비한다.

## 실행 순서

### Step 1: #1059 Windows full suite burn-down

- Windows 4/4 shard 반복 green 달성
- 이전 Wave의 모든 Windows PR이 1.3.14와 1.4.x matrix로 검증
- CI에서 Windows test를 required gate로 복원

### Step 2: #1302 Linux CI hang 해결

- Linux shard hang과 orphan Bun 제거
- 단순 timeout 증가나 재실행으로 숨기지 않음
- 변경:
  - MODIFY: .github/workflows/ (CI configuration)
    - orphan process cleanup step 추가
  - 조사: Bun process가 hang하는 root cause 식별
    - test fixture leak? Bun runtime bug? network wait?

### Step 3: #1419 TLS/SIGTRAP 비교

- stable 1.4.x와 현재 bundled 1.3.14 비교
- 재현 가능하면 upstream 리포트
- OpenCodex retry 로직은 증거 없이 광범위하게 바꾸지 않음

### Step 4: #1608 upstream WebSocket buffering

- 변경:
  - MODIFY: src/server/ (또는 WebSocket handler)
    - upstream WebSocket buffering bounded
    - stalled-client와 queue overflow 실증
  - NEW: tests/websocket-buffering-bound.test.ts
- Bun 1.4 준비의 일부로 검증

### Step 5: Release suite 확장

- client-controlled resource boundary를 release suite에 포함:
  - request size (128MiB/256MiB boundary)
  - deep traversal (JSON nesting depth)
  - config depth (JSON5/YAML)
  - WebSocket queue overflow
- 이 테스트들이 release blocker로 등록

### Step 6: Bun 1.4 승격

- 위 모든 gate 통과 후에만 version bump
- 승격 순서:
  1. #1059 Windows 4/4 green
  2. #1419 TLS/reset stable 1.4.x 비교 완료
  3. #1608 stalled-client 실증
  4. #1302 hang/orphan 해결
  5. 전체 resource boundary 회귀 release suite green
  6. version bump commit

## 이 Wave 완료 조건

- Windows full suite required gate 복원
- Linux CI hang rate이 허용 수준으로 감소
- TLS/SIGTRAP이 1.4.x에서 재현되지 않거나 upstream report됨
- WebSocket buffering bounded
- Release suite에 resource boundary 테스트 포함
- Bun 1.4 version bump (또는 1.4.x에서의 regression 발견 시 보류 결정)

## 닫지 않은 이슈의 이유 (참고)

- 부분 해결: #1388 (#1634 머지 후에도 host exact-match 문제 남음)
- 상류 추적: #92, #417 (upstream close condition)
- 정보 대기: #1672, #1594 (추가 자료 필요, 14-30일 무응답시 not planned)
- 아키텍처/UX: #1478, #1533, #1049 (bug queue가 아닌 별도 큐)
