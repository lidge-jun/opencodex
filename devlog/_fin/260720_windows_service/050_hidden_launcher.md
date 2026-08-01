# 050 — WP2: 기본 Task Scheduler 경로 창 제거 (hidden 런처)

## 목표

`ocx service install`(기본 backend)이 등록하는 태스크가 콘솔 창 없이 실행되게 한다.
`InteractiveToken`은 유지(자격증명 불요, passwordless 계정 호환). #165의 직접 수리.

## 메커니즘 선택

**wscript.exe + .vbs 런처** 채택. 근거:

- `wscript.exe`는 GUI 서브시스템 실행파일이라 태스크가 직접 실행해도 콘솔이 생기지
  않고, VBS가 `WshShell.Run cmd, 0, True`로 배치를 **창 스타일 0(숨김)** 으로 띄운다.
  `bWaitOnReturn=True`(상주 런처)가 핵심: wscript가 배치 종료까지 살아 있어야
  태스크 인스턴스가 실행 중으로 남고 `MultipleInstancesPolicy=IgnoreNew`(중복 방지)와
  `schtasks /end`의 대상이 유지된다. `False`면 wscript가 즉시 종료해 태스크가 끝난
  것으로 보이고 중복 방지가 무력화된다(감사 blocker 1). 실측 항목: `/end`가 wscript만
  죽이는지 자손 트리까지 죽이는지 — MS 문서는 "task가 시작한 프로그램 인스턴스 중지"
  까지만 보장.
- PowerShell 대안 기각: `powershell.exe` 자체가 콘솔 앱이라 태스크가 직접 실행하면
  창이 뜨거나 깜빡이고, `-File`은 클라이언트 기본 ExecutionPolicy(Restricted)에
  막힌다.
- 숨김 실행이므로 창 닫기 사망 경로 자체가 소멸. 배치의 5s 재시작 루프는 그대로
  동작(숨김 콘솔 안에서).
- 실측 필요(문서화): 기업 정책이 WSH를 비활성화한 환경(레지스트리
  `Software\Microsoft\Windows Script Host\Settings\Enabled=0`)에서는 태스크가
  실행되지 않음 — status 진단에 힌트 추가, 실측 매트릭스에 포함.

## Diff-level 변경 (src/service.ts)

1. **NEW** `windowsLauncherVbsPath(): string` — `join(getConfigDir(), "opencodex-service-launcher.vbs")`.
   (windowsServiceScriptPath/windowsTaskXmlPath 옆, :45 부근)
2. **NEW** `export function buildWindowsLauncherVbs(script = windowsServiceScriptPath()): string` —
   내용:
   ```vbs
   ' OpenCodex service launcher — runs the batch wrapper with a hidden window.
   Set shell = CreateObject("WScript.Shell")
   shell.Run """<script 경로, " -> "" 이스케이프>""", 0, True
   ```
   VBS 문자열 이스케이프는 `"` → `""` 만 필요. CRLF 종결.
   **인코딩(감사 blocker 2)**: BOM-less UTF-8 금지 — 비ASCII(한글 등) 사용자 경로가
   WSH 버전/코드페이지에 따라 오독될 수 있다(`win-paths.ts` 계약과 동일 근거).
   task XML과 같은 방식으로 **UTF-16LE + BOM** 으로 기록:
   `writeServiceAssetWithRetry(path, `\uFEFF${vbs}`, "utf16le")`.
3. **MODIFY** `buildWindowsTaskXml(script)` (:339-377) — `<Exec>`를
   `<Command>C:\Windows\System32\wscript.exe</Command>` +
   `<Arguments>/b /nologo "<launcher.vbs>"</Arguments>` 로 변경 (단일 슬래시가
   현행 canonical 형식 — 감사 INFO 10). launcher 경로는 `taskXmlString()`으로
   **독립적으로 XML 이스케이프**(`&` 등 포함 경로 대비, 감사 blocker 2). 시그니처를
   `buildWindowsTaskXml(script, launcher = windowsLauncherVbsPath())`로 확장
   (테스트 주입용). `/b` = 배치 모드(스크립트 오류 팝업 억제). wscript 경로는
   `SystemRoot` 폴백 패턴(windowsSchtasks와 동일)을 helper `windowsWscript()`로.
4. **MODIFY** `installWindows()` (:421-433) — launcher.vbs를
   `writeServiceAssetWithRetry(windowsLauncherVbsPath(), `\uFEFF${buildWindowsLauncherVbs(script)}`, "utf16le")`
   로 함께 기록 (task XML 기록 직전).
5. **MODIFY** `uninstallWindows()` (:437-441) — launcher.vbs unlink 추가.
6. **MODIFY** `buildWindowsServiceScript()` 주석 (:297-299) — "runs in its own
   hidden console"을 "run hidden via the wscript launcher; chcp is safe because
   this console is never interactive"로 사실에 맞게 수정.
7. **MODIFY** `statusWindows()` 경로 진단 — `bakedServicePathsDiagnostic`은 그대로,
   `serviceDiagnosticsSummary`에 WSH 비활성 가능성 힌트는 넣지 않음(로컬에서 판별
   불가) — 대신 README/known-limitation 문구(WP4)로.

## 테스트 (tests/service.test.ts "Windows service task" describe 확장)

- `buildWindowsTaskXml`이 `<Command>...wscript.exe</Command>`와
  `/b /nologo` + 따옴표된 launcher 경로 `<Arguments>`를 담고, `&`가 든 launcher
  경로가 `&amp;`로 이스케이프된다.
- `buildWindowsLauncherVbs`가 `shell.Run` + `, 0, True`를 담고, 경로의 `"`를
  `""`로 이스케이프한다 (악의적 경로 케이스 1개) + **비ASCII(한글) 경로 케이스**.
- `install` 소스가 launcher.vbs를 `writeServiceAssetWithRetry`로 기록한다(소스 문자열
  검사 — 기존 BOM 테스트(:203-207)와 같은 방식), UTF-16LE + `\uFEFF` BOM 포함.
- uninstall 소스가 launcher 경로를 unlink한다(소스 문자열 검사).
- 기존 XML 설정 테스트(:186-201)는 그대로 통과해야 함(설정 블록 불변).

## 실측 매트릭스 (Windows)

창 미노출, `schtasks /run` 기동, WSH 비활성 환경 실패 모드, `schtasks /end` 후
wscript/배치/자식 종료 범위(트리 종료 vs 배치만 — blocker 1의 상주 런처 전제 검증),
`IgnoreNew` 중복 방지가 상주 wscript로 실제 유지되는지, 로그 연속성.

## Out of scope

`RestartOnFailure` 발동 여부 실측, S4U, WinSW(→060), state v2(→070).
