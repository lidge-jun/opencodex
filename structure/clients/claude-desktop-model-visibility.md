# Claude Desktop Model Visibility

`claudeCode.desktopModelVisibility` chooses which rows the Claude Desktop 3P `inferenceModels`
list carries (#7702). It is parsed and applied in `src/claude/desktop-model-visibility.ts`.

The selection has two shapes. `include` lists only its `routes`, so a model discovered later stays
hidden until someone selects it. `exclude` lists everything except its `routes`, so a new model is
listed. Unset means every available model is listed, which is what installs did before the
setting existed. Routes are stored sorted and unique, capped at `MAX_DESKTOP_VISIBILITY_ROUTES`.

The selection is kept apart from three other settings:

- **The Desktop profile.** `claudeCode.desktopProfile` holds tier families, aliases and family
  defaults. A hidden model keeps its assignment and alias, so showing it again restores the same
  Desktop id. Profile saves never rewrite the selection, and the selection never rewrites the
  profile.
- **Provider-wide visibility.** `disabledModels` and provider model lists still decide what is
  available at all. The selection can only narrow what Desktop lists from that set.
- **Other clients.** Only the static and hybrid Desktop writers read the selection. Claude Code,
  Codex and `/v1/models` discovery are unchanged. Discovery-only mode emits no static list, so the
  selection does not apply to it.

## Where it applies

`generateDesktop3pModels` builds the full list and the alias registry first, then filters only
the emitted rows by route. Every writer gets the selection through `desktop3pModelOptions(claudeCode)`:
the local gateway writer (`writeDesktop3pConfig`, which reads the latest config under its locks),
catalog-driven refreshes, and the hub's `wantsDesktopConfig` export, which connected clients
write verbatim. The decode registry keeps hidden routes, so a running Desktop session that still
sends a just-hidden alias keeps routing.

When a hidden row was a family default, the first remaining member of that family takes the role.
Defaults are moved back to the front, which keeps the order `renderDesktopProfile` writes. A
selection that would leave the list empty writes the full list and logs a warning, because Desktop
with an empty static list has no usable picker. The management API refuses to save such a selection.

## Persistence and the dashboard

`PUT /api/claude-desktop` (`src/server/management/agent-settings-routes.ts`) accepts `visibility`
alongside `profile`. An absent field keeps the
stored selection, `null` clears it, and an object replaces it. The selection is written in the
same field-scoped config mutation as the profile. A supplied replacement or clear compares the
selection again inside that mutation; a concurrent visibility edit during discovery returns 409.
An omitted selection preserves the latest persisted value. `GET /api/claude-desktop` (`buildClaudeDesktopState` in
`src/server/management/shared.ts`) returns the selection,
a per-model `visible` flag, and `listed`, the rows the next apply writes. `GET
/api/claude-desktop/status` returns `appliedModels`, the selected profile's on-disk names and labels,
read through the verified library reader. This nullable list does not prove which models the
Desktop process has loaded; a restart or managed policy can affect that. The dashboard derives its selected, available and applied
counts and its added/removed preview from these fields. `listed` includes the writer's full-list
fallback when every selected model is unavailable, without changing the saved selection or default.
When the saved selection differs from the applied list, the status bar reports a pending apply even
while a newer draft has unsaved edits.

A malformed hand-edited selection fails config validation at
`claudeCode.desktopModelVisibility`. Salvage drops that one field, so the rest of the config loads.

Tests: `tests/claude-integration/claude-desktop-model-visibility.test.ts`,
`gui/tests/claude-desktop-visibility.test.ts`, and `gui/tests/claude-desktop-visibility-card.test.tsx`.
