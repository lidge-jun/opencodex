# 020 — WP2: NAV 순서와 Dashboard 상단 탭

## Objective

WP2는 두 동작을 한 번에 고정한다. 첫째, 사이드바 `NAV`에서 Codex Auth를 Dashboard 바로 뒤로 옮긴다. 이 변경은 순서만 바꾸며 구분선이나 CSS를 추가하지 않는다(`gui/src/App.tsx:44-55`, Q3). 둘째, Dashboard Workspace의 좌측 레일을 Logs와 동일한 해시 기반 상단 탭으로 교체한다. 활성 탭의 유일한 소스는 URL hash이며 Overview는 `#dashboard`, 나머지는 `#dashboard/providers`, `#dashboard/models`를 쓴다(`gui/src/pages/Logs.tsx:11-15`, `gui/src/pages/Logs.tsx:261-278`, D4/Q7).

## WP2a — NAV 순서

현재 `NAV`는 Codex Auth가 Storage 뒤에 있다(`gui/src/App.tsx:44-55`). 변경 전 배열은 다음과 같다.

```tsx
const NAV: { id: Page; tkey: TKey; Icon: typeof IconGrid }[] = [
  { id: "dashboard", tkey: "nav.dashboard", Icon: IconGrid },
  { id: "providers", tkey: "nav.providers", Icon: IconServer },
  { id: "models", tkey: "nav.models", Icon: IconBoxes },
  { id: "subagents", tkey: "nav.subagents", Icon: IconBot },
  { id: "logs", tkey: "nav.logs", Icon: IconList },
  { id: "usage", tkey: "nav.usage", Icon: IconActivity },
  { id: "storage", tkey: "nav.storage", Icon: IconHardDrive },
  { id: "codex-auth", tkey: "nav.codexAuth", Icon: IconKey },
  { id: "api", tkey: "nav.api", Icon: IconGlobe },
  { id: "claude", tkey: "nav.claude", Icon: IconSparkle },
];
```

변경 후 배열은 아래 순서를 정확히 따른다. 객체 내용은 바꾸지 않고 `codex-auth` 항목만 두 번째 위치로 이동한다(`gui/src/App.tsx:44-55`).

```tsx
const NAV: { id: Page; tkey: TKey; Icon: typeof IconGrid }[] = [
  { id: "dashboard", tkey: "nav.dashboard", Icon: IconGrid },
  { id: "codex-auth", tkey: "nav.codexAuth", Icon: IconKey },
  { id: "providers", tkey: "nav.providers", Icon: IconServer },
  { id: "models", tkey: "nav.models", Icon: IconBoxes },
  { id: "subagents", tkey: "nav.subagents", Icon: IconBot },
  { id: "logs", tkey: "nav.logs", Icon: IconList },
  { id: "usage", tkey: "nav.usage", Icon: IconActivity },
  { id: "storage", tkey: "nav.storage", Icon: IconHardDrive },
  { id: "api", tkey: "nav.api", Icon: IconGlobe },
  { id: "claude", tkey: "nav.claude", Icon: IconSparkle },
];
```

`NAV`를 렌더하는 기존 평면 리스트는 그대로 둔다. 새 wrapper, 그룹 메타데이터, divider class, `styles.css` 변경은 없다. 목표 순서는 `dashboard, codex-auth, providers, models, subagents, logs, usage, storage, api, claude`다(`gui/src/App.tsx:44-55`, Q3).

## WP2b — Dashboard 상단 탭

### 재사용할 Logs 패턴

Logs는 hash를 읽는 순수 판별 함수와 `hashchange` 구독을 결합한다. `#logs/debug`일 때만 Debug이고 나머지는 Logs로 닫힌다(`gui/src/pages/Logs.tsx:11-15`, `gui/src/pages/Logs.tsx:261-269`).

```tsx
type LogsTab = "logs" | "debug";

function readTabFromHash(): LogsTab {
  return window.location.hash.replace(/^#\/?/, "") === "logs/debug" ? "debug" : "logs";
}

// The hash is the source of truth for the active tab (#logs vs #logs/debug),
// so refresh/bookmark/back-forward keep the tab choice.
const [tab, setTab] = useState<LogsTab>(readTabFromHash);

useEffect(() => {
  const onHash = () => setTab(readTabFromHash());
  window.addEventListener("hashchange", onHash);
  return () => window.removeEventListener("hashchange", onHash);
}, []);
```

