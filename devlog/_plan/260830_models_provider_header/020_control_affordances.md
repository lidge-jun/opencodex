# 020 — Control affordances: make the opaque controls say what they do

Fixes the meaning half. Depends on `010`: this phase adds visible text to the
same header, so it must be measured against a layout that no longer collapses.

## The primitive is the root cause

`gui/src/ui.tsx:8`:

```tsx
export function Switch({ on, mixed = false, onClick, disabled, label }: ...) {
  return (
    <button type="button" className={...} onClick={onClick} disabled={disabled}
      aria-pressed={mixed ? "mixed" : on} aria-label={label ?? (on ? "enabled" : "disabled")}>
      <span className="knob" />
    </button>
  );
}
```

`label` is spent entirely on `aria-label`. The only child is the knob. So every
call site that passes a `label` is describing the control to assistive tech and
to nobody else — the prop *name* implies a visible label it never renders, which
is why the call sites in this header believed they were labeled.

No i18n string needs to be **added** in this phase — every label it needs already
exists in all nine locales. The two switches fail differently, though, and the fix
differs with them: the default-aliases switch already passes the right label and it
is merely discarded, whereas the cap switch passes the **wrong** one
(`models.capValue` = "기본 128k", a value) and must be repointed at
`models.contextCapLabel`.

## Change 1 — `Switch` gains a visible-label affordance

`gui/src/ui.tsx`:

```tsx
-export function Switch({ on, mixed = false, onClick, disabled, label }: { on: boolean; mixed?: boolean; onClick: () => void; disabled?: boolean; label?: string }) {
-  return (
-    <button type="button" className={\`switch\${on ? " on" : ""}\${mixed ? " mixed" : ""}\`} onClick={onClick} disabled={disabled}
-      aria-pressed={mixed ? "mixed" : on} aria-label={label ?? (on ? "enabled" : "disabled")}>
-      <span className="knob" />
-    </button>
-  );
-}
+/**
+ * `label` is the accessible name. It is NOT rendered by default — that is
+ * deliberate for switches inside a labeled row, and it was also the defect:
+ * the two provider-header switches passed a label and rendered a bare knob, so a
+ * sighted user could not tell what they toggled. Pass `showLabel` to render it
+ * as visible text, or `title` for a hover tooltip on an icon-dense row.
+ */
+export function Switch({ on, mixed = false, onClick, disabled, label, showLabel = false, title }: { on: boolean; mixed?: boolean; onClick: () => void; disabled?: boolean; label?: string; showLabel?: boolean; title?: string }) {
+  const control = (
+    <button type="button" className={\`switch\${on ? " on" : ""}\${mixed ? " mixed" : ""}\`} onClick={onClick} disabled={disabled}
+      aria-pressed={mixed ? "mixed" : on} aria-label={label ?? (on ? "enabled" : "disabled")}
+      title={title ?? (showLabel ? undefined : label)}>
+      <span className="knob" />
+    </button>
+  );
+  if (!showLabel || !label) return control;
+  // A <span> wrapper (NOT <label>, which would compete for the accessible name)
+  // keeps exactly one accessible name; the button's aria-label wins, while sighted
+  // users get the same words. It declares flex: 0 0 auto so it preserves the
+  // atomic flex sizing the bare 34px button had in .models-provider-actions.
+  return (
+    <span className="switch-labeled">
+      {control}
+      <span className="switch-labeled-text text-label muted" aria-hidden="true">{label}</span>
+    </span>
+  );
+}
```

Two things matter about this shape:

- The default path gains a `title` fallback, so **every existing bare `Switch`
  in the app** becomes hoverable-explainable without touching its call site.
  That is the cheap fix for opacity across surfaces this unit does not own.
- The visible text is `aria-hidden` so the control keeps exactly one accessible
  name instead of announcing the label twice.

## Change 2 — the three opaque header controls

`gui/src/pages/Models.tsx`:

1. **default-aliases Switch** (line ~1250) — add `showLabel`. The header has room
   once `010` lets the row wrap, and "기본 별칭 사용" is short.
2. **cap Switch** (line ~1355) — add `showLabel` **and** fix the label itself.
   Today it is `models.capValue` = "기본 128k", a value masquerading as a name.
   The visible label must name the function; the number stays in the adjacent
   `Select`, which is where a value belongs.
