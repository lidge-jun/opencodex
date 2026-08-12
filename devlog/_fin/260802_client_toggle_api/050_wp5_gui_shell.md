# 050 — WP5: Integrations routing shell and page migration

**A-gate amendment (round 1): WP5 and WP6 are ONE work-phase.** The audit was
right that a shell whose first compilable checkpoint requires WP6 is not an
independently verifiable phase boundary (PHASE-SPLIT-01). `050` and `060` are
therefore two documents describing one phase, executed and verified together:
the phase closes when `bun run build:gui` succeeds, `bun run lint:gui` is
clean, and both the routing tests here and the surface tests in 060 pass.
The goalplan is amended to seven work-phases.

Shared types come from `006_module_contracts.md`; the journal row this GUI
consumes is `IntegrationJournalRow` (006 §6) with `snapshot` and `undoable`.

Implementation plan. Apply together with `060_wp6_gui_surfaces.md`; the
paste-ready `Integrations.tsx` imports the WP6 components and the combined
change is the first compilable checkpoint. Contract authority:
`005_contract_inventory.md` §5 and `004_ux_design.md` §§2–3, 3.1–3.2, 5.0,
10–11.

## 1. Scope boundary

### IN — exact write set

- `gui/src/app-routing.ts` — replace the three legacy pages with
  `integrations`, register every valid nested hash, and resolve legacy hashes.
- `gui/src/use-app-route-state.ts` — apply the resolver on initial mount so a
  legacy hash receives its specific replacement before generic normalization.
- `gui/src/App.tsx` — collapse three sidebar entries and render one
  `Integrations` page; remove sidebar-owned Claude state and mutation code.
- `gui/src/pages/Integrations.tsx` — new hash-owned wrapping tab shell.
- `gui/src/pages/Claude.tsx` — make Code/Desktop hash-owned and accept
  `active`; preserve both mounted panels and `preventScroll` focus.
- `gui/src/pages/ClaudeCode.tsx` and
  `gui/src/pages/claude-code-sections.tsx` — relocate the immediate Claude
  enable control into the Claude Code surface and remove its duplicate draft
  row.
- `gui/src/pages/ApiKeys.tsx` — accept `active` and gate both data resources.
- `gui/src/pages/Grok.tsx` — accept `active`, pass `AbortSignal`, and gate its
  data resource.
- `gui/src/components/apikeys-workspace/ApiKeysWorkspace.tsx` — remove the
  client-export panel and its `connect` section; WP6 mounts export/settings on
  the file-client pages.
- `gui/src/i18n/{en,ko,de,zh,ru,ja}.ts` — add all shell labels.
- `gui/tests/integrations-routing.test.ts` — new route, history, shell, and
  migration contract suite.

### OUT

- No management API, writer, journal, ownership, or snapshot changes.
- No Overview/card/rollback/per-client visual implementation; WP6 owns those.
- No redesign of `ApiKeys`, `ClaudeCode`, `ClaudeDesktop`, or `Grok` content.
- Do not delete `ClientConfigPanel`, `ClientConfigRow`, or
  `ClientConfigDialog`; WP6 reuses/refactors them under client pages.
- No new dependency and no horizontal-scrolling tab mechanism.

## 2. `gui/src/app-routing.ts` — exact diff

Apply these edits in order.

```diff
 export type Page =
   | "dashboard"
   | "startup"
   | "providers"
   | "models"
   | "combos"
   | "subagents"
   | "logs"
   | "usage"
   | "storage"
   | "codex-auth"
-  | "api"
-  | "claude"
-  | "grok";
+  | "integrations";

 export const VALID_PAGES = new Set<Page>([
   "dashboard",
   "startup",
   "providers",
   "models",
   "combos",
   "subagents",
   "logs",
   "usage",
   "storage",
   "codex-auth",
-  "api",
-  "claude",
-  "grok",
+  "integrations",
 ]);
```

In `readPageFromHash`, place the legacy-page mapping immediately after the
existing `debug` mapping and before `VALID_PAGES.has`. This is required for
the hook's initial `useState(readPageFromHash)` value.

