# WP0 research findings

## Root cause

The fragmentation is a summary-attribution problem, not a CCA routing problem. Antigravity intentionally accepts picker bases, explicit wire suffixes, and historical aliases (`src/providers/antigravity-models.ts:9-91`). The request path records the routed/call ID as `model` (`src/server/responses.ts:991-1023`), while the adapter separately resolves it to the CCA wire ID (`src/adapters/google.ts:243-263`). Historical rows therefore retain whichever accepted ID was called.

`usage.jsonl` preserves `model`, optional `requestedModel`, and optional `resolvedModel` without canonicalization (`src/server/request-log.ts:574-599`, `src/server/request-log.ts:213-238`, `src/usage/log.ts:213-257`, `src/usage/log.ts:266-289`). `summarizeUsage()` then builds daily and model rows (`src/usage/summary.ts:447-477`). Both `buildDayGrid` and `buildModels` key directly on `attribution.model` (`src/usage/summary.ts:254-303`, especially 265-270; `src/usage/summary.ts:306-380`, especially 311-330). Removing `resolvedModel` from identity only prevents reported/unreported splits; it does not merge aliases or wire IDs.

Provider Workspace fetches `/api/usage?range=30d`, groups returned rows by provider, and forwards both fields unchanged (`gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:137-169`). `ProviderUsage` uses `row.resolvedModel ?? row.model` as expansion identity and displayed label (`gui/src/components/provider-workspace/ProviderUsage.tsx:87-94`). Thus a server fix that canonicalizes only the key but retains a historical/wire `resolvedModel` can still display the wrong name and create duplicate React/expansion keys.

## Full data path

1. `parseRequest` captures the caller's ID in `logCtx.requestedModel`; `routeModel` strips a provider namespace and assigns the routed ID to `logCtx.model` (`src/server/responses.ts:958-968`, `src/server/responses.ts:991-1023`).
2. Antigravity converts that model plus effort to `wireModelId` only while building the CCA request (`src/adapters/google.ts:243-263`; resolver at `src/providers/antigravity-models.ts:142-168`).
3. Final request logging emits `model`, optional `requestedModel`, and optional `resolvedModel` (`src/server/request-log.ts:574-599`). Persistence copies them into `usage.jsonl` (`src/server/request-log.ts:213-238`; `src/usage/log.ts:213-269`).
4. Reads normalize but do not change those IDs (`src/usage/log.ts:273-289`).
5. `usageAttributions` carries `model` and optional `resolvedModel`, but not `requestedModel` (`src/usage/summary.ts:153-183`).
6. `buildDayGrid` keys `provider/model`; `buildModels` keys concatenated `provider + model` and retains the first `resolvedModel` (`src/usage/summary.ts:254-303`, `src/usage/summary.ts:306-380`).
7. `/api/usage` returns `summarizeUsage(readUsageEntries(), ...)` (`src/server/management-api.ts:464-470`).
8. `ProviderWorkspaceShell` groups model rows by provider (`gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:137-169`).
9. `ProviderUsage` displays `resolvedModel ?? model` (`gui/src/components/provider-workspace/ProviderUsage.tsx:87-94`).

## Model inventory and canonical reverse map

| Accepted/historical/wire ID | Source category | Canonical picker/call base |
|---|---|---|
| `gemini-3.6-flash` | picker base | `gemini-3.6-flash` |
| `gemini-3.6-flash-low` | wire, suffix compat | `gemini-3.6-flash` |
| `gemini-3.6-flash-medium` | wire, suffix compat | `gemini-3.6-flash` |
| `gemini-3.6-flash-high` | wire, suffix compat | `gemini-3.6-flash` |
| `gemini-3.5-flash-extra-low` | historical compat -> 3.6 low | `gemini-3.6-flash` |
| `gemini-3.5-flash-low` | historical compat -> 3.6 medium | `gemini-3.6-flash` |
| `gemini-3.5-flash-mid` | historical compat -> 3.6 medium | `gemini-3.6-flash` |
| `gemini-3.5-flash-high` | historical compat -> 3.6 high | `gemini-3.6-flash` |
| `gemini-3-flash-agent` | historical compat -> 3.6 high | `gemini-3.6-flash` |
| `gemini-3.1-pro` | picker base | `gemini-3.1-pro` |
| `gemini-3.1-pro-low` | wire, suffix compat | `gemini-3.1-pro` |
| `gemini-pro-agent` | wire, suffix compat, default/high | `gemini-3.1-pro` |
| `gemini-3.1-pro-high` | visible/saved alias -> agent | `gemini-3.1-pro` |
| `gemini-3.1-pro-preview` | visible/saved alias -> agent | `gemini-3.1-pro` |
| `claude-sonnet-4-6` | picker base and wire identity | `claude-sonnet-4-6` |
| `claude-opus-4-6-thinking` | picker base and wire identity | `claude-opus-4-6-thinking` |
| `gpt-oss-120b-medium` | picker base and wire identity | `gpt-oss-120b-medium` |

Effort-to-wire is Flash `low/medium/high -> gemini-3.6-flash-low/medium/high`, Pro `low/high -> gemini-3.1-pro-low/gemini-pro-agent`; default efforts are Flash medium and Pro high (`src/providers/antigravity-models.ts:21-48`). Claude effort is carried through `thinkingConfig`, not a model suffix (`src/providers/antigravity-models.ts:50-55`, 161-165).

## Local log evidence (2026-07-23 KST read-only sample)

The 74 MiB file contained 216,967 rows. Exact `provider == "google-antigravity"` had 91 rows dated 2026-06-30 through 2026-07-19: 61 `gemini-3.5-flash-high`, 27 `gemini-pro-agent`, 2 `gemini-3-flash-agent`, and 1 `gemini-3.5-flash-low`. `requestedModel` was present in 29 and absent in 62. `resolvedModel` was present in 90; all 90 had `model === resolvedModel`; one row had no resolved model. Statuses were 90 reported and 1 unreported.

Provider Workspace uses `baseProviderLabel`, which also folds recognized account-scoped provider labels (`src/providers/label.ts:3-18`). Across exact plus account-scoped Antigravity labels there were 283 rows. The live 30-day API returned eight fragmented rows: `gemini-3.5-flash-low` 87, `gemini-3.5-flash-high` 65, `gemini-3.5-flash-mid` 62, `gemini-pro-agent` 30, `claude-opus-4-6-thinking` 14, `gemini-3.1-pro-low` 13, `gemini-3.1-pro-high` 10, and `gemini-3-flash-agent` 2. Their request count sums to 283, directly matching the folded log population.

## Conclusion

`requestedModel` is too sparse and may include a provider namespace, while `resolvedModel` is a routing/upstream detail and in current history usually repeats the historical ID. The durable attribution source is `model`, canonicalized provider-specifically through the Antigravity reverse map at summary time.

## Expected live merge (API snapshot 2026-07-23)

From fragmented rows:
- Flash family (3.5-flash-mid/low/high + 3-flash-agent) → `gemini-3.6-flash` ≈ 216 requests
- Pro family (gemini-pro-agent + 3.1-pro-low/high) → `gemini-3.1-pro` ≈ 53 requests
- `claude-opus-4-6-thinking` stays itself
