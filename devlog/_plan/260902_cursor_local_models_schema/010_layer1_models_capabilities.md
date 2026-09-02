# 010 — Layer 1: advertise `api_types` + `capabilities` on the raw `/v1/models` list

Branch: `codex/cursor-local-models-schema` (base: `origin/dev` at `85f7ef92a`, created with
`git switch -c codex/cursor-local-models-schema origin/dev`).
PR 1 of the stack, targets `dev`. Thesis: one additive schema change on the OpenAI-shape
model list so Cursor's local-agent runtime detects extended capabilities.

## File change map

| Path | Action | Why |
|---|---|---|
| `src/server/models-capabilities.ts` | NEW | Pure helper: build the `api_types` + `capabilities` fields from catalog data. Keeps `index.ts` from growing another inline lambda. |
| `src/server/index.ts` | MODIFY | Spread the helper's output into `nativeModelRow` and the routed-row object in the raw-list branch. |
| `tests/cursor-local-models-schema.test.ts` | NEW | Regression test: server start, GET `/v1/models`, assert schema on a native row and a routed row; assert Grok fields unchanged; assert `OPENCODEX_MODEL_API_TYPES` keeps an OpenAI-family member (load-bearing: Cursor routes to the Messages wire only when NO OpenAI-family type is present). |
| `tests/server-combo-failover-e2e.test.ts` | MODIFY | Six `toEqual` row literals at :824-846 become `toMatchObject`; keep `is_combo` absence explicit (`expect(row.is_combo).toBeUndefined()`) so the combo-off path stays verified. |

Scope OUT: the Codex-catalog `{ models: [...] }` branch, Claude gateway branch, GUI, docs (020).

## `src/server/models-capabilities.ts` (NEW)

```ts
/**
 * Extended capability advertisement for the OpenAI-shape `GET /v1/models` list.
 *
 * Cursor's local-agent runtime (the "Private Inference" build) only enables its reasoning
 * effort control when at least one row in `data[]` carries `api_types` (a non-empty array
 * naming an API family it can speak) and, optionally, a `capabilities` object. Plain OpenAI
 * clients ignore both keys. Every OpenCodex route serves chat completions, Responses and
 * Anthropic Messages, streams, and accepts tool calls, so those are constants; context and
 * vision come from catalog data when known and are omitted otherwise.
 */
// Membership is load-bearing for Cursor: its selector picks the Anthropic Messages wire only
// when NO OpenAI-family type (chat_completions/responses/openai_chat/openai_responses) is
// present. Keep at least one OpenAI-family entry. Guarded by a unit test.
export const OPENCODEX_MODEL_API_TYPES = ["chat_completions", "responses", "anthropic_messages"] as const;

export interface ModelCapabilityInput {
  reasoningEfforts?: readonly string[];
  contextWindow?: number;
  inputModalities?: readonly string[];
}

export interface ModelCapabilityFields {
  api_types: readonly string[];
  capabilities: {
    context_length?: number;
    supports_tool_use: true;
    supports_streaming: true;
    supports_reasoning: boolean;
    supports_vision?: boolean;
    reasoning_effort?: string[];
  };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function modelCapabilityFields(input: ModelCapabilityInput): ModelCapabilityFields {
  const efforts = (input.reasoningEfforts ?? []).filter(e => typeof e === "string" && e.length > 0);
  const contextLength = positiveInt(input.contextWindow);
  const modalities = input.inputModalities;
  const supportsVision = Array.isArray(modalities) ? modalities.includes("image") : undefined;
  return {
    api_types: OPENCODEX_MODEL_API_TYPES,
    capabilities: {
      ...(contextLength !== undefined ? { context_length: contextLength } : {}),
      supports_tool_use: true,
      supports_streaming: true,
      supports_reasoning: efforts.length > 0,
      ...(supportsVision !== undefined ? { supports_vision: supportsVision } : {}),
      ...(efforts.length > 0 ? { reasoning_effort: [...efforts] } : {}),
    },
  };
}
```

## `src/server/index.ts` (MODIFY, raw-list branch ~L1481-1553)

Before:

```ts
        const nativeModelRow = (id: string, metadataId = id) => ({
            id,
            object: "model",
            created: 0,
            owned_by: "openai",
            ...grokEffortFields(
              nativeReasoningEfforts(metadataId),
              nativeDefaultReasoningEffort(metadataId),
            ),
          });
```

After:

```ts
        // modelCapabilityFields is a static import at the top of index.ts (pure helper, no
        // startup side effects). nativeOpenAiContextWindow / nativeInputModalities join the
        // existing catalog destructuring at ~L1347.
        const nativeLimits = nativeContextLimits(config);
        const nativeModelRow = (id: string, metadataId = id) => ({
            id,
            object: "model",
            created: 0,
            owned_by: "openai",
            ...grokEffortFields(
              nativeReasoningEfforts(metadataId),
              nativeDefaultReasoningEffort(metadataId),
            ),
            // Cursor local-agent discovery (Private Inference build) reads api_types +
            // capabilities; other OpenAI clients ignore them. See src/server/models-capabilities.ts.
            ...modelCapabilityFields({
              reasoningEfforts: nativeReasoningEfforts(metadataId),
              contextWindow: nativeOpenAiContextWindow(metadataId, nativeLimits),
              inputModalities: nativeInputModalities(metadataId),
            }),
          });
```

