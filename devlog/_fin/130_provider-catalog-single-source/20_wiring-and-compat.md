# 130.20 — Wiring and Compatibility

## Consumer rewiring

The implementation keeps existing public surfaces while replacing their authoring source.

| Consumer | Before | After |
|----------|--------|-------|
| `src/oauth/key-providers.ts` | Hand-maintained `KEY_LOGIN_PROVIDERS` map. | `KEY_LOGIN_PROVIDERS = deriveKeyLoginMap()`. |
| `src/init.ts` | Manual assembly from OAuth rows, hardcoded key rows, key-login rows, and local rows. | `buildInitProviders()` returns `deriveInitProviders()`. |
| `src/oauth/index.ts` | OAuth provider configs copied inline. | Login/refresh handlers stay local; `providerConfig` and `defaultModel` derive from registry. |
| `src/server.ts` | `/api/key-providers` only exposed key-login rows. | Existing endpoint remains; new `/api/provider-presets` returns GUI-ready registry projection. |
| `gui/src/components/AddProviderModal.tsx` | Static `PRESETS` plus `/api/key-providers` merge. | Fetches `/api/provider-presets`; keeps a minimal `custom` fallback. |
| `scripts/generate-jawcode-metadata.ts` | Hand-written `PROVIDER_ALIASES`. | Uses `deriveJawcodeAliases()`. |
| `src/codex-catalog.ts` | Exact metadata lookup only. | Exact lookup first; registry-gated case-insensitive fallback for MiniMax-style providers. |
| `README.md` | Azure adapter documented as `azure`. | Azure adapter documented as canonical `azure-openai`. |

## Compatibility contracts preserved

| Contract | Result |
|----------|--------|
| Saved provider config JSON shape | Unchanged. |
| `/api/key-providers` response shape | Still `{ providers: [...] }`. |
| GUI provider creation request shape | Unchanged; only preset source changed. |
| `KEY_LOGIN_PROVIDERS` export | Still a record keyed by provider id. |
| `OAUTH_PROVIDERS` export | Still keyed by OAuth provider id with login/refresh handlers. |
| `resolveJawcodeProvider()` | Still generated and exported from `src/generated/jawcode-model-metadata.ts`. |
| `getJawcodeModelMetadata()` | Still generated and exported with exact lookup behavior. |

## `/api/key-providers` set expansion

The `/api/key-providers` response shape is preserved, but its id set intentionally expands from
the old dedicated key-login map to every registry row with `authKind: "key"`. That brings the
featured key providers that were previously GUI-static/init-hardcoded only into the key-provider
catalog too:

| Newly included key ids | Why |
|------------------------|-----|
| `openai-apikey`, `openrouter`, `groq`, `google`, `azure-openai` | These are real API-key providers and now share the same registry projection as the rest of the key catalog. |

The parity test freezes the full key-provider id set so this public endpoint cannot expand or
shrink silently after Phase 130.

## Legacy Azure alias

The canonical registry value is `adapter: "azure-openai"`. Existing saved configs may still contain
`adapter: "azure"`, so `resolveAdapter()` now accepts both:

| Adapter string | Behavior |
|----------------|----------|
| `azure-openai` | Canonical Azure adapter path. |
| `azure` | Legacy compatibility alias routed to the same Azure adapter. |

This is a compatibility fix: before Phase 130, `azure-openai` worked in the GUI path while `azure`
could be emitted by `ocx init`, creating an inconsistent saved config depending on setup path.

## GUI runtime endpoint

`GET /api/provider-presets` returns the final picker list:

```json
{
  "providers": [
    { "id": "openai", "label": "OpenAI (ChatGPT login)", "auth": "forward" },
    { "id": "custom", "label": "Custom provider", "auth": "key" }
  ]
}
```

The actual response includes adapter, base URL, default model, OAuth provider key, dashboard URL,
and notes when present. `custom` stays last.

The GUI uses this endpoint because importing repo-root `src/providers/*` into the standalone Vite
package would cross its configured TypeScript boundary.

If `/api/provider-presets` is unavailable, the modal falls back only to `custom`. That is a
deliberate tradeoff: keeping the old 13 static presets in the GUI would preserve a second authored
catalog and reintroduce the drift Phase 130 removes.

## Metadata normalization

MiniMax illustrates a concrete metadata drift bug:

| Source | Example model id |
|--------|------------------|
| jawcode bundled metadata | `MiniMax-M2.5` |
| routed catalog slug | `minimax/minimax-m2.5` |

Phase 130 keeps exact lookup as the default and adds a registry-gated fallback:

1. Resolve provider alias through generated metadata aliases.
2. Try `getJawcodeModelMetadata()` exact lookup.
3. If the provider registry row has `metadataModelIdNormalize: "case-insensitive"`, try
   `getJawcodeModelMetadataCaseInsensitive()`.

This keeps normalization narrow and avoids guessing metadata for unrelated providers.
