# WP4 — OpenCode Go Kimi effort matrix

## Goal and dependency

Probe `kimi-k2.7-code` and `kimi-k2.7-code-highspeed` independently, then expose only the effort/tool-choice combinations the endpoint accepts.

## Diff map

| Action | Path | Before | After |
|---|---|---|---|
| MODIFY | `src/providers/registry.ts` | both Kimi models have empty effort arrays and are no-reasoning | encode separate per-model effort lists/maps proven by the live matrix; remove a model from `noReasoningModels` only when proven |
| MODIFY | `src/reasoning-effort.ts` | generic mapping has no Kimi-specific evidence contract | reuse existing per-model map; add no new Kimi branch unless generic config cannot express the result |
| MODIFY | `src/adapters/openai-chat.ts` | drops effort for no-reasoning and handles forced tool choice generically | preserve generic policy; add provider-specific removal only if a failing forced-tool fixture proves it is required |
| MODIFY | `tests/reasoning-effort.test.ts` | Kimi is expected to expose nothing | table-test base/highspeed × low/medium/high/xhigh/max × auto/forced tool choice |
| MODIFY | `tests/opencode-go-deepseek.test.ts` | sibling provider policy only | add regression that Kimi changes do not alter GLM/DeepSeek toggle/budget mappings |
| NEW | `devlog/_plan/260717_non_openai_provider_chase/041_kimi_live_matrix.md` | no authenticated receipt | record status, normalized error class, accepted payload, and date without credentials |

## Activation scenarios

- Base Kimi accepts a proven effort and receives its mapped upstream value.
- Highspeed rejection does not inherit base-model support.
- A forced tool-choice request either strips effort only when proven necessary or remains unchanged; the test must drive the exact branch.
- Reasoning replay remains enabled for both models regardless of picker effort exposure.

## Verification

```bash
bun test tests/reasoning-effort.test.ts tests/opencode-go-deepseek.test.ts tests/provider-registry-parity.test.ts
bun run typecheck
```

## Terminal outcomes

- `DONE`: both models have separate authenticated matrices and encoded policy.
- `NOOP`: both reject all exposed efforts; retain conservative current config and the matrix receipt.
- `NEEDS_HUMAN`: no OpenCode Go key is available.
- `UNSAFE`: probe would incur unbounded spend; set a request-count cap in P before running it.
