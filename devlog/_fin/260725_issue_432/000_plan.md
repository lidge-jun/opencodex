# 260725 #432 — Windows Task Scheduler stale 오탐 (조사 · 근거 · 제약)

단일 work-phase 유닛. 구현 계약은 `010_default_aware_parse.md`.
공식 스키마 근거는 `../260725_bug_sweep/001_external_evidence.md` §Windows Task Scheduler.

## 증상

정상 동작 중인 Task Scheduler 서비스를 `ocx status`와 Dashboard Startup Safety가
stale / AT RISK로 표시한다. 실제 작업과 프록시는 멀쩡히 돌아간다 (Windows 11, 2.7.39).

## 근본 원인 (코드 확인 완료)

Windows가 등록된 작업을 export할 때 스키마 기본값에 해당하는 요소를 생략한다.
OpenCodex는 XML의 유효 의미가 아니라 요소의 문자적 존재를 검사한다.

### 결함 1 — `windowsTaskRegistrationHealthy()` (`src/service.ts:476`)

```ts
  return /<Enabled>\s*true\s*<\/Enabled>/i.test(trigger)
    && /<LogonType>\s*InteractiveToken\s*<\/LogonType>/i.test(principal)
    && /<RunLevel>\s*LeastPrivilege\s*<\/RunLevel>/i.test(principal)
    && /<Enabled>\s*true\s*<\/Enabled>/i.test(settings)
```

세 가지가 동시에 깨진다.

- `taskXmlSection()`(471행)이 여는/닫는 태그 쌍을 전제하므로 `<LogonTrigger />`
  self-closing 형태에서 빈 문자열을 반환한다.
- 생략된 Trigger/Settings `<Enabled>`가 `false`로 판정된다.
- 생략된 `<RunLevel>`이 `false`로 판정된다.

### 결함 2 — `diagnoseService()`의 독립 정규식 (`src/service.ts:955`)

```ts
    const schedulerSettings = taskXmlSection(schedulerXml, "Settings");
    const schedulerEnabled = schedulerInstalled && /<Enabled>\s*true\s*<\/Enabled>/i.test(schedulerSettings);
```

**결함 1만 고치면 이쪽이 계속 `false`를 반환해 서비스가 disabled로 남는다.**
두 판정이 서로 다른 코드 경로라는 점이 이 이슈의 함정이다.

### 전파

`service.ts:897`의 `stale` 계산 → `src/codex/autostart-health.ts:127`의 `service.stale`
→ 146행이 `AT RISK after restart (background service files are stale...)`를 출력한다.

## 제약

생략은 기본값으로 해석하되, **명시된 값은 계속 정확히 검사해야 한다.** 단순히 `false`
문자열만 찾는 방식은 malformed 값까지 healthy로 통과시키므로 쓰지 않는다.

유지해야 할 검사:

- `LogonTrigger` 자체의 존재 (BootTrigger-only 작업을 healthy로 오판하지 않도록)
- 명시적 `Enabled=false`, `RunLevel=HighestAvailable` 거부
- `LogonType=InteractiveToken`, `MultipleInstancesPolicy=IgnoreNew` exact check
- `ExecutionTimeLimit=PT0S` exact check — 생략 기본값이 `PT72H`라 여기서는 생략도 진짜 불일치
- 정확한 `wscript.exe` action과 VBS launcher 인자
- asset 파일 존재, baked path, backend-state mismatch, WinSW 충돌 검사

## PR #408과의 관계

PR #408은 같은 파일에 elevation 로직을 추가하며 최신 head가 `src/service.ts`를 크게
바꿨다. `evaluateWindowsSchedulerInstallVerification()`이라는 새
`windowsTaskRegistrationHealthy()` 소비자를 추가했으므로, #432가 고쳐지지 않으면
elevated install 성공 후에도 canonicalized XML을 unhealthy로 보고 rollback할 수 있다.

이 수정은 #408을 방해하지 않고 보강한다. 다만 행번호 충돌은 실재할 수 있다.

## 검증된 사실

`windowsTaskRegistrationHealthy(xml, wscript = windowsWscript(), launcher = windowsLauncherVbsPath())`
는 두 값을 **기본 인자**로 갖는다. 따라서 새 owner 함수에서 스코프 문제가 없다.
