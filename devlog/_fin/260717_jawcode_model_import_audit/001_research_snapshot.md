# 001 — Research snapshot

## Source state

- OpenCodex base: `dev` at `0167b415` when this audit started.
- jawcode source: local working tree on 2026-07-17.
- jawcode `packages/ai/src/models.json`, provider/model logic, and all `struct_har/chase/model/` files are modified or untracked. Therefore this is a sibling-working-copy comparison, not an upstream release claim.
- jawcode chase pins currently reviewed GJC `4a80bac9..3ddf26079` and OMP `7aa1d581c..b0d04e517`; those pins are provenance only.

### Mutable source fingerprint

| jawcode path | SHA-256 at audit start |
|---|---|
| `packages/ai/src/models.json` | `6151b9f629d2f31bbb85a9b3f0f57fc44bf75953b4bb877db25b18905d8d821f` |
| `packages/ai/src/model-manager.ts` | `597a7c2887866848b391b6d3898e7af7b1bf3bf3fecd4c5a12c3445f6cc36be0` |
| `packages/ai/src/model-thinking.ts` | `2a8e3297f17dde9c26fee4320ce3cbc821ce32b16dd9d9696e699444562be98a` |
| `packages/ai/src/provider-models/descriptors.ts` | `ae0e7718c6f00ac1c894bd26d9356f0cd24da83014fbc77f458c4f1a72bb9ad6` |
| `packages/ai/src/providers/cursor/client-version.ts` | `ee81af11dd65404100dd1699e2879e5708e2daaf32c0aa9a16a291956c61f8d4` |
| `packages/ai/src/providers/openai-bounded-rate-limits.ts` | `846c1a6181e54f8b276a4beb6d1a306aea8fcfaeea378d5e7708ce21f482b216` |
| `packages/ai/src/providers/openai-completions-compat.ts` | `32744430f281a549f368f8ceb390617ed55ce50e5961e15ab2e5ab9a853dcdbf` |
| `struct_har/chase/model/001_model_provider_inventory.md` | `9645345003bac18963a67720f245d397c847c0f5277fc0548d3127a402695f5f` |
| `struct_har/chase/model/002_model_catalog_contract.md` | `72b78d2db31231c242f915db88b387569d1eac1218bdb2d8a9437068213f5f2b` |
| `struct_har/chase/model/003_provider_auth_flow.md` | `1d113a3668c8b71bcf727ca0f64876b539c9b5acf2f09ce771a41fc66f8bcc49` |
| `struct_har/chase/model/005_upstream_model_delta.md` | `5c749dbad16829ef337d6f02e33be72a0d054a819a4629ea8ec95953d8a09ca7` |

If any fingerprint differs at closeout, this audit must report the drift and rerun the affected comparison before claiming completion.

## Provider namespace snapshot

- jawcode generated catalog: 48 top-level provider keys.
- OpenCodex built-in registry: 52 provider IDs at audit start.
- Exact shared IDs include `anthropic`, `azure-openai`, `cursor`, `google`, `openai`, `openrouter`, `opencode-go`, `xai`, and 32 others.
- jawcode-only generated IDs: `alibaba-coding-plan`, `amazon-bedrock`, `deepinfra`, `google-gemini-cli`, `minimax-code`, `minimax-code-cn`, `openai-codex`, `opencode`.
- OpenCodex-only registry IDs: `alibaba`, `anthropic-apikey`, `kimi`, `lm-studio`, `mimo-free`, `neuralwatt`, `ollama`, `openai-apikey`, `opencode-free`, `parallel`, `umans`, `vllm`.
- Namespace differences are not automatically missing providers. In particular, OpenCodex `openai` is forwarded Codex auth while jawcode `openai-codex` is the closer transport counterpart; OpenCodex `openai-apikey` is closer to jawcode `openai`.

## Jawcode metadata bridge snapshot

- OpenCodex maps seven jawcode bundles: `anthropic`, `google`, `minimax`, `moonshot`, `opencode-go`, `openrouter`, `xai`.
- Missing rows are appended only for `opencode-go`; other bundles enrich an existing model row.
- Generated rows contain `contextWindow`, `maxTokens`, `input`, `reasoning`, and `wireModelId`.
- Current OpenCodex catalog application consumes only `contextWindow` and `input`; `maxTokens`, `reasoning`, and `wireModelId` do not affect the catalog.

## Source versus generated snapshot

| Bundle | Delta |
|---|---|
| `anthropic` | Same 25 IDs. Source raises several Sonnet 4.5/4.6 windows; 4.6 is intentionally overridden back to 200K by the generator, while 4.5 has no such override. |
| `google`, `minimax`, `moonshot`, `opencode-go` | No ID/metadata delta found. |
| `openrouter` | 17 source IDs absent from generated snapshot, including GPT-5.6 tier/pro variants, `x-ai/grok-4.5`, and `~x-ai/grok-latest`; 11 `maxTokens` values differ. |
| `xai` | Source adds `grok-4.5`; the OpenCodex registry already exposes that model explicitly. |

The OpenRouter `maxTokens` differences are deferred contract evidence because OpenCodex currently does not consume generated `maxTokens`.

## High-signal logic findings

1. Cursor discovery and run report different client versions in OpenCodex; jawcode centralizes one constant.
2. jawcode prevents OpenAI SDK-internal long 429 retries; OpenCodex does not use that retry path, excludes 429 from generic transient retry, and separately rotates key pools.
3. jawcode retires `google-antigravity/gemini-3.1-pro-high`; OpenCodex still publishes and tests the alias.
4. jawcode maps unsupported OpenCode Go Kimi efforts; OpenCodex currently suppresses reasoning for `kimi-k2.7-code` entirely.
5. jawcode's general Anthropic path omits disabled thinking; OpenCodex already emits thinking only for a non-`none` effort. Its web-search sidecar has a separate explicit-disabled contract.
6. jawcode generates GPT-5.6 Luna/Sol/Terra at 1.05M for OpenAI API and 373K for Codex, then a later policy caps both transports to 373K. OpenCodex already has the same three IDs with 372K native/API-key and 1.05M OpenRouter contracts.

## Evidence kinds

- `local-source`: directly present in the fingerprinted jawcode implementation.
- `chase-only`: described by jawcode chase/upstream notes but not established in the local implementation paths inspected here.
- `live-unverified`: requires authenticated endpoint evidence not collected in this docs-only loop.

`chase-only` and `live-unverified` findings may only produce `RESEARCH`, never direct import approval.

## Reproduction anchors

```bash
git -C ../jawcode status --short -- packages/ai/src struct_har/chase/model
rg -n "CURSOR_.*CLIENT_VERSION|gemini-3.1-pro-high|gpt-5.6-(luna|sol|terra)|kimi-k2.7-code" src tests ../jawcode/packages/ai
rg -n "JAWCODE_CATALOG_AUGMENT_PROVIDERS|applyJawcodeCatalogMetadata|maxTokens|wireModelId" src scripts
rg -n "isTransientUpstreamStatus|rotateKeyOn429|thinking.*none" src tests
```
