# Work phase 020 — provider rail hierarchy and responsiveness

## Outcome

Replace the rail's horizontal fragment pile with a compact two-line semantic row, remove duplicated page controls, and make split-pane/detail composition adapt before text becomes clipped or vertically stacked.

## P stale check — 2026-07-18

- Account phase commits `360a72c` and `6cab890` only touched shared detail-tab tokens in this slice; the rail DOM, duplicate header/Add action, listbox focus owner, and repeated row declarations remain unchanged.
- Live Vite/browser review still renders the page-level `Providers/Add Provider` and rail-local `Providers/Add provider` simultaneously.
- At effective CSS width 1800 the workspace root is only 908px wide (`280px rail + 16px gap + 612px detail`) because the `@media (min-width:1200px)` rule hard-caps the detail track at 800px and the surrounding page max-width centers the root. This is visually sparse but not document overflow.
- The prior effective 1024/960 observations remain the clipping trigger: the viewport-only 768px rule does not fire while the available workspace area is already below the rail + usable-detail minimum. A shell-local container decision is still required.
- The row still has six independent horizontal peers plus three separate `.providers-workspace-rail-row` declarations; long names, model count, badge, trail, and chevron compete before name ellipsis can protect the row.
- Existing original-color provider icons still flow through `providerIconSrc` into an `<img>` and must remain untouched.
- `--fg` and `--fg-muted` remain in filter/detail actions in the touched stylesheet and are undefined by the current design tokens.

The locked diff plan remains valid. One implementation clarification: the rail secondary line owns both duplicate config id and model count so they cannot remain independent shrink-resistant siblings.

## Scope boundary

### IN

- `gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx`
- `gui/src/components/provider-workspace/ProviderRail.tsx`
- `gui/src/styles/provider-workspace-shell.css`
- `gui/src/i18n/{en,ko,de,zh}.ts` only if new accessible copy is unavoidable
- `tests/provider-workspace-rail.test.ts` (new pure/source contract)
- `docs/design-system/components.md` during C after behavior is proven

### OUT

- Provider logo replacement, catalog grouping logic, filter feature redesign, overview quota cards, global sidebar redesign, or arbitrary new breakpoints not grounded in the app shell.

## Exact diff plan

### MODIFY `ProviderWorkspaceShell.tsx`

- Delete the rail-local title and Add button because the page header already owns those actions.
- Keep search and filter as the first rail controls.
- Change rail group descriptors from preformatted `Label (count)` strings to `{ id, label, count, items }` and render label/count as separate spans.
- Fix listbox focus ownership: the listbox itself is not an extra Tab stop when option buttons own focus; retain ArrowUp/Down/Home/End behavior on bubbled option events.
- Pass unchanged provider data to `RailRow`; do not move auth/account state into the shell.

### MODIFY `ProviderRail.tsx`

- Replace independent name/badge/model-count/trail siblings with icon + copy + trail.
- Primary copy: display name and only necessary Free/Local exception badge.
- Secondary copy: model count and duplicate config id only when disambiguation is required. Readiness text remains in the group heading and localized button name/title; the fixed dot stays empty and `aria-hidden`.
- Keep default star with accessible label; remove or responsively hide chevron on persistent desktop split navigation.
- Preserve `providerIconSrc` and its original `<img>` path; do not recolor source SVGs or replace them with workspace-tinted masks.
- Keep full label in title/accessible name; never allow `word-break` or vertical glyph stacking.

### MODIFY `provider-workspace-shell.css`

- Consolidate duplicate `.providers-workspace-rail-row` declarations into one tokenized grid/flex definition.
- Use existing `--space-*`, `--text-*`, `--radius-*`, `--text`, `--muted`, `--green`, `--amber`, and `--border`; replace undefined `--fg`/`--fg-muted` usages in the touched workspace surface.
- Set row minimum geometry, `min-width:0`, ellipsis, `white-space:nowrap`, and stable hover/focus/selected fills.
- Make group headings sentence case with separate tabular count.
- Add a shell-local container wrapper/query and collapse the split below approximately 640px of available workspace width, derived from a 280px rail + gap + usable 320px detail. Keep the existing viewport rule as fallback.
- At constrained desktop widths, reduce rail width and collapse `.pws-overview-layout` to one column before the key/value detail wraps badly.
- At the existing mobile boundary, stack rail/detail, bound the rail list height, and keep 44px touch targets. Do not add scroll-driven motion.
- Ensure the workspace root and children cannot create horizontal document overflow.

### NEW `tests/provider-workspace-rail.test.ts`

- Verify status label/class mappings and the semantic source contract for primary/secondary copy.
- Assert the shell no longer renders the duplicate rail Add action or listbox `tabIndex=0`.
- Assert CSS contains no `var(--fg` references and the row copy has explicit no-wrap/ellipsis contracts.
- These source assertions are a narrow regression net; screenshots remain the layout oracle.

### C-phase SoT sync

- Update `docs/design-system/components.md` with provider rail two-line grammar, tab semantics, account-row state rules, and the no-raw-ID requirement after the rendered implementation passes.

## Activation matrix

