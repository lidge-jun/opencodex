# 001 — Windows 서비스 콘솔 창 문제: 근본 원인 조사

2026-07-20. 트리거: DC 갤러리 제보(2026-07-15) — "closing the proxy's console
window can make every model (even gpt models) disconnect". 댓글에서 이미 원인
후보("작업스케줄러에서 로그인하지 않아도 실행으로 바꾸면 창 사라짐", "애초에 진짜
서비스로 설치된 게 아니라서", "nssm으로 등록하면 해결될 듯")가 지목됨.

## 1. 증상과 재현 경로

1. Windows에서 `ocx service install` 실행.
2. Task Scheduler 태스크 `opencodex-proxy`가 로그온 트리거로
   `~/.opencodex/opencodex-service.cmd`를 실행 → **cmd 콘솔 창이 화면에 보임**.
3. 사용자가 그 창을 X로 닫음 (대표 재현 경로; 세션 logoff, 작업 관리자 종료도
   같은 계열의 강제 종료).
4. Windows가 해당 콘솔에 연결된 모든 프로세스에 `CTRL_CLOSE_EVENT`를 보내고,
   기본 핸들러는 프로세스를 종료한다.
   출처: https://learn.microsoft.com/en-us/windows/console/handlerroutine
5. 래퍼 배치는 Bun을 **동기 실행**하므로(`"%OCX_BUN%" "%OCX_CLI%" start`,
   src/service.ts:320) 래퍼와 프록시 자식이 같은 콘솔 수명에 묶여 함께 죽는다.
   배치 내부의 5초 재시작 루프(:325 `ping -n 6`)는 배치 자체가 죽으므로 무력.
6. Codex가 바라보는 localhost 프록시가 사라짐 → 라우팅되는 **모든** 모델(GPT
   포함)이 disconnect. 프록시 주입 상태에서는 GPT 요청도 프록시를 경유하기 때문.

**needs-verification (Windows 실측 필요)**: 이 강제 종료가 Task Scheduler에서
"task failure"로 기록되어 `RestartOnFailure`(PT1M x3, src/service.ts:368-371)가
발동하는지는 미확인이다. 공식 문서는 RestartOnFailure가 task failure 시 동작한다고만
정의한다. 관측 항목: `schtasks /query /v`의 `LastTaskResult`, TaskScheduler
Operational 이벤트 로그(Microsoft-Windows-TaskScheduler/Operational), 래퍼/자식
PID 추적, 프록시 health 엔드포인트, 창 닫기 후 PT1M 경과 시 재시작 여부.
출처: https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-restartonfailure-settingstype-element

## 2. 근본 원인 (조합)

세 요소의 조합이며, 어느 하나 단독이 아니다:

| # | 요소 | 코드 위치 |
|---|------|-----------|
| a | `<LogonType>InteractiveToken</LogonType>` — 태스크가 사용자의 대화형 세션에서 실행됨 ("Run only when user is logged on") | src/service.ts:352 |
| b | Task action이 콘솔 프로그램인 `.cmd` 배치를 **직접** 실행 — 대화형 세션 + 콘솔 서브시스템 = 보이는 콘솔 창 | src/service.ts:375 (`<Command>` = wrapper .cmd) |
| c | 창을 숨길 hidden-launch 메커니즘 부재 (VBS/PowerShell `-WindowStyle Hidden` 런처, conhost 분리 등 없음) | — |

흔한 오해 배제:

- `<Hidden>`(src/service.ts:365, 현재 `false`)은 Task Scheduler **UI 목록**에서
  태스크를 숨기는 설정일 뿐, 콘솔 창과 무관하다.
  출처: https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-hidden
- `windowsHide: true`(src/service.ts:251 `runFile`)는 opencodex가 `schtasks.exe`를
  **관리 호출**할 때만 적용된다. 등록된 태스크가 나중에 실행하는 창에는 영향 없음.
- 래퍼 스크립트의 "The wrapper runs in its own hidden console" 주석
  (src/service.ts:298)은 실제 동작과 모순된다 — InteractiveToken에서는 hidden이
  아니다.
- LogonType 참고: https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-logontype-simpletype

## 3. `ocx stop`과의 대비 (왜 stop은 문제없나)

`ocx stop`(src/cli/index.ts:267 이후 `handleStop`)은:

1. `stopServiceIfInstalled()` — 서비스 매니저를 먼저 멈춰 respawn 차단
2. `stopProxy(pid)` — management-API drain 우선의 graceful 종료
   (Windows에서 shutdown 핸들러가 실제로 도는 유일한 경로, taskkill /F는 내부 폴백)
3. `restoreNativeCodex()` + `revertSystemEnv()` — Codex 원상 복원

즉 정상 종료 경로는 완결적이다. 문제는 오직 콘솔 창 닫기류의 강제 종료 경로.

## 4. 대안 비교

| 옵션 | 창 제거 | 성격 | 제약/비용 |
|------|---------|------|-----------|
| A. LogonType `S4U` | O (비대화형 실행) | 최소 diff 후보 | batch-logon 권한 필요, 네트워크 자격증명/EFS 접근 불가, 현재 XML에 명시적 `UserId` 없음 → 단순 교체 안정성 미검증, MS 계정 passwordless 등록 호환성 미확인 |
| B. WinSW 래퍼 | O (진짜 SCM 서비스) | 구조적 해법 | 바이너리 동봉/배포 비용, 서비스 등록에 관리자 권한, stable v2.12.0(2023) / 3.x는 prerelease 계열 |
| C. NSSM 래퍼 | O | 커뮤니티 제안 | 동작하지만 공식 정식판 2.24(2014-08-31), 추천 prerelease도 2017년 — 신규 채택엔 WinSW 대비 열위 |
| D. sc.exe 단독 | — | 부적합 | Node/Bun 프로세스가 SCM 핸드셰이크(서비스 컨트롤 프로토콜)를 구현하지 않음 |
| 참고. VBS/PS hidden 런처 | O (창 숨김만) | 증상 완화 | 프로세스 수명 문제(창 닫기 사망)는 창 자체가 없어져 소멸하나, 진짜 서비스는 아님 |

S4U 검증 매트릭스 (옵션 A 채택 전 필수):

- 로컬 계정 / Microsoft 계정(passwordless) 각각에서 `schtasks /create /xml` 등록 성공 여부
- `Log on as a batch job` 권한이 기본 부여되는지 (일반 사용자/기업 GPO 환경)
- 래퍼가 쓰는 `%USERPROFILE%`/`%APPDATA%` 환경 간접화(src/service.ts:273,303)가
  S4U 세션에서 올바르게 해석되는지
- token 파일 읽기(src/service.ts:168 계열, ACL hardened 경로) + 로그 쓰기 정상 여부
- EFS 암호화 홈, UNC/custom `OPENCODEX_HOME`, 기업 인증 프록시 환경

출처:

- https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks
- https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-logontype-simpletype
- https://www.nssm.cc/download
- https://github.com/winsw/winsw / https://github.com/winsw/winsw/releases

## 5. 현재 코드가 이미 갖춘 것 / 빠진 것

이미 있음:

- 중복 인스턴스 방지: `<MultipleInstancesPolicy>IgnoreNew</...>` (src/service.ts:357)
- 실패 재시작: `<RestartOnFailure>` PT1M x3 (:368-371) — 단 창-닫기 시 발동 여부는 §1의 needs-verification
- 크래시 루프: 래퍼 배치의 5s 재시작 루프 (:319-327, `timeout` 대신 `ping` 지연)
- 자산 재작성 내성: `writeServiceAssetWithRetry` (EBUSY/EPERM/EACCES 재시도)
- 스테일 경로 진단: `bakedServicePathsDiagnostic` (npm prefix/nvm 이동 감지)
- 서비스 재시작 시 Codex 설정 비복원: `OCX_SERVICE=1` 계약

빠진 것:

- 창이 보이지 않고, 창 닫기로 죽일 수 없는 실행 모드
- 강제 종료 후 자동 복구 보장 (실측으로 확인 필요)

## 6. 후속 코드 유닛의 SoT 갱신 대상 (이번 유닛에서는 미변경)

- README.md:65 지원 플랫폼 표 ("Fully supported" 문구에 Windows known limitation 주석)
- README.md:237 "starts on boot" — 실제는 logon trigger(src/service.ts:345-348)
- docs/codex-path-investigation.md Windows 서비스 절 (S4U/WinSW 채택 시)