```diff
   // Legacy: Debug used to be a standalone page; it now lives as a tab on Logs.
   if (pageId === ("debug" as Page)) return "logs";
+  // Legacy integration pages now live below one Integrations route. Returning
+  // the destination page here keeps the initial hook state aligned until the
+  // resolver replaces the hash with the exact nested destination.
+  if (pageId === ("api" as Page)
+    || pageId === ("claude" as Page)
+    || pageId === ("grok" as Page)) return "integrations";
   return VALID_PAGES.has(pageId) ? pageId : "dashboard";
 }
```

Place this constant after `DASHBOARD_UPDATE_HASH`. The array is the complete
registered suffix list; Overview remains the bare `integrations` hash.

```ts
/**
 * Integrations uses a wrapping outer tab strip. Claude Desktop is a nested
 * route owned by the Claude family panel, but it still has to be registered
 * here or App normalization strips it before Claude can read it.
 */
export const INTEGRATION_TAB_HASHES = [
  "integrations/keys",
  "integrations/codex",
  "integrations/claude",
  "integrations/claude/desktop",
  "integrations/grok",
  "integrations/opencode",
  "integrations/pi",
  "integrations/hermes",
  "integrations/openclaw",
  "integrations/kimi",
  "integrations/gajae",
] as const;
```

Replace `hashBelongsToPage` with:

```ts
export function hashBelongsToPage(rawHash: string, page: Page): boolean {
  return rawHash === page
    || (page === "logs" && rawHash === "logs/debug")
    || (page === "dashboard"
      && (rawHash === DASHBOARD_UPDATE_HASH
        || (DASHBOARD_TAB_HASHES as readonly string[]).includes(rawHash)))
    || (page === "integrations"
      && (INTEGRATION_TAB_HASHES as readonly string[]).includes(rawHash));
}
```

In `resolveAppHashChange`, place the legacy Integrations redirects immediately
after the `debug` redirect and before `providers/workspace` and generic
normalization. The ordering is observable: `readPageFromHash("api")` is
already `integrations`, but only these branches retain the intended nested
destination.

```diff
   if (rawHash === "debug" || rawHash.startsWith("debug/")) {
     return { page: "logs", replaceTo: "logs/debug" };
   }

+  // Legacy top-level integration pages. `replaceTo` is consumed by
+  // replaceHash/replaceState, so old bookmarks do not add a history trap.
+  if (rawHash === "api") {
+    return { page: "integrations", replaceTo: "integrations/keys" };
+  }
+  if (rawHash === "claude") {
+    return { page: "integrations", replaceTo: "integrations/claude" };
+  }
+  if (rawHash === "grok") {
+    return { page: "integrations", replaceTo: "integrations/grok" };
+  }
+
   // Legacy deep link from the removed dual-layout era.
```

Activation and proof:

- Legacy redirect branch activates only for the exact old bare hash. Proof:
  resolver returns `page: "integrations"` plus the specific `replaceTo`, and
  a real `replaceHash` leaves `history.length` unchanged.
- Registered nested branch activates for every constant entry, including
  `integrations/claude/desktop`. Proof: `replaceTo === null` for every entry.
- Unknown suffix branch activates for any other
  `integrations/<suffix>`. Proof: it returns
  `{ page: "integrations", replaceTo: "integrations" }`.

## 3. `gui/src/use-app-route-state.ts` — initial redirect placement

The current second effect duplicates only two redirects. Replace its body so
the same resolver owns initial mount and later page-driven normalization:

```diff
   useEffect(() => {
     const rawHash = normalizeHashPath(window.location.hash);
-    if (rawHash === "debug" || rawHash.startsWith("debug/")) {
-      replaceHash("logs/debug");
-      return;
-    }
-    // Legacy deep link from the removed dual-layout era.
-    if (rawHash === "providers/workspace") {
-      replaceHash("providers");
-      return;
-    }
-    if (!hashBelongsToPage(rawHash, page)) {
-      replaceHash(page);
-    }
+    const action = resolveAppHashChange(rawHash);
+    if (action.replaceTo) replaceHash(action.replaceTo);
+    // Initial state comes from readPageFromHash and should already agree.
+    // Keep this guard for a hash changed between render and effect commit.
+    if (action.page !== page) setPageState(action.page);
   }, [page]);
```

Then remove `hashBelongsToPage` from this file's imports only if no other use
remains (it remains needed by `navigateToPage` documentation, not execution;
the import itself becomes unused and must be removed). Activation: an initial
`#api`, `#claude`, or `#grok` mount. Observable proof: the nested destination
is installed with replace semantics before any generic bare-page rewrite.

