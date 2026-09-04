# 002 — Decisions: keep / remove / collapse per element

Merged from 001 (R1 claude-fable via sol slot, R2 claude-opus-5, R3 grok-4.6) plus the main
agent's own pass over the corrected captures. Rule applied throughout: nothing loses capability;
a hidden control moves behind a disclosure, tooltip, detail view, or to its owning page.

Ranking is by noise removed (screen area × pages affected × duplication). Each item names the
work-phase that lands it. Votes: number of reviewers proposing remove/collapse/demote.

## Verdicts

| # | Element | Votes | Verdict | Owner phase |
|---|---|---|---|---|
| 1 | Dashboard tabs 활성 프로바이더 / 사용 가능한 모델 (Dashboard.tsx:54-57, dashboard-providers-section.tsx, dashboard-models-section.tsx) | 3/3 | REMOVE tabs; `#dashboard/providers` → `#providers`, `#dashboard/models` → `#models` redirect | 020 |
| 2 | Dashboard: subagent v1/base/v2 in the stat row (dashboard-overview-head.tsx:36-64) | 3/3 | REMOVE from dashboard; owner = Subagents (already has it via SubagentDelegationSection? — verify at P; if not, Models' copy moves there) | 020 |
| 3 | Dashboard: 서브에이전트 위임 card (dashboard-overview-sections.tsx:127) | 3/3 | REMOVE; owner = Subagents | 020 |
| 4 | Dashboard: 쉐도우 호출 가로채기 panel (dashboard-overview-sections.tsx:626) | 3/3 | REMOVE; owner = Models controls row | 020 |
| 5 | Dashboard: 웹 검색 / 비전 사이드카 cards (dashboard-overview-sections.tsx:509,549) | 3/3 | COLLAPSE both into one `<details>` "사이드카" (closed by default) on the dashboard | 020 |
| 6 | Dashboard: Codex 실행 시 opencodex 시작 card (dashboard-overview-sections.tsx:487) | 3/3 | MOVE to Startup 보호 상태 상세 panel atomically (hook `useCodexAutostart`) | 020 |
| 7 | Dashboard: 메모리 관찰 4-stat block (MemoryObservabilityCard.tsx:451) | 3/3 | COLLAPSE the stat row into the existing `<details>`; keep pressure bar, in-flight, restart | 020 |
| 8 | Dashboard: 버전 / 가동 시간 / 토큰(30일)+커버리지 stat cards | 2/3 | KEEP status + 프로바이더 + 토큰(30일); DROP the 버전 and 가동 시간 cards; both render as a visible sub-line on the status card | 020 |
| 9 | Dashboard subtitle (Dashboard.tsx:80) | 3/3 | REMOVE | 020 |
| 10 | Sidebar GitHub star orb (sidebar-github-row.tsx:136) | 3/3 | REMOVE from chrome; the star action stays reachable in the update dialog (DashboardDialogs) | 010 |
| 11 | Sidebar GitHub link row + update orb (sidebar-github-row.tsx:131,147) | 3/3 | COLLAPSE into one footer icon row: GitHub link icon + update icon (dot only when available); no text label | 010 |
| 12 | Sidebar language + theme rows (App.tsx:323,335) | 3/3 | COLLAPSE into the same footer icon row: globe icon opens the existing Select (beside placement), theme icon cycles; text labels removed, aria-labels kept | 010 |
| 13 | Sidebar "프록시" action label (App.tsx:339) | 2/3 | REMOVE label; orbs keep aria-label/title | 010 |
| 14 | Sidebar version chip | 1/3 | KEEP (R2/R3) | — |
| 15 | Sidebar nav rows | 1/3 | KEEP all 9 (R2/R3; route moves are out of scope) | — |
| 16 | Models page-head Codex-restart orb (Models.tsx:2207) | 1/3 (R3) | REMOVE (sidebar orb + stale banner remain) | 030 |
| 17 | Models catalog subtitle (Models.tsx:2226 SUBTITLE_TKEY.catalog) | 3/3 | COLLAPSE: subtitle → focusable `Tooltip` trigger (ⓘ button) next to the tab strip; combos/routing subtitles → keep only in empty state | 030 |
| 18 | Models global controls: 새 모델 정책 / 별칭 / 쉐도우 / v1-base-v2 / 기본 창-상한 + paragraph (Models.tsx:1580-1750) | 3/3 | COLLAPSE into one `<details className="models-advanced">` "고급" (closed by default); the v1/base/v2 row moves to Subagents (see #2) | 030 |
| 19 | Models 피커 순서 paragraph (Models.tsx:1752) | 3/3 | COLLAPSE → focusable `Tooltip` trigger (ⓘ button) after 모두 펼치기 | 030 |
| 20 | Models per-provider header control wall (6 controls × N) | 2/3 | COLLAPSE 기본 별칭 사용 / 커스텀 모델 추가 / 기본 창-상한 / 사용자 지정 창 into a per-provider "⋯" labelled disclosure (inline reveal, not a menu); keep edit + 모두 켜기/끄기 inline | 030 |
| 21 | Integrations 18-tab strip (Integrations.tsx:142) | 3/3 | COLLAPSE: strip shows 개요 + API 키 + detected/applied clients; uninstalled clients under a "더보기 ▾" overflow; hashes keep working | 040 |
| 22 | Integrations subtitle (Integrations.tsx:133) | 3/3 | REMOVE | 040 |
| 23 | Integrations cards for uninstalled clients | 3/3 | COLLAPSE below a "설치되지 않음 (N)" disclosure; applied/stale/conflict cards stay | 040 |
| 24 | Integrations 마지막 변경 cell | 2/3 | REMOVE from summary (복원 센터 shows chronology) | 040 |
| 25 | Integrations 모두 해제 | 1/3 | KEEP (R2/R3: bulk rollback is safety) | — |
| 26 | Codex 설정: 선택 순서 select ×N (AccountPriorityControl.tsx) | 3/3 | COLLAPSE: render the select only when value ≠ default OR the card is expanded; hint already sr-only | 050 |
| 27 | Codex 설정: 별칭 편집 + ✕ per card | 2/3 | COLLAPSE into a per-card "⋯" labelled disclosure; 이 계정을 다음에 사용 / 일시 중지 stay inline | 050 |
| 28 | Codex 설정: truncated account ID line | 2/3 | MOVE into the ⋯ disclosure as a visible mono line + "ID 복사" button | 050 |
| 29 | Codex 설정: 로테이션 전략 three desc lines (AccountPoolStrategyControls.tsx:71) | 2/3 | KEEP (deviation at wp5 B: six existing tests pin both lines as a visible safety property — the affinity/rebinding answer — and the component comment records that as deliberate; a 2/3 vote does not outrank a tested product decision) | — |
| 30 | Codex 설정: empty OpenAI 계정 모드 card | 1/3 (R2) | REMOVE when it has no badges/body | 050 |
| 31 | Usage 활동일 card (Usage.tsx:300) | 3/3 | REMOVE | 060 |
| 32 | Usage 요청/측정됨 pair | 1/3 | KEEP (coverage story needs both) | — |
| 33 | Usage cost row (Usage.tsx:302) | 2/3 | KEEP the number + disclaimer (R2: a number without its caveat is worse); DEMOTE font to text-control | 060 |
| 34 | Usage heatmap (Usage.tsx:400) | 3/3 | COLLAPSE into `<details>` "일별 활동" (closed by default); 7d bars unchanged | 060 |
| 35 | Usage subtitle | 2/3 | COLLAPSE → focusable `Tooltip` ⓘ button beside the 커버리지 card label | 060 |
| 36 | Startup 3 stat cards (startup-sections.tsx:59) | 2/3 | COLLAPSE into a single line under the hero ("로컬 프록시 · 백그라운드 서비스 · 자동 시작 켜짐") | 070 |
| 37 | Startup 대시보드로 돌아가기 (Startup.tsx:325) | 2/3 | REMOVE | 070 |
| 38 | Startup 복구 방법 (Startup.tsx:411) | 3/3 | COLLAPSE into `<details>`, open when not protected | 070 |
| 39 | Startup subtitle | 2/3 | MOVE into the hero card as a visible `.muted` line | 070 |
| 40 | Providers 프로바이더 개요 subtitle (ProviderOverviewDashboard.tsx:98) | 3/3 | REMOVE | 080 |
| 41 | Providers 3 summary cards | 1/3 | KEEP (R1/R3) | — |
| 42 | Providers 최근 사용 list | 2/3 | COLLAPSE into `<details>` (closed) | 080 |
| 43 | Providers "방금 전 전 확인" copy bug | R3 | FIX the ko string (double 전) | 080 |
| 44 | Logs subtitle (Logs.tsx:596) | 3/3 | REMOVE | 080 |
| 45 | Logs 10 columns → column picker | 1/3 | DEFER (Logs just reworked in #3367) | — |
| 46 | Subagents spawn_agent hint (SubagentsWorkspace.tsx:97) | 3/3 | COLLAPSE → focusable `Tooltip` ⓘ button on the 5/5 counter | 080 |
| 47 | Subagents 일 나누는 방법 / 울트라 모드 (SubagentDelegationSection.tsx:116,133) | 2/3 | COLLAPSE into `<details>` "고급" | 080 |
| 48 | Combos duplicate create CTA + search on zero combos | 2/3 | REMOVE search when count 0. The inline first-combo editor STAYS (deviation at wp8 B: four existing tests pin it as a deliberate flow — draft survives a tab switch, Create gates on exhausted targets, confirmation — same rule as #29) | 080 |
| 49 | Routing dry-run card with zero profiles | 3/3 | Render only when a profile is selected | 080 |
| 50 | Storage subtitle | 2/3 keep | KEEP (safety promise) | — |
| 51 | Compatibility second verdicts table | 1/3 | DEFER (Lab surface; opt-in) | — |

## Ask items (contested + workflow-changing) — recorded, not blocking

- #2 owner of v1/base/v2: all three say Subagents; the Subagents page currently has no such
  switch. Decision: Models' copy moves to Subagents in 030; dashboard's copy is removed in
  020. If the user wants it back on the dashboard, it is one line to re-add.
- #33 cost row: R3 wants it hidden as misleading; R2 wants it kept with the caveat. Decision:
  keep with caveat (visible caveat is the safety property).

## Phase map (dependency order, one decade doc = one work-phase = one PR)

| Phase | Doc | Scope | Depends on |
|---|---|---|---|
| wp1 | 010_sidebar_footer.md | Sidebar footer icon row (lang/theme/GitHub/update), remove star orb + action label | — |
| wp2 | 020_dashboard_home.md | Dashboard: remove clone tabs + redirects, remove duplicated settings (autostart rehomed to Startup, effort cap rehomed to Subagents, both in this phase), collapse sidecars + memory, stat row trim | — |
| wp3 | 030_models_catalog.md | Models: remove head orb, subtitle→tooltip, advanced disclosure, per-provider ⋯ disclosure, move v2 switch to Subagents | 020 |
| wp4 | 040_integrations.md | Integrations: tab overflow, uninstalled disclosure, summary trim, subtitle | — |
| wp5 | 050_codex_set.md | Codex 설정 account cards: ⋯ disclosure, priority-on-demand, ID line in disclosure, strategy ⓘ Tooltip, empty card | — |
| wp6 | 060_usage.md | Usage: 활동일, heatmap details, subtitle tooltip, cost row weight | — |
| wp7 | 070_startup.md | Startup: hero line, remove back button, recovery details, subtitle line | 020 (autostart row already rehomed there) |
| wp8 | 080_page_polish.md | Providers / Logs / Subagents / Combos / Routing small items (#40-49) | 030 (Subagents disclosure) |
| wp9 | 090_i18n_prune_docs.md | Remove orphaned i18n keys across 9 locales, docs-site dashboard pages sync | 010-080 |

Each phase's C runs: typecheck, lint:gui, lint:i18n (when copy changes), focused gui tests +
`cd gui && bun test tests`, `cd gui && bun run build`, privacy:scan, and a ko 1440 px
before/after screenshot pair with a DOM count of visible interactive controls and text nodes.

## Gate note (audit blocker 8) and a11y rule

- PR-ready gate: AGENTS.md L207-209 requires `bun run typecheck` + `bun run test` before a
  non-trivial PR is review-ready. The user forbade the repository-wide local suite for this
  task; hosted CI `gates` + `test N/4` shards on the exact head are the equivalent. Each
  phase's D records the CI rollup at merge and never claims a local full-suite run. This is a
  recorded, user-authorized deviation.
- Accessibility rule for every phase: information never moves to a `title` attribute alone;
  it becomes a visible sub-line, a disclosure body, or a focusable `Tooltip` trigger.
  Disclosures are labelled disclosures (aria-expanded), never called menus.
