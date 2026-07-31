# WP1 — Sakana Fugu direct provider

## Goal and dependency

Add a first-class `sakana` keyed provider for `fugu` and `fugu-ultra`, reusing the existing Responses passthrough. Depends only on the current registry/derivation contract.

## Diff map

| Action | Path | Before | After |
|---|---|---|---|
| MODIFY | `src/providers/registry.ts` | Fugu exists only as OpenRouter-generated metadata | `sakana` preset uses `openai-responses`, `https://api.sakana.ai/v1`, key auth, two static models, 1M windows, `high/xhigh/max` exposure, and `max -> xhigh` wire mapping |
| MODIFY | `tests/provider-registry-parity.test.ts` | no Sakana preset assertion | assert derivation into key-login/init/preset surfaces without secret leakage |
| NEW | `tests/sakana-provider.test.ts` | no direct contract fixture | prove `/responses` URL, Bearer auth, model preservation, effort aliasing, SSE/tool continuity, and no global timeout mutation |
| MODIFY | `devlog/_chase/_model/005_upstream_delta_backlog.md` | standalone is rejected for missing endpoint/auth | mark direct provider `PLAN/ADAPT` and point to this unit |
| MODIFY | `devlog/_chase/_model/006_jawcode_import_matrix.md` | missing endpoint/auth gate | record official endpoint/auth/model evidence and implementation gate |
| MODIFY | `devlog/_chase/_model/008_logic_delta.md` | product-boundary reject | replace Fugu reject with direct provider ownership; retain OpenRouter live-discovery rule |

## Contract details

- Provider id is `sakana`; do not overload `openrouter` or introduce `fugu` as a provider id.
- `defaultModel` is `fugu`; static models are `fugu` and `fugu-ultra`.
- Both models advertise `high`, `xhigh`, and Codex-compatible `max`; request mapping sends `max` as `xhigh`.
- Do not add Sakana-specific retry counts to global server policy in this phase. A real dropped-stream fixture is required for a later provider-scoped retry design.
- Do not expose the dated `fugu-ultra-20260615` alias unless `/models` or official setup docs establish it as an accepted public request id at implementation time.

## Activation scenarios

- `ocx provider add sakana --api-key ...` creates a keyed Responses provider and a routed `sakana/fugu` request reaches `${baseUrl}/responses` with Bearer auth.
- Selecting `max` produces upstream `reasoning.effort: "xhigh"`; selecting `high` remains `high`.
- A mock long-lived stream remains governed by the existing configured stall/connect limits; WP1 does not silently alter unrelated providers.

## Verification

```bash
bun test tests/sakana-provider.test.ts tests/provider-registry-parity.test.ts tests/openai-responses-passthrough.test.ts
bun run typecheck
OPENCODEX_HOME=$(mktemp -d) ocx provider add sakana --api-key '$SAKANA_API_KEY'
```

An authenticated live smoke is required for `DONE`; without a user-provided key, unit tests may pass but the work-phase ends `NEEDS_HUMAN`, not `DONE`.

## Terminal outcomes

- `DONE`: registry, payload, stream/tool fixture, CLI/preset proof, typecheck, and authenticated smoke pass.
- `NOOP`: only if the current tree gains an equivalent direct Sakana preset before WP1 starts.
- `BLOCKED`: official endpoint is withdrawn or unavailable in the user's region.
- `UNSAFE`: implementation requires logging keys or widening global retry/timeout policy.
- `NEEDS_HUMAN`: no live Sakana key is available for final smoke.