## 4. `gui/src/App.tsx` — exact shell diff

### 4.1 Imports

```diff
-import { useCallback, useEffect, useRef, useState } from "react";
-import { setClientResourceData, useKeyedClientResource } from "./client-resource";
+import { useEffect, useRef, useState } from "react";
+import { useKeyedClientResource } from "./client-resource";
 import Dashboard from "./pages/Dashboard";
 ...
-import ApiKeys from "./pages/ApiKeys";
-import Claude from "./pages/Claude";
-import Grok from "./pages/Grok";
+import Integrations from "./pages/Integrations";
 ...
-import { IconGrid, IconServer, IconBoxes, IconBot, IconList, IconActivity, IconHardDrive, IconKey, IconMenu, IconSun, IconMoon, IconMonitor, IconGlobe, IconPower, IconSparkle, IconX } from "./icons";
+import { IconGrid, IconServer, IconBoxes, IconBot, IconList, IconActivity, IconHardDrive, IconKey, IconMenu, IconSun, IconMoon, IconMonitor, IconGlobe, IconPower, IconX } from "./icons";
 ...
-import { Select, Switch } from "./ui";
+import { Select } from "./ui";
 import { installApiAuthFetch } from "./api";
-import { readJsonIfOk } from "./fetch-json";
```

### 4.2 `PAGE_TKEY`

```diff
   "codex-auth": "nav.codexAuth",
-  api: "nav.api",
-  claude: "nav.claude",
-  grok: "nav.grok",
+  integrations: "nav.integrations",
 };
```

### 4.3 `NAV`

Replace the existing `api`/`claude`/`grok` trio with one entry in the same
position:

```diff
-  { id: "api", tkey: "nav.api", Icon: IconGlobe },
-  { id: "claude", tkey: "nav.claude", Icon: IconSparkle },
-  { id: "grok", tkey: "nav.grok", Icon: IconBoxes },
+  { id: "integrations", tkey: "nav.integrations", Icon: IconGlobe },
```

### 4.4 Remove sidebar Claude ownership

Delete the complete block from `// Claude navigation row also owns the
connection toggle.` through the closing brace of `toggleClaude`. Do not move
that optimistic mutation into App. `ClaudeCode` remains the existing owner of
`GET/PUT /api/claude-code`, and WP6 places that control in its client header.

Replace the `NAV.map` body with a plain navigation button:

```tsx
{NAV.map(({ id, tkey, Icon }) => (
  <div key={id} className="nav-entry">
    <button
      type="button"
      className={`nav-item${page === id ? " active" : ""}`}
      data-page={id}
      onClick={() => {
        navigateToPage(id);
        setNavOpen(false);
      }}
      aria-current={page === id ? "page" : undefined}
    >
      <Icon /> {t(tkey)}
    </button>
  </div>
))}
```

Activation: every sidebar render. Proof: source contains no
`nav-entry-claude`, sidebar `Switch`, `toggleClaude`, or
`app-claude-code:${API_BASE}` resource; the only navigation ids formerly
named `api`, `claude`, or `grok` are absent.

### 4.5 Render chain

```diff
             {page === "codex-auth" && <CodexAuth apiBase={API_BASE} />}
-            {page === "api" && <ApiKeys apiBase={API_BASE} />}
-            {page === "claude" && <Claude apiBase={API_BASE} />}
-            {page === "grok" && <Grok apiBase={API_BASE} />}
+            {page === "integrations" && <Integrations apiBase={API_BASE} />}
```

## 5. `gui/src/pages/Integrations.tsx` — new file, paste-ready

This is the final shell after WP6 files exist. The outer tab order never
depends on detection. `integrations/claude/desktop` maps to the outer Claude
tab and is delegated to the inner Claude selector.

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { navigateHash, normalizeHashPath } from "../hash-routing";
import { useT, type TKey } from "../i18n/shared";
import ApiKeys from "./ApiKeys";
import Claude from "./Claude";
import Grok from "./Grok";
import IntegrationsOverview from "./integrations/IntegrationsOverview";
import FileIntegrationPage, {
  type FileIntegrationClientId,
} from "./integrations/FileIntegrationPage";

