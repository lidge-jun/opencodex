# 010 — WP1: vertical family stack, Opus on top, collapsible headers

Direction and dials come from `000_plan.md`; audit fold-backs come from
`001_audit_synthesis.md` (blockers 4, 6, 7, 8, 9). This doc is the implementation
contract.

## Scope

IN: family container geometry, family-level collapse, collapsed-header legibility,
persistence, the locale keys those need.
OUT: the per-model row's internal disclosure (WP2), anything Grok (WP3/WP4).

## NEW — `gui/src/pages/collapse-store.ts`

Pure helpers, testable without a DOM. Mirrors the storage idiom in
`gui/src/pages/models-shared.ts:101-116` but parameterized by key, because WP4's Grok
page needs the same behaviour and two copies would drift (audit blocker 4).

```ts
/**
 * Keyed collapse persistence for the dashboard's collapsible group surfaces.
 *
 * Each surface passes its own storage key: the surfaces collapse different things, and
 * sharing one key would make collapsing "opus" on Desktop collapse a provider literally
 * named "opus" on the Models page.
 *
 * Collapse is view state. It never reaches the profile: `modelsByFamily` and
 * `effectiveDefaults` keep seeing every model (see claude-desktop-lane.ts).
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CollapseStore {
  /** `null` means "no stored preference" — the caller applies its data-driven default. */
  read(storage?: StorageLike): Set<string> | null;
  write(collapsed: ReadonlySet<string>, storage?: StorageLike): void;
}

function resolveStorage(storage?: StorageLike): StorageLike | undefined {
  if (storage) return storage;
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export function makeCollapseStore(key: string): CollapseStore {
  return {
    read(storage) {
      const store = resolveStorage(storage);
      if (!store) return null;
      try {
        const saved = store.getItem(key);
        if (saved === null) return null;
        const parsed = JSON.parse(saved) as unknown;
        // Corrupt JSON and non-arrays are indistinguishable from "never set" for the
        // user's purposes, so both fall back to the data-driven default rather than
        // silently collapsing everything.
        return Array.isArray(parsed)
          ? new Set(parsed.filter((value): value is string => typeof value === "string"))
          : null;
      } catch {
        return null;
      }
    },
    write(collapsed, storage) {
      const store = resolveStorage(storage);
      if (!store) return;
      try {
        store.setItem(key, JSON.stringify([...collapsed]));
      } catch {
        /* quota / private-mode — collapse is a preference, never a hard failure */
      }
    },
  };
}

export function toggleInSet(current: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(current);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}
```

And in `gui/src/pages/claude-desktop-lane.ts`, the Desktop-specific default (audit
blocker 8 — a fixed "only Opus is open" list is wrong because any model can be assigned
to any family, `ClaudeDesktop.tsx:153-157`):

```ts
/**
 * With no stored preference, a family is open when it holds models and collapsed when
 * it is empty. On a fresh install that is "Opus open, three empty families folded" —
 * the same result a hard-coded list would give, but it stays correct once the user
 * fills Sonnet.
 */
export function defaultCollapsedFamilies(counts: Record<string, number>): Set<string> {
  return new Set(Object.keys(counts).filter(family => counts[family] === 0));
}
```

## MODIFY — `gui/src/pages/ClaudeDesktop.tsx`

### 1. Import and state

```diff
-import { LANE_PAGE, laneView } from "./claude-desktop-lane";
+import { LANE_PAGE, defaultCollapsedFamilies, laneView } from "./claude-desktop-lane";
+import { makeCollapseStore, toggleInSet } from "./collapse-store";
+import { IconChevron } from "../icons";
```

Next to the existing `laneSearch`/`laneLimit` state (currently `:118-119`), with
`const FAMILY_COLLAPSE = makeCollapseStore("ocx.claudeDesktop.collapsedFamilies.v1");`
at module scope:

```diff
+  // View state only — see the lane comment above: collapse must never narrow the
+  // source arrays that effectiveDefaults reads.
+  const [collapsedFamilies, setCollapsedFamilies] = useState<Set<string>>(() => FAMILY_COLLAPSE.read() ?? new Set());
```

**Snapshot, not derive (WP1 focused audit, blocker 1).** An earlier draft derived the
set on every render from the current family counts. That is wrong: `modelsByFamily`
depends on `[data, profile]` (`ClaudeDesktop.tsx:153-158`) and `profile` changes on
every move (`:179-195`) and on import (`:245-255`), so moving the last model out of a
family would fold it under the user's cursor and opening the target family would look
like a glitch. The default is therefore computed ONCE, when a load resolves, and only
when the user has no stored preference:

```diff
       const normalized = normalizeProfile(payload);
       setData(payload);
       setProfile(normalized);
+      // Fold empty families on FIRST load only. After this the set is user-owned, so a
+      // move or an import can never re-fold a section the user opened.
+      if (FAMILY_COLLAPSE.read() === null) {
+        const counts = {} as Record<Family, number>;
+        for (const family of FAMILIES) counts[family] = 0;
+        for (const model of payload.models) {
+          counts[normalized.assignments[model.route]?.family ?? "opus"] += 1;
+        }
+        setCollapsedFamilies(defaultCollapsedFamilies(counts));
+      }
```

