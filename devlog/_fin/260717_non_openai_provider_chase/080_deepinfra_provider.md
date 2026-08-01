# WP8 — DeepInfra provider preset

## Goal and dependency

Add DeepInfra's OpenAI-compatible chat lane as a keyed, live-model provider. Depends on registry/catalog precedence being stable through WP7.

## Diff map

| Action | Path | Before | After |
|---|---|---|---|
| MODIFY | `src/providers/registry.ts` | no `deepinfra` row | keyed `openai-chat` preset at `https://api.deepinfra.com/v1/openai`, dashboard URL, live models, no speculative static default |
| MODIFY | `tests/provider-registry-parity.test.ts` | provider absent | assert key-login/init/preset derivation and featured-policy decision |
| NEW | `tests/deepinfra-provider.test.ts` | no endpoint fixture | prove `/chat/completions`, `/models`, Bearer auth, tool stream parsing, model ids containing `/`, and safe 401/429 behavior |
| MODIFY | `README.md`, `README.ko.md`, `README.zh-CN.md`, `docs/README.md` | no DeepInfra | add only after runtime smoke passes; keep source-of-truth tables aligned |

## Contract details

- Do not route DeepInfra's native `/v1/inference/{model}` surface through this preset.
- Live `/models` is authoritative. A static fallback model is added only from an implementation-time official/live receipt.
- Namespaced model ids such as `deepseek-ai/...` stay intact; no provider-prefix stripping.
- Existing OpenAI-chat tool, usage, and error normalization is reused unless a failing fixture proves a DeepInfra delta.

## Activation scenarios

- Authenticated `/models` rows become `deepinfra/<id>` without double-prefixing.
- A streamed tool call with fragmented arguments is assembled by the existing buffered parser.
- 401 redacts upstream details; transient 429 follows existing keyed-provider cooldown behavior.
- A native non-chat model discovered by `/models` is excluded by the existing model exposure gate or an explicit provider predicate, with a fixture.

## Verification

```bash
bun test tests/deepinfra-provider.test.ts tests/provider-live-models.test.ts tests/provider-registry-parity.test.ts
bun run typecheck
```

Authenticated model-list and one tool-call smoke are required for `DONE`.

## Terminal outcomes

- `DONE`: preset, live discovery, tool stream, error fixture, docs, and live smoke pass.
- `NOOP`: an equivalent preset lands before this phase.
- `NEEDS_HUMAN`: no DeepInfra token is available.
- `BLOCKED`: official compatibility endpoint or required tool streaming is unavailable.
