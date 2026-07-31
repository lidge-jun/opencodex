# 010 — Bug 이슈 초안 (등록용 최종 문안)

제목: `[Bug]: Windows 서비스 설치 시 콘솔 창이 표시되고, 창을 닫으면 프록시가 죽어 모든 모델 연결이 끊김`
라벨: `bug`

---

## Summary

Windows에서 `ocx service install`로 서비스를 설치하면 Task Scheduler 태스크가 `opencodex-service.cmd` 래퍼를 실행하는데, 이 래퍼의 cmd 콘솔 창이 사용자 화면에 그대로 표시됩니다. 사용자가 이 창을 닫으면 래퍼와 프록시가 함께 종료되고, Codex가 바라보는 localhost 프록시가 사라져 라우팅되는 **모든** 모델(GPT 계열 포함)이 disconnect 됩니다. 커뮤니티 제보에서 시작된 문제로, "서비스로 설치했는데 cmd 창이 뜨고, 작업 스케줄러에서 '로그인하지 않아도 실행'으로 바꾸고 비밀번호를 넣어야 창이 사라진다"는 정확한 관찰도 함께 보고되었습니다.

원인은 세 요소의 조합입니다.

1. `buildWindowsTaskXml()`이 태스크를 `<LogonType>InteractiveToken</LogonType>`으로 등록해 사용자의 대화형 세션에서 실행됩니다 (`src/service.ts` 352행 부근).
2. Task action이 콘솔 프로그램인 `.cmd` 배치를 직접 실행합니다 (같은 파일 375행 부근, `<Command>`가 래퍼 `.cmd`). 대화형 세션 + 콘솔 서브시스템 조합이라 창이 보입니다.
3. 창을 숨기는 hidden-launch 메커니즘이 없습니다. `<Hidden>`은 Task Scheduler UI 목록 숨김 설정일 뿐 콘솔 창과 무관하고(MS Learn TaskSettings.Hidden), `windowsHide: true`는 opencodex가 `schtasks.exe`를 호출할 때만 적용되어 등록된 태스크의 실행 창에는 영향이 없습니다. 래퍼 스크립트의 "runs in its own hidden console" 주석(`src/service.ts` 298행 부근)은 실제 동작과 모순됩니다.

창을 닫으면 Windows가 해당 콘솔의 모든 프로세스에 `CTRL_CLOSE_EVENT`를 보내고 기본 핸들러가 프로세스를 종료합니다(MS Learn HandlerRoutine). 래퍼가 Bun을 동기 실행하므로(`"%OCX_BUN%" "%OCX_CLI%" start`) 래퍼와 프록시가 같은 콘솔 수명에 묶여 함께 죽고, 배치 내부의 5초 재시작 루프도 배치 자체가 죽어 무력화됩니다.

`ocx stop`으로 정상 종료하면 서비스 매니저 중지 → graceful drain → 네이티브 Codex 복원까지 완결되므로 문제가 없습니다. 문제는 콘솔 창 닫기류(창 X 버튼이 대표 재현이며 세션 logoff, 작업 관리자 강제 종료도 같은 계열)의 강제 종료 경로에만 있습니다.

**미검증 항목(needs verification)**: 이 강제 종료가 Task Scheduler에 "task failure"로 기록되어 `RestartOnFailure`(PT1M x3)가 발동하는지는 아직 Windows 실측으로 확인하지 못했습니다. 공식 문서는 RestartOnFailure가 task failure 시 동작한다고만 정의합니다. 확인이 필요한 관측 항목: `schtasks /query /v`의 `LastTaskResult`, `Microsoft-Windows-TaskScheduler/Operational` 이벤트 로그, 래퍼/자식 PID, 프록시 health, 창 닫기 후 PT1M 경과 시 재시작 여부.

기대 동작:

- 서비스 모드에서 콘솔 창이 사용자에게 보이지 않아야 합니다.
- 사용자가 실수로 서비스 프로세스를 종료해도 프록시가 살아 있거나 자동 복구되어야 합니다.

창 없는 실행 모드 설계(S4U 전환 vs WinSW 채택 트레이드오프)는 별도 Feature 이슈로 분리해 제안합니다.

## Reproduction

1. Windows 11에서 `ocx service install` 실행.
2. Task Scheduler 태스크 `opencodex-proxy`가 로그온 트리거로 실행되면서 cmd 콘솔 창이 화면에 표시되는 것을 확인.
3. 해당 콘솔 창을 X 버튼으로 닫음.
4. Codex에서 아무 모델(GPT 포함)로 요청 → 프록시 부재로 연결 실패.
5. `ocx stop`으로 종료한 경우에는 4의 문제가 발생하지 않음(정상 복원 경로).

## Logs and screenshots

```shell
# 커뮤니티 제보 요지 (2026-07-15):
# - 서비스 설치 후에도 cmd 창이 떠 있음
# - 콘솔 창을 닫으면 모든 모델(GPT 포함)이 disconnect
# - Task Scheduler에서 "Run whether user is logged on or not"로 바꾸면 창이 사라짐
```

## Area

CLI

## Version

2.7.25

## OS

Microsoft Windows 11 (커뮤니티 제보 기준; InteractiveToken 등록은 모든 Windows 설치에 해당)

## Config shape

특정 provider/routing 설정과 무관합니다. `ocx service install` 기본 경로에서 발생합니다.

## Checks

- [x] 기존 이슈와 문서를 먼저 검색했습니다. (#30 graceful drain, #63 WSL 지원과는 별개 문제)
- [x] 로그와 진단 정보에서 비밀 값, 토큰, 사용자명 및 개인 경로를 제거했습니다.

---

참고 출처:

- https://learn.microsoft.com/en-us/windows/console/handlerroutine
- https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-hidden
- https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-logontype-simpletype
- https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-restartonfailure-settingstype-element
