# 040 — One cap cluster, and a slot that is always occupied

Second phase of the row work. Depends on `020`: the labels must already be
visible so this cluster is measured at its real width rather than at bare-knob
width.

## What is wrong

The provider-wide context window is **one setting wearing three sibling
controls** in `.models-provider-actions` (`Models.tsx:1355-1394`):

| control | source | today |
|---------|--------|-------|
| cap on/off | `Switch` | bare knob; accessible name is `기본 128k`, a VALUE not a function |
| cap value | `Select` | rendered only when `(capOn \|\| nativeProviderGroup)` |
| per-model overrides | `사용자 지정 창` button | labeled, opens `openContextSettings` |

Two consequences, both measured in `evidence/030-baseline.json`:

- Three peer items for one concept, inflating the 7-8 control count the user
  complained about.
- The conditional `Select` is the **cap-driven half of the 114.8px left-edge
  spread**: `openai` and `kiro` carry a `custom-select`, the seven cap-off
  providers carry nothing where that control would be.

## Change 1 — always render the cap Select, disabled when off

```tsx
-{(capOn || nativeProviderGroup) && (
+{/* Always rendered. A cap-off provider previously dropped this control
+    entirely, which is what made anthropic's row start 26px right of openai's
+    and left the switch with no adjacent number to explain it. Disabled-with-a-
+    value is honest and keeps the slot occupied. */}
+{(
```

with `disabled={busy || !capOn}` already present on the `Select`, so the off
state is inert rather than absent.

This is the audit's own recommendation, and its cost is recorded rather than
hidden: it **adds** a control to 8 of 10 cards. At 780 that is extra wrap height
inside a row that is already full-width, and it must not overflow.

## Change 2 — group the three into one visual cluster

```tsx
<div className="models-cap-cluster">
  <Switch ... label={t("models.contextCapLabel")} showLabel />
  <Select ... title={t("models.contextCapLabel")} />
  <button ...>{t("models.contextSettings")}</button>
</div>
```

```css
/* Grouping only: one visual unit, three tab stops. The gap is tighter than the
   row's own gap, which is what makes it read as one control instead of three. */
.models-cap-cluster {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}
```

**Visual grouping, not a functional merge.** The audit was explicit and it is
right: `사용자 지정 창` opens **per-model** overrides
(`openContextSettings`, `Models.tsx:538`) while the switch and select are the
**provider-wide default**. Different scopes cannot be collapsed into one control,
and doing so on an admin surface would also violate the domain gate. The cluster
keeps three separate tab stops.

## Not changed

- `모두 켜기` / `모두 끄기` stay. They toggle row VISIBILITY; the preset segmented
  selects a curated SET. They overlap in appearance, not in function, so per
  UX-LAZY-01 they are disambiguated by `020`'s labels rather than removed.
- The preset control keeps `if (!preset) return null`.
- The count stays in `.models-provider-toggle`.

## Regression coverage

Extends `gui/tests/models-provider-head.test.ts`:

1. The cap `Select` is present in the header markup **without** a
   `capOn`-conditional guard, and carries `disabled` wired to `!capOn` — the
   assertion that stops the conditional from being reinstated.
2. `.models-cap-cluster` exists in the stylesheet with a `gap` tighter than
   `.models-provider-actions`.
3. `t("models.contextSettings")` is still rendered in the header (the existing
   L41 assertion, which a functional merge would have broken).
4. The cluster contains three interactive elements, so the grouping did not
   silently become one control.

Assertion 4 was **wrong as written** and the audit caught it: the custom-cap
editor lives inside the cluster too, so a count of interactive children is a
moving target. What is asserted instead is that the switch, the select, and the
per-model button are all present as descendants, with the editor optional.

## What the third audit round changed

Two blockers, both fixed before implementation.

**The cluster must wrap.** The drafted `min-width: 0` with no `flex-wrap` is the
`011` clip wearing a new name. As one flex item of `.models-provider-actions` the
cluster can be squeezed, and none of its children shrink: the labeled switch is
`flex: 0 0 auto`, `.btn` is `white-space: nowrap`, the `Select` is `inline-block`.
The overflow would then be swallowed by `.models-provider-card { overflow: hidden }`
while a page-level `scrollWidth === clientWidth` assertion still reported success.
That is why the measurement below records **card clip and cluster clip separately**
from page overflow: the failure this phase risks is invisible at page level.

**The custom-cap editor could outlive the cap.** `providerCapCustomOpen` is
independent per-provider state and nothing clears it when the cap is switched off.
With Custom already open, flipping the switch left the 120px input and its Apply
button standing under an off cluster — and `applyProviderCustomCap` sends
`enabled: true`, so that field would turn the cap back on. This was already
reachable for the native group; always-rendering the Select would have spread it to
every routed card. The editor is now gated on `capOn` as well.

## Measured after the change

`evidence/wp3-geometry.json` (harness `evidence/040-geometry-harness.ts`),
ko/de/en x 780/1024/1280/1440 against the built GUI on the live proxy:

| check | result |
|---|---|
| page `hOverflow` | `false` at every locale and width |
| card `scrollWidth - clientWidth` | `0` everywhere |
| `.models-cap-cluster` clip | `0` everywhere |
| cap slot present on every card | `true` everywhere |
| actions children under 6px | `0` everywhere |
| `maxHeadH` at 780 | rose to 194.4 (de), 160.4 (en), 125.5 (ko) |

The 780px height increase is the recorded **cost**, not a regression: the gate is
overflow and clipping, and an extra wrap line in a row that is already full-width
is what buying occupancy costs.

`evidence/wp3-state.json` confirms the per-card behaviour the phase exists for:
`openai` cap on with an enabled Select, and `anthropic`, `cursor`,
`google-antigravity`, `opencode-free`, `woong`, `xai` all cap off with the slot
**present and disabled** — where before they rendered nothing at all. Cluster tab
stops read `Default window / cap`, `Default 1.05M`, `Custom windows`: three stops,
in the order the controls are seen.