탭 선택과 키보드 이동도 hash를 먼저 바꾸고, 브라우저가 발생시키는 `hashchange`가 상태를 갱신한다(`gui/src/pages/Logs.tsx:271-278`).

```tsx
const selectTab = (next: LogsTab) => {
  window.location.hash = next === "debug" ? "logs/debug" : "logs";
};

const onTabKeyDown = (e: React.KeyboardEvent) => {
  if (e.key === "ArrowLeft" || e.key === "Home") { e.preventDefault(); selectTab("logs"); document.getElementById("logs-tab-logs")?.focus(); }
  else if (e.key === "ArrowRight" || e.key === "End") { e.preventDefault(); selectTab("debug"); document.getElementById("logs-tab-debug")?.focus(); }
};
```

접근성 계약은 `tablist` 안의 `role="tab"`, 활성 탭 하나만 `tabIndex={0}`, `aria-selected`, `aria-controls`, 그리고 대응하는 `tabpanel`/`aria-labelledby` 조합이다(`gui/src/pages/Logs.tsx:334-370`). 현재 마크업은 다음과 같다.

```tsx
<div className="page-tabs" role="tablist" aria-label={t("nav.logs")}>
  <button
    type="button"
    role="tab"
    id="logs-tab-logs"
    aria-selected={tab === "logs"}
    aria-controls="logs-panel-logs"
    tabIndex={tab === "logs" ? 0 : -1}
    className={`page-tab${tab === "logs" ? " page-tab--active" : ""}`}
    onClick={() => selectTab("logs")}
    onKeyDown={onTabKeyDown}
  >
    {t("logs.tabLogs")}
  </button>
  <button
    type="button"
    role="tab"
    id="logs-tab-debug"
    aria-selected={tab === "debug"}
    aria-controls="logs-panel-debug"
    tabIndex={tab === "debug" ? 0 : -1}
    className={`page-tab${tab === "debug" ? " page-tab--active" : ""}`}
    onClick={() => selectTab("debug")}
    onKeyDown={onTabKeyDown}
  >
    {t("logs.tabDebug")}
  </button>
</div>

{tab === "debug" && (
  <div role="tabpanel" id="logs-panel-debug" aria-labelledby="logs-tab-debug">
    <Debug apiBase={apiBase} embedded />
  </div>
)}

{tab === "logs" && (
  <div role="tabpanel" id="logs-panel-logs" aria-labelledby="logs-tab-logs">
    {/* logs body */}
  </div>
)}
```

### Dashboard의 현재 교체 대상

Dashboard는 현재 컴포넌트 로컬 상태 `selectedSection`을 `overview`로 초기화한다. 따라서 reload나 Back/Forward가 섹션 상태를 보존하지 못한다(`gui/src/pages/Dashboard.tsx:190-194`). Workspace 분기 안의 섹션 데이터는 다음 세 항목이다(`gui/src/pages/Dashboard.tsx:1380-1386`).

```tsx
const sections = [
  { id: "overview", label: t("dash.workspace.overview"), body: overviewSection },
  { id: "providers", label: t("dash.activeProviders"), body: providersSection },
  { id: "models", label: t("dash.availableModels"), body: modelsSection },
];
const selected = sections.find(s => s.id === selectedSection) ?? sections[0];
```

교체되는 좌측 레일은 아래 블록 전체다(`gui/src/pages/Dashboard.tsx:1393-1412`).

```tsx
<div className="dashboard-workspace-root">
  <aside className="dashboard-workspace-rail" aria-label={t("dash.workspace.sections")}>
    <div className="dashboard-workspace-rail-list">
      {sections.map(s => (
        <button
          key={s.id}
          type="button"
          className={`dashboard-workspace-rail-row${selectedSection === s.id ? " dashboard-workspace-rail-row--selected" : ""}`}
          onClick={() => setSelectedSection(s.id)}
          aria-current={selectedSection === s.id ? "true" : undefined}
        >
          <span className="dashboard-workspace-rail-name">{s.label}</span>
        </button>
      ))}
    </div>
  </aside>
  <section className="dashboard-workspace-main" aria-label={selected.label}>
    {selected.body}
  </section>
</div>
```

### 구체적 Dashboard 적응

`gui/src/pages/Dashboard.tsx` 상단의 컴포넌트 밖에 탭 타입과 hash 판별 함수를 둔다. 알 수 없는 Dashboard 접미사는 라우터가 `#dashboard`로 정규화하므로 함수 자체도 Overview로 닫는다(`gui/src/app-routing.ts:35-49`, `gui/src/app-routing.ts:87-93`).

