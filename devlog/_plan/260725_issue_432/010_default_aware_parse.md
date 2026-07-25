# 010 — 기본값 인식 파싱 구현 계약

근거는 `000_plan.md`.

> 개정 이력: r1은 A-gate에서 FAIL. (1) `deriveWindowsServiceDiagnostic()`이 XML이 아니라
> 계산된 boolean만 받으므로 제안한 테스트가 반쪽 수정을 잡지 못했다. (2) `LogonTrigger`
> 존재 검사가 문서 전역이라 `<Data>`나 주석 속 decoy에 속을 수 있었다.

## 변경 파일

| 파일 | 종류 |
|---|---|
| `src/service.ts` | MODIFY |
| `tests/service.test.ts` | MODIFY |

## 설계

### 헬퍼 추가 (`taskXmlSection()` 옆)

```ts
/**
 * Count occurrences of a tag, including the self-closing form. Requires a real
 * element boundary and matches only unprefixed tags, so neither `<EnabledFoo>`
 * nor `<t:Enabled>` counts as `Enabled`.
 */
function taskXmlElementCount(xml: string, tag: string): number

/**
 * True when a namespace-prefixed form of this tag appears. A prefixed element
 * bound to the task namespace carries a genuine value, but this module parses by
 * regex and cannot resolve prefixes — so its presence must fail closed rather
 * than read as "omitted, use the default" (#432).
 */
function taskXmlHasPrefixedTag(xml: string, tag: string): boolean

/** Remove comments and CDATA so a commented-out decoy cannot satisfy a check. */
function taskXmlWithoutCommentsAndCdata(xml: string): string

/**
 * Task Scheduler omits schema-default elements when exporting a registered task,
 * so an absent element means the documented default rather than a mismatch (#432).
 * An element that IS present must still match exactly — a malformed value must
 * never read as healthy.
 */
function taskXmlOptionalValueEquals(xml: string, tag: string, expected: string): boolean
```

`taskXmlOptionalValueEquals`는 요소가 0개면 `true`, 1개면 값 비교, 2개 이상이면 `false`
(중복 요소는 신뢰할 수 없음).

**단, 0개 판정 전에 prefixed 형태를 먼저 검사한다.** `taskXmlHasPrefixedTag()`가 참이면
`false`를 반환한다. 그렇지 않으면 `<t:Enabled>false</t:Enabled>`가 "생략 = 기본 true"로
둔갑해 실제 비활성화된 작업이 healthy로 통과한다.

### 검사 범위를 소유 구간으로 한정한다 (r2)

공식 XSD상 `IdleSettings`/`RestartOnFailure` 아래에는 `Enabled`가 없으므로 정상 스키마
XML에서 `Settings`의 카운트가 중첩으로 오염되지는 않는다. 진짜 위험은 **비소유 구간**이다.

XSD는 실제 trigger를 `Task/Triggers` 아래에 두면서 `Task/Data`에는 임의 XML을 허용한다.
따라서 문서 전역에서 `LogonTrigger`를 세면 BootTrigger-only 작업에
`<Data><LogonTrigger /></Data>`나 주석 속 `<!-- <LogonTrigger /> -->`를 심어 존재 검사를
속일 수 있다. 그 상태에서 trigger section이 비어 있으면 `Enabled`가 "0개 = 기본 true"로
판정되어 나머지 필드만 맞추면 healthy가 된다.

**결정 (B로 미루지 않는다):**

1. 검사 전 주석(`<!-- ... -->`)과 CDATA를 제거한다.
2. `LogonTrigger` 존재는 **`<Triggers>` 섹션 안에서만** 센다. 전역 검색을 쓰지 않는다.
3. `Settings`의 `Enabled`는 `<Settings>` 섹션 안에서만 센다.
4. `Task/Data` 구간은 검사 대상에서 제외한다.
5. 위 구간 밖에서 critical tag가 발견되면 **fail-closed**한다 (healthy로 통과시키지 않는다).
6. critical tag의 **prefixed 형태가 발견되면 fail-closed**한다. regex 파서는 prefix를
   네임스페이스로 해석할 수 없으므로 안전한 쪽으로 거부한다.
7. 태그 매칭은 요소 경계를 요구한다 (`<Enabled>` / `<Enabled ...>` / `<Enabled/>`만 인정).
8. **`<Data>` 요소가 하나라도 있으면 registration 전체를 fail-closed한다.**
   prefixed 형태(`<t:Data>`)도 포함한다 — `taskXmlElementCount()`는 prefixed를 세지 않으므로
   `taskXmlHasPrefixedTag()`를 함께 검사해야 한다.

### 8번이 필요한 이유

`taskXmlSection()`은 문서에서 **처음 발견되는** 섹션을 고른다. XSD는 `Task/Data`에 임의
XML을 허용하므로, `<Data>`를 `<Settings>`보다 앞에 두고 그 안에 healthy-looking
`<Settings>`·`<Principal>`·`<Exec>`를 심으면 실제 root 소유 섹션을 가릴 수 있다.
예: Data의 decoy Settings는 `Enabled=true`, 진짜 Settings는 `Enabled=false`인 작업이
healthy로 통과한다. 주석/CDATA 제거로는 막히지 않는다.

