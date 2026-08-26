# Discovered Model Display Names Design

## Status

Design approved by the contributor on 2026-08-26 for issue #2201.

Base: `dev` at `01b5da9f574956f8eb55b13e55dd48e79ab74502`.

## Problem

OpenCodex can assign a display name to a custom model, but a model returned by provider discovery has no operator owned display name. The generated Codex catalog therefore falls back to a namespaced routing slug such as `xai/grok-composer-2.5-fast`.

Editing `opencodex-catalog.json` is not a durable solution because sync, startup, provider refresh, and updates regenerate that file. A Windows startup script that edits generated state introduces ordering problems with Codex Desktop and the OpenCodex proxy.

The dashboard also has no control for naming an existing discovered model. Its current Add control creates a separate custom model row and rejects an ID that already exists in discovery.

## Goals

1. Let an operator assign a readable name to an existing discovered provider model.
2. Persist that name in `config.json`, not generated catalog state.
3. Reapply the name during every catalog generation path.
4. Preserve provider identity, native model ID, routed slug, routing, billing, visibility, aliases, fallback targets, and outbound wire requests.
5. Support clear and reset behavior with deterministic fallback.
6. Expose the feature through configuration and the management API first, then through the dashboard in a separate pull request.
7. Keep provider labels available while a model is temporarily absent from discovery.

## Non goals

1. Renaming a provider ID or native model ID.
2. Changing model routing or alias collision rules.
3. Creating a second custom model row for a discovered model.
4. Renaming native OpenAI marketing rows in the first pull request.
5. Adding automatic startup helpers or modifying Codex Desktop files.
6. Importing provider supplied marketing names from new external sources.

## Configuration contract

Each provider can hold an optional native model ID to display name map:

```json
{
  "providers": {
    "xai": {
      "modelDisplayNames": {
        "grok-4.6": "Grok 4.6",
        "grok-composer-2.5-fast": "Grok Composer Fast"
      }
    }
  }
}
```

The map key is the provider native model ID. It is not the routed slug. Native IDs may contain `/`, so validation must use the same model ID rules as provider discovery rather than display name rules.

The map value is display only. It must be a trimmed, nonempty string with a bounded length. It must reject control characters and `/`, matching the existing custom model display name safety contract. A malformed map or malformed entry must degrade safely without discarding the rest of the provider configuration. Exact validation behavior will follow the repository's existing config parsing and management mutation patterns.

Unknown or currently absent model IDs are retained. A temporary provider outage, a stale discovery response, or a model disappearing for one refresh must not delete user owned metadata.

Deleting a map entry clears the override. An empty map may be omitted during persistence. Clearing restores the normal derived display name on the next catalog convergence.

## Display name precedence

For a routed discovered model, the catalog label resolves in this order:

1. Valid operator override from `provider.modelDisplayNames[modelId]`.
2. Trusted display metadata already carried by the current catalog pipeline.
3. Existing derived name or routed slug fallback.

The operator override changes only `CatalogModel.displayName` and the emitted Codex `display_name`. It must not feed slug construction, equality, pricing, disable checks, provider selection, effort metadata, context metadata, modality metadata, aliases, fallbacks, combos, or the outbound request model.

## Core data flow

```text
config.json provider.modelDisplayNames
  -> defensive config validation
  -> provider model discovery
  -> routed catalog row construction
  -> display precedence resolver
  -> Codex catalog display_name
```

The resolver belongs at the shared catalog construction boundary so startup sync, `ocx sync`, live provider refresh, management mutations, and service restart use the same behavior. No caller should patch the generated catalog after it is written.

## Management API

The first pull request adds a focused mutation surface for one provider and native model ID. The exact route should follow the existing management API conventions and must:

1. Validate provider existence, model ID, and display name.
2. Allow a model ID that is temporarily absent from live discovery.
3. Update only the targeted map entry.
4. Persist through the existing safe config writer.
5. Roll back in memory if persistence fails.
6. Trigger catalog convergence after a successful mutation.
7. Return the resulting display name and catalog refresh result.
8. Support clear or reset without accepting an ambiguous blank value.

Read surfaces must return the effective label and whether its source is an operator override, provider metadata, or fallback. Credentials and unrelated configuration must never be exposed.

## Dashboard follow up

The dashboard work is a separate pull request stacked after the core contract, as requested by the maintainer in issue #2201.

Each discovered model row receives a small rename action. The editor shows:

1. The immutable provider and native model ID.
2. The current effective display name.
3. A text field for the operator override.
4. Save and Reset actions.
5. Clear feedback for saving, success, validation failure, network failure, and catalog refresh failure.

The dashboard must not create a custom model to rename a discovered row. The current custom model Add flow remains unchanged.

