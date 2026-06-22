# Provider Catalog Metadata Plan

## Goal

Update `dev` with the remaining safe provider-catalog metadata work from PR #12 and PR #21 without
regressing the verified Umans Anthropic Messages provider.

## Source PRs

- PR #12 by 0disoft / ZeroDi: configurable provider and model context-window caps.
- PR #21 by Ingwannu / 이완우: native Umans provider metadata and registry-to-catalog propagation.

## Decision

Do not cherry-pick PR #21 wholesale. Current `dev` already has a verified Umans provider that uses:

- `adapter: "anthropic"`
- `baseUrl: "https://api.code.umans.ai"`
- `POST /v1/messages`
- `x-api-key`
- `escapeBuiltinToolNames: true`

PR #21 changes Umans to OpenAI Chat Completions shape. That would reopen the stream/tool-call class
of issues documented in `devlog/230_umans-wire-protocol/`.

Preserve these ideas instead:

- From PR #12:
  - `contextWindow?: number`
  - `modelContextWindows?: Record<string, number>`
  - configured context windows are caps, not blind overrides:
    - cap live `/models` metadata with `Math.min(live, configured)`
    - cap fresh/stale cached live metadata the same way
    - use configured values for static configured-model fallback
- From PR #21:
  - `modelInputModalities?: Record<string, string[]>`
  - registry metadata should flow through provider config seed, key-login maps, saved login payloads,
    provider enrichment, and Codex catalog entries.

## Implementation Plan

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/src/types.ts`

Add optional provider catalog metadata fields to `OcxProviderConfig`:

- `contextWindow?: number`
- `modelContextWindows?: Record<string, number>`
- `modelInputModalities?: Record<string, string[]>`

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/src/providers/registry.ts`

Extend `ProviderRegistryEntry` and `ProviderConfigSeed` with the same metadata fields.

Add Umans metadata to the existing Anthropic Messages entry only:

- context windows:
  - `umans-coder`: `262_144`
  - `umans-kimi-k2.7`: `262_144`
  - `umans-kimi-k2.6`: `262_144`
  - `umans-flash`: `262_144`
  - `umans-glm-5.2`: `405_504`
  - `umans-glm-5.1`: `202_752`
  - `umans-qwen3.6-35b-a3b`: `262_144`
- input modalities:
  - `umans-coder`: `["text", "image"]`
  - `umans-kimi-k2.7`: `["text", "image"]`
  - `umans-kimi-k2.6`: `["text", "image"]`
  - `umans-flash`: `["text", "image"]`
  - `umans-glm-5.2`: `["text"]`
  - `umans-glm-5.1`: `["text"]`
  - `umans-qwen3.6-35b-a3b`: `["text", "image"]`

The GLM rows stay text-only to match the current `noVisionModels` behavior and OMP's treatment of
GLM vision as a handoff, not native image input.

Keep these fields unchanged:

- `adapter: "anthropic"`
- `baseUrl: "https://api.code.umans.ai"`
- `authKind: "key"`
- `defaultModel: "umans-coder"`
- `escapeBuiltinToolNames: true`

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/src/providers/derive.ts`

Copy the new metadata fields through:

- `providerConfigSeed()`
- `deriveKeyLoginMap()`
- `DerivedKeyLoginProvider`

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/src/oauth/key-providers.ts`

Copy the new metadata fields through:

- `KeyLoginProvider`
- `enrichProviderFromCatalog()`

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/src/oauth/login-cli.ts`

Copy the new metadata fields into the saved key-login provider config.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/src/oauth/index.ts`

Include the new metadata fields in OAuth provider reconciliation so future OAuth registry metadata
stays synced.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts`

Extend `catalogHintsFromProviderConfig()` so provider config metadata reaches `CatalogModel`:

- context cap selection must use existing per-model lookup semantics:
  - use `modelRecordValue(prov.modelContextWindows, id) ?? prov.contextWindow`
  - model-specific cap wins over provider-wide cap
  - if no live/cached context exists, return configured cap for configured/static models
- input modalities:
  - use `modelRecordValue(prov.modelInputModalities, id)` when present

`catalogHintsFromProviderConfig()` alone cannot cap live/cached values because it does not know the
live value. Add a merge helper for live/cached models:

```ts
function applyProviderConfigHints(name: string, prov: OcxProviderConfig, model: CatalogModel): CatalogModel
```

The helper should:

- compute the configured cap from `modelContextWindows` / `contextWindow`
- set `contextWindow` to `Math.min(model.contextWindow, configuredCap)` when both values exist
- set `contextWindow` to the configured cap when the model lacks live/cached context
- copy `inputModalities` when `modelInputModalities` has a match
- preserve current reasoning-effort behavior via `configuredReasoningEfforts()`

Use that helper in all three catalog paths:

- `applyConfigHintsToCachedModels()`
- configured/static fallback models
- live `/models` rows after `catalogHintsFromModelsApiItem()`

This preserves PR #12's cap semantics: config can lower oversized live metadata but must not raise a
smaller live context window.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/tests/provider-registry-parity.test.ts`

Assert registry-derived key-login and provider presets preserve Umans context/input metadata.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/tests/umans-provider.test.ts`

Strengthen Umans tests so the saved/enriched provider retains catalog metadata while preserving
Anthropic Messages runtime behavior.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/tests/codex-catalog.test.ts`

Add catalog tests for:

- static configured models receiving context/input metadata
- live `/models` metadata being capped by provider-wide and model-specific config
- configured caps not raising smaller live metadata
- cached metadata being capped consistently

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/README.md`

Add a short configuration example or field summary for `contextWindow`, `modelContextWindows`, and
`modelInputModalities`, then point detailed field definitions to the docs-site configuration
reference.

### MODIFY docs-site config reference pages

Update English, Korean, and Chinese docs-site config/reference pages if the fields are documented
there.

## Verification Plan

Run:

- `bun test tests/codex-catalog.test.ts tests/provider-registry-parity.test.ts tests/umans-provider.test.ts tests/reasoning-effort.test.ts`
- `bun run typecheck`
- `bun test tests`
- `cd docs-site && bun run build`
- `git diff --check`

## Contributor Credit

Commit with trailers:

```text
Co-authored-by: 0disoft <rodisoft1@gmail.com>
Co-authored-by: Ingwannu <ingwannu@users.noreply.github.com>
```

## GitHub Closeout

After the dev commit is verified and pushed:

- Comment on PR #12 that context-window cap behavior has landed on `dev` with credit, then close it
  as superseded.
- Comment on PR #21 that the metadata plumbing has landed on `dev` with credit, but the OpenAI Chat
  Umans runtime shape was intentionally not merged because `dev` keeps the verified Anthropic
  Messages provider, then close the draft PR as superseded.