계층 인식 파서를 도입하면 정확히 `Task/Settings`를 고를 수 있지만, 이 범위에서 XML 파서를
추가하는 것은 과하다. OpenCodex가 생성하는 작업은 `<Data>`를 쓰지 않으므로, 존재 자체를
거부하는 편이 단순하고 안전하다. 사용자가 손으로 `Data`를 넣은 작업은 우리가 등록한
작업이 아니며, stale로 표시되는 것이 옳다.

### 타입 시스템이 반쪽 수정을 막게 한다 (r2)

r1은 `readWindowsSchedulerXmlState()`를 만들고 테스트가 그걸 호출하게 하려 했다.
그러나 `deriveWindowsServiceDiagnostic()`(880행)은 XML이 아니라 이미 계산된 boolean 세 개
(`schedulerInstalled` / `schedulerEnabled` / `schedulerAssetsHealthy`)를 받는다.
테스트가 owner 결과를 그 boolean으로 변환해 넣으면, `diagnoseService()`가 955–958행의
옛 정규식을 그대로 둬도 테스트는 통과한다. **규율이 아니라 타입으로 강제해야 한다.**

`WindowsServiceDiagnosticInputs`에서 scheduler boolean 세 개를 제거하고 XML 기반 입력으로
교체한다.

```ts
export interface WindowsServiceDiagnosticInputs {
-  schedulerInstalled: boolean;
-  schedulerEnabled: boolean;
-  schedulerAssetsHealthy: boolean;
+  /** Raw `schtasks /query /xml` output; empty when the task is not registered. */
+  schedulerXml: string;
+  /** Whether the on-disk service assets exist (filesystem concern, not XML). */
+  schedulerAssetsPresent: boolean;
  nativeStatus: ...;
  ...
}
```

`deriveWindowsServiceDiagnostic()`이 내부에서 `readWindowsSchedulerXmlState()`를 호출해
세 값을 파생한다. 그러면 `diagnoseService()`는 XML을 넘길 수밖에 없고, 옛 정규식을
남겨두면 **컴파일되지 않는다.**

```ts
export interface WindowsSchedulerXmlState {
  installed: boolean;
  enabled: boolean;
  registrationHealthy: boolean;
}

export function readWindowsSchedulerXmlState(
  xml: string,
  wscript?: string,
  launcher?: string,
): WindowsSchedulerXmlState
```

`wscript`/`launcher`는 `windowsTaskRegistrationHealthy()`의 기본 인자를 그대로 위임한다
(확인 완료).

`deriveWindowsServiceDiagnostic()`의 기존 호출자를 전수 확인해 함께 고친다
(`tests/service.test.ts` 포함).

파생 공식을 명시한다.

```ts
const state = readWindowsSchedulerXmlState(inputs.schedulerXml);
const schedulerInstalled = state.installed;
const schedulerEnabled = state.enabled;
const schedulerAssetsHealthy = inputs.schedulerAssetsPresent && state.registrationHealthy;
```

확인된 호출자: production `src/service.ts:964` 한 곳, `tests/service.test.ts:506` 이하 10곳.
production에서 놓친 호출자는 없다.

### `windowsTaskRegistrationHealthy()` 본문

```ts
  // Strip comments/CDATA first so a commented-out decoy cannot satisfy any check.
  const scrubbed = taskXmlWithoutCommentsAndCdata(xml);
  // taskXmlSection() takes the FIRST match, and the XSD allows arbitrary XML under
  // Task/Data — so a Data block placed before the real sections could shadow them.
  // We never emit Data, so its presence alone is disqualifying (#432).
  // Both forms must be rejected: taskXmlElementCount() ignores prefixed tags, so a
  // <t:Data> wrapper would otherwise slip through and still shadow the real sections.
  if (
    taskXmlElementCount(scrubbed, "Data") > 0
    || taskXmlHasPrefixedTag(scrubbed, "Data")
  ) return false;
  // Scope every check to its owning section: the XSD allows arbitrary XML under
  // Task/Data, so a document-wide search can be spoofed (#432).
  const triggers = taskXmlSection(scrubbed, "Triggers");
  const principal = taskXmlSection(scrubbed, "Principal");
  const settings = taskXmlSection(scrubbed, "Settings");
  const action = taskXmlSection(scrubbed, "Exec");
  const trigger = taskXmlSection(triggers, "LogonTrigger");

  // A self-closing <LogonTrigger /> yields an empty section, so check the element
  // itself — but only inside <Triggers>.
  return taskXmlElementCount(triggers, "LogonTrigger") > 0
    && taskXmlOptionalValueEquals(trigger, "Enabled", "true")
    && /<LogonType>\s*InteractiveToken\s*<\/LogonType>/i.test(principal)
    && taskXmlOptionalValueEquals(principal, "RunLevel", "LeastPrivilege")
    && taskXmlOptionalValueEquals(settings, "Enabled", "true")
    && /<MultipleInstancesPolicy>\s*IgnoreNew\s*<\/MultipleInstancesPolicy>/i.test(settings)
    && /<ExecutionTimeLimit>\s*PT0S\s*<\/ExecutionTimeLimit>/i.test(settings)
    && action.includes(...)   // 변경 없음
```

