# 080 — D 요약 (구현 레인 전체, outcome: DONE)

## 무엇을 했나

이슈 #165(콘솔 창 버그)/#166(창 없는 서비스 모드) 구현 레인. 040 로드맵의
WP1-WP4를 전부 착륙.

- `77b966ca` WP2: VBS wscript 런처로 서비스 콘솔 창 숨김(기본 Scheduler 경로 수리).
  UTF-16LE+BOM VBS/XML로 비ASCII 프로필 경로 방어, 절대 wscript 경로.
- `dd40e318` WP3: opt-in 네이티브 SCM 서비스(WinSW v2.12, `--native`). SHA-256 핀
  다운로드, install /p 자격증명 프롬프트, LocalSystem 롤백 검증, state v2 스키마 +
  `readServiceBackend()`/`serviceReinstallArgs()` export.
- `733c0dd6` WP3 감사 R3: stopwait race, 트랜잭셔널 backend 전환(두 매니저 공존
  금지), 충돌 플래그 거부.
- `b2bd6ce5` WP4: update 두 경로(CLI/GUI job)의 backend 보존 재설치,
  고아/충돌 탐지(양 backend 항상 질의), README SoT 정정, #166 댓글.
- `a28aca09` push 전 감사: fail-open 라이프사이클 조임 + 회귀 게이트 assertion 수정.

## 후속 수정 (2026-07-20, 같은 레인)

- sol 최종 감사(McClintock) blocker 1: WinSW status 질의 실패가 "nonexistent"로
  매핑돼 라이브 SCM 서비스를 stop/uninstall 대상에서 제외할 수 있던
  fail-open 결함. `WinswStatus`에 `unknown` 추가, parse/질의 실패 fail-closed,
  install은 unknown에서 명시적 거부. 테스트 갱신(기존 garbage→nonexistent 락인 제거).
- PR #167 리뷰(Peirce): 서비스/재시작 본체는 dev가 상위 집합으로 커버하므로
  `updateChildStdio()`/`logSpawnOutput()` stdio 파이프만 포트(세 자식 stop/
  installer/service reinstall 전부, `serviceReinstallArgs()` 유지).
- 이슈 #168: `ocx update --help`가 실제 self-update를 실행하던 결함.
  src/cli/index.ts + bin/ocx.mjs 양 진입로에 help 단축. 실기 검증: 양쪽 모두
  usage 출력 + exit 0 + 부작용 없음.

## 증거

- focused: `bun test tests/winsw.test.ts tests/update-stop-first.test.ts
  tests/service.test.ts tests/update-job.test.ts` → 69 pass / 0 fail.
- `bunx tsc --noEmit` root+gui green.
- 전체 스위트는 로컬 병렬 실행에서 서버/포트 계열 간헐 실패가 나오나 동일 파일
  격리 실행은 전부 pass, dev CI는 a28aca09에서 all-green — 로컬 부하 플레이크로
  판정(최종 전체 재실행 결과는 푸시 전 기록).

## LOOP-PESSIMIST-01

- Windows 실기 스모크(서비스 설치/업데이트/창 닫기)는 macOS 개발 환경이라
  미실행 — #165/#166 댓글에 검증 매트릭스를 남겼고, Windows 사용자 회신이
  들어오면 후속 유닛.
- `updateChildStdio()`는 비TTY 환경에서도 pipe로 전환한다 — 출력이 완료 후
  일괄 relay되므로 대화형 진행 표시가 사라진다(부작용 허용, PR 원저자 설계).
- WinSW `unknown` 상태에서의 stop/uninstall 시도는 깨진 exe에서 추가 에러를
  낼 수 있으나, 라이브 서비스 방치보다 명시적 실패가 낫다는 판단.
