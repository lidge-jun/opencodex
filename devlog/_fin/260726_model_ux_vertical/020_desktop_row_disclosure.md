# 020 — WP2: two-tier disclosure for Desktop model rows

Depends on WP1: the row lives inside the vertical family section WP1 builds. Audit
fold-backs (blockers 6, 7, 8) come from `001_audit_synthesis.md`.

## Scope

IN: the per-model card becoming a collapsed row that expands to its controls.
OUT: family geometry (WP1), Grok (WP3/WP4).

## Current shape

`gui/src/pages/ClaudeDesktop.tsx:425-490` (WP1 shifted it down by adding the family
disclosure header) renders every model fully expanded:
title + badge, context, effort badge, effective-default note, alias field, default
radio, and a `move to` select + button. That is ~180px per model. At 23 models in one
family the user scrolls past 4000px of controls to find one route.

## The rule this phase must not break

Row-level collapse is view state, exactly like search and paging
(`ClaudeDesktop.tsx:115-119`). The default radio and the move select must keep their
existing `onChange` handlers and keep writing to `profile`/`destinations`; collapsing a
row must not unmount those in a way that loses a pending selection. Because
`destinations` is page-level state keyed by route (`:109`), so an unmounted row's pending
move destination survives a collapse — verify this in the test rather than assuming it.

## MODIFY — `gui/src/pages/claude-desktop-lane.ts`

Add the row-summary helper so the collapsed row's content is a pure function, testable
without React:

```ts
/** What a collapsed model row shows: enough to identify and triage, nothing to edit. */
export interface RowSummary {
  label: string;
  route: string;
  available: boolean;
  /** Formatted context string, or null when the catalog does not know one. */
  context: string | null;
  /** True when this row is the family's resolved default (stored or effective). */
  isDefault: boolean;
}
```

plus:

```ts
/**
 * A row starts collapsed unless it is the family default: the default is the row a
 * user is most likely to want to change, so hiding it behind a second click would be
 * the disclosure pattern failing its own discoverability test.
 */
export function rowStartsOpen(route: string, familyDefault: string | null): boolean {
  return familyDefault !== null && route === familyDefault;
}
```

## MODIFY — `gui/src/pages/ClaudeDesktop.tsx`

### 1. State

```diff
+  // Route -> explicitly toggled open/closed. Absent means "use rowStartsOpen".
+  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
```

Row open state is deliberately NOT persisted: a family's collapse is a durable
preference, but which single model you were inspecting is not, and restoring five open
rows on reload would recreate the wall this phase removes.

### 2. Row markup

```tsx
const rowOpen = openRows[model.route] ?? rowStartsOpen(model.route, effectiveDefaults[family]);
return (
  <article
    key={model.route}
    className={`claude-model-card${rowOpen ? " open" : ""}`}
    draggable={model.available}
    onDragStart={event => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", model.route); }}
  >
    <button
      type="button"
      className="claude-model-summary"
      aria-expanded={rowOpen}
      aria-controls={`claude-model-body-${model.route}`}
      onClick={() => setOpenRows(current => ({ ...current, [model.route]: !rowOpen }))}
    >
      <IconChevron
        className="ocx-chevron"
        width={12}
        height={12}
        aria-hidden="true"
        style={{ transform: rowOpen ? "rotate(90deg)" : "none" }}
      />
      <span className="claude-model-names">
        <strong title={model.label}>{model.label}</strong>
        <code title={model.route}>{model.route}</code>
      </span>
    {context && <span className="claude-model-context">{context}</span>}
    {/* Effort stays in the SUMMARY (audit blocker 8): whether a model honours effort
        informs which model you make the family default, so folding it away defeats the
        summary's purpose. */}
    {model.effortSupported === false && <span className="claude-effort-badge off">{t("claudeDesktop.effort.displayOnly")}</span>}
    {model.effortSupported === true && <span className="claude-effort-badge on">{t("claudeDesktop.effort.supported")}</span>}
      <span className={`badge ${model.available ? "badge-green" : "badge-muted"}`}>
        {model.available ? t("claudeDesktop.available") : t("claudeDesktop.unavailable")}
      </span>
      {profile.defaults[family] === model.route && (
        <span className="claude-row-default">{t("claudeDesktop.defaultBadge")}</span>
      )}
    </button>
    {rowOpen && (
      <div className="claude-model-body" id={`claude-model-body-${model.route}`}>
        {/* effective-default note, alias field, default radio, move row —
            all moved here verbatim from the current card body */}
      </div>
    )}
  </article>
);
```

The availability badge, context and effort chip stay in the SUMMARY, not the body: they
are triage information (`000_plan.md` — do not hide state the user must act on). Only
the edit affordances — alias, default radio, move control — go behind the fold.

### 3. Interaction rules that must not regress

- Drag from a collapsed row still works: `draggable` and `onDragStart` remain on the
  `<article>`, and the summary button is inside it.
- The keyboard path to the move control is: family toggle → row toggle → select →
  button. Every step is a native focusable element, so tab order stays correct.
- A model hidden by search or the pager keeps its assignment (unchanged from WP1).

## MODIFY — `gui/src/styles.css`

```css
.claude-model-card { padding: 0; }                 /* padding moves onto the parts */
.claude-model-summary {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px;
  border: 0; background: transparent; color: inherit; cursor: pointer; text-align: left;
}
.claude-model-summary:hover { background: var(--hover); }
.claude-model-names { display: flex; min-width: 0; flex-direction: column; gap: 1px; flex: 1; }
.claude-model-body { padding: 0 12px 12px; border-top: 1px solid var(--border-soft); }
.claude-row-default { color: var(--green); font-size: 10.5px; font-weight: 600; }
```

`.claude-model-context` loses `margin-top: 6px` (it now sits inline in the summary) and
`.claude-model-title` rules are folded into `.claude-model-names`.

## Locale keys — NEW

One key, all six locales (`gui/src/i18n/{en,ko,ja,zh,de,ru}.ts`):

| Key | en | ko |
|-----|----|----|
| `claudeDesktop.defaultBadge` | `Default` | `기본` |

ja `既定`, zh `默认`, de `Standard`, ru `По умолчанию`.

## TESTS

`gui/tests/claude-desktop-row-disclosure.test.tsx` (NEW, MOUNTED — audit blocker 7):

- a non-default row renders collapsed: no alias field, no default radio, no move select
  in the DOM; the summary button reports `aria-expanded="false"`;
- the family's resolved default row renders open (`rowStartsOpen`);
- clicking a summary reveals the alias, the radio and the move control;
- **pending move destination survives a collapse**: open a row, pick a destination,
  collapse it, reopen it, and the select still shows the chosen family (this is the
  regression the `destinations`-is-page-state comment predicts, so it must be observed
  rather than assumed);
- dragging from a COLLAPSED row still sets the drag payload;
- the availability badge and context remain in the DOM while collapsed;
- `claudeDesktop.defaultBadge` resolves in all six locales.

Extend `gui/tests/claude-desktop-lane.test.ts` with the `rowStartsOpen` cases so the
pure-helper suite stays in one place.

## Verification (C)

| Command | Expected |
|---------|----------|
| `cd gui && bun test tests/claude-desktop-row-disclosure.test.tsx tests/claude-desktop-lane.test.ts` | pass |
| `cd gui && bun run test` | pass |
| `bun run lint:gui` / `bun run lint:i18n` | clean |
| headless render | collapsed rows one line tall; the default row open; expanding a row reveals alias/default/move |