```tsx
type DashboardTab = "overview" | "providers" | "models";

function readDashboardTabFromHash(): DashboardTab {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash === "dashboard/providers") return "providers";
  if (hash === "dashboard/models") return "models";
  return "overview";
}
```

기존 `selectedSection` 상태(`gui/src/pages/Dashboard.tsx:193`)를 아래 hash 기반 상태와 구독으로 교체한다. 별도 localStorage나 query parameter는 만들지 않는다.

```tsx
const [tab, setTab] = useState<DashboardTab>(readDashboardTabFromHash);

useEffect(() => {
  const onHash = () => setTab(readDashboardTabFromHash());
  window.addEventListener("hashchange", onHash);
  return () => window.removeEventListener("hashchange", onHash);
}, []);

const selectTab = (next: DashboardTab) => {
  window.location.hash = next === "overview" ? "dashboard" : `dashboard/${next}`;
};
```

세 탭의 키 이동은 DOM 순서 `overview → providers → models`를 기준으로 한다. `ArrowLeft`/`ArrowRight`는 양끝에서 순환하고, `Home`은 Overview, `End`는 Models로 간다. 선택 뒤 대상 탭에 focus를 준다. 이는 Logs의 두 탭 키보드 계약을 세 탭으로 일반화한 것이다(`gui/src/pages/Logs.tsx:275-278`).

```tsx
const DASHBOARD_TABS: DashboardTab[] = ["overview", "providers", "models"];

const onTabKeyDown = (e: React.KeyboardEvent, current: DashboardTab) => {
  let next: DashboardTab | undefined;
  const index = DASHBOARD_TABS.indexOf(current);
  if (e.key === "ArrowLeft") next = DASHBOARD_TABS[(index - 1 + DASHBOARD_TABS.length) % DASHBOARD_TABS.length];
  else if (e.key === "ArrowRight") next = DASHBOARD_TABS[(index + 1) % DASHBOARD_TABS.length];
  else if (e.key === "Home") next = "overview";
  else if (e.key === "End") next = "models";
  if (!next) return;
  e.preventDefault();
  selectTab(next);
  document.getElementById(`dashboard-tab-${next}`)?.focus();
};
```

`sections`의 `id`는 `DashboardTab`으로 좁히고 기존 label/body를 재사용한다(`gui/src/pages/Dashboard.tsx:1381-1386`). 레일 블록 대신 아래 `page-tabs`와 하나의 panel을 렌더한다.

```tsx
const sections: Array<{ id: DashboardTab; label: string; body: React.ReactNode }> = [
  { id: "overview", label: t("dash.workspace.overview"), body: overviewSection },
  { id: "providers", label: t("dash.activeProviders"), body: providersSection },
  { id: "models", label: t("dash.availableModels"), body: modelsSection },
];
const selected = sections.find(section => section.id === tab) ?? sections[0];

<div className="page-tabs" role="tablist" aria-label={t("dash.workspace.sections")}>
  {sections.map(section => (
    <button
      key={section.id}
      type="button"
      role="tab"
      id={`dashboard-tab-${section.id}`}
      aria-selected={tab === section.id}
      aria-controls={`dashboard-panel-${section.id}`}
      tabIndex={tab === section.id ? 0 : -1}
      className={`page-tab${tab === section.id ? " page-tab--active" : ""}`}
      onClick={() => selectTab(section.id)}
      onKeyDown={event => onTabKeyDown(event, section.id)}
    >
      {section.label}
    </button>
  ))}
</div>
<section
  className="dashboard-workspace-main"
  role="tabpanel"
  id={`dashboard-panel-${selected.id}`}
  aria-labelledby={`dashboard-tab-${selected.id}`}
>
  {selected.body}
</section>
```

`dashboard-workspace-root`와 `dashboard-workspace-rail*` 마크업이 사라지므로 해당 레이아웃/레일 규칙도 제거한다: 2열 grid와 rail 규칙(`gui/src/styles-dashboard-workspace.css:16-77`), 768px에서 이를 1열/하단 경계로 바꾸는 규칙(`gui/src/styles-dashboard-workspace.css:233-245`)이 대상이다. `dashboard-workspace-main`과 그 표/고정 헤더 규칙은 새 panel이 계속 소비하므로 유지한다(`gui/src/styles-dashboard-workspace.css:79-101`).

