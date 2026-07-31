# 040 — 구현 로드맵: 창 없는 Scheduler 기본 + WinSW --native 옵트인

2026-07-20 확정 (사용자 승인 + sol 아키텍처 검토 반영). 대상 이슈: #165(버그), #166(개선).

## 확정 방향 (sol 검토 결론 채택)

1. **기본값 유지+수리**: `ocx service install`은 Task Scheduler + `InteractiveToken`을
   유지하되, 콘솔 창이 생기지 않는 hidden 런처로 실행한다. 자격증명 불요 —
   passwordless Microsoft 계정 호환성 유지. #165의 두 증상(창 노출, 창 닫기 사망) 중
   창 자체를 제거해 둘 다 해소.
2. **옵트인 네이티브**: `ocx service install --native`가 WinSW 2.12.0(NET461 빌드)로
   진짜 SCM 서비스를 사용자 계정으로 등록. LocalSystem 금지(ACL hardening이 사용자
   SID에만 grant — SYSTEM ACE 없음). `--scheduler`는 명시적 기본 backend 지정.
3. **영속화**: service-state.json v2에 backend 선택을 기록하고 `ocx update`의 서비스
   재설치가 그 backend를 보존한다. UAC 거부 시 조용한 다운그레이드 금지.
4. **승격 보류**: WinSW를 기본값으로 승격하는 것은 Windows 실측 매트릭스 통과 후의
   별도 결정 — 이 루프의 범위 밖.

## Work-phase 의존 순서 (PHASE-SPLIT-01)

| WP | Doc | 내용 | 의존 |
|----|-----|------|------|
| WP2 | 050 | hidden 런처 (기본 경로 창 제거) | 없음 — 현행 자산 위에 최소 확장 |
| WP3 | 060 | WinSW `--native` 옵트인 + state v2 스키마/accessor | 050의 자산 기록 패턴 재사용; CLI 인자 파싱은 060에서 도입 |
| WP4 | 070 | update 양경로 backend 전파 + 고아/충돌 탐지 + SoT + #166 댓글 | 060의 state v2/accessor 위에 전파 |

효과 크기가 아니라 빌드 순서다: 런처(공용 자산 계층) → 신규 backend → backend 선택의
영속/전파.

## macOS 개발 제약 — 검증 전략

이 머신은 macOS다. Windows 동작 실측(창 미노출, schtasks /end 트리 종료, WinSW
graceful stop, passwordless 계정 등록)은 불가능하므로:

- C 게이트는 **단위테스트(tests/service.test.ts 확장) + `bunx tsc --noEmit`** 를
  기준으로 한다. 생성물(XML/스크립트)의 문자열 계약을 테스트로 고정.
- Windows 실측이 필요한 항목은 각 decade doc의 "실측 매트릭스" 절에 명시하고,
  WP4에서 #166 댓글에 실측 요청 목록으로 게시한다.
- 기존 스위트 선례: `tests/service.test.ts`의 "Windows service task" describe가
  XML 설정/이스케이프/BOM 계약을 이미 문자열 수준에서 검증 (170-313행).

## 실측 매트릭스 (Windows 사용자/후속 확인 필요 항목 합본)

1. hidden 런처: 창 미노출, `schtasks /run` 정상 기동, `schtasks /end` 후 프록시
   드레인 경로 정상, 로그 기록.
2. WinSW: 설치 UAC 흐름, 사용자 계정 자격증명 프롬프트, passwordless MS 계정에서의
   실패 모드(명확한 에러), SCM stop의 graceful drain(Ctrl+C 시그널이 Bun 프로세스에
   전달되는지), 부팅 시작.
3. update: backend 보존 재설치, 스테일 자산 진단.

## 커밋/게이트 규칙

- WP별 로컬 커밋(LOOP-GIT-01), push 금지.
- 각 구현 WP: sol 리뷰어 감사(A) → 구현(B) → `bunx tsc --noEmit` + `bun test
  tests/service.test.ts` (+ 영향 스위트) (C) → 커밋+요약(D).
- `gui/src/pages/Models.tsx` dirty 보존.
