# WP12 — Amazon Bedrock Mantle provider

## Goal and dependency

Add the lower-cost OpenAI-compatible Bedrock path before designing a native Converse adapter.

## Diff map

| Action | Path | Before | After |
|---|---|---|---|
| MODIFY | `src/providers/registry.ts` | no Bedrock preset | `bedrock-mantle` keyed Responses preset with required region/base URL, live models, and explicit storage note |
| MODIFY | `src/providers/derive.ts` | no region-derived preset URL | carry region/base URL requirement without embedding credentials |
| MODIFY | `src/cli/provider.ts` | no Bedrock region input | accept/validate region and resolve `https://bedrock-mantle.<region>.api.aws/v1` |
| MODIFY | `src/server/management-api.ts`, `gui/src/components/AddProviderModal.tsx`, `gui/src/provider-payload.ts`, `gui/src/i18n/en.ts`, `gui/src/i18n/ko.ts`, `gui/src/i18n/zh.ts`, `gui/src/i18n/de.ts` | no region-specific provider UX | collect region and Bedrock API key; explain short-term vs long-term key risk |
| MODIFY | `src/adapters/openai-responses.ts`, `src/server/responses.ts` | caller `store` passes through | preserve caller value by default; if P explicitly selects a privacy-first Bedrock policy, inject `store:false` at one named request boundary with a focused test and documented tradeoff |
| NEW | `tests/bedrock-mantle.test.ts` | no Mantle fixtures | region URL, `/models`, Responses stream/tool events, Bearer auth, store policy, quotas, and redaction |
| MODIFY | `tests/provider-registry-parity.test.ts`, `tests/server-auth.test.ts` | no Mantle preset | derivation and management negatives |

## Contract details

- Official base is `https://bedrock-mantle.<region>.api.aws/v1`; use an allowlist/validated AWS region grammar.
- Bedrock API keys are Bearer tokens. Short-term keys are preferred; OCX does not generate or refresh them in this phase.
- Live `/models` decides availability because Responses support varies by model.
- Bedrock stores Responses state for 30 days when `store:true/default`. The plan must make this visible; it must not silently claim stateless behavior.
- No SigV4 or native Converse event parsing in WP12.

## Activation scenarios

- Region `ap-northeast-1` resolves to the exact Mantle host and rejects malformed/credential-bearing regions.
- `/models` filters or labels models that do not support Responses according to official/live capability data.
- `store:false` survives unchanged end to end; any injected default branch is explicitly triggered and observed.
- A streamed tool call and terminal error remain valid Responses protocol events.

## Verification

```bash
bun test tests/bedrock-mantle.test.ts tests/provider-registry-parity.test.ts tests/server-auth.test.ts tests/openai-responses-passthrough.test.ts
bun run typecheck
bun run build:gui
```

## Terminal outcomes

- `DONE`: region/key UX, model discovery, storage contract, stream/tool/error fixtures, and live smoke pass.
- `NEEDS_HUMAN`: no Bedrock key/project/model access.
- `UNSAFE`: storage behavior cannot be presented accurately or requires long-term keys by default.
- `BLOCKED`: target models are unavailable on Mantle; continue to WP14 only for a named native requirement.
