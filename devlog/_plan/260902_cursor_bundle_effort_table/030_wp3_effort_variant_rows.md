# 030 — wp3: opt-in effort-variant rows for table-less models

Depends on: 010 (wp1 resolver `predictCursorEffort`; "table-less" = `ladder === null` from the
bundle table, falling back to `cursorEffortFamily(id) === null`), 020 (row shape). Own PR.

Loop-spec: spec-satisfaction; trigger = fable/kimi/qwen rows render no Reasoning control in
Cursor and no gateway field can add one (000); goal = with `cursorEffortRows: true` the picker
lists `<id>--<effort>` rows that route to the base model with that effort; non-goals = any change
when the flag is off (byte-identical list), rows for models Cursor already renders; verifier =
`bun test tests/cursor-effort-rows.test.ts tests/cursor-local-models-schema.test.ts tests/cursor-integration-status.test.ts`
+ typecheck; stop = green + exact-head CI. Grammar decision: `--<effort>` (evidence below);
NEEDS_HUMAN condition from the goal (ambiguity) is NOT triggered.

Design produced by a sol/high research lane on 2026-09-02 (read-only, no files changed), folded
verbatim below. Amendments made at P of the wp3 cycle: (a) "table-less" must consult
`predictCursorEffort(id, table).ladder === null` once wp1 has landed, with `cursorEffortFamily`
as the static fallback, so the projection follows the installed bundle; (b) exact known full
model ids take precedence over the synthetic grammar (open question 1 → yes).

Amendment (c), audit blocker 1 (005): on `/v1/messages` reuse the existing `effortOverride`
slot (`claude-messages.ts:603/649`, written as `output_config.effort` before translation and
already respected by `anthropicToResponsesTranslation`) instead of injecting the internal
Responses `reasoning.effort`: `effortOverride = effortRow?.effort ?? extractOcxEffortDirective(...)`.
The `none` rung the lane worried about is never published as a row (Cursor's own ladders have
no `none`; filter it from the row set), so the translator's exclusion of `none` is moot.
Amendment (d): `tableLess` in the status route uses `predictCursorEffort(id, table, supportsReasoning).ladder === null`
(wp1 landed the `supportsReasoning` parameter).

---

No files were modified. The untracked `devlog/_plan/260902_cursor_bundle_effort_table/` appeared concurrently and was left untouched. No tests were run.

## Recommendation

Use `<base-id>--<effort>`.

Evidence:

- `@` is stripped by Cursor’s matcher and already appears in Codex account-selector values ([models-capabilities.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/server/models-capabilities.ts:45), [config.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/types/config.ts:681)).
- `:` is already a family separator in `modelRecordValue()` and is common in real model tags ([reasoning-effort.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/reasoning-effort.ts:115)).
- Single `-<effort>` collides with ordinary IDs such as `gpt-5.1-codex-max` and Cursor’s own effort suffixes.
- `--` has no routing/catalog semantics today. `routedSlug()` preserves hyphens while only encoding inner slashes ([slug-codec.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/providers/slug-codec.ts:24)).

Enabling the feature should explicitly reserve terminal `--(none|minimal|low|medium|high|xhigh|max|ultra)` for synthetic rows. The parser must only activate when the flag is exactly `true` and the base is table-less.

## Diff-level design

### 1. Configuration contract

[src/types/config.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/types/config.ts:366)

Before:

```ts
defaultModelAliases?: boolean;
```

After:

```ts
defaultModelAliases?: boolean;
/**
 * Opt-in Cursor Private Inference compatibility rows. When true, `/v1/models`
 * adds `<base-id>--<effort>` selectors for reasoning-capable model ids absent
 * from Cursor's built-in effort table. Omitted/false preserves discovery output.
 */
cursorEffortRows?: boolean;
```

[src/config.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/config.ts:1046)

Before:

```ts
defaultProvider: z.string().min(1).default("openai"),
defaultModelAliases: z.boolean().optional(),
```

After:

```ts
defaultProvider: z.string().min(1).default("openai"),
defaultModelAliases: z.boolean().optional(),
// Malformed hand edits disable this opt-in projection without rejecting providers.
cursorEffortRows: z.boolean().optional().catch(false),
```

