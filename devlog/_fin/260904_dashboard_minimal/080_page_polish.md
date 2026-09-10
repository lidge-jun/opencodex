# 080 — WP8: page polish — Providers, Logs, Subagents, Combos, Routing

Depends on: 030 (Subagents section owns the advanced disclosure that also hosts the moved
v1/base/v2 switch).

## File change map

### Providers — MODIFY gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx

- L101: delete `<p className="muted pws-dashboard-subtitle">`.
- L196-…: wrap the `pws-dashboard-section--recent` section body in `<details>` (closed);
  the section heading becomes the summary.
- ko copy bug: `gui/src/i18n/ko.ts:2011` `"pws.dashboard.checkedAgo": "{time} 전 확인"` renders
  "방금 전 전 확인" because `{time}` is already "방금 전". Change to `"{time} 확인"` and
  verify the relative-time formatter's outputs ("3분 전" → "3분 전 확인" reads fine).

### Logs — MODIFY gui/src/pages/Logs.tsx L596

- Delete `<p className="page-sub">{t("logs.subtitle")}</p>`.

### Subagents — MODIFY gui/src/components/subagents-workspace/SubagentsWorkspace.tsx L97-100, SubagentDelegationSection.tsx L116-150

- Order hint `<p className="swi-featured-hint">` → `Tooltip` on the "5/5" counter (content
  keeps the `<Trans k="sub.orderHint" cmd="spawn_agent"/>`).
- 일 나누는 방법 알려주기 + 울트라 모드 (+ the v1/base/v2 row that 030 moved in) go under
  `<details className="swi-advanced"><summary>{t("sub.advanced")}</summary>…</details>`;
  먼저 부를 모델 and Codex 설정에도 저장 stay inline.

### Combos — MODIFY gui/src/components/ComboWorkspace.tsx L112-125

- Render `.cwi-search-row` only when `combos.length > 0`.
- Empty state DECIDED (audit blocker 3): ComboWorkspace.tsx:52-53 `selected` is null when
  `combos.length === 0`; the detail panel (combo-workspace-detail-panel.tsx:218+) renders a tab
  strip + form for that case. Change: when `combos.length === 0 && localBaseline === null` render
  `<EmptyState title={t("cws.emptyTitle")}><button className="btn btn-primary" onClick={onAdd}>{t("cws.add")}</button></EmptyState>`
  instead of the detail panel. `onAdd` (the modal opener), NOT `handleAdd`: ComboWorkspace.tsx:91-98
  `handleAdd` short-circuits to focusing `#cwi-edit-id` while `creatingFirstCombo`, and the add
  modal is suppressed in that state (L229-230); both branches are DELETED in this phase so the
  first combo is created through the same modal as every later one. The rail's 콤보 추가 (L108)
  is hidden while `combos.length === 0` so there is exactly one CTA. `cws.emptyTitle` is a NEW key.

### Routing — MODIFY gui/src/pages/RoutingProfiles.tsx L1010-1100

- Dry-run panel: render only when `selectedProfile !== null`. 라우팅 분석 empty panel: render
  only when `profiles.length > 0`.

### i18n

- ADD `sub.advanced` ("Advanced" / "고급") and `cws.emptyTitle` ("No combos yet" / "아직 콤보가 없습니다")
  to ALL NINE locale files (en, ko, ja, zh, zh-TW, de, fr, ru, tr) in the same commit; non-English
  catalogs are `Record<TKey,string>`, so a missing key fails typecheck (audit blocker 7).
  Orphans: `logs.subtitle`, `pws.dashboard.subtitle` → 090.

### Tests

- MODIFY tests pinning the removed subtitles/hint (`rg -n 'logs.subtitle|pws.dashboard.subtitle|swi-featured-hint|routing.dryRun' gui/tests`).
- NEW gui/tests/page-polish-minimal.test.tsx: Routing with 0 profiles renders no dry-run
  form; Combos with 0 combos renders no search input; Subagents advanced details closed;
  ko `pws.dashboard.checkedAgo` interpolated with "방금 전" contains no "전 전".

## Verifiers

`bun test ./gui/tests/provider-*.test.ts* ./gui/tests/logs-*.test.ts* ./gui/tests/subagent*.test.ts* ./gui/tests/combo*.test.ts* ./gui/tests/routing*.test.ts*`, `cd gui && bun test tests`, `cd gui && bun run lint:i18n`, build.

## Accept criteria

- Each touched page's ko 1440 screenshot shows no orphan subtitle; Routing empty state is one card.

## Bypass fields

E2 · CI gates · `--no-verify` · none · "early warning".
