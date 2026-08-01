# 020 — Feature 이슈 초안 (등록용 최종 문안)

제목: `[Feature]: Windows에서 창 없는 백그라운드 서비스 실행 모드`
라벨: `enhancement`

---

## Problem to solve

Windows에서 `ocx service install`은 Task Scheduler 태스크를 `InteractiveToken`으로 등록하고 콘솔 배치 래퍼를 직접 실행하기 때문에, cmd 콘솔 창이 사용자 세션에 계속 표시됩니다. 사용자가 그 창을 닫으면 래퍼+프록시가 함께 죽어 모든 모델 연결이 끊깁니다(상세 진단은 연관 Bug 이슈 참조). macOS launchd·Linux systemd 사용자와 동일한 "창 없이 백그라운드에서 돌고, 실수로 죽일 수 없는" 서비스 경험이 Windows에도 필요합니다.

또한 README의 서비스 설명("starts on boot and stays out of your way")과 실제 Windows 동작(logon 트리거 + 보이는 콘솔 창)이 불일치하므로, 해결 전까지는 문서에 known limitation으로 명시할 필요가 있습니다.

## Proposed solution

옵션 A를 우선 검증하고, 검증 매트릭스를 통과하지 못하면 옵션 B로 진행하는 순서를 제안합니다.

**옵션 A — Task XML의 LogonType을 `S4U`로 전환 (최소 diff 후보)**

`buildWindowsTaskXml()`의 `<LogonType>`을 `S4U`("Run whether user is logged on or not", 비밀번호 미저장)로 바꾸면 태스크가 비대화형으로 실행되어 창이 아예 생성되지 않습니다. 커뮤니티에서 Task Scheduler UI로 "로그인하지 않아도 실행"을 수동 적용해(이때 비밀번호를 입력했으므로 정확히는 Password 로그온 타입) 창이 사라진 것이 확인되었습니다 — 즉 "비대화형 실행이면 창이 사라진다"는 증거이지, 비밀번호 미저장 S4U 자체가 검증된 것은 아닙니다.

단, 확정 채택 전에 아래 검증 매트릭스를 통과해야 합니다:

- 로컬 계정 / Microsoft 계정(passwordless)에서 `schtasks /create /xml` 등록 성공 여부 — 현재 XML에는 명시적 `<UserId>`가 없어 단순 문자열 교체의 안정성이 미검증
- 실행 계정에 `Log on as a batch job` 권한이 기본 부여되는지 (일반 사용자 / 기업 GPO 환경)
- S4U는 네트워크 자격증명·EFS 접근이 없음 — 래퍼의 `%USERPROFILE%`/`%APPDATA%` 환경 간접화, ACL hardened token 파일 읽기, 서비스 로그 쓰기가 S4U 세션에서 정상 동작하는지
- EFS 암호화 홈, UNC/custom `OPENCODEX_HOME`, 기업 인증 프록시 환경
- **엔드투엔드 확인**: S4U로 기동된 프록시에 실제 라우팅된 모델 요청을 보내 응답까지 확인 (파일/환경 체크만으로는 프록시의 핵심 아웃바운드 요청 경로가 증명되지 않음)

**옵션 B — WinSW 기반 네이티브 Windows 서비스 등록 (구조적 해법)**

WinSW로 프록시를 진짜 SCM 서비스로 등록하면 창 문제와 프로세스 수명 문제가 구조적으로 해소되고, 선언형 XML 설정·자동 재시작·로그 롤링을 얻습니다. 비용: 바이너리 동봉/배포 복잡도, 서비스 등록에 관리자 권한 필요. 릴리스 상태는 정확히: 저장소는 현재도 활동 중이나 최신 stable은 v2.12.0(2023)이고 3.x는 prerelease 계열입니다.

**수용 기준 (어느 옵션이든)**

- 서비스 설치 후 사용자 세션에 콘솔 창이 보이지 않음
- 사용자가 프로세스를 강제 종료해도 서비스 매니저가 자동 재시작 (Bug 이슈의 RestartOnFailure 실측 포함)
- `ocx service install/start/stop/status/uninstall` 계약 유지, `OCX_SERVICE=1` 재주입 계약 유지
- 중복 인스턴스 방지 유지 (현행 `MultipleInstancesPolicy=IgnoreNew` 상당)
- README 서비스 시맨틱 정정(채택 옵션에 맞게): S4U 채택 시 logon 트리거 유지를 명시, WinSW 채택 시 boot 시작 여부를 실제 구성에 맞게 서술 — 어느 쪽이든 현행 "starts on boot" 일괄 서술은 Windows에 대해 정정
- `docs/codex-path-investigation.md` Windows 서비스 절 동기화

## Alternatives considered

- **NSSM**: 커뮤니티에서 제안된 우회책이고 여전히 동작하지만, 공식 정식판이 2.24(2014-08-31)이고 추천 prerelease도 2017년이라 신규 채택 후보로는 WinSW 대비 열위입니다.
- **sc.exe 단독 등록**: Node/Bun 프로세스가 SCM 서비스 컨트롤 프로토콜을 구현하지 않으므로 부적합합니다.
- **VBS/PowerShell hidden 런처**: 창만 숨기는 증상 완화책. 창이 없어지므로 창-닫기 사망 경로도 함께 사라지지만, 진짜 서비스 시맨틱(SCM 관리, 부팅 시작)은 얻지 못합니다.
- **현상 유지 + 문서 안내**: Task Scheduler UI에서 수동으로 "Run whether user is logged on or not"를 선택하도록 안내 — 사용자마다 수동 설정이 필요하고 비밀번호 입력을 요구할 수 있어 근본 해결이 아닙니다.

## Additional context

- 연관 Bug 이슈: (등록 후 번호 링크)
- https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-logontype-simpletype
- https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks
- https://github.com/winsw/winsw / https://github.com/winsw/winsw/releases
- https://www.nssm.cc/download
