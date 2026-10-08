# 020 — Findings (wp1)

Audit of #6579, #6593, #6596 and the GUI part of #6522 against the Design Read in
`000_design_read.md`. Evidence screenshots live in the lane's scratch folder
(`.tmp/r4/<auditor>/…`, not committed); the PRs carry the before/after images.
#6597 is still open and is audited after it lands.

Severity scale: P0 broken flow or data loss; P1 stated intent missing, unreachable
route, or a11y blocker; P2 visible defect a user hits; P3 polish.

## Fixed in the GUI PR (codex/r4-gui-audit)

| ID | Sev | Finding | Cause | Evidence |
|---|---|---|---|---|
| F1 | P2 | In a short window (about 320 CSS px tall, e.g. 1280×480 at 150% desktop zoom) the sidebar nav shrinks to its 8px padding and all eight rows disappear; a focused row shows only a clipped slice. The auditor rated it P1; lowered to P2 because it needs an unusually short window, and the drawer layout below 760px wide is unaffected. | `gui/src/styles/sidebar-zoom.css:48` lets the nav shrink to `min-height: 0` while brand and foot keep their height | a1/shots/short-focused-nav.png, short-native-equivalent.png |
| F2 | P2 | Claude → Web search / Vision sidecar override rows: at 768px (French) the two controls cover the setting title and squeeze the description to a word per line; at 390px the model input runs past the card edge and is clipped. | `gui/src/pages/claude-code-sections.tsx:165` unwrapping control row, `:198` fixed 210px input, shared `.setting-row` stacks only below 760px viewport | a2/shots/fr-768-sidecar-overlap.png, sidecar-mobile.png |
| F3 | P2 | A failed Save on the one-page Claude settings shows its error only at the top of the page; at the bottom, where Save was clicked, the sticky bar looks unchanged. | `gui/src/pages/ClaudeCode.tsx:419` renders status above all sections only | a2/shots/failed-save-bottom.png, failed-save-top.png |
| F4 | P3 (cheap, fixed with F3) | German Save-bar status slides under Revert at 390px and 150% zoom. | `gui/src/styles-claudecode-workspace.css:187` lets the status shrink to 0 instead of wrapping | a2/shots/de-390-zoom150-dirty.png |
| F5 | P2 | Cold-loading a legacy `#debug` or `#debug/…` bookmark lands on `#logs/debug` with the Logs tab selected instead of Debug. | `gui/src/pages/logs-tab-keydown.ts:6` reads the raw hash before the passive legacy rewrite | a3/shots/debug.png vs debug-canonical.png |

## Fixed in the docs PR (codex/r4-docs-sync)

| ID | Sev | Finding | Cause |
|---|---|---|---|
| D1 | P2 | DSH guide still names the legacy `llm-pi-ai.providers.opencodex` mapping as the owned path; the dashboard (correctly) names the `[id=llm-pi-ai].config.providers.opencodex` row in the Desktop profile patch. | `docs-site/src/content/docs/guides/integrations.md:86`, `:286`, and the seven translations |
| D2 | P2 | Guides send users to an "Integrations" tab; the sidebar row and page are called Connect since #6593. | `guides/integrations.md:6`, `:452`, `guides/web-dashboard.md:264`, translations |
| D3 | P2 | The Claude guide's GUI section lists the old switch-first order; the seven translations also omit the Save/Revert/dirty contract and that the connection switch applies immediately. | `guides/claude-code.md:921`; `fr:693`, `ja:551`, `ko:614`, `ru:583`, `tr:794`, `zh-cn:520`, `zh-tw:596` |

## Reported, not fixed

| ID | Sev | Finding | Owner / reason |
|---|---|---|---|
| R3-1 | P2 | Claude Desktop Models card: a long unavailable stored choice (route plus "(unavailable)") makes the role select overflow the card at 390px (chevron and suffix clipped) and squeezes the label column to ~6px at 768px. Cause `gui/src/pages/ClaudeDesktop.tsx:517`, `:682`, `:700`; `gui/src/styles/claude-page.css:56`. Evidence a5/long-stored/long-stored-de-390.png, -768.png | lane R3 owns ClaudeDesktop.tsx and its styles |
| K1 | P3 | Mobile drawer: Tab past the last control (or Shift+Tab on entry) leaves the page for browser chrome before cycling back; the background is correctly inert. Pre-existing, not from these PRs. | known issue |
| K2 | P3 | While Save is in flight the bar keeps saying "Unsaved changes" with disabled buttons; no pending label. | known issue |
| K3 | P3 | Connect's 25-tab strip wraps to seven rows at 390px, pushing content below the fold. Pre-existing; grew by one tab in #6593. | known issue |
| K4 | P3 | Translated web-dashboard and desktop-app guides lack the new English "Dashboard layout" and "Zoom" sections (coverage gap; nothing contradicts the UI). | known issue |

## Checked and clean

Eight rows navigate and light for every owned page (Startup lights none); collapse and
expand; drawer switches at 760/761px, Escape and inert work; theme switch names,
`aria-pressed`, alignment with the globe and orbs; mac/Linux display row vs browser
"Theme" row in nine locales; reduced motion; section switcher order, named nav,
`aria-current`, arrow/Home/End, focus survival and Remote Workspace drop-out; every
legacy redirect except F5, including `#claude/account` → Anthropic Accounts while
plain Providers keeps the workspace; Connect tab order; Claude section order, draft
across tab hops, Revert, reload, loading/error/empty states; all 26 changed keys in
eleven catalogs with matching placeholders, no removed key still referenced, no
clipping in seven long locales at 1440/1024; DSH plan-path allowlist is exact
(`integration-api.ts:262`, `:273`, `:285`); design-system notes match the code.
No emoji used as UI on the audited surfaces. No console errors in roughly 250 renders.

## #6597 audit (after it landed on dev as e0238355da)

The missing-store remedy passes end to end in the sandbox: a Desktop profile manifest
without `cordis.patch.yml` shows the remedy (full path, the exact `[]` document) in the
status notice and the refused preview, the switch stays off, and creating the patch lets
Apply, the Applied badge, rollback and Disable work. All eleven catalogs carry both new
keys with matching placeholders; en/de/pt/ru/ja/ko × 1440/1024/768/390 × light/dark show no
clipping, overflow or console errors. OpenCode, Hermes and Factory Droid pages are unchanged.

| ID | Sev | Finding | Cause | Fix |
|---|---|---|---|---|
| F6 | P2 | The consequence dialog opens with focus on the invisible full-screen backdrop button; no focus ring, and Space dismisses it unseen. Predates #6597. | `gui/src/pages/integrations/ConsequenceDialog.tsx:82` `showModal()` focuses the first focusable descendant | #6623 focuses Close after `showModal()` |
| F7 | P2 | A cold client status failure shows only "Could not load integration state." with no Retry. Predates #6597. | `gui/src/pages/integrations/FileIntegrationPage.tsx:292` | #6623 adds the existing Retry control |