A reload re-runs it, which is correct: a fresh page with no stored preference should
again show the compact index. Import does NOT reset it — an imported profile is an edit,
not a new session.

The toggle, next to `moveModel`:

```diff
+  const toggleFamily = (family: Family) => {
+    // The first toggle also persists, so the derived first-load default becomes a real
+    // preference the moment the user disagrees with it.
+    const next = toggleInSet(collapsedFamilies, family);
+    FAMILY_COLLAPSE.write(next);
+    setCollapsedFamilies(next);
+  };
```

### 2. Family section markup

`FAMILIES` is already `["opus", "fable", "sonnet", "haiku"]` (`:6`), so Opus-on-top
follows from the container becoming a vertical stack — no reordering code needed. The
container class changes so the CSS grid does not have to be overloaded:

```diff
-      <div className="claude-lanes" aria-label={t("claudeDesktop.assignmentsLabel")}>
+      <div className="ocx-group-stack" aria-label={t("claudeDesktop.assignmentsLabel")}>
```

The lane header becomes a real disclosure button. Replacing the current
`<header className="ocx-group-head">` block (`:334-352`):

```tsx
const isCollapsed = collapsedFamilies.has(family);
const familyDefault = effectiveDefaults[family];
return (
  <section
    key={family}
    className={`ocx-group${isCollapsed ? " collapsed" : ""}`}
    aria-labelledby={`claude-lane-${family}`}
    onDragOver={event => event.preventDefault()}
    onDrop={event => dropOnLane(event, family)}
  >
    <header className={`ocx-group-head${isCollapsed ? "" : " open"}`}>
      {/* A heading is not phrasing content, so the button goes INSIDE the h3, not the
          other way round (audit blocker 9). The heading stays in the a11y tree and the
          family name becomes the button's accessible name. */}
      <h3 id={`claude-lane-${family}`} className="ocx-group-heading">
        <button
          type="button"
          className="ocx-group-toggle"
          aria-expanded={!isCollapsed}
          aria-controls={`claude-lane-body-${family}`}
          onClick={() => toggleFamily(family)}
        >
          <IconChevron
            className="ocx-chevron"
            width={14}
            height={14}
            aria-hidden="true"
            style={{ transform: isCollapsed ? "none" : "rotate(90deg)" }}
          />
          <span className="ocx-group-name">{t(FAMILY_KEYS[family])}</span>
          <span className="ocx-group-count">
            {t(all.length === 1 ? "claudeDesktop.modelCountOne" : "claudeDesktop.modelCountMany", { count: all.length })}
          </span>
          {/* Collapsed legibility: the resolved default is the one thing a user opens a
              lane to check, so it must be readable without opening it. */}
          {familyDefault && (
            <code className="claude-lane-default" title={familyDefault}>{familyDefault}</code>
          )}
        </button>
      </h3>
      {/* Warnings stay OUTSIDE the fold — ux-states.md §5 forbids hiding state the
          user has to act on. */}
      {all.length > 0 && profile.defaults[family] === null && (
        <span className="claude-default-needed">{t("claudeDesktop.chooseDefault")}</span>
      )}
      {familyDefault && familyDefault !== profile.defaults[family] && (
        <span className="claude-default-needed" title={familyDefault}>{t("claudeDesktop.temporaryDefault")}</span>
      )}
    </header>
    {!isCollapsed && (
      <div id={`claude-lane-body-${family}`}>
        {/* existing search input + .claude-lane-models block, unchanged */}
      </div>
    )}
  </section>
);
```

Note the header count switches from `modelsByFamily[family].length` to `all.length` —
they are the same array (`const all = modelsByFamily[family]`), this only removes the
repeated lookup.

### 3. Drag-and-drop while collapsed

`onDrop`/`onDragOver` stay on the `<section>`, so a collapsed family is still a valid
drop target — dropping onto its header row moves the model there. That is the
behaviour the current code already has at the lane level (`:329-333`); collapsing must
not remove it.

## MODIFY — `gui/src/styles.css`

Replace the 4-column grid with a vertical stack and add the toggle/summary styling.

**Class vocabulary decision (audit round 2, blocker 3).** WP4 needs the same collapsible
group chrome on the Grok page, and a retroactive rename in WP4 would leave WP1's markup
undefined. So WP1 introduces the shared names NOW, and WP4 only consumes them:

| Shared (introduced here, used by both pages) | Desktop-specific (stays `.claude-*`) |
|---|---|
| `.ocx-group-stack`, `.ocx-group`, `.ocx-group-head`, `.ocx-group-toggle`, `.ocx-group-heading`, `.ocx-group-name`, `.ocx-group-count`, `.ocx-chevron` | `.claude-lane-default`, `.claude-lane-models`, `.claude-lane-search`, `.claude-lane-more`, `.claude-lane-empty`, `.claude-model-*`, `.claude-alias`, `.claude-move-row`, `.claude-default-radio`, `.claude-default-needed`, `.claude-effort-badge` |

