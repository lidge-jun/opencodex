# Current-state inventory

## Existing owners

| Area | Current owner | Relevant proof surface |
|---|---|---|
| Provider presets | `src/providers/registry.ts`, `src/providers/derive.ts` | `tests/provider-registry-parity.test.ts` |
| Keyed provider creation | `src/oauth/key-providers.ts`, `src/cli/provider.ts`, `src/server/management-api.ts` | `tests/cli-provider.test.ts`, `tests/server-auth.test.ts` |
| Provider GUI | `gui/src/components/AddProviderModal.tsx`, `gui/src/provider-payload.ts`, `gui/src/i18n/en.ts`, `gui/src/i18n/ko.ts`, `gui/src/i18n/zh.ts`, `gui/src/i18n/de.ts` | `tests/server-auth.test.ts`, `tests/provider-payload.test.ts`, `gui/package.json` |
| OpenAI-compatible Chat | `src/adapters/openai-chat.ts` | `tests/openai-chat-hardening.test.ts`, `tests/openai-chat-parallel-stream.test.ts`, `tests/openai-chat-eof.test.ts` |
| Responses passthrough | `src/adapters/openai-responses.ts`, `src/server/responses.ts` | `tests/openai-responses-passthrough.test.ts` |
| Cursor | `src/adapters/cursor/live-models.ts`, `src/adapters/cursor/live-transport.ts` | `tests/cursor-hardening.test.ts`, `tests/cursor-live-transport.test.ts`, `tests/cursor-live-smoke-gate.test.ts` |
| Antigravity | `src/adapters/google.ts`, `src/adapters/google-antigravity-replay.ts`, `src/providers/antigravity-models.ts` | `tests/google-antigravity-replay.test.ts`, `tests/google-antigravity-wire.test.ts`, `tests/google-models-listing.test.ts` |
| Kimi/OpenCode Go | `src/providers/registry.ts`, `src/reasoning-effort.ts`, `src/adapters/openai-chat.ts` | `tests/reasoning-effort.test.ts`, `tests/provider-registry-parity.test.ts`, `tests/opencode-go-deepseek.test.ts` |
| Z.AI errors | `src/lib/errors.ts`, `src/adapters/upstream-http-error.ts`, `src/adapters/openai-chat.ts`, `src/server/responses.ts` | `tests/error-fidelity.test.ts`, `tests/server-key-failover-e2e.test.ts` |
| Anthropic stream | `src/adapters/anthropic.ts`, `src/bridge.ts` | `tests/anthropic-hardening.test.ts`, `tests/anthropic-reasoning.test.ts`, `tests/anthropic-thinking-signature.test.ts` |
| Metadata | `src/generated/jawcode-model-metadata.ts`, `src/codex/catalog.ts` | `tests/codex-catalog.test.ts`, `tests/provider-registry-parity.test.ts` |
| Vertex auth | `src/lib/gcp-adc.ts`, `src/adapters/google.ts` | `tests/gcp-adc.test.ts`, `tests/google-vertex-http.test.ts`, `tests/google-vertex-stream.test.ts` |
| AWS-compatible path | `src/adapters/kiro.ts`, `src/adapters/kiro-retry.ts`, `src/adapters/kiro-events.ts` | `tests/kiro-adapter.test.ts`, `tests/kiro-retry.test.ts`, `tests/kiro-stream.test.ts`; reference only, no direct Bedrock owner |

## Confirmed deltas

- Cursor discovery sends `cli-2026.02.13-41ac335`; Run sends `cli-2026.07.08-0c04a8a`.
- Antigravity maps `gemini-3.1-pro-high` to `gemini-pro-agent`; the alias is both picker-visible and inbound-compatible today.
- OpenCode Go advertises empty effort arrays and marks both Kimi K2.7 code variants as no-reasoning.
- Z.AI has registry/context/reasoning support but no provider-scoped weekly exhaustion fixture.
- Anthropic stream parsing tracks one mutable block type and tool id while upstream events carry block indexes.
- Generated jawcode rows contain `contextWindow`, `maxTokens`, `input`, `reasoning`, and `wireModelId`; the catalog currently consumes only context and input.
- Vertex already supports service-account ADC, authorized-user refresh tokens, gcloud ADC, and metadata-server credentials. The gap is first-class setup/status UX, not token exchange.
- Direct xAI already has OAuth/key mode, live models, replay preservation, and 401 refresh/re-resolve/replay. It is excluded.

## Stale chase statements to replace

- Fugu/Sakana is no longer missing endpoint and auth: Sakana published both on 2026-06-22.
- Old global chase claims that Cursor is unported or xAI lacks a transport do not match this tree.

## Necessity gate

- Do nothing: rejected because the user explicitly promoted direct Sakana and requested a durable full roadmap.
- Delete: only stale/rejected roadmap rows are removed; existing compatibility code is preserved.
- Configure: reused whenever a provider fits current adapters; new adapters are planned only for native AWS signing/event semantics.
- Reuse: registry derivation, OpenAI-compatible adapters, ADC, key management, catalog enrichment, and focused test patterns are the preferred owners.
