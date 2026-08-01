# 040 — WP4: keep the Desktop lanes navigable as the model list grows

Direction and dials come from the Design Read in `000_plan.md`. This doc is the
implementation contract. Depends on WP1 — the page must load before its density
can be improved.

## Current shape

`gui/src/pages/ClaudeDesktop.tsx:307-345` maps `FAMILIES` to four lanes and, inside
each, maps `modelsByFamily[family]` to a card with no cap and no filter. The lanes
are a four-column grid collapsing to two then one
(`gui/src/styles.css` `.claude-lanes` plus its 1200px/900px media queries), so a
long catalog produces four tall columns of cards with nothing to orient by.

## The decision, restated from the Design Read

Reuse the idiom that `gui/src/pages/Models.tsx:583-599` already ships in this same
app rather than inventing a second one:

1. a search input that appears ONLY past a threshold, so small setups are untouched;
2. a stable sort that floats the models that matter to the top;
3. a `Show {n} more` pager for the tail.

`models.search` and `models.showMore` already exist in all six locales, so this
adds no translation debt.

## MODIFY map

### `gui/src/pages/ClaudeDesktop.tsx`

State, next to the existing `useState` block:

```tsx
+const LANE_PAGE = 6;                 // cards before the pager kicks in
+const LANE_SEARCH_MIN = 4;           // show the filter only past this many
+const [laneSearch, setLaneSearch] = useState<Record<string, string>>({});
+const [laneLimit, setLaneLimit] = useState<Record<string, number>>({});
```

Per lane, between the header and the card list:

```tsx
const all = modelsByFamily[family];
const q = (laneSearch[family] ?? "").trim().toLowerCase();
const filtered = q
  ? all.filter(m => m.label.toLowerCase().includes(q) || m.route.toLowerCase().includes(q))
  : all;
// Available models first; stable, so server order is preserved inside each partition.
const sorted = filtered.toSorted((a, b) => Number(!a.available) - Number(!b.available));
const shown = laneLimit[family] ?? LANE_PAGE;
const visible = sorted.slice(0, shown);
const remaining = sorted.length - visible.length;
```

Render the search input only when `all.length > LANE_SEARCH_MIN`, and a
`Show {n} more` button when `remaining > 0`. Both mirror the Models markup so the
two pages read identically.

### Interaction rules that must NOT regress

- Drag-and-drop and the keyboard move control keep working for every VISIBLE card.
- Dropping onto a lane still targets the lane, not a card, so a filtered lane is
  still a valid drop target.
- A model hidden by search or the pager keeps its assignment; filtering is display
  only, exactly as the Models page comment states for visibility toggles.
- The lane header count keeps reporting the TRUE total (`all.length`), not the
  filtered count, or the user loses track of what is assigned.

### `gui/src/styles.css`

Lane-scoped input sizing and a pager button, reusing existing tokens. No new
visual language (Design Read: VARIANCE 3, MOTION 1).

## TESTS

`gui/tests/claude-desktop-density.test.tsx` (NEW):

- a lane under the threshold renders NO search input;
- past the threshold, typing filters by label and by route;
- the pager appears past `LANE_PAGE` and reveals the rest when pressed;
- the header count still shows the unfiltered total;
- an unavailable model sorts below available ones.

## Verification (C)

| Command | Expected |
|---------|----------|
| `gui: bun test tests/claude-desktop-density.test.tsx` | pass |
| `gui: bun run test` | pass |
| `bun run lint:gui` | clean |