`nativeOpenAiContextWindow` and `nativeInputModalities` are added to the existing `await import("../codex/catalog")`
destructuring at the top of the branch (both re-exported by `src/codex/catalog.ts:5`, verified). Native modalities come from the pinned upstream entry via `nativeInputModalities` (metadata.ts).

Routed row, before:

```ts
              ...(effective ? { alias_of: `${provider?.alias || m.provider}/${effective.alias}` } : {}),
              ...grokEffortFields(m.reasoningEfforts ?? [], m.defaultReasoningEffort),
            };
```

After:

```ts
              ...(effective ? { alias_of: `${provider?.alias || m.provider}/${effective.alias}` } : {}),
              ...grokEffortFields(m.reasoningEfforts ?? [], m.defaultReasoningEffort),
              ...modelCapabilityFields({
                reasoningEfforts: m.reasoningEfforts,
                contextWindow: m.contextCap ?? m.contextWindow,
                inputModalities: m.inputModalities,
              }),
            };
```

`contextCap` wins over `contextWindow` because it is the operator-narrowed effective limit
(`CatalogModel.contextCap`, `parsing.ts:117`).

## `tests/cursor-local-models-schema.test.ts` (NEW)

Modelled on `tests/grok-models-effort-list.test.ts` (same fixture: `kimi` provider with
`liveModels: false`, seeded native entitlements, `OPENCODEX_HOME` tmp dir, `SERVER_BUDGET_MS`).

Assertions:

1. Routed row `kimi/k3` (config: `modelReasoningEfforts.k3 = ["low","high","max"]`,
   `modelContextWindows.k3 = 200000`, `modelInputModalities.k3 = ["text","image"]`):
   - `api_types` equals `["chat_completions","responses","anthropic_messages"]`
   - `capabilities` equals `{ context_length: 200000, supports_tool_use: true, supports_streaming: true, supports_reasoning: true, supports_vision: true, reasoning_effort: ["low","high","max"] }`
   - Grok fields still present and unchanged: `supports_reasoning_effort === true`,
     `reasoning_efforts[1].default === true`.
2. Routed row `kimi/kimi-for-coding` (no efforts): `capabilities.supports_reasoning === false`,
   no `reasoning_effort` key.
3. Native row `gpt-5.6-sol`: `api_types` present; `capabilities.reasoning_effort` equals
   `nativeReasoningEfforts("gpt-5.6-sol")`; `capabilities.context_length` is a positive number.
4. Unit test of `modelCapabilityFields` directly: empty input yields
   `{ api_types, capabilities: { supports_tool_use: true, supports_streaming: true, supports_reasoning: false } }` with no
   `context_length`/`supports_vision`/`reasoning_effort` keys (activation scenario for the
   omit branches, C-ACTIVATION-GROUNDING-01).

Config keys confirmed on `OcxProviderConfig` in `src/types/provider.ts`: `modelContextWindows`
(:362), `modelInputModalities` (:364), `modelReasoningEfforts` (:440),
`modelDefaultReasoningEfforts` (:442). No fallback needed.

## Accept criteria

- `bun run typecheck` exit 0.
- Focused set covering every raw-list consumer (audit blocker 2): `bun test tests/cursor-local-models-schema.test.ts tests/grok-models-effort-list.test.ts tests/server-combo-failover-e2e.test.ts tests/claude-models-discovery.test.ts tests/server-auth.test.ts tests/ollama-native.test.ts tests/provider-outbound.test.ts tests/codex-catalog.test.ts tests/gui-management-session.test.ts` exit 0. The full suite stays forbidden; exact-head CI is the gate.
- Restarted local proxy: `curl -s http://127.0.0.1:10100/v1/models | jq '.data[] | select(.id=="gpt-5.6-sol") | {api_types, capabilities}'` shows both keys.
- Live: Cursor Private Inference → Settings → Models → "Refresh model list" → composer
  model row for `gpt-5.6-sol` shows a Reasoning control with low/medium/high/xhigh.
  Screenshot saved as `devlog/_plan/260902_cursor_local_models_schema/011_effort_control.png`.
- Live: send a turn with effort `high`; `ocx observe logs --json` last `gpt-5.6-sol` row
  shows the effort (field name to record at C — the log has `requestedEffort`/`reasoningEffort`
  or similar; if the log does not carry it, capture via `ocx debug provider on` request dump).

## Bypass / enforcement (PLAN-BYPASS-NAMED-01)

Not an enforcement change; no gate added. n/a.

## Field chain (PLAN-FIELD-CHAIN-01)

New output keys only (`api_types`, `capabilities`). Creation: helper. Serialization:
`jsonResponse`. Deserialization: none server-side (`N/A` — inbound consumers are external
clients). Consumers: Cursor local runtime (target), Grok Build (ignores), Codex (uses the other
branch), Claude gateway (other branch), GUI API-keys page (`gui/src/pages/ApiKeys.tsx:170`) reads this list and only displays ids — additive keys are ignored.