| Case | Trigger | Observable evidence |
|---|---|---|
| previous collision | long provider + count + default/free state | no overlap; name ellipsizes; metadata remains readable |
| duplicate name | two display labels collide | safe config-id disambiguation without raw fragment dominance |
| status | ready/setup/disabled | localized group heading + accessible name/title, with empty reinforcing dot |
| empty model count | undefined/zero | no orphan separator or floating dot |
| constrained desktop | effective CSS width around 1024/768 | rail contracts and detail becomes one column before clipping |
| mobile | effective CSS width 390/320 | stacked composition, bounded rail, 44px controls |
| Korean/English | locale switch with longest labels | no character stacking or clipped control labels |
| themes | light/dark | active/focus states use defined tokens and remain visible |
| keyboard | Tab then ArrowUp/Down/Home/End | one coherent option focus model, no listbox double stop |

## Verification

```sh
bun test --isolate tests/provider-workspace-rail.test.ts tests/provider-workspace-data.test.ts tests/provider-workspace-state.test.ts
bun run typecheck
cd gui && bun run lint:i18n
cd gui && bun run build
rg -n 'var\(--fg|font-size:\s*[0-9]|font-weight:\s*[0-9]' gui/src/styles/provider-workspace-shell.css
```

Browser screenshots and observed DOM metrics are required at desktop, split, tablet, mobile, and narrow widths in English and Korean. Stop after one clean observation per changed state/width; rerender only after a repair.

## B implementation receipt — 2026-07-18

- Added the source/status contract test and observed `1 pass / 3 fail` before production edits. After the DOM/CSS implementation the rail/workspace suite is `53 pass / 0 fail / 213 assertions`.
- Deleted the rail-local Providers/Add action and removed the listbox's duplicate tab stop. Group labels and tabular counts now have separate visual owners and a full localized group label.
- Replaced the six-peer row with original-color icon + two-line copy + fixed star/status trail. Model count and collision-only config id share the secondary line; status text remains in the group/accessibility contract and never enters the dot.
- Consolidated the base row rule, removed the chevron, replaced undefined foreground aliases, and added no-wrap/ellipsis/focus/selected contracts from existing design tokens.
- Added a named shell container and scoped wide-page expansion. The workspace now consumes 1368px inside an effective 1800px viewport instead of staying at 908px; the detail grows from 596px to a bounded 960px while document and shell scroll widths remain equal to client widths.
- Container states are derived from actual workspace width: a 710px constrained split uses a 240px rail and one-column overview; a 646px workspace stacks rail/detail. The 320px viewport stacks actions and preserves a 274px overflow-free root.

### Browser-discovered repair during B

The first constrained screenshot still rendered Base URL characters vertically because the overview container override appeared before the later base `.pws-overview-layout` rule. The override was moved after the base declaration; the same effective 1024px viewport then rendered a 452px one-column overview with normal URL wrapping and no overlap.

### Build evidence

```text
bun test --isolate tests/provider-workspace-rail.test.ts tests/provider-workspace-data.test.ts tests/provider-workspace-state.test.ts
  53 pass / 0 fail / 213 assertions
focused ESLint (ProviderWorkspaceShell + ProviderRail)
  0 errors / 0 warnings
cd gui && bun run build
  tsc PASS; Vite build PASS; pre-existing chunk-size warning only
```

## C verification receipt — 2026-07-18

### Automated

```text
rail + workspace + account regression suite
  61 pass / 0 fail / 237 assertions
focused shell/rail ESLint
  0 errors / 0 warnings
gui production build
  PASS
bun run privacy:scan
  PASS
undefined workspace foreground token scan
  0 matches
```

### Browser viewport matrix

The in-app Browser requested dimensions render at a 1.25 CSS scale in this host; both requested and effective dimensions were recorded.

| Requested | Effective CSS | Workspace state | Result |
|---:|---:|---|---|
| 1440 | 1800 | wide split | root 1368, rail 280, main 1072, detail 960; all client/scroll widths equal |
| 819 | 1024 | constrained split | root 710, rail 240, main 458; one-column overview; no vertical URL/text breakup |
| 768 | 960 | stacked | root/rail/main 646; bounded rail scroll and full-width detail |
| 312 | 390 | mobile stacked | root 344; actions/search/rows/tabs fit; document overflow zero |
| 256 | 320 | narrow stacked | root 274; page actions wrap; document/header overflow zero |

### Interaction and locale/theme evidence

- English and Korean narrow screenshots contain no vertical glyph stacks in the rail, no visible Ready/status text inside rows, and no clipped Add Provider action.
- All visible row text is display name, exception badge, and model/config metadata; readiness remains in the group label and localized option name.
- Listbox `tabindex` is absent. ArrowDown moved Anthropic -> Cursor and End moved Cursor -> xAI Grok using the option buttons as the single focus model.
- Original provider `<img>` assets report `filter: none`; light and dark screenshots retain source colors. Selected/focus/status treatment remains visible in both themes.
- The Korean 320px filter menu measured left 52/right 282 within a 320px viewport and closed with Escape.
- Browser console contains no error or warning entries. Theme and locale were restored to the original System/English values after QA.

### Design SoT sync

`docs/design-system/components.md` now records the provider rail grammar, container-based split behavior, original-color SVG rule, tab semantics, account states, and no-raw-id privacy contract.

VERDICT: PASS (provider-rail-polish)