Saving updates the existing row in place after the server confirms success. Reset removes the override and restores the server returned fallback label. A failed save keeps the entered value so the user can retry. Controls must be keyboard accessible and translated through the existing i18n catalog.

## Error handling

1. Invalid display names return a bounded validation error and do not mutate config or catalog.
2. An unknown provider returns not found and does not create a provider implicitly.
3. A temporarily absent model ID is allowed for an existing provider so labels survive discovery gaps.
4. A config persistence failure restores the previous in memory map.
5. A catalog refresh failure keeps the successfully persisted label and reports that refresh is pending, matching existing management mutation behavior where possible.
6. A malformed hand edited map is ignored entry by entry where the existing parser permits safe degradation. Valid provider settings remain usable.
7. Concurrent mutations must use the existing config mutation serialization path so unrelated entries are not lost.

## Pull request split

### Pull request 1: core contract

1. Provider config type and defensive validation.
2. Display precedence resolver.
3. All catalog construction paths.
4. Management read and mutation API.
5. Configuration reference documentation.
6. Focused runtime, config, API, and catalog regression tests.

### Pull request 2: dashboard editor

1. Provider model row rename and reset controls.
2. API client integration and optimistic state rules.
3. Loading, validation, failure, retry, and success states.
4. i18n strings in every supported locale.
5. Component tests, accessibility checks, lint, build, and screenshots.

The second pull request targets the first branch while the first is open. It is retargeted to `dev` after the core pull request lands.

## Test strategy

Tests are written before production code and observed failing for the missing feature.

### Configuration and validation

1. Accept one valid provider scoped map.
2. Preserve several labels under one provider.
3. Keep identical native model IDs isolated across two providers.
4. Reject or safely ignore empty, whitespace only, slash containing, control character, nonstring, oversized, array, and prototype shaped values according to the established parser boundary.
5. Preserve valid provider fields when one label is malformed.
6. Preserve labels for model IDs absent from the latest discovery result.
7. Round trip the map through load, mutation, persistence, and reload.
8. Clear one entry without deleting neighboring entries.

### Catalog behavior

1. Apply an operator label to a discovered routed row.
2. Keep the routed slug and native model ID unchanged.
3. Keep pricing, disabled model matching, effort levels, context window, modalities, priority, aliases, fallback targets, and outbound wire model unchanged.
4. Use operator override over provider metadata.
5. Restore provider metadata or slug fallback after reset.
6. Preserve labels through repeated catalog generation.
7. Preserve labels through provider discovery success, failure fallback, empty discovery, and later recovery.
8. Avoid duplicate rows when a discovered model has a label.
9. Keep custom model display names unchanged.
10. Keep providers without the new field byte and behavior compatible where the existing writer allows it.

### Management API

1. Read effective name and source without exposing secrets.
2. Set a label for a discovered model.
3. Set a label for a temporarily absent model under an existing provider.
4. Reset a label.
5. Reject unknown providers and invalid labels.
6. Prove persistence failure does not leave an in memory partial mutation.
7. Prove successful mutation requests catalog convergence exactly once.
8. Prove concurrent updates do not erase unrelated map entries.

### Dashboard

1. Show Rename for a discovered model and not confuse it with Add custom model.
2. Load and display effective and overridden names.
3. Save a trimmed valid label with the correct provider and native model ID.
4. Reset an override.
5. Disable duplicate submits while saving.
6. Keep user input after server or network failure.
7. Display validation, network, persistence, and refresh feedback.
8. Work with filtering, a large capped model list, selected models, default models, configured fallback models, and custom rows.
9. Support keyboard operation and accessible labels.
10. Render correctly at repository required desktop and mobile widths.

### Full verification before submission

For the core pull request:

```text
focused Bun tests
bun run typecheck
bun run test
bun run privacy:scan
```

For the dashboard pull request:

```text
focused GUI tests
cd gui && bun test
bun run lint:gui
bun run typecheck
bun run test
bun run build:gui
bun run privacy:scan
manual dashboard test against a disposable config
desktop and mobile screenshots
```

The manual test uses a disposable OpenCodex config and catalog. It must not modify the user's installed configuration, provider credentials, or production catalog.

## Acceptance criteria

1. A discovered model can receive a durable operator display name without becoming a custom model.
2. The label survives sync, catalog regeneration, proxy restart, Codex restart, provider discovery gaps, and config reload.
3. Reset restores the deterministic fallback label.
4. Routing identity and all non-display catalog behavior remain unchanged.
5. The dashboard can edit and reset the same core configuration without a local patch script.
6. All focused and full repository checks pass with no secrets or personal data added.
7. Pull requests follow the repository templates, target the correct branches, include required evidence, and remain drafts until review readiness is proven.
