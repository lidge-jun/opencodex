# 90 Phase 6 Dashboard + Codex Exposure Plan

## Goal

Expose the existing Cursor adapter scaffold in the user-facing opencodex flow so
`cursor/auto` can be added from the dashboard and become visible to Codex's routed
model catalog, while preserving the existing safe boundary:

- no Cursor binary execution
- no live Cursor HTTP/2 smoke without `OPENCODEX_CURSOR_TEST_TOKEN`
- no native read/write/delete/shell/MCP/fetch/screen/computer-use execution
- Cursor requests continue to fail closed until the live transport is audited

## Current State

- `src/providers/registry.ts` contains `cursor`, but it is `featured: false`
  and `authKind: "local"`.
- `deriveProviderPresets()` currently includes only featured providers and
  key-login providers, so `cursor` is absent from `/api/provider-presets`.
- The GUI's `AddProviderModal` only understands `oauth | forward | key`;
  it has no local/safe-scaffold mode and its adapter select omits `cursor`.
- A dashboard-created Cursor provider would currently miss static model metadata
  unless the server enriches it from the registry.

## Work Phase

Single PABCD work-phase: open Cursor in GUI/Codex-facing configuration surfaces,
without enabling live transport.

## Diff-Level Plan

### MODIFY: `src/providers/registry.ts`

- Add a registry-level flag for dashboard exposure:
  - `dashboardPreset?: boolean`
- Add a registry-level static catalog flag:
  - `liveModels?: boolean`
- Set Cursor:
  - `dashboardPreset: true`
  - `liveModels: false`
- Add `liveModels` to `ProviderConfigSeed` so registry-derived configs can
  preserve static model allowlists without network model discovery.

### MODIFY: `src/providers/derive.ts`

- Add `liveModels?: boolean` to derived key-login/preset seed shapes where needed.
- Add `auth: "local"` to `DerivedProviderPreset`.
- Include entries when:
  - `entry.featured`
  - `entry.authKind === "key"`
  - `entry.dashboardPreset === true`
- Map `authKind: "local"` to preset auth `"local"`.
- Add a helper:
  - `enrichProviderFromRegistry(name, provider)`
  - It copies `providerConfigSeed(entry)` fields onto a created provider without
    overwriting explicit caller fields.
- The helper will copy `liveModels: false`, `models`, `defaultModel`,
  `modelContextWindows`, `modelInputModalities`, and `modelReasoningEfforts`
  for Cursor so `/v1/models` can return static `cursor/auto` without touching
  Cursor's live `/models` endpoint.

### MODIFY: `src/oauth/key-providers.ts`

- Keep the existing server call site stable:
  - `server.ts` continues calling `enrichProviderFromCatalog(name, provider)`.
  - `enrichProviderFromCatalog()` delegates to `enrichProviderFromRegistry()`.
- This lets `/api/providers` enrich Cursor and future non-key registry presets
  with static metadata without renaming the public helper in this pass.
- Keep the current key-login API behavior intact.

### MODIFY: `gui/src/components/AddProviderModal.tsx`

- Extend preset/form auth union with `"local"`.
- Add a "Local scaffold" badge for Cursor/local presets.
- Add `cursor` to the adapter select.
- For local presets:
  - do not show API-key fields
  - show a safety notice that no key is needed and live Cursor transport remains disabled
  - submit adapter/baseUrl/defaultModel only
- Keep OAuth/key/custom behavior unchanged.

### MODIFY: `tests/provider-registry-parity.test.ts`

- Update Cursor parity:
  - still not featured
  - still not key-login
  - still not OAuth
  - now appears in `deriveProviderPresets()`
  - preset has `auth: "local"`, `adapter: "cursor"`, `defaultModel: "auto"`
  - registry-derived provider seed includes `models: ["auto"]` and `liveModels: false`

### MODIFY: `tests/cursor-oauth-shell.test.ts`

- Rename the expectation from "init only" to "init and dashboard preset only".
- Keep OAuth disabled and source-safety assertions unchanged.

### MODIFY: docs

- `README.md`
- `docs-site/src/content/docs/guides/providers.md`
- `docs-site/src/content/docs/ko/guides/providers.md`

Update wording from "not advertised in dashboard Add Provider" to:

- Cursor appears in dashboard Add Provider as an experimental local scaffold.
- Adding it exposes static `cursor/auto` catalog metadata.
- Live transport/OAuth/native execution remain disabled until separately audited.

## Verification Plan

Run without invoking `ocx`, `codex`, `cursor`, or `cursor-agent`:

1. `bun test tests/provider-registry-parity.test.ts tests/cursor-oauth-shell.test.ts tests/cursor-discovery.test.ts tests/cursor-adapter.test.ts`
2. `bun run typecheck`
3. `bun test tests`
4. `bun run build:gui`
5. `git diff --check`
6. Static safety grep:
   - ensure Cursor OAuth shell still has no `fetch(`, `node:fs`, `node:http2`,
     `child_process`, `spawn(`, or `exec(`

## Out Of Scope

- Live Cursor HTTP/2 transport.
- Cursor OAuth login.
- Cursor native tool execution.
- Making Cursor the default provider automatically.
- Running live `ocx`, `codex`, `cursor`, or `cursor-agent`.