type IntegrationTab =
  | "overview"
  | "keys"
  | "codex"
  | "claude"
  | "grok"
  | FileIntegrationClientId;

interface TabDefinition {
  id: IntegrationTab;
  hash: string;
  labelKey: TKey;
}

const TABS: readonly TabDefinition[] = [
  { id: "overview", hash: "integrations", labelKey: "integrations.tab.overview" },
  { id: "keys", hash: "integrations/keys", labelKey: "integrations.tab.keys" },
  { id: "codex", hash: "integrations/codex", labelKey: "integrations.tab.codex" },
  { id: "claude", hash: "integrations/claude", labelKey: "integrations.tab.claude" },
  { id: "grok", hash: "integrations/grok", labelKey: "integrations.tab.grok" },
  { id: "opencode", hash: "integrations/opencode", labelKey: "integrations.tab.opencode" },
  { id: "pi", hash: "integrations/pi", labelKey: "integrations.tab.pi" },
  { id: "hermes", hash: "integrations/hermes", labelKey: "integrations.tab.hermes" },
  { id: "openclaw", hash: "integrations/openclaw", labelKey: "integrations.tab.openclaw" },
  { id: "kimi", hash: "integrations/kimi", labelKey: "integrations.tab.kimi" },
  { id: "gajae", hash: "integrations/gajae", labelKey: "integrations.tab.gajae" },
] as const;

const FILE_CLIENTS = new Set<FileIntegrationClientId>([
  "opencode",
  "pi",
  "hermes",
  "openclaw",
  "kimi",
  "gajae",
]);

function readIntegrationTab(hash = window.location.hash): IntegrationTab {
  const raw = normalizeHashPath(hash);
  if (raw === "integrations/claude/desktop") return "claude";
  const match = TABS.find(tab => tab.hash === raw);
  return match?.id ?? "overview";
}

function tabDomId(tab: IntegrationTab): string {
  return `integrations-tab-${tab}`;
}

function panelDomId(tab: IntegrationTab): string {
  return `integrations-panel-${tab}`;
}

export default function Integrations({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [tab, setTab] = useState<IntegrationTab>(readIntegrationTab);
  const [mounted, setMounted] = useState<ReadonlySet<IntegrationTab>>(
    () => new Set([readIntegrationTab()]),
  );
  const tabRefs = useRef(new Map<IntegrationTab, HTMLButtonElement>());

  useEffect(() => {
    const syncFromHash = () => setTab(readIntegrationTab());
    window.addEventListener("hashchange", syncFromHash);
    window.addEventListener("popstate", syncFromHash);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
      window.removeEventListener("popstate", syncFromHash);
    };
  }, []);

  useEffect(() => {
    setMounted(current => {
      if (current.has(tab)) return current;
      return new Set([...current, tab]);
    });
  }, [tab]);

  const selectTab = (next: IntegrationTab, moveFocus: boolean) => {
    const definition = TABS.find(candidate => candidate.id === next);
    if (!definition) return;
    navigateHash(definition.hash);
    setTab(next);
    if (moveFocus) {
      window.requestAnimationFrame(() => {
        tabRefs.current.get(next)?.focus({ preventScroll: true });
      });
    }
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex(candidate => candidate.id === tab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "ArrowRight") nextIndex = (index + 1) % TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    selectTab(TABS[nextIndex].id, true);
  };

  return (
    <section className="integrations-page">
      <div className="page-head">
        <h2>{t("nav.integrations")}</h2>
      </div>
      <p className="page-sub">{t("integrations.subtitle")}</p>

      <div className="page-tabs" role="tablist" aria-label={t("integrations.tabsLabel")}>
        {TABS.map(definition => (
          <button
            key={definition.id}
            ref={node => {
              if (node) tabRefs.current.set(definition.id, node);
              else tabRefs.current.delete(definition.id);
            }}
            type="button"
            role="tab"
            id={tabDomId(definition.id)}
            aria-selected={tab === definition.id}
            aria-controls={panelDomId(definition.id)}
            tabIndex={tab === definition.id ? 0 : -1}
            className={`page-tab${tab === definition.id ? " page-tab--active" : ""}`}
            onClick={() => selectTab(definition.id, true)}
            onKeyDown={handleTabKeyDown}
          >
            {t(definition.labelKey)}
          </button>
        ))}
      </div>

      {TABS.map(definition => {
        if (!mounted.has(definition.id)) return null;
        const active = tab === definition.id;
        return (
          <div
            key={definition.id}
            role="tabpanel"
            id={panelDomId(definition.id)}
            aria-labelledby={tabDomId(definition.id)}
            hidden={!active}
          >
            {definition.id === "overview" && (
              <IntegrationsOverview apiBase={apiBase} active={active} />
            )}
            {definition.id === "keys" && <ApiKeys apiBase={apiBase} active={active} />}
            {definition.id === "codex" && (
              <section className="integration-native-page" aria-labelledby="codex-integration-title">
                <h3 id="codex-integration-title">{t("integrations.codex.title")}</h3>
                <p>{t("integrations.codex.body")}</p>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => navigateHash("startup")}
                >
                  {t("integrations.codex.openService")}
                </button>
              </section>
            )}
            {definition.id === "claude" && <Claude apiBase={apiBase} active={active} />}
            {definition.id === "grok" && <Grok apiBase={apiBase} active={active} />}
            {FILE_CLIENTS.has(definition.id as FileIntegrationClientId) && (
              <FileIntegrationPage
                apiBase={apiBase}
                client={definition.id as FileIntegrationClientId}
                active={active}
              />
            )}
          </div>
        );
      })}
    </section>
  );
}
```

Conditional activation and proof:

- Lazy panel branch activates after a tab's first selection. Proof: an
  unvisited panel is absent; after first visit it remains mounted with
  `hidden` toggled, preserving drafts.
- Active-gate branch activates only for the visible panel. Proof: each
  data-owning child receives `active={true}` for exactly one outer panel and
  `false` for all mounted hidden panels.
- Nested Desktop branch activates only for
  `#integrations/claude/desktop`. Proof: outer `aria-selected` remains on
  Claude while the inner Desktop tab is selected.
