# 070 — WP7: surface `supports1m` on the Desktop DTO + read-only 1M chip (D1c)

Root cause in `030a_defect_investigation.md` §D1-3. This doc is the implementation
contract. The `prefer1m` TOGGLE is deliberately out of scope (deferred — the profile
has no preference field).

## Scope

IN: add `supports1m` to the Desktop model DTO and render a compact `1M` chip on the
collapsed row summary for eligible models.
OUT: any write path, any toggle, any change to `SUPPORTS_1M_THRESHOLD` or the
`prefer1m` hard-wire in `desktop-3p.ts:178`.

## Why read-only is the honest scope

The writer derives `supports1m`/`prefer1m` from eligibility
(`contextWindow >= 1_000_000`, `desktop-3p.ts:42,166-197`). A toggle that changed the
written config would need a persisted per-model preference the profile does not have —
half-persisting that here would be a data-shape contradiction like the
`appliedFingerprint` incident (`260726_gui_grok_improvements/000`). So the chip is a
VIEW of the capability the writer already emits, and the chip's eligibility predicate
must be the same one, from the same source.

## MODIFY — `src/server/management/shared.ts`

`DesktopModel` rows are built at `:213-220` from `profile.assignments`. Derive
`supports1m` from the model's context window with the SAME threshold the writer uses,
and export the threshold so the two cannot drift:

```diff
+/** The same eligibility the desktop-3p writer applies (SUPPORTS_1M_THRESHOLD). */
+export const DESKTOP_SUPPORTS_1M_THRESHOLD = 1_000_000;
+
   const models = Object.keys(profile.assignments).sort().map(route => ({
     route,
     label: modelByRoute.get(route)?.label ?? route,
     available: available.has(route),
     ...(modelByRoute.get(route)?.contextWindow ? { contextWindow: ... } : {}),
     effortSupported: effortByRoute.get(route) ?? false,
+    // Read-only view of the capability the written Desktop config already carries.
+    // It derives from the same threshold, never from a second rule.
+    supports1m: (modelByRoute.get(route)?.contextWindow ?? 0) >= DESKTOP_SUPPORTS_1M_THRESHOLD,
     assignment: profile.assignments[route]!,
   }));
```

`desktop-3p.ts` imports `DESKTOP_SUPPORTS_1M_THRESHOLD` from `shared.ts` (or a small
shared module) and drops its local `SUPPORTS_1M_THRESHOLD`, so the DTO and the writer
read one constant. If the circular-import risk between `shared.ts` and
`desktop-3p.ts` is real, put the constant in `src/claude/desktop-3p.ts` and import it
from `shared.ts` instead — pick the direction with no cycle.

## MODIFY — `gui/src/pages/ClaudeDesktop.tsx`

`DesktopModel` gains `supports1m?: boolean`. On the collapsed row summary, next to the
context span, render a compact chip when true:

```diff
   {context && <span className="claude-model-context">{context}</span>}
+  {model.supports1m === true && <span className="claude-1m-chip">{t("claudeDesktop.supports1m")}</span>}
```

The chip is distinct from the context string because a model can show `984k context`
and NOT support 1M (qwen3.8 at 983616 is below threshold), so the chip carries real
information the context number does not.

## Locale keys — NEW (all six)

| Key | en | ko | ja | zh | de | ru |
|-----|----|----|----|----|----|----|
| `claudeDesktop.supports1m` | `1M` | `1M` | `1M` | `1M` | `1M` | `1M` |

## CSS

`.claude-1m-chip` — small pill, accent-tinted, `flex-shrink: 0`, same size language as
`.claude-effort-badge`.

## TESTS

`tests/claude-desktop-1m.test.ts` (NEW):

- `buildClaudeDesktopState` sets `supports1m: true` for a 1_000_000 model and a
  1_048_576 model, `false` for 983_616 and for a blank window;
- the DTO threshold and `desktop-3p.ts`'s writer threshold are the SAME constant
  (import both and assert equality — the drift guard);
- a native 1M-capable model (if any) resolves `supports1m` consistently with the
  writer.

`gui/tests/claude-desktop-1m-chip.test.tsx` (NEW, mounted):

- a `supports1m` row renders the `1M` chip in the collapsed summary;
- a below-threshold row (983616) does NOT;
- the chip resolves `claudeDesktop.supports1m` in all six locales.

## Verification (C)

| Command | Expected |
|---------|----------|
| `bun test tests/claude-desktop-1m.test.ts tests/claude-desktop-native-context.test.ts tests/desktop-3p.test.ts` | pass |
| `cd gui && bun test tests/claude-desktop-1m-chip.test.tsx` | pass |
| all gates + live render | a 1M-capable row shows the chip; a 984k row does not |
