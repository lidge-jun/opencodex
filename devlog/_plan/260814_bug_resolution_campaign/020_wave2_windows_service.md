# 020 — Wave 2: Windows Service and Ownership

선행: Wave 1 (#1674 머지 필수)
이슈: #1296, #1612, #1059
PR: #1647, #1626

## 목표

Windows 서비스 lifecycle, process cleanup, scheduler 설치 경로를
안전한 순서로 고정한다.

## 실행 순서

### Step 1: #1647 rebase + behavior test + 병합

- 선행: #1674 머지 완료
- 현재 문제: source regex 테스트만으로는 부족
- 변경:
  - MODIFY: src/cli/tray/ (또는 서비스 wrapper 관련)
    - service wrapper가 이미 살아있는 proxy를 감지하면 exit 0
  - NEW: tests/windows-service-cleanup.test.ts (또는 기존 테스트에 추가)
    - behavior-level process cleanup 테스트:
      1. 정확한 OpenCodex home token을 가진 wrapper만 종료
      2. 다른 home의 wrapper는 종료하지 않음
      3. 단순 substring 일치로 잘못 종료하지 않음
      4. stop 이후 wrapper가 proxy를 다시 spawn하지 못함
    - process enumeration/termination seam 필요
- 검증: Windows CI + behavior test green

### Step 2: #1626 rebase + 병합

- 선행: #1674, #1678 머지 완료
- 변경: src/cli/windows-service/ (또는 scheduler 관련)
  - MODIFY: fresh scheduler install 시 native service 제거
- 검증: Windows Service lifecycle + security review
- 보안 리뷰 필요 (MAINTAINERS.md)

### Step 3: #1296 별도 PR

- 이슈: ACL/filesystem 실패를 401 authentication_error로 잘못 분류
- 변경:
  - MODIFY: src/server/ (error taxonomy)
    - Windows ACL 실패 -> 적절한 filesystem/permission 오류 코드
    - 401은 실제 authentication 실패에만 사용
  - NEW: tests/windows-acl-error-taxonomy.test.ts
- 이 PR은 기존 열린 PR이 아닌 새로 만들어야 함

### Step 4: #1612 별도 PR

- 이슈: Docker foreground start가 systemd ownership 판정 불가 시 native 요청 차단
- 변경:
  - MODIFY: src/server/ (ownership 판정)
    - foreground/external supervisor 모드 명시적 모델링
    - systemd 없는 환경에서도 foreign ownership과 구분
  - NEW: tests/docker-foreground-ownership.test.ts

### 참고: #1059 (Windows full suite)

- 이 Wave에서 직접 해결하지 않음
- Wave 6 (CI/Bun 1.4)에서 release gate로 운영
- 이 Wave의 모든 Windows PR이 1.3.14와 1.4.x matrix로 검증되어야 함

## 이 Wave 완료 조건

- #1647, #1626 dev에 머지됨
- #1296, #1612용 새 PR 생성 및 머지됨
- Windows 실기에서 service lifecycle smoke 통과
- #1296, #1612 이슈 종료됨
