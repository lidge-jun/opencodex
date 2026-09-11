# Current state: how a Cursor row is built and where Fast dies

Research only. No diffs here.

## 1. The picker path never reads the capability table

`cursorUmbrellaRows()` (`src/adapters/cursor/catalog.ts:554`) is imported by
`tests/cursor-umbrella-rows.test.ts` and nothing else in `src/`. The published rows come
from a different list:

```
CURSOR_STATIC_MODELS (discovery.ts:276)
  -> registry.ts:1110  models: cursorModelIds(CURSOR_STATIC_MODELS)
  -> derive.ts:230     seeded into config.providers.cursor.models
  -> provider-fetch.ts:1394  cursor branch: live GetUsableModels intersection
  -> sync.ts           disabledModels removal, deriveEntry writes slug/display_name/...
```

So the capability table describes dimensions the picker never sees. Collapsing a variant in
`catalog.ts` changes routing, not listing.

## 2. Four inconsistencies, measured

**Mixed row semantics.** 16 seed ids have no capability record. Some are genuine products
with no base (`composer-1`, `composer-2.5`, `gemini-3-pro`, `gpt-5-codex`), and three are
dimensions wearing a row costume: `claude-4-sonnet-1m` (a real wire id, guarded by
`REAL_1M_WIRE_IDS` at `catalog.ts:333`), `gpt-5-fast`, `composer-2.5-fast`.

**1M means two things.** `kimi-k3-1m` is synthetic — `CURSOR_ULTRA_1M_MODEL_IDS`
(`discovery.ts:174`) folds it into `kimi-k3` + Max Mode. `claude-4-sonnet-1m` is a real
upstream id and stays a second row. Both read as "1M" to a user.

**Fast means two things.** Opus/Grok fast ids were folded to aliases
(`tests/cursor-umbrella-rows.test.ts:20-31`); `gpt-5-fast` and `composer-2.5-fast` remain
rows because they have no capability base.

**Labels and windows.** `routedDisplayName()` (`sync.ts:272`) returns the slug unchanged for
every provider except command-code, so Cursor rows read `cursor/kimi-k3`. Three windows
disagree between seed and capability table (000_plan.md).

`ProviderRegistryEntry` has `modelContextWindows`, `modelInputModalities`,
`modelReasoningEfforts` — but **no `modelDisplayNames`** (`registry.ts:265-290`), and
`ProviderConfigSeed` (`registry.ts:327`) does not list it either. The consumer exists
(`configuredModelDisplayName`, `provider-fetch.ts:634`) and reads
`prov.modelDisplayNames`; only the registry->config path is missing.

## 3. Where Codex Fast dies for Cursor

Codex Fast is OpenAI `service_tier`, not a boolean:

```
app catalog row service_tiers:[{id:"priority",name:"Fast"}]   (effort.ts:160)
  -> request service_tier:"priority"                          (parser.ts:826)
  -> decideTier(policy, config.fastMode, callerTier)           (fastwire.ts:392)
  -> applyServiceTierGate deletes the field when kind==="drop" (responses/core.ts:2638)
```

The drop is structural. `FAST_WIRE_ADAPTERS` (`fastwire.ts:14-18`) maps
`"service-tier" -> {openai-chat, openai-responses}` and `"anthropic-speed" -> {}`. Cursor is
in neither, so `resolveFastPolicy` sets `eligibility: "wire-unavailable"`,
`serviceTierSupportFromPolicy` publishes `supportsServiceTier: false`, and
`applyCatalogModelMetadata` never stamps the tier. No config value fixes this: forcing
`supportsServiceTier: true` still fails the wire check, and declaring
`fastWire.kind: "service-tier"` fails the adapter-set check.

Meanwhile the fast wire genuinely exists, keyed off the picked id:

- Grok (`wirePrefix: "cursor-"`): base id + `{id:"effort"},{id:"fast",value:"true"}`
  parameters, via `cursorGrokFastSelection` (`catalog.ts:538`,
  `request-builder.ts:204-213`).
- Everyone else: flattened wire id `claude-opus-5-thinking-high-fast` via `composeWireId`
  (`catalog.ts:446-466`).

`normalizeCursorModelId` (`request-builder.ts:189`) receives only `parsed.modelId` and
`parsed.options.reasoning`. `rg` finds no `serviceTier`/`tierDecision` read anywhere under
`src/adapters/cursor/`.

Telemetry is a separate hole: `adapters/registry.ts:156-176` attaches
`createAdapterTierMetadata(..., null, null)` for every non-OpenAI adapter, so even a
working Cursor fast request would report an absent wire field.

Five bases have a fast dimension: `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`,
`grok-4.5`, `grok-4.6`. Stamping a tier on the other 29 would recreate the dead-toggle
defect `NO_FAST_TIER_NATIVE_SLUGS` (`parsing.ts:297`) exists to prevent.

## 4. Listing surfaces outside Codex

`GET /v1/models` has three branches (`server/index.ts:1316-1560`):

| Trigger | Id shape | Composed at |
|---|---|---|
| `?client_version` | catalog slugs | `buildCatalogEntries` |
| `anthropic-version` / `?flavor=anthropic` | `claude-ocx-*` or Desktop hashes | `claude/model-info.ts:105` |
| default | `alias ?? provider/id` | `server/index.ts:1534` |

`buildAnthropicModelInfos` already publishes a second row for a dimension: `push1mVariant`
(`model-info.ts:115-128`) appends `<id>[1m]`, and `resolveInboundModel` strips it before
routing. That is the precedent `-fast` listing should follow.

`config.fastMode` (`types/config.ts:462`) is tri-state and today only reaches
`decideTier` plus Codex's injected `[features] fast_mode` (`codex/inject.ts:708`). It
touches no listing code: `rg fastMode` is empty in `server/index.ts`,
`claude/model-info.ts`, `management/model-rows.ts`, and `cli/models.ts`.

Dashboard `/api/models` uses `namespaced` as the disable/export key
(`catalogModelSlug`, `parsing.ts:703`), so rewriting it would desync `disabledModels`.
That surface stays untouched.
