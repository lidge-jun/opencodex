# 010 phase 1 - seven-group sidebar

Superseded by 030_refine_and_land_outcome.md for the shipped shape (eight rows; Connect
without a switcher). Kept as the record of the first cycle.

## Scope

IN: gui/src/nav-groups.ts (NEW), gui/src/components/SectionSwitcher.tsx (NEW),
gui/src/styles/section-switcher.css (NEW), gui/src/App.tsx, gui/src/i18n/*.ts (11
catalogs), gui/tests (sidebar-rows, sidebar-codex-mark, sidebar-codex-set,
dashboard-tabs, i18n-language-switch, NEW section-switcher test), gui/design-system/
components.md, docs-site guides (web-dashboard.md, claude-code.md + fr/ja/ko/ru/tr/
zh-cn/zh-tw), structure/dashboard-and-usage.md, structure/gui-and-management-api.md.
OUT: app-routing.ts and use-app-route-state.ts behaviour (read only), every page
component body, src/ runtime.

## File change map

### NEW gui/src/nav-groups.ts

```ts
import type { TKey } from "./i18n/shared";
import type { Page } from "./app-routing";
import { IconGrid, IconCodex, IconServer, IconBoxes, IconBot, IconActivity, IconGlobe } from "./icons";

export type NavGroupId = "dashboard" | "connect" | "codex-set" | "providers" | "models" | "subagents" | "usage-logs";
export interface NavGroup { id: NavGroupId; tkey: TKey; Icon: typeof IconGrid; pages: readonly [Page, ...Page[]] }

export const NAV_GROUPS: readonly NavGroup[] = [
  { id: "dashboard", tkey: "nav.dashboard", Icon: IconGrid, pages: ["dashboard"] },
  { id: "connect", tkey: "nav.connect", Icon: IconGlobe, pages: ["claude", "integrations", "remote", "remote-workspace"] },
  { id: "codex-set", tkey: "nav.codexSet", Icon: IconCodex, pages: ["codex-set"] },
  { id: "providers", tkey: "nav.providers", Icon: IconServer, pages: ["providers"] },
  { id: "models", tkey: "nav.models", Icon: IconBoxes, pages: ["models"] },
  { id: "subagents", tkey: "nav.subagents", Icon: IconBot, pages: ["subagents"] },
  { id: "usage-logs", tkey: "nav.usageLogs", Icon: IconActivity, pages: ["usage", "logs", "storage"] },
];

export function groupForPage(page: Page): NavGroup | null   // startup -> null
export function visibleGroupPages(group: NavGroup, opts: { remoteWorkspaceAvailable: boolean }): Page[]
  // drops "remote-workspace" when unavailable
```

### NEW gui/src/components/SectionSwitcher.tsx

Props `{ items: readonly { page: Page; label: string }[]; currentPage: Page;
onNavigate(page: Page): void; ariaLabel: string }`. Renders
`<nav className="section-switcher" aria-label={ariaLabel}>` with one
`<button type="button" className="section-switcher-btn" aria-current={page === currentPage ? "page" : undefined}>`
per item. Left/Right/Home/End move focus among the buttons (wrapping); Enter/Space are
native button activation. Imports `../styles/section-switcher.css`. It has no
visible text of its own (labels arrive translated).
Focus recovery: the component remembers whether focus was inside it (focus/blur on
the nav). When `items` change and focus had been inside but the focused button is
gone (Remote Workspace became unavailable), a layout effect moves focus to the
current page's button, else the first button.

### NEW gui/src/styles/section-switcher.css

Pill group using existing tokens only (`--border`, `--radius-pill`, `--surface`,
`--raised`, `--muted`, `--text`, `--accent-ring`, `--weight-semibold`,
`--control-touch`): inline-flex, wrap, 2px padding/gap, bottom margin; active
= `[aria-current="page"]` raised fill + semibold; focus-visible ring; at
`max-width: 760px` buttons get `min-height: var(--control-touch)`.

### MODIFY gui/src/App.tsx

- Remove the `NavEntry` type and `NAV` array (lines ~64-84) and icon imports
  only they used; import `NAV_GROUPS, groupForPage, visibleGroupPages` and
  `SectionSwitcher`.
- Sidebar: `NAV_GROUPS.map(group => ...)`; `active = groupForPage(page)?.id === group.id`;
  `data-page={group.pages[0]}` plus `data-group={group.id}`; onClick
  `navigateToPage(group.pages[0])`. The per-row remote-workspace filter goes away
  with the row.
- The row click keeps `setNavOpen(false)` beside navigation, so a mobile drawer
  still closes on selection (App.tsx:465-466 today).
- Outside the page-keyed ErrorBoundary (it remounts on every page change and would
  destroy the focused switcher button), as the first child of `.main-inner` and only
  when `targetsSettled`:
  `const group = groupForPage(page)`,
  `const sectionPages = group ? visibleGroupPages(group, { remoteWorkspaceAvailable }) : []`;
  render `<SectionSwitcher>` when `sectionPages.length > 1`, items labelled
  `t(PAGE_TKEY[p])`, `onNavigate={navigateToPage}`,
  `ariaLabel={t("nav.sectionNavigation")}`.
- ErrorBoundary keeps `key={page}` and `PAGE_TKEY[page]`.

### MODIFY gui/src/i18n/*.ts (en, ko, ja, zh, zh-TW, de, fr, pt, ru, tr, vi)

Add beside `nav.codexSet`: `nav.connect`, `nav.usageLogs`,
`nav.sectionNavigation`; change `nav.codexSet` to `Codex` everywhere.
Because "Codex" now equals the English value in every catalog, add `nav.codexSet`
(product name) to the intentional-English allowlists in
`gui/tests/locale-parity.test.ts` (ZH_TW_KEEP_ENGLISH) and
`gui/tests/fr-localization.test.ts` (INTENTIONAL_ENGLISH), plus any other per-locale
allowlist a test run reveals.

| key | en | ko | ja | zh | zh-TW | de | fr | pt | ru | tr | vi |
|---|---|---|---|---|---|---|---|---|---|---|---|
| nav.connect | Connect | 연결 | 接続 | 连接 | 連線 | Verbinden | Connexion | Conexão | Подключение | Bağlantı | Kết nối |
| nav.usageLogs | Usage & Logs | 사용량 & 로그 | 使用量とログ | 用量与日志 | 用量與日誌 | Nutzung & Protokolle | Utilisation et journaux | Uso e logs | Использование и журналы | Kullanım ve Günlükler | Mức dùng & nhật ký |
| nav.sectionNavigation | Section pages | 섹션 페이지 | セクションのページ | 分区页面 | 分區頁面 | Bereichsseiten | Pages de la section | Páginas da seção | Страницы раздела | Bölüm sayfaları | Trang trong mục |

### MODIFY tests

- gui/tests/sidebar-rows.test.ts: the first test becomes "seven groups in order":
  import `NAV_GROUPS`; ids equal
  `["dashboard","connect","codex-set","providers","models","subagents","usage-logs"]`;
  members exact; no page in two groups; every `VALID_PAGES` member except
  `startup` belongs to a group; `groupForPage("startup")` is null; usage-logs'
  first member is `usage`; App source contains `NAV_GROUPS.map(`. Keep the
  navigation-only and CSS tests unchanged.
- gui/tests/sidebar-codex-mark.test.tsx: take the Icon from
  `NAV_GROUPS.find(g => g.id === "codex-set")!.Icon`; keep every geometry assertion.
- gui/tests/sidebar-codex-set.test.ts: assert nav-groups.ts holds
  `{ id: "codex-set", tkey: "nav.codexSet", Icon:` and App contains `NAV_GROUPS.map(`.
- gui/tests/dashboard-tabs.test.ts: order[0] dashboard, order[1] connect, order[2]
  codex-set from `NAV_GROUPS`.
- gui/tests/i18n-language-switch.test.tsx: NAV_TKEYS mirror the seven rows; update
  the English, zh-TW, zh and French expectations from the table above.
- NEW gui/tests/section-switcher.test.tsx (happy-dom, same harness style as existing
  DOM tests): named nav, only the current page has aria-current, click calls
  onNavigate, ArrowRight/End/Home move focus; pure test that
  `visibleGroupPages(connect, { remoteWorkspaceAvailable: false })` omits
  remote-workspace and keeps it when true; a DOM test that removes a focused item by
  re-rendering and asserts focus lands on a surviving button.
- Same file: a DOM test that keyboard-activates another button, re-renders with the
  new currentPage (same component instance, as App does outside the boundary), and
  asserts focus stayed on the activated button.

### MODIFY docs

- docs-site/src/content/docs/guides/web-dashboard.md:412 - Claude lives under
  **Connect**; add a short paragraph listing the seven rows and the grouped members,
  Usage first.
- docs-site claude-code.md:908 and the fr/ja/ko/ru/tr/zh-cn/zh-tw equivalents -
  "(below API)" becomes "under Connect" in each language.
- gui/design-system/components.md "App shell and navigation" - add the switcher rule.
- structure/dashboard-and-usage.md:121 and structure/gui-and-management-api.md:275 -
  seven rows, groups, Logs reached through Usage & Logs.

## Acceptance criteria (with activation)

1. c-1 seven rows: rendered DOM shows exactly 7 `.nav-item` in order; unit test on
   `NAV_GROUPS`.
2. c-2 switcher: `#claude` shows Claude / Integrations / Remote Link (Workspace
   absent: standalone localhost has no workspace, which activates the hidden-member
   path); clicking Integrations lands on `#integrations`. The unit test also
   covers the available case.
3. c-3 Usage first: clicking "Usage & Logs" lands on `#usage`.
4. c-4 deep links: `#logs/debug`, `#usage/companion`, `#integrations/keys`,
   `#claude/code`, `#api`, `#debug`, `#codex-auth`, `#storage` open the right
   page and light the right row; existing routing tests stay green.
5. c-5 i18n: `cd gui && bun run lint:i18n` exit 0 + locale parity tests.
6. c-6 gates: focused gui tests, gui `bun run lint` and `bun run build`, root
   `bun run typecheck` and `bun run structure:check`.
7. c-7 browser QA: screenshots of the desktop sidebar, Connect switcher, Usage & Logs
   switcher, and the narrow-width drawer.
8. Exceptional states (part of c-2/c-4/c-7 evidence):
   - Back/Forward: Usage -> Logs via switcher -> Storage, then Back twice returns to
     Logs then Usage with the switcher state following.
   - `#startup`: no switcher, no sidebar row active.
   - `#remote-workspace` on standalone: Connect row active, recovery notice visible,
     switcher shows Claude/Integrations/Remote Link with no button carrying
     aria-current.
   - Mobile drawer: a row click closes the drawer.
   - Remote pairing (`targets.connected` without a session) is not reachable on a
     standalone localhost; the switcher renders above the pairing form by placement,
     which is checked by source inspection and left to the user's QA on a paired hub.

## Verification

- `cd gui && bun test tests/sidebar-rows.test.ts tests/sidebar-codex-mark.test.tsx tests/sidebar-codex-set.test.ts tests/dashboard-tabs.test.ts tests/i18n-language-switch.test.tsx tests/section-switcher.test.tsx tests/i18n-locales.test.ts tests/locale-parity.test.ts tests/fr-localization.test.ts tests/integrations-routing.test.ts tests/protocol-deep-links.test.ts`
  - these read the changed modules by import or direct file read.
- `cd gui && bun run lint && bun run lint:i18n && bun run build` - covers gui/src.
- root `bun run typecheck`, `bun run structure:check` (structure docs edited).
- Rendered: local proxy on a spare port with an isolated OPENCODEX_HOME, opened in the
  in-app browser.

## Lanes (subagents, disjoint write scopes)

- main: nav-groups.ts, SectionSwitcher.tsx, section-switcher.css, App.tsx, gui tests.
- lane i18n (sol executor): the 11 gui/src/i18n catalogs only.
- lane docs (sol executor): docs-site files, design-system components.md, the two
  structure docs only.
No lane runs branch-level git operations; main commits.

## Reflection record

- Sent 010 rev 1 to the same handle; verdict MISALIGNED with three gaps, no redesign:
  (1) drawer dismissal missing from the click contract - FOLDED (App bullet);
  (2) focus recovery when Workspace disappears - FOLDED (SectionSwitcher focus
  recovery + DOM test); (3) exceptional-state/history checks - FOLDED (criterion 8),
  with remote pairing recorded as not reachable on standalone and handed to user QA.
- 010 rev 2 resolves every listed gap; architect's D-ID mapping D1-D9 covers all plan
  sections.

## Audit record

- Reviewer `01a10737-0cd2-7be3-a846-7c8368bdbb57` (gpt-6.1-sol, fresh context) on rev 2:
  VERDICT FAIL with two blockers. (1) switcher inside the page-keyed ErrorBoundary
  loses focus on activation - FOLDED: rendered outside the boundary + focus-survival
  DOM test. (2) `nav.codexSet = "Codex"` trips English-placeholder tests - FOLDED:
  allowlist entries + fr-localization in the verifier. Notes 3-6 accepted (oxlint,
  manifest ownership already covers gui/, component CSS import precedent, happy-dom
  harness in i18n-language-switch.test.tsx).
