---
title: Model Ordering
description: How opencodex determines model order in the Codex picker and spawn_agent model overrides.
---

The Codex model picker does not preserve the order of provider declarations or model arrays in the
opencodex configuration. Its final order comes from catalog priorities, with a deterministic
alphabetical order for routed models that share the same priority.

## The rule Codex applies

Codex's models-manager sorts picker-visible catalog entries by `priority` in ascending order. It
discards the catalog array order, so moving an entry earlier in a generated JSON array does not move
it earlier in the picker. The implementation records this constraint directly in
`src/codex/catalog/sync.ts`.

opencodex therefore controls featured placement by assigning lower priorities, not by relying on
array position. Unless noted otherwise, the fixed priorities and worked example below describe a
catalog with no eligible Codex account selectors. With `N` eligible selectors, featured priorities
use `N` as a stride: a bare native choice at configured rank `i` expands to selector rows at
priorities `i * N + j`, where `j` is the selector's zero-based position; a routed choice uses
`i * N`; and an exact selector-qualified choice uses `i * N + j` for its selector. Unselected routed
rows are moved outside those selector groups. Codex still advertises only the first five
picker-visible rows.

The relevant no-selector priorities are:

| Catalog entry | Priority | Source |
| --- | ---: | --- |
| `subagentModels[i]` | `i` (`0` through `4`) | The featured rank map in `src/codex/catalog/sync.ts` |
| Other routed models | `5` | Routed entry creation in `src/codex/catalog/sync.ts` |
| Non-featured routed models listed in `modelPickerOrder` | `1000 + i` | Display-only picker rank in `src/codex/catalog/sync.ts` |
| Native GPT slugs by default | `9` | Native entry creation in `src/codex/catalog/sync.ts` |
| Unselected native models while a featured list exists | At least `featured.length + 100` | Native catalog merge in `src/codex/catalog/sync.ts` |

The management API limits `subagentModels` to five entries with `slice(0, 5)` in
`src/server/management/agent-settings-routes.ts`. This matches the Codex `spawn_agent` surface, which
advertises only the first five model overrides. Models outside those five can still remain visible
in the main picker and callable by their exact id.

## How ties are ordered

All ordinary routed models have priority `5`, so they need a tie-breaker. Before catalog entries are
built, `gatherRoutedModels()` sorts the routed model list by provider name and then by model id, both
alphabetically (`src/codex/catalog/provider-fetch.ts`).

This means neither of these configuration details changes the final order:

- the declaration order of keys in the `providers` object;
- the order of ids in a provider's `models` array.

`orderForSubagents()` then uses a stable sort to move configured featured picks to the front in the
same order as `subagentModels`. Non-featured models keep the provider/id alphabetical relative order
established earlier (`src/codex/catalog/sync.ts`). The featured rank is also converted to
priorities `0` through `4` when entries are built, so Codex's priority sort preserves that leading
sequence.

## Visibility is separate from ordering

`selectedModels` and `disabledModels` decide which routed models are exposed; they are not ordering
controls. `filterCatalogVisibleModels()` converts both selections to `Set` lookups and filters the
gathered list without using the arrays as ranks (`src/codex/catalog/provider-fetch.ts`).

As a result, reordering `selectedModels` or `disabledModels` has no effect on picker position. It can
only change whether a model is included.

## Effective picker pattern

With no eligible account selectors and a non-empty featured list, the resulting order is:

1. Models in the exact configured `subagentModels` order, with priorities `0` through `4`.
2. All remaining routed models, ordered alphabetically by provider and then model id, at priority `5`.
3. Unselected native models, pushed below the featured block during catalog merge.

Without `subagentModels`, routed models remain at priority `5`, native GPT entries use their normal
priority (normally `9` for entries built by opencodex), and the routed group remains provider/id
alphabetical.

## Example

Suppose `subagentModels` contains these five ids in this exact order:

```toml
subagentModels = [
  "gpt-5.5",
  "opencode-go/glm-5.2",
  "anthropic/claude-opus-4-6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]
```

The picker begins as follows:

| Picker position | Model | Priority | Why it appears there |
| ---: | --- | ---: | --- |
| 1 | `gpt-5.5` | `0` | First `subagentModels` selection |
| 2 | `opencode-go/glm-5.2` | `1` | Second selection, even though its provider sorts after `anthropic` |
| 3 | `anthropic/claude-opus-4-6` | `2` | Third selection |
| 4 | `gpt-5.6-sol` | `3` | Fourth selection |
| 5 | `gpt-5.6-terra` | `4` | Fifth selection |
| 6 | `anthropic/claude-fable-5` | `5` | First remaining routed id in provider/id alphabetical order |
| 7 onward | Remaining routed models | `5` | Provider alphabetically, then model id alphabetically |
| After routed models | Remaining native models | `featured.length + 100` or higher | Unselected natives are moved below the featured block |

The first five entries are the overrides advertised to `spawn_agent`; the rest continue in the
normal picker order. With account selectors, the five-entry limit applies after bare native choices
have expanded into selector-qualified groups.

## Changing the order

Use `subagentModels` to choose and order the leading models that Codex also advertises to
`spawn_agent`. The dashboard's **Sub-agents** page can reorder bare native and routed ids. Use
`ocx agent subagents set` or edit the opencodex configuration for exact
`<selector>/<native-openai-model>` choices; the dashboard does not list those choices and omits them
if it saves the roster. Use at most five configured ids. With account selectors, one bare native
choice can expand into multiple selector-qualified catalog rows, so configured choices and
advertised rows are not necessarily one-to-one.

Use `modelPickerOrder` for display-only ordering of routed `<provider>/<model>` rows beyond that
featured block:

```json
{
  "modelPickerOrder": [
    "tyler/deepseek-v4-pro",
    "jd-chat/kimi-k3",
    "jd-chat/glm-5.2"
  ]
}
```

Listed routed rows appear in the configured order. A routed row omitted from the array keeps its
normal priority, so it remains ahead of the `modelPickerOrder` display band; list every routed row
whose relative position you want to control. A row also present in `subagentModels` keeps its
featured priority. Bare native and account-qualified native rows are not reordered by
`modelPickerOrder`; use `subagentModels` for those rows.

`modelPickerOrder` never changes the `spawn_agent` candidate set. It changes only the
Codex-visible picker priority while opencodex retains each moved row's natural priority for
sub-agent selection. `disabledModels` and each provider's `selectedModels` remain visibility fields,
not ordering controls. There is no separate `modelOrder`, `providerOrder`, or priority-map setting.