### 2. Single grammar owner

Create `src/server/effort-row.ts`:

```ts
import {
  canonicalizeReasoningEfforts,
  isDeclaredReasoningEffort,
} from "../reasoning-effort";
import type { OcxConfig } from "../types";
import { cursorEffortFamily } from "./models-capabilities";

const EFFORT_ROW_SEPARATOR = "--";

export interface ParsedEffortRowId {
  baseId: string;
  effort: string;
}

export function effortRowId(baseId: string, effort: string): string {
  return `${baseId}${EFFORT_ROW_SEPARATOR}${effort}`;
}

export function parseEffortRowId(
  id: string,
  config: Pick<OcxConfig, "cursorEffortRows">,
): ParsedEffortRowId | null {
  if (config.cursorEffortRows !== true) return null;

  const separator = id.lastIndexOf(EFFORT_ROW_SEPARATOR);
  if (separator <= 0) return null;

  const baseId = id.slice(0, separator);
  const effort = id.slice(separator + EFFORT_ROW_SEPARATOR.length);
  if (!isDeclaredReasoningEffort(effort)) return null;

  // Cursor-table models retain Cursor's native control and never gain variants.
  if (cursorEffortFamily(baseId) !== null) return null;
  return { baseId, effort };
}

export function expandCursorEffortRow<T extends { id: string }>(
  row: T,
  efforts: readonly string[] | undefined,
  config: Pick<OcxConfig, "cursorEffortRows">,
): T[] {
  if (config.cursorEffortRows !== true || cursorEffortFamily(row.id) !== null) {
    return [row];
  }

  const supported = canonicalizeReasoningEfforts(
    (efforts ?? []).filter(isDeclaredReasoningEffort),
  );
  return [
    row,
    ...supported.map(effort => ({ ...row, id: effortRowId(row.id, effort) })),
  ];
}
```

Cloning the complete base row and changing only `id` preserves `api_types`, `capabilities`, modalities, context fields, `long_context_threshold_tokens`, `pricing.overrides`, and `cost.long_context` without reconstructing Cursor’s validated schema.

### 3. `/v1/models` expansion

[src/server/index.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/server/index.ts:1511)

Import `expandCursorEffortRow`. Refactor each row site to pass the same ladder already used by `modelCapabilityFields()`.

Before:

```ts
const data = [
  ...visibleNatives.map(id => nativeModelRow(id)),
  ...visibleAccountNatives.map(({ id, metadataId }) => nativeModelRow(id, metadataId)),
  ...await Promise.all(uniqueCatalogModelsForRawPublicList(goOrdered).map(async m => {
    // ...
    return { id: publicId, /* complete row */ };
  })),
];
```

After:

```ts
const routedRows = await Promise.all(
  uniqueCatalogModelsForRawPublicList(goOrdered).map(async m => {
    // Existing publicId/provider/alias calculation remains unchanged.
    const row = { id: publicId, /* existing complete row, unchanged */ };
    return expandCursorEffortRow(row, m.reasoningEfforts, config);
  }),
);

const data = [
  ...visibleNatives.flatMap(id =>
    expandCursorEffortRow(
      nativeModelRow(id),
      nativeReasoningEfforts(id),
      config,
    )
  ),
  ...visibleAccountNatives.flatMap(({ id, metadataId }) =>
    expandCursorEffortRow(
      nativeModelRow(id, metadataId),
      nativeReasoningEfforts(metadataId),
      config,
    )
  ),
  ...routedRows.flat(),
];
```

When omitted/false, `expandCursorEffortRow()` returns the original row only, preserving order and serialized bytes.

Do not modify `routeModel()`, `routeConcreteModel()`, `knownModelIdsForProvider()`, `routedSlug()`, or alias resolution. Synthetic IDs are removed before those parsers run.

### 4. Responses inbound

[src/server/responses/core.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/server/responses/core.ts:2750)

Immediately after `parseRequest(body)`, before logging, shadow interception, or `routeModel()`:

