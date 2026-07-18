# WP11 — Databricks workspace provider

## Goal and dependency

Add a workspace-bound preset that requires an explicit Databricks host and endpoint model id. This is not a global static-model provider.

## Diff map

| Action | Path | Before | After |
|---|---|---|---|
| MODIFY | `src/providers/registry.ts` | registry assumes a usable fixed base URL for key presets | add `databricks` with base-URL override required, no global model seed, and a provider note explaining endpoint-name model ids |
| MODIFY | `src/providers/derive.ts` | preset DTO lacks a required-base-url signal | propagate a narrow `requiresBaseUrl`/equivalent flag to CLI and management GUI |
| MODIFY | `src/cli/provider.ts` | preset add can use registry URL | require `--base-url https://<workspace>/serving-endpoints` and at least one `--model` for Databricks |
| MODIFY | `src/server/management-api.ts` | provider preset validation is fixed/key-centric | reject placeholder/non-HTTPS/public-suffix-invalid Databricks URLs before persistence |
| MODIFY | `gui/src/components/AddProviderModal.tsx` | base URL hidden for non-custom presets | show required workspace URL and endpoint model fields for this preset |
| MODIFY | `gui/src/provider-payload.ts`, `gui/src/i18n/en.ts`, `gui/src/i18n/ko.ts`, `gui/src/i18n/zh.ts`, `gui/src/i18n/de.ts` | no workspace-bound preset payload | send trimmed base URL/model list; add concise labels in supported locales |
| NEW | `tests/databricks-provider.test.ts` | no workspace routing fixture | URL validation, endpoint-name model routing, PAT auth, M2M token equivalence, stream/tool/errors |
| MODIFY | `tests/server-auth.test.ts`, `tests/provider-payload.test.ts` | no required-base preset | reject missing/unsafe URL and prove safe DTO/preset behavior |

## Security boundary

- Accept only HTTPS workspace URLs by default. Private/custom workspace hosts require the existing explicit private-network policy, not an automatic bypass.
- Store tokens through the existing secret field; never persist them in `baseUrl`, headers, logs, or model names.
- PAT and machine-to-machine OAuth access tokens are both Bearer material to the adapter. Token acquisition/rotation is not built in this phase.
- Do not auto-discover every workspace endpoint unless an authenticated official list API and least-privilege scope are designed in P.

## Activation scenarios

- Missing workspace URL/model is rejected before config mutation.
- A valid workspace URL produces `/serving-endpoints/chat/completions` through the OpenAI client shape with the endpoint name as `model`.
- A hostile URL containing credentials, query secrets, loopback, or invalid scheme is rejected/redacted according to destination policy.
- A streamed external-model tool call completes through the common parser.

## Verification

```bash
bun test tests/databricks-provider.test.ts tests/server-auth.test.ts tests/cli-provider.test.ts
bun run typecheck
bun run build:gui
```

## Terminal outcomes

- `DONE`: required-input UX, destination-policy negatives, tool stream, docs, and workspace smoke pass.
- `NEEDS_HUMAN`: no disposable Databricks workspace/token/endpoint.
- `UNSAFE`: requested host requires weakening SSRF/private-network policy globally.
- `BLOCKED`: no compatible endpoint with tool streaming is available.