Rule: a class is shared only when the two pages need the SAME chrome (the collapsible
group shell). Anything that means "Claude family assignment" keeps its `.claude-` name,
because Grok has no aliases to edit, no default radio and no move control. Existing
`.claude-lane*` rules for those parts stay untouched; `.claude-lanes` itself is deleted.

```diff
-.claude-lanes { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: start; gap: 12px; }
+/* Shared collapsible-group chrome. Used by the Claude Desktop family stack and the
+   Grok page's native/routed groups, so the two dense surfaces cannot drift apart.
+   Replaces the 4-column kanban — with a real catalog, three lanes sat empty beside
+   one 4000px column. */
+.ocx-group-stack { display: flex; flex-direction: column; gap: 10px; }
```

```css
.ocx-group-toggle {
  display: flex; flex: 1; align-items: baseline; gap: 10px; min-width: 0; padding: 0;
  border: 0; background: transparent; color: inherit; cursor: pointer; text-align: left;
}
.ocx-group-heading { flex: 1; min-width: 0; margin: 0; font-size: 14px; }
.ocx-group-name { font-size: 14px; font-weight: 600; }
.ocx-chevron { flex-shrink: 0; color: var(--muted); transition: transform var(--motion-fast); }
.ocx-group-count { color: var(--muted); font-size: 11.5px; }
.claude-lane-default {
  min-width: 0; overflow: hidden; color: var(--faint); font-size: 11px;
  text-overflow: ellipsis; white-space: nowrap;
}
.ocx-group-head.open { border-bottom: 1px solid var(--border-soft); }
.ocx-group.collapsed .ocx-group-head { border-bottom: 0; }
```

`.ocx-group` and `.ocx-group-head` inherit the current `.claude-lane` / `.claude-lane-head`
declarations (`styles.css:1295-1302`) verbatim — the rules are renamed, not rewritten,
so the visual result is unchanged and the diff stays reviewable.

And the media queries that only existed to re-flow the grid:

```diff
-@media (max-width: 1200px) {
-  .claude-lanes { grid-template-columns: repeat(2, minmax(0, 1fr)); }
-}
-
-@media (max-width: 900px) {
-  .claude-lanes { grid-template-columns: 1fr; }
-}
```

A vertical stack is already correct at every width, so the breakpoints are dead code.
The `.claude-lane-head` rule that sets `border-bottom` unconditionally
(`styles.css:1299-1302`) drops that property; `.open` now owns it.

## Locale keys

No new user-visible strings: the header reuses `claudeDesktop.modelCountOne/Many`,
`claudeDesktop.chooseDefault`, `claudeDesktop.temporaryDefault`. The toggle button's
accessible name is the family name it already renders, so no `aria-label` key is
needed. **WP1 therefore adds zero i18n debt** — verify with `bun run lint:i18n`
rather than assuming.

## TESTS

`gui/tests/collapse-store.test.ts` (NEW):

- no stored value → `read()` returns `null` (caller applies its default);
- a stored `[]` → an empty Set, distinct from `null` (an explicit "everything open"
  preference must beat the data-driven default);
- `write` round-trips through a fake storage;
- a throwing `setItem` (private mode) does not throw out of the writer;
- corrupt JSON and a non-array payload both return `null`, not a crash;
- two stores with different keys do not read each other's values;
- `toggleInSet` adds/removes without mutating its input;
- `defaultCollapsedFamilies` folds only the empty families.

`gui/tests/claude-desktop-vertical.test.tsx` (NEW, MOUNTED — audit blocker 7; the repo
already mounts React with Happy DOM in `gui/tests/subagents-busy-race.test.tsx`):

- with models only in Opus, Opus renders expanded and the three empty families render
  with `aria-expanded="false"`;
- clicking a family header toggles `aria-expanded` and hides/shows its body;
- **dropping a model onto a COLLAPSED family still moves it** (the drop handler lives on
  the section, so collapse must not break it);
- the header count still reports the family's true total while a search is active;
- the toggle writes to storage and a remount restores it.

Plus a small source-shape guard in the same file: `styles.css` no longer declares
`grid-template-columns: repeat(4` for the family container, and `ClaudeDesktop.tsx`
references `ocx-group-stack` rather than `claude-lanes`.

## Verification (C)

| Command | Expected |
|---------|----------|
| `cd gui && bun test tests/claude-desktop-collapse.test.ts tests/claude-desktop-vertical.test.ts` | pass |
| `cd gui && bun run test` | pass |
| `bun run lint:gui` | clean |
| `bun run lint:i18n` | clean |
| `bun x tsc --noEmit` (root) + `gui` build typecheck | clean |
| headless render of `/#claude-desktop` | Opus section open at top, three collapsed sections beneath, chevrons rotated correctly |
