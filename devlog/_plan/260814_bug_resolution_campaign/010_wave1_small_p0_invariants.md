# 010 — Wave 1: Small P0/P1 Invariant Fixes

선행: 없음 (첫 Wave)
이슈: #1589, #1573, #1601, #1582, #1661, #1580
PR: #1674, #1677, #1680, #1678, #1673, #1636, #1675, #1638, #1617

## 목표

작고 명확한 correctness fix를 dev에 먼저 고정해서
이후 대형 PR rebase의 기준선을 만든다.

## 실행 순서

### Step 1: #1674 병합

- 상태: APPROVE, CI green, mergeable
- 변경: src/cli/windows-powershell.ts (또는 해당 파일)
  - MODIFY: direct PowerShell child argv에서 -WindowStyle Hidden pair 제거
  - 유지: Bun의 windowsHide, 내부 Start-Process, VBS/.NET 기반 숨김 동작
- 검증: exact-head Cross-platform CI + React Doctor 성공
- 이슈 종료: #1589 (Fixes 자동 종료 확인 + Windows smoke)

### Step 2: #1677 병합

- 상태: COMMENT (코드 차단점 없음), Actions action_required
- 변경: src/server/responses/ (또는 해당 encrypted payload 처리 파일)
  - MODIFY: 재귀적 순회 -> explicit stack 기반 순회
  - 유지: post-order normalization, 배열 splice 의미
- 검증: Actions 승인 -> CI green -> 병합
- 보안: deep encrypted payload recursion (30,000-depth stack overflow) 제거

### Step 3: #1680 병합

- 상태: COMMENT (코드 차단점 없음), Actions action_required
- 변경: src/adapters/cursor/ (또는 해당 tool call 처리 파일)
  - MODIFY: malformed arguments를 빈 {}로 바꾸던 경로 -> fail closed
  - 추가: freeform tool의 request-local advertised catalog + {input:string} wrapper 검증
- 검증: Actions 승인 -> CI green -> 병합

### Step 4: #1636 fixup + 병합

- 상태: REQUEST_CHANGES (테스트 보강 필요)
- 기존 변경: src/server/ (Bun.serve listeners)
  - MODIFY: maxRequestBodySize를 256 MiB로 설정
- 추가 필요:
  - NEW: tests/server-body-limit.test.ts (또는 기존 테스트 파일에 추가)
    - 128 MiB 초과 fixture 또는 Bun.serve options seam 주입
    - public + loopback 두 리스너 모두 검증
    - maxRequestBodySize 제거 시 반드시 실패
    - 256 MiB 초과는 OpenCodex typed 413 경로 확인
- 검증: fixup commit 후 CI green
- 이슈 종료: #1601

### Step 5: #1582 새 PR

- 이슈: custom base URL에 /v1/chat/completions가 이미 포함되어 있을 때 suffix 중복
- 변경:
  - MODIFY: src/adapters/openai-chat.ts (또는 URL builder)
    - URL이 이미 /v1/chat/completions로 끝나면 suffix 추가하지 않음
  - NEW: tests/openai-chat-url-dedup.test.ts
    - custom baseUrl + suffix 중복/비중복 케이스
- 검증: focused test + CI green

### Step 6: #1678 rebase

- 상태: REQUEST_CHANGES, #1674 선행 필요
- 실행: #1674 머지 후 최신 dev 위에 rebase
  - 유지: deterministic UTF-16LE -> Base64 PowerShell output
  - 유지: bounded locale fallback decoder
  - 제거: direct -WindowStyle Hidden argv pair (#1674에서 이미 제거됨)
- fixup commit: fix(windows): preserve deterministic output without WindowStyle argv
- 검증: 한국어 Windows 실기 검증
  - ocx service repair -> ocx sync -> scheduled-task ownership -> LocalAppData/coordinator
- 이슈 종료: #1573

### Step 7: #1673 rebase + 병합

- 변경: src/adapters/cursor/ (unified exec tool filtering)
  - MODIFY: generic tool filtering에서 unified exec bridge 보존
- 검증: rebase 후 Cursor 전체 집중 suite
- 이슈 종료: #1661

### Step 8-10: 독립 소형 PR

- #1675: body-read timeout rebase + 병합
- #1638: DST 회귀 테스트 추가 + rebase + 병합 -> #1580 종료
- #1617: packaging symlink 수정 rebase + 병합

## 이 Wave 완료 조건

- #1674, #1677, #1680, #1636, #1678, #1673 모두 dev에 머지됨
- #1582 새 PR 생성 및 머지됨
- #1675, #1638, #1617 머지됨
- 이슈 #1589, #1573, #1601, #1582, #1661, #1580 종료됨
- typecheck + 전체 테스트 green