`page-tabs`는 현재 Logs만 소비한다(`gui/src/pages/Logs.tsx:334`, `gui/src/styles.css:369-374`). Dashboard가 두 번째 소비자가 되면서 주석도 Logs 전용 표현에서 공용 page-level tab 표현으로 바꾼다.

## 라우터 등록

### `gui/src/app-routing.ts`

`readPageFromHash()`는 `/` 앞의 첫 segment만 읽고, 이미 `dashboard`를 유효 페이지로 알고 있다(`gui/src/app-routing.ts:6-18`, `gui/src/app-routing.ts:20-43`). 따라서 `Page` union이나 `VALID_PAGES`에는 아무 항목도 추가하지 않는다. Logs의 `debug` 별칭 처리(`gui/src/app-routing.ts:41-42`, `gui/src/app-routing.ts:78-84`)도 Dashboard에는 레거시 별칭이 없으므로 복제하지 않는다.

실제 등록 지점은 `hashBelongsToPage()`다. 현재 `logs/debug`는 이 함수의 허용 하위 hash로 등록되어 있다(`gui/src/app-routing.ts:46-50`). Dashboard도 정확히 같은 소유권 표에 두 하위 hash를 추가한다.

```diff
 export function hashBelongsToPage(rawHash: string, page: Page): boolean {
   return rawHash === page
     || (page === "providers" && rawHash === "providers/workspace")
+    || (page === "dashboard" && (
+      rawHash === "dashboard/providers"
+      || rawHash === "dashboard/models"
+    ))
     || (page === "logs" && rawHash === "logs/debug");
 }
```

이 추가로 `readPageFromHash("dashboard/providers")`와 `readPageFromHash("dashboard/models")`는 모두 `dashboard`를 반환하고, `resolveAppHashChange()`의 invalid-suffix 교정 분기를 통과하지 않으며 `replaceTo: null`을 반환한다(`gui/src/app-routing.ts:35-49`, `gui/src/app-routing.ts:75-94`, `gui/src/app-routing.ts:114-119`). 반면 `dashboard/unknown`은 계속 `replaceTo: "dashboard"`로 닫혀야 한다.

라우팅 회귀 계약은 `gui/tests/providers-hash-history.test.tsx`의 기존 `resolveAppHashChange()` 직접 검증 옆에 추가한다(`gui/tests/providers-hash-history.test.tsx:49-82`). 코드 형태는 다음과 같다.

```tsx
test("resolveAppHashChange preserves registered Dashboard tab hashes", () => {
  expect(resolveAppHashChange("dashboard/providers", "workspace")).toMatchObject({
    page: "dashboard",
    replaceTo: null,
  });
  expect(resolveAppHashChange("dashboard/models", "workspace")).toMatchObject({
    page: "dashboard",
    replaceTo: null,
  });
});

test("resolveAppHashChange normalizes unknown Dashboard suffixes", () => {
  expect(resolveAppHashChange("dashboard/unknown", "workspace")).toMatchObject({
    page: "dashboard",
    replaceTo: "dashboard",
  });
});
```

### `gui/src/use-app-route-state.ts`

현재 passive-replace effect는 Providers와 legacy Debug를 먼저 처리한 뒤, `hashBelongsToPage(rawHash, page)`가 false인 모든 hash를 bare page로 교체한다(`gui/src/use-app-route-state.ts:86-100`). 그래서 현재 `#dashboard/providers`와 `#dashboard/models`는 `#dashboard`로 지워진다.

이 파일에 Dashboard 전용 조건을 중복 추가하지 않는다. 위 `hashBelongsToPage()` 변경 뒤 아래 기존 분기가 등록된 두 hash를 자연스럽게 보존한다(`gui/src/use-app-route-state.ts:97-99`). 코드 shape는 그대로다.

```tsx
if (!hashBelongsToPage(rawHash, page)) {
  replaceHash(page);
}
```

검증해야 할 변화는 조건식이 아니라 결과다. `page === "dashboard"`일 때 `dashboard/providers`와 `dashboard/models`는 true가 되어 replace하지 않고, `dashboard/unknown`만 false가 되어 `dashboard`로 passive replace한다. 라우트 허용 목록을 `use-app-route-state.ts`에도 복제하면 두 파일이 서로 어긋날 수 있으므로 금지한다(`gui/src/app-routing.ts:46-50`, `gui/src/use-app-route-state.ts:97-99`).

