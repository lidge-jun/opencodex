# WP2 — #432 Windows Task Scheduler 기본값 생략으로 인한 stale 오탐

> 개정 이력: r1 초안은 A-gate에서 FAIL(스윕 전체). blocker 8(테스트가 두 번째 wiring
> 누락을 잡지 못함)과 11(PR #408 현황 stale)을 r2에서 수정했다. 공식 스키마 근거는
> `001_external_evidence.md` §Windows Task Scheduler 참조.
>
> r3: r2도 FAIL. `readWindowsSchedulerXmlState()`를 도입했지만 테스트가 여전히 결과를
> 손으로 derive에 주입하는 형태라 반쪽 수정을 못 잡고, 제안 호출의 `wscript`/`launcher`가
> 해당 스코프에 없었다.
>
> **이 문서의 코드 블록은 설계 스케치다.** 정확한 diff는 이 phase의 P에서 작성한다.

## 증상

정상 동작 중인 Task Scheduler 서비스를 `ocx status`와 Dashboard Startup Safety가
stale / AT RISK로 표시한다. 실제 작업과 프록시는 멀쩡히 돌아간다. Windows 11 + 2.7.39.

## 근본 원인

Windows가 등록된 작업을 export할 때 스키마 기본값에 해당하는 요소를 생략한다.
OpenCodex는 XML의 유효 의미가 아니라 요소의 문자적 존재를 검사한다.

`src/service.ts:471`의 섹션 추출기는 여는/닫는 태그 쌍을 전제한다.

```ts
function taskXmlSection(xml: string, tag: string): string {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml)?.[1] ?? "";
}
```

`windowsTaskRegistrationHealthy()`가 세 값을 리터럴로 요구한다.

```ts
  return /<Enabled>\s*true\s*<\/Enabled>/i.test(trigger)
    && /<LogonType>\s*InteractiveToken\s*<\/LogonType>/i.test(principal)
    && /<RunLevel>\s*LeastPrivilege\s*<\/RunLevel>/i.test(principal)
    && /<Enabled>\s*true\s*<\/Enabled>/i.test(settings)
    && ...
```

세 가지가 동시에 깨진다.

- `<LogonTrigger />`는 self-closing이라 `taskXmlSection()`이 빈 문자열을 반환한다.
- 생략된 Trigger/Settings `<Enabled>`가 `false`로 판정된다.
- 생략된 `<RunLevel>`이 `false`로 판정된다.

**두 번째 독립 오탐**이 `src/service.ts:953`에 따로 있다. 이걸 놓치면 반쪽 수정이 된다.

```ts
const schedulerEnabled =
  schedulerInstalled && /<Enabled>\s*true\s*<\/Enabled>/i.test(schedulerSettings);
```

`windowsTaskRegistrationHealthy()`만 고치면 `schedulerEnabled`는 계속 `false`이고
서비스는 여전히 disabled로 표시된다.

전파 경로는 `src/service.ts:897`의 `stale` 계산 → `src/codex/autostart-health.ts:127`의
`service.stale` → 146행의 `AT RISK after restart (background service files are stale...)`.

## 공식 스키마 근거

Trigger `Enabled`와 Settings `Enabled`는 `default="true" minOccurs="0"`, Principal
`RunLevel`은 생략 시 `LeastPrivilege`다. 출처와 상충 문서 처리 방침은
`001_external_evidence.md` §Windows Task Scheduler 참조.

## Diff-level 변경안

### `src/service.ts`

헬퍼 두 개를 `taskXmlSection()` 옆에 추가한다.

```ts
+/** Count occurrences of a tag, including self-closing forms. */
+function taskXmlElementCount(xml: string, tag: string): number {
+  return xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?\\s*\\/?>`, "gi"))?.length ?? 0;
+}
+
+/**
+ * Task Scheduler omits schema-default elements when exporting a registered task,
+ * so absence means the documented default, not a mismatch (#432). An element that
+ * IS present must still match exactly — never treat a malformed value as healthy.
+ */
+function taskXmlOptionalValueEquals(xml: string, tag: string, expected: string): boolean {
+  const elementCount = taskXmlElementCount(xml, tag);
+  if (elementCount === 0) return true;
+  const values = [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*([^<]*?)\\s*<\\/${tag}>`, "gi"))];
+  return elementCount === 1
+    && values.length === 1
+    && values[0]![1]!.trim().toLowerCase() === expected.toLowerCase();
+}
+
+/** Settings/Enabled defaults to true when omitted. */
+export function windowsTaskRegistrationEnabled(xml: string): boolean {
+  return taskXmlOptionalValueEquals(taskXmlSection(xml, "Settings"), "Enabled", "true");
+}
```

`windowsTaskRegistrationHealthy()` 본문:

```ts
-  return /<Enabled>\s*true\s*<\/Enabled>/i.test(trigger)
-    && /<LogonType>\s*InteractiveToken\s*<\/LogonType>/i.test(principal)
-    && /<RunLevel>\s*LeastPrivilege\s*<\/RunLevel>/i.test(principal)
-    && /<Enabled>\s*true\s*<\/Enabled>/i.test(settings)
+  // A self-closing <LogonTrigger /> yields an empty section, so check the element
+  // itself rather than inferring presence from its body.
+  return taskXmlElementCount(xml, "LogonTrigger") > 0
+    && taskXmlOptionalValueEquals(trigger, "Enabled", "true")
+    && /<LogonType>\s*InteractiveToken\s*<\/LogonType>/i.test(principal)
+    && taskXmlOptionalValueEquals(principal, "RunLevel", "LeastPrivilege")
+    && windowsTaskRegistrationEnabled(xml)
     && /<MultipleInstancesPolicy>\s*IgnoreNew\s*<\/MultipleInstancesPolicy>/i.test(settings)
     && /<ExecutionTimeLimit>\s*PT0S\s*<\/ExecutionTimeLimit>/i.test(settings)
     && action.includes(...)
```

`diagnoseService()`의 두 번째 오탐 (953-958행):

```ts
-const schedulerSettings = taskXmlSection(schedulerXml, "Settings");
-const schedulerEnabled =
-  schedulerInstalled && /<Enabled>\s*true\s*<\/Enabled>/i.test(schedulerSettings);
+const schedulerEnabled = schedulerInstalled && windowsTaskRegistrationEnabled(schedulerXml);
```

`schedulerSettings` 지역 변수가 다른 곳에서 쓰이지 않으면 함께 제거한다.

### 두 판정을 production owner 하나로 합친다 (blocker 8)

헬퍼만 고치면 `diagnoseService()`의 정규식 교체를 잊어도 헬퍼 테스트와 derive 테스트가
모두 통과한다. r2는 `readWindowsSchedulerXmlState()`를 도입했지만, 테스트가 그 결과를
**손으로** derive에 넣는 형태라 구멍이 그대로였다.

**요구사항**: production `diagnoseService()`가 실제로 호출하는 순수 함수 하나를 만들고,
테스트가 **그 함수를** 호출해야 한다. 그래야 production wiring을 고치지 않은 반쪽 수정이
테스트에서 실패한다.

형태(이름과 인자는 P에서 확정):

```
diagnoseWindowsServiceFromXml(xml, assetsPresent, wscript, launcher, ...) -> 진단 결과
```

- `diagnoseService()`는 XML과 파일 존재 여부만 수집해 이 함수에 넘긴다.
- 테스트는 XML 문자열을 만들어 이 함수를 직접 호출하고 `stale`/`enabled`/`viable`을 단언한다.
- `schedulerEnabled` 판정과 `registrationHealthy` 판정이 이 함수 안에서 함께 이뤄지므로
  한쪽만 고치면 테스트가 깨진다.

**P에서 확인할 것**: `wscript`와 `launcher` 값이 `diagnoseService()` 스코프에서 어떻게
얻어지는지. r2 diff는 이 두 변수가 해당 스코프에 있다고 가정했으나 확인되지 않았다.
없다면 함수 내부에서 유도하거나 기본 인자로 처리한다.

**PR #408 결합**: #408의 `evaluateWindowsSchedulerInstallVerification()`도 같은 판정을
쓰므로, 가능하면 그 경로도 이 owner를 거치게 한다. 최신 head 대조 시 함께 확인한다.

## 회귀 테스트

`tests/service.test.ts` (203행 부근의 `buildWindowsTaskXml()` + `.replace()` inline
fixture 패턴을 따른다).

1. `accepts canonicalized scheduler XML with omitted defaults`
   - `<LogonTrigger />` self-closing, Trigger/Settings `Enabled` 없음, `RunLevel` 없음
   - `windowsTaskRegistrationHealthy()` 및 `windowsTaskRegistrationEnabled()` 모두 `true`
   - 수정 전 실패: 세 리터럴 정규식과 빈 섹션 때문에 `false`

2. `rejects explicit unsafe values even when defaults may be omitted`
   - Trigger `Enabled=false`, Settings `Enabled=false`, `RunLevel=HighestAvailable`
   - 각각 `false` — 생략 허용이 명시적 비활성화까지 통과시키지 않음을 고정

3. `still requires a logon trigger`
   - `<LogonTrigger />` → `<BootTrigger />`
   - `false` — optional-default 도입이 trigger 부재를 우연히 통과시키지 않음

4. `preserves exact service lifecycle constraints`
   - `InteractiveToken→Password`, `IgnoreNew→Parallel`, `PT0S→PT72H`,
     `wscript.exe→cmd.exe`, launcher path 변경 → 전부 `false`

5. `canonicalized scheduler XML yields a healthy diagnostic` — **blocker 8 대응**
   - production owner 함수에 canonical XML(기본값 생략형)을 **직접** 넣어
     `stale:false`, `enabled:true`, `viable:true` 확인
   - 중간 결과를 손으로 주입하지 않는다. `diagnoseService()`가 이 함수를 쓰지 않으면
     production은 여전히 깨진 채이므로, P에서 `diagnoseService()`가 이 함수만 호출하도록
     리팩터링했는지 diff로 확인한다

6. `explicitly disabled task is still reported disabled`
   - Settings `Enabled=false` XML → 같은 함수가 `enabled:false`
   - 오탐 수정이 진짜 비활성화까지 통과시키지 않음을 고정

## 유지해야 할 동작

- `LogonTrigger` 자체의 존재 요구.
- 명시적 `Enabled=false` / `RunLevel=HighestAvailable` 거부.
- `LogonType=InteractiveToken`, `MultipleInstancesPolicy=IgnoreNew` exact check.
- `ExecutionTimeLimit=PT0S` exact check — 생략 기본값이 `PT72H`라 여기서는 생략도 진짜 불일치.
- 정확한 `wscript.exe` action과 VBS launcher 인자.
- asset 파일 존재, baked path, backend-state mismatch, WinSW 충돌 검사.

## PR #408과의 관계 (blocker 11 — 초안 서술은 stale이었다)

r1은 #408이 import 부근과 321-330행만 건드린다고 적었으나, **현재 head는 `src/service.ts`에
훨씬 큰 변경을 담고 있다.** 특히 `evaluateWindowsSchedulerInstallVerification()`이라는
새 `windowsTaskRegistrationHealthy()` 소비자와 전용 테스트를 추가했다.

따라서 WP2 착수 시 다음을 반드시 먼저 수행한다.

```bash
gh pr diff 408 --repo lidge-jun/opencodex > /tmp/pr408.diff
```

확인 항목:

1. `windowsTaskRegistrationHealthy()` 시그니처를 #408이 바꿨는지. 바꿨다면 우리
   `readWindowsSchedulerXmlState()`의 인자도 맞춰야 한다.
2. `evaluateWindowsSchedulerInstallVerification()`이 canonicalized XML(기본값 생략형)을
   어떻게 다루는지. #432 수정 후 그 경로가 install을 rollback하지 않는지.
3. #408이 추가한 install-verification 테스트가 우리 수정 이후에도 의미를 유지하는지.

의미상 결합은 유지된다: #432를 고치지 않으면 #408의 elevated install이 성공한 뒤에도
canonicalized XML을 unhealthy로 보고 rollback할 수 있다. 이 수정은 #408을 보강한다.
다만 **행번호 기준 충돌은 이제 실재할 수 있으므로** 최신 head 대조가 필수다.

## 검증 명령

```bash
bun test tests/service.test.ts
bun run typecheck
```