- Keyboard branches activate on ArrowLeft/Right/Home/End. Proof: hash changes,
  roving `tabIndex` moves, and focused button is visible without page scroll.

## 6. Migrated page diffs

### 6.1 `gui/src/pages/ApiKeys.tsx`

```diff
-export default function ApiKeys({ apiBase }: { apiBase: string }) {
+export default function ApiKeys({ apiBase, active = true }: { apiBase: string; active?: boolean }) {
```

Add `enabled: active` to both `useDataSurface` option objects. Remove the
`apiBase={apiBase}` prop passed to `ApiKeysWorkspace` after §6.2 removes that
prop. Activation: hidden Keys panel. Proof: both resources classify as
`disabled`, make no initial fetch/poll while hidden, and retain keyed cached
data for the next activation.

### 6.2 `gui/src/components/apikeys-workspace/ApiKeysWorkspace.tsx`

- Remove the `ClientConfigPanel` import.
- Remove `apiBase` from `ApiKeysWorkspaceProps`, destructuring, and call sites.
- Remove `{ id: "connect", ... }` from `sectionTabs`.
- Delete the complete `sectionAnchorId("api", "connect")` block containing
  `ClientConfigPanel`.
- Keep endpoints/auth/models/examples and key management unchanged.

Proof: `ClientConfigPanel` has no call site under `ApiKeysWorkspace`; the Keys
tab contains credentials and endpoints only. Do not delete the export
components because WP6 consumes them.

### 6.3 `gui/src/pages/Grok.tsx`

```diff
-export default function Grok({ apiBase }: { apiBase: string }) {
+export default function Grok({ apiBase, active = true }: { apiBase: string; active?: boolean }) {
```

Change `fetchStatus` to `(signal: AbortSignal)` and pass `{ signal }` to its
fetch. Add `enabled: active` to `useDataSurface` options. Activation: hidden
Grok panel. Proof: no status request while inactive; an in-flight request is
aborted on deactivation; saved draft state remains mounted.

### 6.4 `gui/src/pages/Claude.tsx`

- Props become `{ apiBase: string; active?: boolean }`, defaulting `active` to
  `true`.
- Initialize `tab` from the hash:
  `integrations/claude/desktop` -> `desktop`, otherwise `code`.
- Add `hashchange` and `popstate` listeners that update the inner tab from the
  hash.