### Dashboard 계약 테스트

현재 `dashboard-contracts.test.ts`는 Workspace pane이 `<main>`이 아니라 labelled `<section>`인지 검사한다. 구체적으로 `dashboard-workspace-main`, `dash.workspace.sections`, `<section>`을 요구하지만 rail class 자체는 요구하지 않는다(`gui/tests/dashboard-contracts.test.ts:19-25`). 위 적응안은 tablist의 `aria-label`에 `dash.workspace.sections`를 유지하고 panel을 `dashboard-workspace-main` class의 `<section>`으로 유지하므로 기존 테스트는 깨지지 않는다. 다만 이 테스트만으로는 레일이 탭으로 바뀌었는지 증명할 수 없다.

같은 테스트를 아래 계약으로 보강한다. 기존 landmark assertion은 유지하고, `page-tabs`, `role="tablist"`, `role="tab"`, `role="tabpanel"`을 요구하며 `dashboard-workspace-rail`이 남지 않았음을 검사한다(`gui/tests/dashboard-contracts.test.ts:19-25`, `gui/src/pages/Dashboard.tsx:1393-1412`).

```tsx
expect(src).toContain('className="page-tabs"');
expect(src).toContain('role="tablist"');
expect(src).toContain('role="tab"');
expect(src).toContain('role="tabpanel"');
expect(src).not.toContain("dashboard-workspace-rail");
```

### WP5 상호작용

좌측 레일은 `if (workspaceView)` 분기 안에만 존재한다(`gui/src/pages/Dashboard.tsx:192`, `gui/src/pages/Dashboard.tsx:1380-1416`). Classic 반환 경로는 세 section을 순서대로 직접 렌더하며 레일이 없다(`gui/src/pages/Dashboard.tsx:1418-1428`). 따라서 WP2가 Workspace 분기의 레일을 상단 탭으로 교체하고, WP5가 Classic 분기와 `viewMode`를 제거하면 Dashboard에는 이 상단 탭 레이아웃 하나만 남는다. WP5는 hash 기반 `tab` 상태와 탭 마크업을 제거 대상으로 오인하면 안 된다.

## 반응형

현재 `.page-tabs`는 flex 한 줄이지만 overflow 계약이 없고 Logs 전용 주석만 붙어 있다(`gui/src/styles.css:369-374`). Q7을 CSS에 명시적으로 고정한다.

```diff
-/* Page-level underline tabs (Logs & Debug). Distinct from pill .segmented filters. */
-.page-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin: 2px 0 14px; }
+/* Shared page-level underline tabs. Distinct from pill .segmented filters. */
+.page-tabs {
+  display: flex;
+  flex-wrap: nowrap;
+  gap: 2px;
+  overflow-x: auto;
+  border-bottom: 1px solid var(--border);
+  margin: 2px 0 14px;
+}
-.page-tab { appearance: none; background: none; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px; padding: 8px 12px; color: var(--muted); cursor: pointer; font: inherit; font-size: var(--text-control); }
+.page-tab { appearance: none; flex: 0 0 auto; background: none; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px; padding: 8px 12px; color: var(--muted); cursor: pointer; font: inherit; font-size: var(--text-control); }
```

`flex-wrap: nowrap`은 줄바꿈 금지를 코드에 드러내고, `.page-tab { flex: 0 0 auto; }`는 세 버튼이 폭에 맞춰 찌그러지는 대신 실제 overflow를 만들게 한다. 320px viewport에서는 탭이 두 줄로 내려가거나 잘리지 않고 `.page-tabs` 자체가 가로 스크롤되어야 한다. Dashboard 전용 media query나 탭 축약 문구는 추가하지 않는다(`gui/src/styles.css:369-374`, Q7).

## 검증

구현 후 정적·계약 검증을 다음 순서로 실행한다. 첫 명령은 Dashboard landmark/tab 계약과 route normalize 계약을 직접 검증한다(`gui/tests/dashboard-contracts.test.ts:19-25`, `gui/tests/providers-hash-history.test.tsx:49-82`). 나머지는 GUI 전체 타입/빌드, lint, root 타입 계약을 확인한다(`gui/package.json:8-10`, `package.json:39`, `package.json:43`, `package.json:50`).

집중 확인:

```bash
(cd gui && bun test tests/dashboard-contracts.test.ts tests/providers-hash-history.test.tsx)
```