3. **`+` button** (line ~1286) — give it a **visible text label**, not a tooltip.
   It must NOT be wrapped in the existing `Tooltip` component: `Tooltip` renders its
   own `<button>` (`ui.tsx:318-320`), so wrapping an interactive child produces
   invalid nested `<button><button>` markup with two competing focus targets and
   unreliable activation. Adding an `asChild`-style anchor to `Tooltip` is out of
   scope here. A native `title` is the weaker fallback because it is undiscoverable
   on touch, so the button gets short visible text (`models.customAdd`) beside the
   `+` glyph — which is what the user's complaint actually asks for.

For (2) the correct key **already exists in every locale**: `models.contextCapLabel`
— ko "기본 창 / 상한", en "Default window / cap", de "Standardfenster / Limit"
(`i18n/ko.ts:520`, `en.ts:534`, `de.ts:509`). An earlier draft of this doc
proposed inventing a key and touching all nine locale files; that was wrong.
**No i18n file changes in this phase.**

## Change 3 — cap Select says what its number means

The `Select` at line ~1362 shows "128k" with no indication of what is capped.
Pass `title` set to `models.contextCapLabel`. `Select` already accepts `title`
(`ui.tsx:79,263`) and the call site simply never passes it.

## Explicitly NOT changed

- `사용자 지정 창` keeps its text: it is a labeled button, and the user's
  confusion there is about *what the feature does*, which is a docs/tooltip
  question rather than a missing affordance. Do not rename it — the name matches
  the modal it opens. Its tooltip must **not** be `models.setAllHint`: that
  string describes turning a default window on for *every routed provider*, while
  this button opens *per-provider* model overrides. Use `models.contextHint`
  (`i18n/ko.ts:547`), which describes the actual per-model window semantics.
- The preset segmented control, `모두 켜기`/`모두 끄기`, and the collapse button
  are already legible and are left alone.
- No new control is added and none is removed: UX-LAZY-01 was applied and every
  control here is a real per-provider setting with no correct global default.

## Diff scope

- `gui/src/ui.tsx` — `Switch` signature + optional labeled wrapper.
- `gui/src/pages/Models.tsx` — two `showLabel` additions, one label-key
  correction (`models.capValue` -> `models.contextCapLabel`), a visible text
  label on `+` (**not** a `Tooltip` wrap — see Change 2), and two `title`
  passes (cap `Select`, custom-window button).
- `gui/src/styles.css` — `.switch-labeled` (inline-flex,
  `gap: var(--space-1)`, `align-items: center`, `flex: 0 0 auto`) and
  `.switch-labeled-text` (`white-space: nowrap`).
- **No `gui/src/i18n/` changes.**
- `gui/tests/models-provider-head.test.ts` — extended (the existing file; note
  the name is `...-head`, not `...-header`).

## Regression test (red first)

1. `Switch` with `showLabel` renders the label text; without it, does not.
2. `Switch` without `showLabel` sets `title` from `label` (the app-wide fallback).
3. Rendering the provider header leaves **no** `button.switch` whose meaning is
   unreachable — the assertion that catches this class of defect rather than only
   the two known instances. Note the oracle must match the shipped DOM: with
   `showLabel` the visible text is a **sibling** inside `.switch-labeled` and the
   button deliberately carries no `title`, so the check is "the button has a
   `title` OR its `.switch-labeled` wrapper contains text", not "the button
   element itself has text".
4. The cap switch's label resolves to `models.contextCapLabel`, not
   `models.capValue`. (No locale key is added, so there is nothing to check there.)

Test 3 is the one that matters: 1 and 2 test the primitive, 3 tests the property
the user actually complained about.

## Rendered verification

Screenshot the header at 1100 and 1440 in ko, and confirm by CDP that every
`button.switch` in the header resolves a non-empty accessible name **and** is legible
to a sighted user. Apply the same wrapper-aware condition stated in item 3 above — the
button has a `title` **OR** its enclosing `.switch-labeled` wrapper contains text —
because a `showLabel` switch deliberately carries no `title` and puts its visible text
in a **sibling** node. A check that inspects only the button element would fail exactly
the controls this phase fixes. Re-run the `010` geometry sweep afterwards: the added
text changes intrinsic widths, so the chip/overlap gate must still pass.