```ts
parsed = parseRequest(body);
const effortRow = parseEffortRowId(parsed.modelId, config);
if (effortRow) {
  parsed.modelId = effortRow.baseId;
  parsed.options.reasoning = effortRow.effort;

  const raw = parsed._rawBody as Record<string, unknown>;
  raw.model = effortRow.baseId;
  raw.reasoning = {
    ...(isRec(raw.reasoning) ? raw.reasoning : {}),
    effort: effortRow.effort,
  };
}
```

The row effort intentionally overrides any contradictory body effort: selecting the row is the user’s effort choice.

Writing both `parsed.options.reasoning` and `_rawBody.reasoning.effort` follows the existing dual-shape contract used by `applyEffortCap()` and `nativeEffortClamp()` ([effort-policy.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/server/effort-policy.ts:159), [core.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/server/responses/core.ts:2140)).

### 5. Chat Completions inbound

Modify [src/server/chat-completions.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/server/chat-completions.ts:89), not `chat-native.ts`.

Before routing:

```ts
const requestedModel = chatBody.model as string;
```

After:

```ts
const requestedModel = chatBody.model as string;
const effortRow = parseEffortRowId(requestedModel, config);
if (effortRow) chatBody.model = effortRow.baseId;
```

After `chatCompletionsToResponsesBody(chatBody)`:

```ts
if (effortRow) {
  internalBody.reasoning = {
    ...(isRec(internalBody.reasoning) ? internalBody.reasoning : {}),
    effort: effortRow.effort,
  };
}
```

Prevent only synthetic-row requests from taking the native-chat shortcut:

```ts
if (!effortRow && isNativeChatRouteEligible(route, chatBody)) {
  chatNativeRoute = route;
}
```

This is necessary because [chat-native.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/server/chat-native.ts:120) sends directly and does not enter the Responses choke point where the existing cap/clamp runs. Ordinary Chat requests remain unchanged.

Keep `requestedModel` as the original synthetic ID so Chat response-model echoing remains stable.

### 6. Anthropic Messages inbound

[src/server/claude-messages.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/server/claude-messages.ts:605)

Resolve after `ocx-route` extraction, but before native passthrough and before translation:

```ts
let effortRow: ParsedEffortRowId | null = null;
let requestedModel = "";

if (isRec(anthropicBody) && typeof anthropicBody.model === "string") {
  requestedModel = anthropicBody.model;
  effortRow = parseEffortRowId(requestedModel, config);
  if (effortRow) anthropicBody.model = effortRow.baseId;
}
```

Change native passthrough:

```ts
if (
  !effortRow
  && isRec(anthropicBody)
  && wantsNativePassthrough(req, config, requestPolicy, anthropicBody.model)
) {
  return await anthropicNativePassthrough(/* unchanged arguments */);
}
```

After `anthropicToResponsesTranslation()`:

```ts
internalBody = translation.body;
if (effortRow) {
  internalBody.reasoning = {
    ...(isRec(internalBody.reasoning) ? internalBody.reasoning : {}),
    effort: effortRow.effort,
  };
}
```

Do not inject through `output_config.effort`: the current Claude translator excludes `none`, while OpenCodex ladders may legitimately publish it. Directly injecting the internal Responses shape supports every declared effort and still reaches the existing cap/clamp.

Use the preserved `requestedModel` for Anthropic response conversion.

### 7. Cursor status projection

[src/server/management/cursor-integration-routes.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/server/management/cursor-integration-routes.ts:23)

Extend each model:

```ts
{
  id: string;
  reasoning: string[] | null;
  tableLess: boolean;
  effortRows: string[];
  context: { defaultWindow: number; longWindow: number } | null;
}
```

Projection:

```ts
const family = cursorEffortFamily(id);
return {
  id,
  reasoning: family,
  tableLess: family === null,
  effortRows: config.cursorEffortRows === true && family === null
    ? canonicalizeReasoningEfforts(reasoningEfforts)
        .map(effort => effortRowId(id, effort))
    : [],
  context: tier ? { defaultWindow: tier.defaultWindow, longWindow: tier.longWindow } : null,
};
```

Thus “table-less” has one owner: `cursorEffortFamily(id) === null`. Do not duplicate Cursor’s regex in management or GUI code.

