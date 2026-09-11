# 023 — WP6c: the stack, the scope split, and switching presets in place

Three asks, one panel:

1. "각 위치를 순서대로 쌓는거" — assembly order should be VISIBLE, not inferred
   from row order.
2. "live 같은 live에만 주입되는건 별도로" — layers that only appear in a live
   turn should not sit in the same list as layers that ship every turn.
3. "팝업에서 추가해서 바로바로 ... 개인 프리셋 갈아끼우면서" — move between
   saved presets inside the dialog, editing in place.

## What "live only" actually means

Measured, not assumed. Three layers render on a TRANSITION rather than on every
turn, and they are not the same kind of conditional:

| Layer | When it renders | Source |
|---|---|---|
| realtime | only as a session enters or leaves realtime | `realtime.rs:43-53`, `:77-90` |
| model-switch | only after the model changed mid-conversation | `model_switch_instructions.rs:40` |
| agents-md | when the project doc CHANGES, not on every turn | `agents_md.rs:52-64` |

The first two are genuinely live-scoped: a user reading a steady-state prompt
will never see them. `agents-md` is different — it is diff-rendered like every
other section, so grouping it with realtime would be wrong.

So the split is **two groups, not a filter**: layers that ship in a steady-state
turn, and layers that only appear on a transition. Both stay visible; the second
group carries the condition that produces it.

## Ordering

`LAYER_INVENTORY` already carries `order`, and the panel already sorts by it. What
it does not do is SHOW it, so "this is a stack" is something the reader has to
infer from vertical position alone.

The research lane (Figma, Photoshop, Zapier, Atlassian, W3C APG) converges on the
same three things for an ordered list: a visible position, a persistent affordance
when the order is editable, and a keyboard path that is not the drag handle.

Two important limits here:

- **Built-in order is not editable.** It comes from `world_state.rs`, so a drag
  handle on those rows would promise something the runtime does not honor. They
  get a position number and nothing else.
- **Custom layers ARE ordered by the user** and already have up/down buttons from
  WP5. They gain the same position number so both halves read as one stack.

## Preset switching inside the dialog

The ask names swipe or `<-->`. The search lane found no shipped product doing
arrow-cycling for presets: VS Code Profiles, Arc Boosts, and Cursor Rules all use
an explicit current-item label plus a list, and edit in place. The one consistent
warning is that arrows WITHOUT a position indicator lose the user.

So: prev/next controls as asked, plus `n / total` so the position is never
ambiguous, plus the name of the current preset. Editing stays in the same dialog.

This is the WP5 custom-layer editor gaining navigation, not a new surface. A
preset opened this way is still an ordinary custom layer — same endpoint, same
validation, same revision handling.

## Files

```
gui/src/pages/codex-set-prompt.tsx            (group the stack, pass positions)
gui/src/components/codex-set/PromptLayerRow.tsx   (position number)
gui/src/components/codex-set/CustomLayerRow.tsx   (position number)
gui/src/components/codex-set/CustomLayerDialog.tsx (prev/next + position)
gui/src/styles-codex-set.css                  (stack rail, group heading)
```

## Tests

1. every row shows its position, and the numbers ascend without gaps
2. the live-only group contains exactly realtime and model-switch
3. agents-md stays in the steady-state group — it is diff-rendered, not live-only
4. next/prev move between custom layers and the position indicator follows
5. the indicator is present whenever the controls are (the lost-user guard)
6. editing a layer reached by navigation writes through the ordinary custom path
7. navigation is disabled at the ends rather than wrapping silently
8. a dirty editor does not lose its text when the user navigates away

Case 8 is the one that matters: navigation inside an editor is a new way to
discard someone's typing, and WP5 already had to fix that once for Cancel.

## Round 2 corrections

An audit rejected three things above. All three are retractions, not defences.

### "Steady-state" and "every turn" are both false

I wrote that one group "ships every turn". Almost nothing does: world-state
sections are diff-rendered, so an unchanged section sends nothing on an ordinary
turn. Naming the groups that way would have taught the user the same wrong model
that produced the last two rounds of corrections.

The axis is not steady-state versus live. It is what the layer IS:

- **State layers** — describe configuration or context, and render when their
  snapshot first appears or changes.
- **Transition notices** — exist only to announce a change. `realtime`
  (`realtime.rs:43-53`) and `model-switch` (`model.rs:44-60`) have no steady
  state to describe; a notice about a change that did not happen is nothing.

That is the honest version of "live에만 주입되는 것": exactly two layers, and
the reason is their kind rather than a scope flag.

### One position sequence would misrepresent the runtime

Two separate errors in the original numbering plan.

First, renumbering per visual group. If the transition notices are lifted out,
the remaining rows must keep their ORIGINAL assembly indices, gaps included.
Renumbering 1..n inside each group would invent an order the runtime does not
have. "Numbers ascend without gaps" is withdrawn as a test.

Second, and worse: custom layers do not interleave with built-ins at all. They
concatenate into ONE `developer_instructions` projection
(`prompt-layers.ts:384-386`), which occupies a single slot. Numbering built-ins
and custom layers in one sequence would draw a fifteen-plus-n stack that does
not exist.

So: built-ins carry their assembly index. Custom layers are an ordered sub-stack
INSIDE their one slot, numbered among themselves, and the panel says so.

### Navigation changes the editor target and nothing else

Presets are saved custom layers, and they are not mutually exclusive — every
enabled one composes into the projection together. Prev/next must therefore move
only which layer is being EDITED. It must not toggle enablement, and the copy
must not imply a single active preset.

### Evidence wording

"Measured, not assumed" was wrong for this section: the classification comes from
reading `render_diff`, not from captured output. It is source-verified, and the
two-member transition group gets a fixture-backed test before it becomes UI
taxonomy.

## Tests, restated

1. every built-in row shows its CANONICAL `order` from `LAYER_INVENTORY`, gaps
   included after grouping — not a renumbered 1..n
2. the transition group contains exactly `realtime` and `model-switch`
3. every built-in appears exactly once across the two groups, and none is dropped
4. custom layers are numbered among THEMSELVES, and the panel states they share
   one slot rather than interleaving with built-ins
5. next/prev move the editor target; title and body follow the layer, and
   navigating writes nothing
6. the position indicator exists whenever the controls do
7. at the ends the controls are disabled, and clicking one leaves the editor
   unchanged rather than wrapping
8. **edit A, navigate to B, come back to A: the unsaved title and body are still
   there, and no PUT was issued before Save.** Blocking navigation while dirty
   would pass a weaker version of this test while making the feature useless
9. saving a layer reached by navigation goes to `/api/codex-prompt/custom` with a
   stable id, the siblings intact, and the current revision
10. zero and one custom layers: the controls are absent or consistently disabled
11. a refresh that deletes the layer under an open editor does not strand it