- `selectTab("code")` calls `navigateHash("integrations/claude")`;
  `selectTab("desktop")` calls
  `navigateHash("integrations/claude/desktop")`, then preserves the current
  `requestAnimationFrame` + `focus({ preventScroll: true })` behavior.
- Pass `active && tab === "code"` to `ClaudeCode` and
  `active && tab === "desktop"` to `ClaudeDesktop`.
- Preserve both mounted panels and `onPortChange`; do not recreate the
  Claude-code toggle in this wrapper.

Activation: inner segmented Code/Desktop selection or browser Back/Forward.
Proof: the nested hash, `aria-selected`, visible panel, and active poll gate
all agree; reselecting the same inner tab creates no extra history entry
because `navigateHash` is a no-op for the current hash.

### 6.5 `gui/src/pages/ClaudeCode.tsx` and `claude-code-sections.tsx`

The removed sidebar switch was an immediate mutation, while the existing
Settings-card toggle is only a draft until Save. Preserve the immediate
semantics instead of silently changing the control's meaning:

- import the shared `Switch` into `ClaudeCode.tsx`;
- add `connectionPending` and a re-entrancy ref;
- add `toggleConnection`, which sends exact
  `PUT /api/claude-code { enabled: !state.enabled }`, waits for an OK response,
  updates `draftState.enabled`, refreshes `codeResource`, and surfaces failure
  through the existing `Notice` without optimistically flipping;
- render label + Switch in a new `.claudecode-connection-head` immediately
  above `claudecode-workspace-root`, so it is the Claude Code sub-tab's header
  control and remains absent from Desktop;
- remove the `claude.enabledLabel` setting row from
  `ClaudeCodeSettingsCard` to avoid two controls with different commit
  semantics.

Activation: only while the outer Claude panel and inner Code panel are active
and state has loaded. Proof: one click emits one partial PUT, the Switch changes
only after 2xx, a failed PUT retains the old pressed state, and Desktop renders
no Claude Code switch. This is also the single-client control that the native
Overview card mirrors in WP6.

## 7. i18n additions

Add the following exact source values to `en.ts` and `ko.ts`. The four other
locale files (`de.ts`, `zh.ts`, `ru.ts`, `ja.ts`) must add natural translations
for every key in the same change; copying English is not acceptance.

| Key | English | Korean |
|---|---|---|
| `nav.integrations` | Integrations | 연동 |
| `integrations.subtitle` | Connect clients to opencodex, manage credentials, and restore client configuration. | 클라이언트를 opencodex에 연결하고 자격 증명과 설정 복원을 관리합니다. |
| `integrations.tabsLabel` | Integration surfaces | 연동 화면 |
| `integrations.tab.overview` | Overview | 개요 |
| `integrations.tab.keys` | API Keys | API 키 |
| `integrations.tab.codex` | Codex CLI | Codex CLI |
| `integrations.tab.claude` | Claude | Claude |
| `integrations.tab.grok` | Grok Build | Grok Build |
| `integrations.tab.opencode` | OpenCode | OpenCode |
| `integrations.tab.pi` | Pi | Pi |
| `integrations.tab.hermes` | Hermes | Hermes |
| `integrations.tab.openclaw` | OpenClaw | OpenClaw |
| `integrations.tab.kimi` | Kimi Code | Kimi Code |
| `integrations.tab.gajae` | Gajae Code | Gajae Code |
| `integrations.codex.title` | Codex CLI | Codex CLI |
| `integrations.codex.body` | Codex wiring is owned by the proxy service. Starting opencodex applies it; stopping the service restores native routing. | Codex 연결은 프록시 서비스가 관리합니다. opencodex를 시작하면 적용되고 서비스를 중지하면 기본 라우팅으로 복원됩니다. |
| `integrations.codex.openService` | Open service controls | 서비스 제어 열기 |

Keep old `nav.api`, `nav.claude`, and `nav.grok` keys in this WP if other
components still use them (`nav.claude`/`nav.grok` currently do); dead-key
cleanup is a separate mechanical pass after `rg` proves no references.

## 8. `gui/tests/integrations-routing.test.ts` — exact suite

Create the file with these exact test names and assertions:

```ts
import { expect, test } from "bun:test";
import {
  INTEGRATION_TAB_HASHES,
  hashBelongsToPage,
  readPageFromHash,
  resolveAppHashChange,
} from "../src/app-routing";

test("registers every Integrations sub-hash without normalization", () => {
  expect(INTEGRATION_TAB_HASHES).toEqual([
    "integrations/keys",
    "integrations/codex",
    "integrations/claude",
    "integrations/claude/desktop",
    "integrations/grok",
    "integrations/opencode",
    "integrations/pi",
    "integrations/hermes",
    "integrations/openclaw",
    "integrations/kimi",
    "integrations/gajae",
  ]);
  for (const raw of INTEGRATION_TAB_HASHES) {
    expect(readPageFromHash(raw)).toBe("integrations");
    expect(hashBelongsToPage(raw, "integrations")).toBe(true);
    expect(resolveAppHashChange(raw)).toEqual({ page: "integrations", replaceTo: null });
  }
});

test("redirects legacy API Claude and Grok hashes with replace semantics", () => {
  expect(resolveAppHashChange("api")).toEqual({
    page: "integrations",
    replaceTo: "integrations/keys",
  });
  expect(resolveAppHashChange("claude")).toEqual({
    page: "integrations",
    replaceTo: "integrations/claude",
  });
  expect(resolveAppHashChange("grok")).toEqual({
    page: "integrations",
    replaceTo: "integrations/grok",
  });
});

test("normalizes unknown Integrations suffixes to Overview", () => {
  expect(resolveAppHashChange("integrations/nope")).toEqual({
    page: "integrations",
    replaceTo: "integrations",
  });
});

test("keeps nested Claude Desktop deep link registered", () => {
  expect(hashBelongsToPage("integrations/claude/desktop", "integrations")).toBe(true);
  expect(resolveAppHashChange("integrations/claude/desktop").replaceTo).toBeNull();
});

test("Integrations owns one wrapping ARIA tablist and lazy active-gated panels", async () => {
  const page = await Bun.file(new URL("../src/pages/Integrations.tsx", import.meta.url)).text();
  expect(page).toContain('className="page-tabs" role="tablist"');
  expect(page).toContain('role="tab"');
  expect(page).toContain('role="tabpanel"');
  expect(page).toContain("if (!mounted.has(definition.id)) return null");
  expect(page).toContain("active={active}");
  expect(page).toContain("preventScroll: true");

  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  const start = css.indexOf(".page-tabs {");
  const strip = css.slice(start, css.indexOf("}", start));
  expect(strip).toContain("flex-wrap: wrap");
  expect(strip).toContain("overflow: visible");
});

test("sidebar collapses API Claude and Grok into one Integrations entry", async () => {
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  const nav = app.slice(app.indexOf("const NAV"), app.indexOf("];", app.indexOf("const NAV")));
  const ids = [...nav.matchAll(/id: "([a-z-]+)"/g)].map(match => match[1]);
  expect(ids).toContain("integrations");
  expect(ids).not.toContain("api");
  expect(ids).not.toContain("claude");
  expect(ids).not.toContain("grok");
  expect(app).not.toContain("nav-entry-claude");
  expect(app).not.toContain("toggleClaude");
});
```

Add one real-hook case to this file by copying the `mountAt` harness from
`providers-hash-history.test.tsx` (rename the file to `.tsx` only if JSX is
used; otherwise render with `React.createElement`). Exact test name:

`legacy Integrations hashes are replaced on initial mount without adding a history entry`

Run it once each for `#api`, `#claude`, and `#grok`; assert destination hash,
`page === "integrations"`, and unchanged `history.length`. This is the
observable proof for the initial-effect placement in §3, which pure resolver
tests cannot provide.

## 9. Verification

Run after WP5 + WP6 files are both applied:

```bash
cd gui
bun test tests/integrations-routing.test.ts tests/dashboard-tabs.test.ts tests/providers-hash-history.test.tsx
bun run lint:i18n
bun run lint
bun run build
```

Manual browser proof at desktop and 760 px:

1. Open each legacy hash directly; URL changes with no extra Back stop.
2. Visit all outer tabs, then Back/Forward through them; selected tab and panel
   follow the hash.
3. Visit Claude Desktop, reload, and verify both outer Claude and inner Desktop
   are selected.
4. Use ArrowLeft/Right/Home/End across a two-row wrapped strip; focus never
   scrolls the page and every focused tab is visible.
5. Inspect Network while moving between visited tabs; only the active page's
   polls continue.
