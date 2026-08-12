# Audit round 1 — VERDICT: FAIL

An independent reviewer audited the roadmap against the actual tree and returned FAIL
with eight blockers. Every one was re-verified here before acceptance. All eight are
accepted; none is rebutted. The roadmap is amended in place and re-audited.

## The root mistake

**There are two test directories.** `tests/` at the repository root, and `gui/tests/`
with 116 files. The roadmap looked only at the first and concluded "no existing test
covers the combos route." That is false:

- `gui/tests/page-loading-contract.test.tsx:136` boots a happy-dom window at
  `#combos` and asserts against `.combos-workspace-shell-body`.
- `gui/tests/sidebar-claude-entry.test.ts:18` requires the exact Claude row and its
  `activeHashes` — the row phase 4 deletes.
- `gui/tests/routing-profiles.test.tsx:175` requires the literal string
  "Routing Intelligence (beta)" and `[data-page="routing"]`.

These are mounted behavioural tests, which is precisely the kind the roadmap proposed
to *invent* while the repository already had them. Worse, the plan's own test proposals
were mostly `expect(src).toContain(...)` string matches — assertions that pass while the
UI is broken. The reviewer's judgement stands: static source checks may supplement, but
they cannot be the oracle.

## Blockers, verified

**B1 — phase 2 cannot typecheck.** `NavEntry.id` is typed `Page`
(`App.tsx:53`) and NAV holds `{ id: "routing" }` (`App.tsx:71`). Removing `"routing"`
from the union in phase 2 while deferring NAV cleanup to phase 4 is a type error.
Same class of problem for i18n: `TKey` derives from `en`, so the tab keys must exist in
the phase that renders the strip.
→ Routing NAV row, `IconRoute`, its tests, and all tab-shell i18n keys move into
phase 2. Only the Claude row stays in phase 4.

**B2 — legacy hashes lose their destination on cold load.** `replaceHash` deliberately
emits no `hashchange` (`hash-routing.ts:8`) and the redirect runs in an effect
(`use-app-route-state.ts:87`). So a cold load at `#combos` rewrites the URL to
`#models/combos` while the tab state — initialized from the *original* hash — is already
`catalog`. The URL says Combos, the screen shows the catalog. The three
`href="#combos"` links (`Models.tsx:1104,1132,1143`) hit this on every click, and the
roadmap never scheduled changing them.
→ `readModelsTab` must recognize `combos`, `combos/*`, `routing`, `routing/*` as well
as the nested forms, so the pre-redirect hash resolves to the right tab. All three links
point at `#models/combos`. Covered by a mounted cold-load test, not a resolver assertion.

**B3 — the `active` gating destroys the drafts it was meant to protect.** A disabled
`useDataSurface` yields `data: undefined` (`data-surface.ts:59`), and the roadmap's
answer was to render the skeleton. But the skeleton *replaces* `ComboWorkspace`
(`Combos.tsx:223`), unmounting the editor and its draft. Keeping the page mounted while
swapping its subtree preserves nothing.
→ The disabled path must retain the last rendered data and keep the workspace subtree
alive. Gate the *network*, never the tree. Proven by a type → switch → switch back test.

**B4 — the hidden-work analysis gated the wrong component.** Routing and Combos do not
poll; that correction was right. But **Models does**: `pollMs: 10_000` on the catalog
resource (`Models.tsx:271`) and a second 10-second `setInterval` for V2
(`Models.tsx:302`). So the catalog keeps hitting `/api/models` and `/api/v2` while the
user reads Combos — the exact leak the plan claimed to prevent, in the one panel it never
examined. Also, `if (!active) return` does not cancel a load already in flight:
`RoutingProfiles` fetches take no signal and hiding never bumps `loadGenerationRef`.
→ Gate the catalog resource, the combo-summary resource, and the shadow/V2 effect and
interval on the catalog tab. Give Routing real cancellation, not just scheduling
suppression.

**B5 — the CSS fix is right but lands a phase late and is incomplete.** The direct-child
break at `styles.css:399` is real and the fill-panel chain is sound. But phase 2 inserts
the wrapper and phase 3 repairs it, so phase 2 knowingly ships a broken layout while
claiming all three tabs paint. Two omissions: the per-tab `.page-sub` also needs the
restored padding and `flex-shrink: 0`, and `.main-inner:has(.models-workspace-shell)`
(`styles-models-workspace.css:8`) still matches a *hidden* catalog panel — so Routing
renders at 980px on a direct visit and 1200px after the catalog has mounted once. A
history-dependent width is a bug, not a cosmetic detail.
→ All wrapper CSS moves to phase 2. The 1200px selector becomes active-panel-aware.

**B6 — `ErrorBoundary key={page}` stops resetting.** The boundary is keyed on `page`
(`App.tsx:328`) and all three tabs are now one page, so an error in Combos persists
after switching to Routing. Keying on the tab instead is worse: it remounts the whole
workspace on every switch and destroys drafts — the same trap as B3.
→ Per-panel boundaries, or a reset that clears an existing error without remounting.
Regression test: error, switch, expect a clean panel.

**B7 — the tab counts cannot work as specified.** Models' combo summary uses a different
resource key than the Combos workspace (`Models.tsx:143` vs `Combos.tsx:157`), and combo
mutations refresh only their own (`Combos.tsx:186`) — so the count goes stale right after
a create or delete. Routing has no channel at all to report `profiles.length`, which
makes the promised discoverability mitigation undeliverable as written.
→ Child-to-shell count callbacks or one shared resource owner, tested after a mutation.
A count that lies is worse than no count.

**B8 — test adequacy.** Covered above.

## Non-blocking, accepted

- The Routing header instruction was incoherent ("an `h3` carrying only the action
  buttons" — a heading cannot carry buttons). Decision: `routing.title` is dropped from
  the panel entirely and its actions move into a toolbar row; the Models page header is
  the only title. `gui/tests/routing-profiles.test.tsx:175` asserts that string, so the
  test moves with the decision rather than the decision bending to the test.
- The ≤939px stacked layout keeps a 220px rail minimum; adding a header and strip leaves
  very little detail height on short landscape viewports. Added to browser coverage.
- `nav.combos`, `nav.routing`, and `nav.claude` all keep non-sidebar consumers. Do not
  delete them.

## Revised phase map

| Phase | Scope change |
|-------|--------------|
| wp01 | unchanged — additive, green |
| wp02 | **+** Routing NAV row + `IconRoute`, **+** all tab-shell i18n keys, **+** the complete wrapper CSS, **+** catalog poll gating, **+** per-panel error boundaries |
| wp03 | **−** CSS (moved up); **+** retained-data path for drafts; **+** count callback |
| wp04 | **−** Routing NAV (moved up); keeps Claude row, remaining i18n, render grounding |

wp02 becomes the largest phase. That is correct: "remove a page, add the tab that
replaces it, keep the tree compiling and the layout intact" is one atomic change, and
splitting it was what produced four of these eight blockers.
