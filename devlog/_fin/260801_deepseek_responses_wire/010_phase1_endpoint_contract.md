# 010 — Phase 1: make the DeepSeek Responses endpoint reachable

## Problem

`createResponsesPassthroughAdapter()` derives the key-mode URL as
`${baseUrl minus trailing /v1}/v1/responses`. For `deepseek`
(`baseUrl: "https://api.deepseek.com"`, no `responsesPath`) that yields
`https://api.deepseek.com/v1/responses`, while the documented route is
`https://api.deepseek.com/responses`.

The adapter already supports an explicit override: when `provider.responsesPath` is
defined it appends that path verbatim. The registry simply never sets it. So the fix
is registry metadata plus the derive/seed plumbing that carries it onto a configured
provider row — not an adapter change.

## Change map

### MODIFY `src/providers/registry.ts`

Add the field to `ProviderRegistryEntry` (near `modelWireDefaults`, ~line 132):

```ts
  modelWireDefaults?: Record<string, string>;
+ /**
+  * Responses-API path for providers whose route is not `/v1/responses`.
+  * DeepSeek documents `POST /responses` (no `/v1`).
+  */
+ responsesPath?: string;
```

Set it on the `deepseek` entry, beside the existing `modelWireDefaults` line:

```ts
     modelWireDefaults: { "deepseek-v4-flash": "openai-responses" },
+    // DeepSeek documents `POST /responses` (no `/v1` segment); without this the
+    // passthrough adapter would build `/v1/responses` and never route.
+    // Evidence: https://api-docs.deepseek.com/api/create-response/
+    responsesPath: "/responses",
```

### MODIFY `src/providers/derive.ts`

`providerConfigSeed()` must carry the field (mirrors the `promptCacheKey` line ~134):

```ts
    ...(entry.promptCacheKey !== undefined ? { promptCacheKey: entry.promptCacheKey } : {}),
+   ...(entry.responsesPath !== undefined ? { responsesPath: entry.responsesPath } : {}),
```

and `enrichProviderFromRegistry()` must backfill it for already-saved configs
(mirrors line ~250), fill-only so a hand-edited value is never overwritten:

```ts
  if (prov.promptCacheKey === undefined && seed.promptCacheKey !== undefined) prov.promptCacheKey = seed.promptCacheKey;
+ if (prov.responsesPath === undefined && seed.responsesPath !== undefined) prov.responsesPath = seed.responsesPath;
```

`OcxProviderConfig.responsesPath` already exists (`src/types.ts:923`); no type change.
Config validation also already exists (`providerResponsesPathConfigError`,
`src/config.ts:486-493`), and `/responses` satisfies it: relative, leading slash, no
scheme, no query or fragment.

## Accept criteria

- `createResponsesPassthroughAdapter` on the seeded deepseek config builds
  `https://api.deepseek.com/responses`.
- A provider row saved before this change gets the path backfilled by
  `enrichProviderFromRegistry`.
- Providers without `responsesPath` still build `/v1/responses` (no global change).

### Activation scenario (C-ACTIVATION-GROUNDING-01)

The `responsesPath !== undefined` branch in the adapter already exists but is dead for
registry providers. The test triggers it by seeding the deepseek preset and asserting
the built URL string; the observable effect is the absent `/v1` segment. The negative
control is a second assertion on a provider without the field, proving the default
branch still runs.
