# 040 — WP4: Integrations — relevant clients first

Depends on: nothing.

## File change map

### MODIFY gui/src/pages/Integrations.tsx (L131-175)

- Delete `<p className="page-sub">{t("integrations.subtitle")}</p>`.
- Tab strip: split `TABS` into `primary` (overview, keys, + every client whose state from the
  overview's `clients` resource is `installed || applied`) and `secondary` (rest). Render
  primary tabs inline; render secondary under a `<details className="page-tabs-more">` whose
  `<summary>` reads `t("integrations.moreClients", { count })`. The `role="tablist"` stays on
  the primary strip; secondary tabs keep `role="tab"` inside the details (still one tablist by
  `aria-owns` — or simpler: put the details INSIDE the tablist div so DOM order == a11y order).
  Keyboard: `handleTabKeyDown` iterates `TABS` — unchanged; an arrow into a hidden tab opens
  the details (`detailsRef.current.open = true`) before focusing.
- The client-state source: Integrations.tsx does not load client states today (the overview
  does). Lift `useClientStates`-equivalent one level: check `IntegrationsOverview.tsx:298`
  (`clients`, `installedFileClients`) and its resource hook; move the hook call to
  Integrations.tsx and pass `clients` down as a prop to the overview (keeps one fetch).
- Direct hashes (`#integrations/omp`) still resolve: `mounted`/`tab` logic unchanged; when
  `tab` is a secondary id, open the details on mount.

### MODIFY gui/src/pages/integrations/IntegrationsOverview.tsx

- Summary (L517-556): delete the 마지막 변경 cell (L541-544). Keep detected/applied/stale +
  conditional unknown + 모두 해제.
- Cards (L593-610): partition `rows` into `rows.filter(r => r.installed || r.applied)` (grid,
  as today) and the rest under
  `<details className="integration-cards-more"><summary>{t("integrations.notInstalled", { count })}</summary><ul className="integration-cards">…</ul></details>`.
- Paths on cards: unchanged in this phase (they are the card's one-line; R1 wanted them in
  details, R3 too — defer to 080 if screenshot still reads noisy).

### MODIFY gui/src/i18n/*.ts (9)

- ADD `integrations.moreClients` ("More clients ({count})" / "다른 클라이언트 ({count})"),
  `integrations.notInstalled` ("Not installed ({count})" / "설치되지 않음 ({count})").
- `integrations.subtitle`, `integrations.summary.lastChange` → orphan; delete in 090.

### Tests

- MODIFY gui/tests/integrations-surfaces.test.tsx (asserts the tab strip): update to primary
  + details; add: navigating to `#integrations/hermes` (uninstalled fixture) opens the details
  and selects the tab.
- NEW gui/tests/integrations-minimal.test.tsx: overview with 3 installed + 5 uninstalled
  fixtures renders 3 cards in the grid and `details.integration-cards-more` summary "…(5)";
  no 마지막 변경 cell.

## Verifiers

`bun test ./gui/tests/integrations-*.test.ts*`, `cd gui && bun test tests`, `cd gui && bun run lint:i18n`, build.

## Accept criteria

- ko 1440 #integrations: tab strip fits one row for this machine (10 detected); interactive
  count 86 → ≤ 45 with details closed.
- `#integrations/aside` deep link still lands on the Aside panel.

## Bypass fields

E2 · CI gates · `--no-verify` · residual: primary/secondary split depends on a fetch — until
it settles all tabs render primary (no flash-hide) · "early warning".