전체 게이트 (`000_plan.md` 필수 항목 전부):

```bash
bun run typecheck
bun run lint:gui
bun run test                      # 루트 스위트 (./tests/)
(cd gui && bun test tests)        # GUI 스위트 — 루트 test 는 gui/tests 를 돌리지 않는다
bun run privacy:scan
bun run build:gui
git diff --check
```

> 이 WP는 `app-routing.ts`/`use-app-route-state.ts` 를 바꾸므로 루트 스위트의
> `tests/provider-workspace-rail.test.ts` 가 반드시 함께 돌아야 한다.

브라우저 검증은 `bun run dev:gui`로 Vite를 띄운 뒤 다음을 확인한다(`package.json:37`, `gui/package.json:7`).

1. `#dashboard`로 진입한다. Overview 탭이 선택되고 panel id/label 연결이 맞는지 확인한다.
2. Providers와 Models 탭을 차례로 클릭한다. hash가 각각 `#dashboard/providers`, `#dashboard/models`가 되고 Back/Forward가 탭을 복원하는지 확인한다.
3. 주소창에 `#dashboard/models`를 직접 입력하고 reload한다. reload 뒤에도 Models 탭과 Models panel이 선택된 상태로 남아야 한다.
4. `#dashboard/unknown`을 입력한다. history entry를 추가하지 않는 replace로 `#dashboard`에 정규화되고 Overview가 보여야 한다(`gui/src/app-routing.ts:87-93`, `gui/src/use-app-route-state.ts:97-99`).
5. 탭에 focus를 두고 Left/Right/Home/End를 누른다. focus, `aria-selected`, hash, panel이 같은 탭을 가리켜야 한다(`gui/src/pages/Logs.tsx:275-278`, `gui/src/pages/Logs.tsx:334-370`).
6. viewport를 320px로 줄인다. `.page-tabs`는 한 줄을 유지하고 가로 스크롤되며, page 전체에 불필요한 가로 overflow가 생기지 않아야 한다(`gui/src/styles.css:369-374`, Q7).
7. 사이드바가 `Dashboard → Codex Auth → Providers → Models → Subagents → Logs → Usage → Storage → API → Claude` 순서인지, Dashboard와 Codex Auth 사이에 새 divider가 없는지 확인한다(`gui/src/App.tsx:44-55`, Q3).

## 위험

- `hashBelongsToPage()` 등록을 빠뜨리면 Dashboard가 올바른 하위 hash를 설정한 직후 passive effect가 다시 `#dashboard`로 덮는다(`gui/src/app-routing.ts:46-50`, `gui/src/use-app-route-state.ts:86-100`). 클릭만 확인하지 말고 reload와 Back/Forward까지 확인해야 한다.
- `setTab()`을 클릭 핸들러에서 직접 호출하면 hash와 React 상태에 소유자가 둘 생긴다. Logs처럼 클릭은 hash만 바꾸고 `hashchange`가 상태를 갱신해야 한다(`gui/src/pages/Logs.tsx:261-273`, D4).
- `dashboard-workspace-root`의 2열 grid를 남긴 채 rail만 제거하면 panel이 두 번째 열에 놓이거나 빈 열이 남는다. rail markup과 함께 root/rail CSS 및 768px rail 보정도 제거해야 한다(`gui/src/styles-dashboard-workspace.css:16-77`, `gui/src/styles-dashboard-workspace.css:233-245`).
- `.page-tab`의 shrink를 막지 않으면 320px에서 가로 스크롤 대신 버튼 폭이 눌릴 수 있다. `overflow-x: auto`, `flex-wrap: nowrap`, `flex: 0 0 auto`를 한 계약으로 적용한다(`gui/src/styles.css:369-374`, Q7).
- 기존 `dashboard-contracts.test.ts`는 rail 자체를 검사하지 않아 변경 전 UI도 통과할 수 있다. tablist/tabpanel과 rail 제거 assertion을 함께 추가해야 전환을 증명한다(`gui/tests/dashboard-contracts.test.ts:19-25`).
- WP5에서 Classic을 제거할 때 Workspace 전용이라는 이유로 Dashboard 탭까지 지우면 D4를 되돌리게 된다. 레일은 Workspace 분기에만 있고 Classic에는 없으므로, WP2의 상단 탭이 최종 단일 레이아웃이다(`gui/src/pages/Dashboard.tsx:1380-1428`).
