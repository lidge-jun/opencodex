# 020 — WP2: the locale dropdown runs off the bottom of the sidebar

## Cause

`gui/src/App.tsx:262-270` renders the locale picker as:

```tsx
<Select … placement="right" portal={false} />
```

`gui/src/ui.tsx:185` then applies positioning ONLY in the portal case:

```tsx
style={portal ? { ...menuStyle, zIndex: 60, ...dropdownStyle } : dropdownStyle}
```

So with `portal={false}` the computed `menuStyle` is discarded and the menu falls
back to CSS: `.select-dropdown-beside { top: 0; left: calc(100% + 6px) }`
(`gui/src/styles.css:334` and `:666`). `top: 0` anchors it to the trigger with no
knowledge of the viewport.

The viewport-aware logic already exists and already handles this exact case —
`gui/src/select-position.ts:41-63`, the `placement === "right"` branch, computes
`openAbove` from `spaceBelow` vs `spaceAbove` and clamps `maxHeight`. The bug is
that the sidebar dropdown never calls it.

Why it appeared now: the locale list grew to six entries
(`gui/src/i18n/shared.ts` `LOCALES`), and the sidebar footer sits near the bottom
of the viewport, so `measuredHeight` finally exceeded `spaceBelow`.

## Why `portal={false}` at all

Worth stating so the fix does not simply flip it. The non-portal path exists so
the menu inherits the sidebar's glass treatment
(`.lang-toggle .select-dropdown`, `gui/src/styles.css:333`) and stays inside the
drawer's stacking/`inert` context on mobile. Switching to `portal` would move the
node to `document.body`, losing the scoped styling and escaping the drawer's
`inert` guard while the mobile nav is open. So the fix keeps `portal={false}` and
applies the computed style there too.

## A-phase finding: the obvious fix is WRONG here

The first plan was to reuse `computeMenuStyle` on the non-portal path. The audit
killed it. `computeMenuStyle` returns `position: "fixed"`, and fixed positioning
is viewport-relative ONLY when no ancestor establishes a containing block. The
sidebar establishes one in both layouts:

| Layout | Property | Location |
|--------|----------|----------|
| Desktop | `backdrop-filter: var(--glass-blur)` | `gui/src/styles.css:225-226` |
| Mobile drawer | `transform: translateX(-100%)` / `translateX(0)` | `gui/src/styles.css:1053`, `:1059` |

Either property makes a descendant's `position: fixed` resolve against the
SIDEBAR, not the viewport. So the fixed coordinates `computeMenuStyle` produces
would be interpreted in the wrong coordinate space — the menu would move, but to
the wrong place, and the bug would look "fixed" only at the one scroll position
where the two frames happen to coincide.

Worse, the blur is conditional: `styles.css:759-762` drops it under
`@supports not (backdrop-filter)` and `@media (prefers-reduced-transparency)`.
A fixed-position fix would therefore behave DIFFERENTLY depending on the user's
accessibility settings. That is exactly the class of bug that survives review and
reappears as an irreproducible report.

Note also that the mobile case is already handled in CSS at `styles.css:1087`,
which flips the menu upward from the foot row. Only the desktop case is broken.

## MODIFY map (revised)

Stay in the sidebar's coordinate space and constrain the menu there. This is a
pure-CSS fix with no positioning-frame ambiguity.

### `gui/src/styles.css`

The desktop `.select-dropdown-beside` currently pins `top: 0` with no height
limit, so a six-item menu simply grows past the sidebar's bottom edge. Anchor it
to the trigger's bottom instead and cap its height to the space actually
available, letting it scroll rather than overflow:

```css
-.select-dropdown-beside { top: 0; left: calc(100% + 6px); right: auto; min-width: 10rem; }
+.select-dropdown-beside {
+  top: auto; bottom: 0; left: calc(100% + 6px); right: auto; min-width: 10rem;
+  max-height: min(60vh, 20rem); overflow-y: auto;
+}
```

`bottom: 0` aligns the menu's bottom edge with the trigger row, which sits in the
sidebar footer — so the menu grows UPWARD into the empty sidebar space instead of
downward past the edge. `max-height` plus `overflow-y` guarantees it can never
exceed the viewport regardless of how many locales are added later, which is the
property that actually prevents this bug from returning.

The `.lang-toggle` override at `styles.css:334` carries the same declarations and
needs the identical edit, or it wins by specificity.

### `gui/src/ui.tsx`

No change. The portal path is correct as-is, and forcing the non-portal path
through `computeMenuStyle` is precisely the mistake this section rejects.

## TESTS

A CSS-only fix needs a CSS-shape assertion, in the house style of
`gui/tests/apikeys-layout.test.ts` and `gui/tests/models-provider-head.test.ts`
(read the stylesheet as text and assert the rule's shape).

`gui/tests/locale-dropdown-bounds.test.ts` (NEW):

- `.select-dropdown-beside` no longer pins `top: 0`;
- it declares a `max-height` and `overflow-y`, so the menu can never exceed the
  viewport as locales are added;
- the `.lang-toggle` override agrees with the base rule rather than reinstating
  `top: 0` by specificity;
- the mobile flip at the 760px breakpoint is still present.

This is the assertion that would have caught the original bug: the six-locale
overflow was a missing height bound, not a missing calculation.

## Verification (C)

| Command | Expected |
|---------|----------|
| `gui: bun test tests/select-position.test.ts` | pass |
| `gui: bun run test` | pass |
| `bun run lint:gui` | clean |
