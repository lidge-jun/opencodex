# 040 — WP4: the full layer taxonomy

WP3 shipped the five `config-toggle` rows. WP4 adds the remaining four classes
from `001` §4 — `base`, `feature-gated`, `runtime-conditional`,
`extension-unknown` — and the read-only dialog. Custom layers are WP5.

## Files

```
gui/src/components/codex-set/PromptLayerPanel.tsx    (new)
gui/src/components/codex-set/PromptLayerRow.tsx      (new)
gui/src/components/codex-set/PromptLayerDialog.tsx   (new)
gui/src/components/codex-set/prompt-layer-copy.ts    (new — id → i18n key map)
gui/src/styles-codex-set.css                         (new)
```

Row and dialog are modeled on `ClientConfigRow.tsx` / `ClientConfigDialog.tsx`,
which already solve "compact row, detail behind a dialog" in this codebase
(`004` §Reuse map).

## Data

The WP3 data surface is reused unchanged. No polling: the file changes when the
user changes it, and a 30s timer would fight the editor for no gain.

## Row kinds come from the class, not a list

There is no `rowKind()` heuristic. The server sends
`inventory[].class` (`020`), which is `LAYER_INVENTORY` from WP1, which is
`001` §4. One definition, three consumers:

```tsx
const kind = descriptor.class;   // that is the whole mapping
```

| Class | Renders |
|---|---|
| `config-toggle` | a real switch (shipped in WP3) |
| `base` | lock glyph, "always on", **no switch element at all** |
| `runtime-conditional` | lock glyph, the condition it follows, no switch |
| `feature-gated` | gear glyph, governing key, link to its owner, no switch |
| `extension-unknown` | rendered as a count, never as rows |

The first draft derived row kind from a server `locked` array that WP1 never
exported, and an audit found it also mis-listed Plugins as non-disableable.
Deriving from `class` removes both failure modes: the taxonomy is the contract.

Precise wording matters in the UI copy too. `base` and `runtime-conditional`
rows have **no off-switch anywhere in Codex**. `feature-gated` rows *are*
disableable — through `[features]`, not through this page. An earlier draft
applied the stronger sentence to all non-switch rows, which is false for
feature-gated ones and would mislead a user into thinking a setting does not
exist.

"No switch element at all" is literal: no `<input type="checkbox" disabled>`,
no greyed toggle. `005` explains the reasoning — a disabled control claims the
capability exists and is temporarily unavailable, which is false. `001` §4
proves these layers have no off-switch anywhere in Codex.

## Ordering

Assembly order from `001` §1, so the list reads the way the prompt is built.
Skills carries a footnote that its position among extensions is
registration-dependent (`001` ordering caveat).

## Dialog — read-only

Ask item 8: built-in layers open a popup that cannot be edited. Contents:

- what the layer does, in one sentence
- its class, and for classes B/C the exact key and its TOML position
- for class B: default and this file's value
- for class D: the runtime condition that decides emission
- Copy button for the key name

**No rendered prompt text.** The first draft promised to show each layer's
actual content; an audit noted nothing produces it. Codex exposes no API for
rendered layer bodies, and reconstructing them would mean reimplementing
`world_state.rs` against a moving target (`001` §6). The dialog explains the
layer and names its key — the honest scope.

No textarea, no Save. Escape closes and returns focus, matching
`client-config-panel.test.tsx:204-222`.

## Failure states

From `005`:

- `configExists: false` → defaults, switches **live**; the first write creates
  the file (`010` §First write).
- `readable: false` → writes refused with an explanation.
- `developerInstructionsOwned: false` → toggles still work; the custom group
  explains the key is externally managed.
- PUT rejected → revert the row to the server snapshot and surface the error.
  Never leave a switch showing a state the file does not have.

## Tests — `gui/tests/codex-set-prompt-layers.test.tsx`

Harness from `client-config-panel.test.tsx:86-152`.

1. every inventory entry renders a row, in `order`
2. **table-driven over the inventory: every non-`config-toggle` class renders
   no switch element** — query returns null for each
3. a `feature-gated` row names its governing key and links out
4. a `runtime-conditional` row states its condition
5. `extension-unknown` renders as a count, never as rows
6. a rejected PUT reverts the row
7. dialog opens read-only: no textarea, no Save
8. Escape closes and returns focus
9. the dialog claims no rendered prompt text
10. `readable: false` refuses writes
11. cold load renders the skeleton; refresh keeps rows visible

Case 2 is ask item 9 at the rendering layer; `020` case 5 is the same guarantee
at the API layer. Both are required — one without the other is a UI that merely
looks safe, or an API nobody exercises. Driving it from the inventory means a
new upstream layer is covered the day WP1 lists it.

## Styling

Design tokens only, no gradients — the constraint `260802_api_tab_client_connect_simplify`
records at `styles-apikeys-workspace.css:1-10`. Rows reuse existing row/switch
patterns; the new stylesheet only carries what the layer list genuinely needs.