Mirror the fields in [gui/src/pages/integrations/cursor-api.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/gui/src/pages/integrations/cursor-api.ts:12). Rendering can remain a later lane; the status contract is sufficient for the GUI to distinguish native controls from variant rows.

Update existing exact-object assertions in `tests/cursor-integration-status.test.ts` with `tableLess` and `effortRows`.

### 8. Documentation

Update:

- `docs-site/src/content/docs/reference/configuration/providers.md`: add `cursorEffortRows?: boolean`, default off, grammar, and reservation warning.
- `docs-site/src/content/docs/guides/cursor-private-inference.md`: replace “set a provider default” as the sole workaround with the opt-in variant-row workflow and examples:
  - `anthropic/claude-fable-5-1--high`
  - `cursor/kimi-k3--max`
- State that existing table-matched IDs receive no variants and that refresh/restart may be required because Cursor caches `/models`.

## Tests

Create `tests/cursor-effort-rows.test.ts` with these exact cases:

1. `parseEffortRowId enables only the --<effort> grammar behind cursorEffortRows`
   - Off/omitted returns `null`.
   - `@high`, `:high`, and `-high` return `null`.
   - Invalid/empty suffixes return `null`.
   - `kimi/k3--high` resolves to `{ baseId: "kimi/k3", effort: "high" }`.

2. `Cursor-table model ids never become effort rows`
   - `anthropic/claude-opus-5--high` and `gpt-5.6-sol--high` return `null`.

3. `cursorEffortRows false is byte-identical to an omitted flag`
   - Compare raw `/v1/models` response text for otherwise identical configs.

4. `raw model discovery clones one complete row per supported effort only for table-less ids`
   - Fable/Kimi get one row per exact ladder member.
   - GPT-5.6/Opus do not.
   - Strip only `id` and assert every variant’s remaining object deeply equals its base row.

5. `Responses effort rows route the base model and pass through the existing cap`
   - Request `...--max` with child marker and `subagentEffortCap: "high"`.
   - Captured upstream body contains base model and `reasoning.effort: "high"`.

6. `Chat effort rows use Responses normalization instead of the native-chat shortcut`
   - OpenAI-chat provider; `...--max` plus child cap.
   - Captured upstream Chat body has base model and capped `reasoning_effort`.

7. `Messages effort rows resolve after route directives and before native passthrough`
   - Assert translated upstream request uses the base model and chosen/capped effort.
   - Include a `none` row to prove translation does not depend on `output_config`.

8. `Cursor integration status marks table-less bases and reports generated row ids`
   - Fable/Kimi: `tableLess: true`, populated `effortRows` when enabled.
   - Opus/GPT: `tableLess: false`, empty `effortRows`.

Focused verification:

```bash
bun test tests/cursor-effort-rows.test.ts
bun test tests/cursor-local-models-schema.test.ts
bun test tests/cursor-integration-status.test.ts
bun run typecheck
```

Do not run the repository-wide suite in this lane.

## RISKS

- `--` is not globally forbidden in upstream model IDs. Enabling the flag reserves a terminal `--<declared-effort>` suffix; document this. A later hardening can give exact known full model IDs precedence over synthetic parsing.
- Combo/policy aliases can be table-less. Their generated effort must continue through normal combo/policy target selection; never resolve a concrete target inside `effort-row.ts`.
- Chat native and Anthropic native passthrough bypass the shared cap/clamp. Synthetic rows must force the existing Responses replay path as specified.
- Mutating only the parsed effort or only the raw body creates adapter-dependent behavior. Both representations are mandatory on direct Responses requests.
- Cursor caches model discovery by Base URL, so correct server behavior may not appear until refresh/restart.

## OPEN QUESTIONS

- Should an exact real model ID ending in `--high` always beat the synthetic grammar, even after `cursorEffortRows` is enabled? Recommended: yes, once an exact-known-ID check can cover static, live, custom, combo, policy, and alias rows consistently.
- Should the dashboard merely report `effortRows`, or render them inline under each table-less base? This lane recommends the API contract now and leaves presentation to the UI/UX lane.
- Should synthetic rows be added for table-less aliases of otherwise table-matched models? Recommended: yes—the matcher sees the public ID, so an alias such as `opus` genuinely has no Cursor control.