`triggers`(소유 collection)와 `trigger`(단수 `LogonTrigger` 본문)를 구분한다.

### `diagnoseService()` (953–958행)

세 지역 변수를 모두 제거하고 XML과 asset 존재 여부만 넘긴다.

```ts
-    const schedulerInstalled = schedulerXml.length > 0;
-    const schedulerSettings = taskXmlSection(schedulerXml, "Settings");
-    const schedulerEnabled = schedulerInstalled && /<Enabled>\s*true\s*<\/Enabled>/i.test(schedulerSettings);
-    const schedulerAssets = [...].every(existsSync) && windowsTaskRegistrationHealthy(schedulerXml);
+    const schedulerAssetsPresent = [windowsServiceScriptPath(), windowsLauncherVbsPath(), windowsTaskXmlPath()]
+      .every(existsSync);
     ...
     return deriveWindowsServiceDiagnostic({
-      schedulerInstalled,
-      schedulerEnabled,
-      schedulerAssetsHealthy: schedulerAssets,
+      schedulerXml,
+      schedulerAssetsPresent,
```

## 회귀 테스트 (`tests/service.test.ts`)

기존 `buildWindowsTaskXml()` + `.replace()` inline fixture 패턴을 따른다.

1. `accepts canonicalized scheduler XML with omitted defaults` — **핵심 회귀**
   - `<LogonTrigger />` self-closing, Trigger/Settings `Enabled` 없음, `RunLevel` 없음
   - `readWindowsSchedulerXmlState()`가 `{installed:true, enabled:true, registrationHealthy:true}`
   - 수정 전 실패: 세 리터럴 정규식과 빈 섹션 때문에 false
2. `rejects explicit unsafe values even when defaults may be omitted`
   - Trigger `Enabled=false` / Settings `Enabled=false` / `RunLevel=HighestAvailable` 각각 거부
3. `still requires a logon trigger` — `<LogonTrigger />` → `<BootTrigger />` 거부
4. `preserves exact service lifecycle constraints`
   - `InteractiveToken→Password`, `IgnoreNew→Parallel`, `PT0S→PT72H`,
     `wscript.exe→cmd.exe`, launcher path 변경 → 전부 거부
5. `canonicalized scheduler XML feeds a healthy diagnostic` — **wiring 회귀**
   - `deriveWindowsServiceDiagnostic({ schedulerXml: canonicalXml, schedulerAssetsPresent: true, ... })`
     에 **XML을 직접** 넣어 `stale:false`, `enabled:true`, `viable:true`
   - 옛 정규식을 남긴 구현은 타입이 맞지 않아 컴파일 자체가 실패한다
6. `duplicate elements are not trusted` — `<Settings>` 안 `<Enabled>` 2개면 거부
7. `decoy triggers outside Triggers do not satisfy the logon requirement` — **blocker 2 회귀**
   - BootTrigger-only XML에 `<Data><LogonTrigger /></Data>` 추가 → 거부
   - BootTrigger-only XML에 `<!-- <LogonTrigger /> -->` 주석 추가 → 거부
   - 전역 카운트 구현은 두 케이스에서 healthy로 통과해 실패한다
8. `namespace-prefixed values are not mistaken for omissions` — **r2 blocker 2 회귀**
   - Settings의 `<Enabled>true</Enabled>` → `<t:Enabled>false</t:Enabled>` 치환 시 거부
   - `<RunLevel>` → `<t:RunLevel>HighestAvailable</t:RunLevel>` 치환 시 거부
   - prefix를 무시하는 구현은 "생략 = 기본값"으로 판정해 healthy를 통과시킨다
9. `tag matching requires an element boundary`
   - `<EnabledExtra>` 같은 유사 태그가 `Enabled` 카운트에 잡히지 않음을 고정
10. `a Data block disqualifies the registration` — **r3 blocker 회귀**
    - 정상 XML 앞쪽에 `<Data><Settings><Enabled>true</Enabled></Settings></Data>`를 넣고
      실제 Settings는 `<Enabled>false</Enabled>`로 바꾼 XML → 거부
    - `<Data>`에 decoy `<Principal>`(LogonType/RunLevel 정상)을 넣고 실제 Principal을
      `HighestAvailable`로 바꾼 XML → 거부
    - `<Data>`에 decoy `<Exec>`를 넣고 실제 Exec의 Command를 바꾼 XML → 거부
    - Data를 무시하는 구현은 decoy를 읽어 healthy로 통과한다
    - `<t:Data>`(prefixed) + unprefixed decoy `<Settings>` → 거부.
      unprefixed만 세는 구현은 여기서 통과해 실패한다

## 검증

```bash
bun run typecheck
bun test tests/service.test.ts
```
