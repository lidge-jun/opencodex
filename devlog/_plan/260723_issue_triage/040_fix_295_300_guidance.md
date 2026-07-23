# 040 — Fix issue #295: accurate multi-agent guidance roster

Date: 2026-07-23 (Asia/Seoul)
Scope: issue #295 only
Implementation file count: **14 MODIFY, 0 NEW**
Automated regression count: **9 affected cases (5 targeted regressions + 4 existing-case adaptations)**

## 1. Acceptance contract

1. Built-in v2 guidance contains none of `hidden`, `not in the schema`, or `never claim`.
2. Every model named by the built-in preferred-model sentence or roster occurs in Codex's picker-visible, v2-compatible, priority-sorted first five for the active catalog.
3. Roster derivation uses canonical catalog slugs and does not mutate `subagentModels`.
4. Configured entries excluded because they are missing, picker-hidden, v2-incompatible, or displaced beyond five are emitted to the existing injection debug log with a reason.
5. A custom `injectionPrompt` remains user-owned. `{{model}}` keeps the configured raw value and `{{roster}}` receives the effective canonical roster.
6. v1 behavior, surface selection, catalog generation, routing, effort caps, and the 700-character built-in budget remain unchanged.

## 2. Dependency-ordered file map

| Order | Action | Current anchor | Path | Exact change |
|---:|---|---|---|---|
| 1 | MODIFY | `:332-357`, `:386-387`, `:435-459`, `:1091-1095` | `src/codex/catalog.ts` | Add the catalog-owned effective roster/candidate derivation and exclusion reason types; keep `catalogModelEfforts()` for existing consumers. |
| 2 | MODIFY | `:178-228`, `:241-269`, `:897-910` | `src/server/responses.ts` | Replace stale schema comments and default copy; format the effective roster; suppress an ineligible built-in preferred model; log exclusions through the existing injection debug channel. |
| 3 | MODIFY | `:29-37`, `:84-254`, `:305-322` | `tests/multi-agent-compat.test.ts` | Extend catalog fixtures; implement five targeted regressions and four literal adaptations to retained cases. |
| 4 | MODIFY | `:237` | `README.md` | Replace the raw configured-roster claim with the effective v2 roster contract and neutral schema wording. |
| 5 | MODIFY | `:36` | `docs-site/src/content/docs/guides/sub-agent-surface.md` | Replace the hidden-argument claim and document effective candidate filtering. |
| 6 | MODIFY | `:36` | `docs-site/src/content/docs/ja/guides/sub-agent-surface.md` | Apply the same guide correction in Japanese. |
| 7 | MODIFY | `:36` | `docs-site/src/content/docs/ko/guides/sub-agent-surface.md` | Apply the same guide correction in Korean. |
| 8 | MODIFY | `:36` | `docs-site/src/content/docs/ru/guides/sub-agent-surface.md` | Apply the same guide correction in Russian. |
| 9 | MODIFY | `:36` | `docs-site/src/content/docs/zh-cn/guides/sub-agent-surface.md` | Apply the same guide correction in Chinese. |
| 10 | MODIFY | `:35` | `docs-site/src/content/docs/reference/configuration.md` | Define `subagentModels` as configured intent whose guidance roster is the effective first-five intersection. |
| 11 | MODIFY | `:33` | `docs-site/src/content/docs/ja/reference/configuration.md` | Apply the same reference correction in Japanese. |
| 12 | MODIFY | `:34` | `docs-site/src/content/docs/ko/reference/configuration.md` | Apply the same reference correction in Korean. |
| 13 | MODIFY | `:38` | `docs-site/src/content/docs/ru/reference/configuration.md` | Apply the same reference correction in Russian. |
| 14 | MODIFY | `:32` | `docs-site/src/content/docs/zh-cn/reference/configuration.md` | Apply the same reference correction in Chinese. |

## 3. `src/codex/catalog.ts` diff

### Current anchor

`catalogModelEfforts()` at `src/codex/catalog.ts:339-356` answers only “does this slug have effort metadata?” It does not apply `visibility`, `multi_agent_version`, priority, or the five-item cap documented at `:1091-1095`.

### After

Add directly after `catalogModelEfforts()`:

```ts
export const MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5;

export type SpawnAgentSurface = "v1" | "v2";
export type SubagentRosterExclusionReason =
  | "missing_catalog_entry"
  | "picker_hidden"
  | "surface_incompatible"
  | "outside_display_limit";

export interface EffectiveSubagentModel {
  model: string;
  efforts: string[];
}

export interface SubagentRosterExclusion {
  configured: string;
  reason: SubagentRosterExclusionReason;
  catalogModel?: string;
}

export interface EffectiveSubagentRoster {
  candidates: EffectiveSubagentModel[];
  advertised: EffectiveSubagentModel[];
  excluded: SubagentRosterExclusion[];
}

function catalogEntryEfforts(entry: RawEntry): string[] {
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  return levels.flatMap(level => typeof level.effort === "string" ? [level.effort] : []);
}

function configuredCatalogEntry(entries: RawEntry[], configured: string): RawEntry | undefined {
  return entries.find(entry => entry.slug === configured)
    ?? entries.find(entry => typeof entry.slug === "string" && slugsEquivalent(configured, entry.slug));
}

export function effectiveSubagentRoster(
  configuredModels: readonly string[],
  surface: SpawnAgentSurface,
): EffectiveSubagentRoster {
  const configured = configuredModels
    .filter(model => model.trim().length > 0)
    .filter((model, index, all) =>
      !all.slice(0, index).some(previous => slugsEquivalent(previous, model))
    );
  const entries = readCatalog(readCodexCatalogPath())?.models ?? [];
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => typeof entry.slug === "string")
    .filter(({ entry }) => entry.visibility === "list")
    .filter(({ entry }) => surface !== "v2" || entry.multi_agent_version === "v2")
    .sort((left, right) => {
      const leftPriority = typeof left.entry.priority === "number" && Number.isFinite(left.entry.priority)
        ? left.entry.priority : Number.MAX_SAFE_INTEGER;
      const rightPriority = typeof right.entry.priority === "number" && Number.isFinite(right.entry.priority)
        ? right.entry.priority : Number.MAX_SAFE_INTEGER;
      return leftPriority - rightPriority || left.index - right.index;
    })
    .slice(0, MAX_SPAWN_AGENT_MODEL_OVERRIDES);

  const candidates = ordered.map(({ entry }) => ({
    model: entry.slug as string,
    efforts: catalogEntryEfforts(entry),
  }));
  const advertised = candidates.filter(candidate =>
    configured.some(model => slugsEquivalent(model, candidate.model))
  );
  const excluded = configured.flatMap((model): SubagentRosterExclusion[] => {
    const entry = configuredCatalogEntry(entries, model);
    if (!entry) return [{ configured: model, reason: "missing_catalog_entry" }];
    const catalogModel = entry.slug as string;
    if (entry.visibility !== "list") {
      return [{ configured: model, catalogModel, reason: "picker_hidden" }];
    }
    if (surface === "v2" && entry.multi_agent_version !== "v2") {
      return [{ configured: model, catalogModel, reason: "surface_incompatible" }];
    }
    if (!candidates.some(candidate => candidate.model === catalogModel)) {
      return [{ configured: model, catalogModel, reason: "outside_display_limit" }];
    }
    return [];
  });
  return { candidates, advertised, excluded };
}
```

Rules fixed by this code:

- `visibility === "list"` is the catalog representation of picker visibility.
- v2 requires explicit `multi_agent_version === "v2"`; v1 has no version predicate.
- Sort priority ascending, preserve catalog order for ties, then cap before intersecting configured ids.
- Return canonical `entry.slug`; legacy raw aliases are matching inputs only.
- Do not exclude a valid model merely because its effort list is empty; the formatter omits that annotation.
- `outside_display_limit` describes Codex's displayed five-model set, not exact-name runtime rejection outside that set.

## 4. `src/server/responses.ts` diff

### 4.1 Comments and default wording

Current `:186-192`:

```ts
 * The published spawn_agent schema HIDES model/reasoning_effort by
 * default ... so the prompt tells the model to pass the
 * arguments even though the schema does not list them.
```

After:

```ts
 * Current Codex surfaces can expose model/reasoning_effort overrides directly or
 * omit them. The proxy wording therefore stays schema-agnostic and advertises only
 * the effective candidates described for this collaboration surface.
```

Current `:214-217`:

```ts
let text = "spawn_agent also accepts hidden \"model\" and \"reasoning_effort\" string arguments "
  + "(not in the schema, but parsed and applied) — never claim sub-agent models cannot be selected. "
  + "When setting either, set fork_turns to \"none\" (or e.g. \"3\"; full-history forks reject overrides) "
  + "and make the message self-contained.";
```

After:

```ts
let text = "When the active spawn_agent tool supports optional \"model\" or \"reasoning_effort\" overrides, "
  + "use only models listed for this collaboration surface. "
  + "When setting either override, set fork_turns to \"none\" "
  + "(or a positive turn count such as \"3\"; full-history forks reject overrides) "
  + "and make the task message self-contained.";
```

### 4.2 Roster, preferred model, and diagnostics

Current `:209-223` derives a string from `catalogModelEfforts()` and always emits the raw `injectionModel`.

After, preserve the public positional function signature for this issue and replace only the v2 body setup:

```ts
const configuredForGuidance = [
  ...(subagentModels ?? []),
  ...(injectionModel ? [injectionModel] : []),
];
const { effectiveSubagentRoster } = await import("../codex/catalog");
const effective = effectiveSubagentRoster(configuredForGuidance, "v2");
const rosterModels = effective.advertised.filter(candidate =>
  (subagentModels ?? []).some(model => slugsEquivalent(model, candidate.model))
);
const roster = subagentRosterText(rosterModels);
const preferred = injectionModel
  ? effective.candidates.find(candidate => slugsEquivalent(injectionModel, candidate.model))
  : undefined;

if (isInjectionDebugEnabled() && effective.excluded.length > 0) {
  injectionDebugLog(`[opencodex] multi-agent guidance excluded: ${effective.excluded
    .map(item => `${item.configured}:${item.reason}`)
    .join(", ")}`);
}
if (!injectionModel && roster === "") return null;
if (injectionPrompt) {
  return `<multi_agent_mode>${applyInjectionPlaceholders(
    injectionPrompt, injectionModel, injectionEffort, roster,
  )}</multi_agent_mode>`;
}
if (!preferred && roster === "") return null;

// Build neutral text above.
if (preferred) {
  text += ` Preferred sub-agent: model "${preferred.model}"`
    + (injectionEffort ? `, reasoning_effort "${injectionEffort}"` : "")
    + " — use it unless the user names another.";
}
text += roster;
```

Add the existing import owner at the top-level import from `../providers/slug-codec` if `slugsEquivalent` is not already imported. Verify the export before editing.

Replace current `subagentRosterText(subagentModels?: string[])` at `:254-269` with a synchronous formatter:

```ts
function subagentRosterText(models: Array<{ model: string; efforts: string[] }>): string {
  if (models.length === 0) return "";
  const ladders = new Set(models.map(model => model.efforts.join("/")));
  if (!ladders.has("") && ladders.size === 1) {
    return ` Available models (reasoning_effort ${[...ladders][0]}): ${models
      .map(model => `"${model.model}"`)
      .join(", ")}.`;
  }
  const entries = models.map(model => model.efforts.length > 0
    ? `"${model.model}" (${model.efforts.join("/")})`
    : `"${model.model}"`);
  return ` Available models (valid reasoning_effort): ${entries.join(", ")}.`;
}
```

Custom prompts intentionally retain raw `{{model}}` behavior; only built-in preferred-model copy is constrained to the effective candidates. The existing roster-first budget removal at `:224-227` remains unchanged.

## 5. `tests/multi-agent-compat.test.ts` executable diff — 9 affected cases

### 5.1 Imports and cleanup

Current imports at `:6-12` have no catalog/debug test harness. Add:

```ts
import { effectiveSubagentRoster } from "../src/codex/catalog";
import { clearDebugSettings, setDebugSettings } from "../src/lib/debug-settings";
import {
  getInjectionDebugLogEntries,
  resetInjectionDebugLogBufferForTests,
} from "../src/lib/injection-debug-log";
```

Extend the current `afterEach()` at `:16-19`:

```ts
afterEach(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  clearDebugSettings();
  resetInjectionDebugLogBufferForTests();
});
```

### 5.2 Replace `catalogFixture()` at `:29-38`

```ts
type CatalogFixtureModel = {
  slug: string;
  efforts?: string[];
  visibility?: "list" | "hide";
  priority?: number;
  multiAgentVersion?: "v1" | "v2" | null;
};

/** Write an injected-catalog fixture into the active CODEX_HOME. */
function catalogFixture(dir: string, models: CatalogFixtureModel[]): void {
  writeFileSync(join(dir, "opencodex-catalog.json"), JSON.stringify({
    models: models.map((model, index) => ({
      slug: model.slug,
      display_name: model.slug,
      visibility: model.visibility ?? "list",
      priority: model.priority ?? index,
      multi_agent_version: model.multiAgentVersion === undefined ? "v2" : model.multiAgentVersion,
      supported_reasoning_levels: (model.efforts ?? [])
        .map(effort => ({ effort, description: effort })),
    })),
  }));
}
```

### 5.3 Replace the current wording test at `:84-99`

```ts
test("v2 built-in guidance is schema-agnostic and keeps fork rules", async () => {
  const dir = codexHomeFixture(V2_ON);
  catalogFixture(dir, [{
    slug: "anthropic/claude-sonnet-5",
    efforts: ["low", "medium", "high", "xhigh"],
  }]);

  const text = await multiAgentGuidanceText(
    parsedFixture({ reasoning: "medium", tools: [{ name: "spawn_agent" }] }),
    "anthropic/claude-sonnet-5",
  );

  expect(text).toContain("When the active spawn_agent tool supports optional");
  expect(text).toContain("use only models listed for this collaboration surface");
  expect(text).toContain("fork_turns");
  expect(text).toContain('"none"');
  expect(text).not.toMatch(/hidden/i);
  expect(text).not.toMatch(/not in the schema/i);
  expect(text).not.toMatch(/never claim/i);
  expect(text).not.toContain("Proactive multi-agent delegation is active");
});
```

### 5.4 Insert after the wording test: reporter consistency

```ts
test("v2 roster is the configured intersection of the active spawn_agent candidates", async () => {
  const dir = codexHomeFixture(V2_ON);
  catalogFixture(dir, [
    { slug: "gpt-5.6-sol", efforts: ["high", "max", "ultra"], priority: 0, multiAgentVersion: "v2" },
    { slug: "gpt-5.5", efforts: ["low", "medium", "high"], priority: 1, multiAgentVersion: null },
    { slug: "gpt-5.6-terra", efforts: ["high", "max", "ultra"], priority: 2, multiAgentVersion: "v2" },
    { slug: "gpt-5.6-luna", efforts: ["high", "max"], priority: 3, multiAgentVersion: "v1" },
  ]);
  const configured = ["gpt-5.6-sol", "gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna"];

  const effective = effectiveSubagentRoster(configured, "v2");
  expect(effective.candidates.map(model => model.model)).toEqual([
    "gpt-5.6-sol",
    "gpt-5.6-terra",
  ]);
  expect(effective.advertised.map(model => model.model)).toEqual([
    "gpt-5.6-sol",
    "gpt-5.6-terra",
  ]);

  const text = await multiAgentGuidanceText(
    parsedFixture({ tools: [{ name: "spawn_agent" }] }),
    undefined,
    undefined,
    configured,
  );
  expect(text).toContain('"gpt-5.6-sol"');
  expect(text).toContain('"gpt-5.6-terra"');
  expect(text).not.toContain('"gpt-5.5"');
  expect(text).not.toContain('"gpt-5.6-luna"');
  for (const advertised of effective.advertised) {
    expect(effective.candidates.map(model => model.model)).toContain(advertised.model);
  }
});
```

### 5.5 Insert after reporter consistency: ordering, cap, and diagnostics

```ts
test("effective roster applies alias, visibility, v2 compatibility, stable priority, cap, and diagnostics", async () => {
  const dir = codexHomeFixture(V2_ON);
  catalogFixture(dir, [
    { slug: "provider/vendor-model", efforts: ["high"], priority: 0 },
    { slug: "eligible-a", efforts: ["high"], priority: 1 },
    { slug: "eligible-b", efforts: ["high"], priority: 1 },
    { slug: "hidden-model", efforts: ["high"], visibility: "hide", priority: 2 },
    { slug: "v1-model", efforts: ["high"], priority: 3, multiAgentVersion: "v1" },
    { slug: "filler-a", efforts: ["high"], priority: 4 },
    { slug: "filler-b", efforts: ["high"], priority: 5 },
    { slug: "displaced-model", efforts: ["high"], priority: 6 },
  ]);
  const configured = [
    "provider/vendor/model",
    "hidden-model",
    "v1-model",
    "missing-model",
    "displaced-model",
  ];

  const effective = effectiveSubagentRoster(configured, "v2");
  expect(effective.candidates.map(model => model.model)).toEqual([
    "provider/vendor-model",
    "eligible-a",
    "eligible-b",
    "filler-a",
    "filler-b",
  ]);
  expect(effective.advertised.map(model => model.model)).toEqual(["provider/vendor-model"]);
  expect(effective.excluded).toEqual([
    { configured: "hidden-model", catalogModel: "hidden-model", reason: "picker_hidden" },
    { configured: "v1-model", catalogModel: "v1-model", reason: "surface_incompatible" },
    { configured: "missing-model", reason: "missing_catalog_entry" },
    { configured: "displaced-model", catalogModel: "displaced-model", reason: "outside_display_limit" },
  ]);

  setDebugSettings({ injection: false });
  await multiAgentGuidanceText(
    parsedFixture({ tools: [{ name: "spawn_agent" }] }),
    undefined,
    undefined,
    configured,
  );
  expect(getInjectionDebugLogEntries()).toEqual([]);

  resetInjectionDebugLogBufferForTests();
  setDebugSettings({ injection: true });
  await multiAgentGuidanceText(
    parsedFixture({ tools: [{ name: "spawn_agent" }] }),
    undefined,
    undefined,
    configured,
  );
  const lines = getInjectionDebugLogEntries().map(entry => entry.line).join("\n");
  expect(lines).toContain("hidden-model:picker_hidden");
  expect(lines).toContain("v1-model:surface_incompatible");
  expect(lines).toContain("missing-model:missing_catalog_entry");
  expect(lines).toContain("displaced-model:outside_display_limit");
});
```

### 5.6 Insert after diagnostics: preferred model accuracy

```ts
test("built-in preferred model is canonical and limited to active candidates", async () => {
  const dir = codexHomeFixture(V2_ON);
  catalogFixture(dir, [
    { slug: "provider/vendor-model", efforts: ["high"], priority: 0, multiAgentVersion: "v2" },
    { slug: "gpt-5.5", efforts: ["high"], priority: 1, multiAgentVersion: null },
  ]);

  expect(await multiAgentGuidanceText(
    parsedFixture({ tools: [{ name: "spawn_agent" }] }),
    "gpt-5.5",
  )).toBeNull();

  const eligible = await multiAgentGuidanceText(
    parsedFixture({ tools: [{ name: "spawn_agent" }] }),
    "provider/vendor/model",
    "high",
  );
  expect(eligible).toContain('Preferred sub-agent: model "provider/vendor-model", reasoning_effort "high"');
  expect(eligible).not.toContain('model "provider/vendor/model"');
});
```

### 5.7 Replace the custom-prompt test at `:215-234`

```ts
test("injectionPrompt preserves raw model and substitutes only the effective roster", async () => {
  const dir = codexHomeFixture(V2_ON);
  catalogFixture(dir, [
    { slug: "gpt-5.6-terra", efforts: ["high", "max"], priority: 0, multiAgentVersion: "v2" },
    { slug: "gpt-5.6-luna", efforts: ["high", "max"], priority: 1, multiAgentVersion: "v1" },
  ]);
  const custom = "CUSTOM model={{model}} effort={{effort}}{{roster}}";
  const text = await multiAgentGuidanceText(
    parsedFixture({ tools: [{ name: "spawn_agent" }] }),
    "raw/preferred-model",
    "max",
    ["gpt-5.6-terra", "gpt-5.6-luna"],
    custom,
  );

  expect(text).toBe(
    '<multi_agent_mode>CUSTOM model=raw/preferred-model effort=max'
      + ' Available models (reasoning_effort high/max): "gpt-5.6-terra".</multi_agent_mode>',
  );
  expect(text).not.toContain("gpt-5.6-luna");
});
```

### 5.8 Exact adaptations to retained existing cases

The post-040 function no longer treats a configured preferred model as eligible without a catalog candidate. Apply these literal edits so the existing suite remains meaningful.

In `NATIVE v2 wire shape ...` at current `:101-120`, replace:

```ts
codexHomeFixture(V2_ON);
```

with:

```ts
const dir = codexHomeFixture(V2_ON);
catalogFixture(dir, [{
  slug: "anthropic/claude-sonnet-5",
  efforts: ["low", "medium", "high", "xhigh"],
}]);
```

In `responses_lite WS shape ...` at current `:154-156`, replace:

```ts
expect(text).toContain("never claim sub-agent models cannot be selected");
expect(text).toContain('(reasoning_effort high/max/ultra): "gpt-5.6-terra"');
```

with:

```ts
expect(text).toContain("When the active spawn_agent tool supports optional");
expect(text).not.toMatch(/hidden|not in the schema|never claim/i);
expect(text).toContain('(reasoning_effort high/max/ultra): "gpt-5.6-terra"');
```

In `v2 surface + injectionModel + injectionEffort names both` at current `:205-213`, replace the complete test with:

```ts
test("v2 surface + eligible injectionModel + injectionEffort names both", async () => {
  const dir = codexHomeFixture(V2_ON);
  catalogFixture(dir, [{
    slug: "opencode-go/glm-5.2",
    efforts: ["low", "medium", "high", "xhigh"],
  }]);
  const text = await multiAgentGuidanceText(
    parsedFixture({ tools: [{ name: "spawn_agent" }] }),
    "opencode-go/glm-5.2",
    "xhigh",
  );
  expect(text).toContain('Preferred sub-agent: model "opencode-go/glm-5.2", reasoning_effort "xhigh"');
});
```

In `v2 surface + roster alone ...` at current `:244-254`, replace:

```ts
expect(text).toContain("never claim sub-agent models cannot be selected");
```

with:

```ts
expect(text).toContain("When the active spawn_agent tool supports optional");
expect(text).not.toMatch(/hidden|not in the schema|never claim/i);
```

Keep and adapt the existing 700-character budget case at `:305-322`; it is existing coverage, not a sixth new regression.

## 6. Conditional-path activation matrix

| Conditional path | Activation | Expected |
|---|---|---|
| No/contradictory collaboration surface | no `spawn_agent`, mixed spawn shapes, or contradictory companions | Existing `null`; no catalog helper call. |
| v1 below top tier | v1 tools, effort below max/ultra | Existing `null`; no roster. |
| v1 top tier | v1 tools, max/ultra | Existing Proactive text only. |
| v2 custom prompt | raw injection model and/or effective roster plus `injectionPrompt` | User body; raw `{{model}}`; effective `{{roster}}`. |
| v2 built-in, eligible preferred/roster | at least one effective candidate | Neutral text and canonical accepted models only. |
| v2 built-in, only excluded inputs | ineligible preferred and empty effective roster | `null`; exclusions available in debug diagnostics. |
| Built-in over budget | effective roster pushes body over 700 | Drop roster only; retain neutral rules/preferred sentence. |
| Diagnostics disabled/enabled | exclusions with injection debug off/on | No log when off; reasoned exclusion log when on. |

## 7. Documentation literal full-line replacements

### `README.md:237`

Before:

```md
- **Delegate to the right model.** Feature up to five routed or native models in Codex's subagent picker from the dashboard or config — route complex tasks to a reasoning model, fast tasks to a cheap one. On the v2 multi-agent surface (GPT-5.6 Sol/Terra) the proxy injects compact delegation guidance: a preferred sub-agent model and effort (`injectionModel` / `injectionEffort`), the featured-model roster with the effort ladder each supports, and the `fork_turns` rules that let cross-model `spawn_agent` calls apply their overrides. Known limitation: when a native parent spawns a routed child, the task body can currently arrive backend-encrypted and be lost ([#92](https://github.com/lidge-jun/opencodex/issues/92)) — use the v1 surface for reliable cross-provider delegation. Want your own wording? Set `injectionPrompt` with `{{model}}` / `{{effort}}` / `{{roster}}` placeholders.
```

After:

```md
- **Delegate to the right model.** Feature up to five routed or native models in Codex's subagent picker from the dashboard or config — route complex tasks to a reasoning model, fast tasks to a cheap one. On the v2 multi-agent surface (GPT-5.6 Sol/Terra) the proxy injects compact, schema-agnostic delegation guidance: an eligible preferred sub-agent model and effort (`injectionModel` / `injectionEffort`), the configured intersection of Codex's picker-visible, v2-compatible, priority-sorted first five with available effort ladders, and the `fork_turns` rules that let cross-model `spawn_agent` calls apply their overrides. Known limitation: when a native parent spawns a routed child, the task body can currently arrive backend-encrypted and be lost ([#92](https://github.com/lidge-jun/opencodex/issues/92)) — use the v1 surface for reliable cross-provider delegation. Want your own wording? Set `injectionPrompt` with `{{model}}` / `{{effort}}` / `{{roster}}` placeholders.
```

### `docs-site/src/content/docs/guides/sub-agent-surface.md:36`

Before:

```md
On a **v2** turn (Sol/Terra in base mode, every model in v2 mode), the proxy injects a compact guidance block — budgeted to 700 characters — whenever an injection model is set or the configured sub-agent roster resolves in the catalog. The block teaches `spawn_agent`'s hidden `model` / `reasoning_effort` arguments, mandates `fork_turns: "none"` (or a partial fork) for overrides, names the preferred model and effort, and lists the `subagentModels` roster with the effort ladder each advertises in the injected catalog — the same list Codex validates spawn efforts against.
```

After:

```md
On a **v2** turn (Sol/Terra in base mode, every model in v2 mode), the proxy injects a compact guidance block — budgeted to 700 characters — whenever an eligible injection model is set or the effective sub-agent roster is non-empty. The block conditionally describes `model` / `reasoning_effort` overrides without assuming whether they appear in the active schema, mandates `fork_turns: "none"` (or a partial fork), names only an eligible canonical preferred model, and lists only configured models in Codex's picker-visible, v2-compatible, priority-sorted first five with their available effort ladders.
```

### `docs-site/src/content/docs/ja/guides/sub-agent-surface.md:36`

Before:

```md
**v2** リクエスト(base モードの Sol/Terra、v2 モードでは全モデル)では注入モデルが設定されているかサブエージェントロスターがカタログから解釈されるとき 700 字以内の簡潔なガイドを注入します。ガイドには `spawn_agent` の隠し `model` / `reasoning_effort` 引数の使い方、オーバーライドに必要な `fork_turns: "none"`(または部分 fork)ルール、推奨モデル・推論強度、そして `subagentModels` ロスターと各モデルがカタログに広告する effort ラダーが含まれます。このラダーは Codex がスポーン effort を検証する一覧と同じです。
```

After:

```md
**v2** リクエスト(base モードの Sol/Terra、v2 モードでは全モデル)では、有効な注入モデルが設定されているか実効サブエージェントロスターが空でないとき、700 字以内の簡潔なガイドを注入します。ガイドは `model` / `reasoning_effort` が現在のスキーマに表示されるかを断定せず条件付きで override を説明し、`fork_turns: "none"`(または部分 fork)ルール、有効な正規 slug の推奨モデル、Codex の picker-visible・v2 互換・priority 順の先頭 5 件に含まれる設定済みモデルと利用可能な effort ラダーだけを表示します。
```

### `docs-site/src/content/docs/ko/guides/sub-agent-surface.md:36`

Before:

```md
**v2** 요청(base 모드의 Sol/Terra, v2 모드에서는 전체 모델)에서는 주입 모델이 설정되어 있거나 서브에이전트 로스터가 카탈로그에서 해석될 때 700자 이내의 간결한 가이드를 주입합니다. 가이드에는 `spawn_agent`의 숨겨진 `model` / `reasoning_effort` 인자 사용법, 오버라이드에 필요한 `fork_turns: "none"`(또는 부분 fork) 규칙, 선호 모델·추론 강도, 그리고 `subagentModels` 로스터와 각 모델이 카탈로그에 광고하는 effort 사다리가 들어갑니다. 이 사다리는 Codex가 스폰 effort를 검증하는 목록과 동일합니다.
```

After:

```md
**v2** 요청(base 모드의 Sol/Terra, v2 모드에서는 전체 모델)에서는 유효한 주입 모델이 설정되어 있거나 실효 서브에이전트 로스터가 비어 있지 않을 때 700자 이내의 간결한 가이드를 주입합니다. 가이드는 `model` / `reasoning_effort`가 현재 스키마에 노출되는지 단정하지 않고 조건부로 override를 설명하며, `fork_turns: "none"`(또는 부분 fork) 규칙, 유효한 정규 slug의 선호 모델, Codex의 picker-visible·v2 호환·priority 순 상위 5개에 포함된 설정 모델과 사용 가능한 effort 사다리만 표시합니다.
```

### `docs-site/src/content/docs/ru/guides/sub-agent-surface.md:36`

Before:

```md
В ходах **v2** (Sol/Terra в режиме base, любая модель в режиме v2) прокси внедряет компактный блок инструкции — с бюджетом 700 символов — всякий раз, когда задана модель внедрения или настроенный список подагентов разрешается в каталоге. Блок объясняет скрытые аргументы `model` / `reasoning_effort` инструмента `spawn_agent`, требует `fork_turns: "none"` (или частичный форк) для переопределений, называет предпочтительные модель и уровень рассуждений и перечисляет список `subagentModels` со шкалой уровней, которую каждая модель объявляет во внедрённом каталоге, — тем же списком, по которому Codex валидирует уровни при порождении.
```

After:

```md
В ходах **v2** (Sol/Terra в режиме base, любая модель в режиме v2) прокси внедряет компактный блок инструкции — с бюджетом 700 символов — когда задана допустимая модель внедрения или эффективный список подагентов не пуст. Блок условно описывает переопределения `model` / `reasoning_effort`, не утверждая, видны ли они в активной схеме, требует `fork_turns: "none"` (или частичный форк), называет только допустимую каноническую предпочтительную модель и перечисляет только настроенные модели из первых пяти видимых в селекторе, совместимых с v2 и отсортированных по priority записей Codex с доступными уровнями effort.
```

### `docs-site/src/content/docs/zh-cn/guides/sub-agent-surface.md:36`

Before:

```md
在 **v2** 请求上（base 模式下的 Sol/Terra，v2 模式下的全部模型），只要设置了注入模型、或配置的子代理清单能在目录中解析出来，proxy 就会注入一段不超过 700 字符的精简指引：`spawn_agent` 隐藏的 `model` / `reasoning_effort` 参数用法、覆盖所需的 `fork_turns: "none"`（或部分 fork）规则、首选模型与推理强度，以及 `subagentModels` 清单和各模型在目录中公布的 effort 阶梯 —— 这正是 Codex 验证生成强度所用的列表。
```

After:

```md
在 **v2** 请求上（base 模式下的 Sol/Terra，v2 模式下的全部模型），只要设置了有效的注入模型、或有效子代理清单非空，proxy 就会注入一段不超过 700 字符的精简指引。该指引以条件方式说明 `model` / `reasoning_effort` 覆盖，不假定它们是否出现在当前 schema 中；它要求使用 `fork_turns: "none"`（或部分 fork），仅命名有效的规范首选模型，并只列出 Codex 中 picker 可见、兼容 v2、按 priority 排序后前五项内的已配置模型及其可用 effort 档位。
```

### `docs-site/src/content/docs/reference/configuration.md:35`

Before:

```md
| `subagentModels?` | `string[]` | `gpt-5.5`, GPT-5.6 trio, `gpt-5.4-mini` | Up to 5 native slugs or `provider/model` ids featured first in Codex's subagent picker. Also injected into v2 delegation guidance as the available-model roster, annotated with the effort ladder each entry advertises in the catalog. An explicit empty list is preserved. |
```

After:

```md
| `subagentModels?` | `string[]` | `gpt-5.5`, GPT-5.6 trio, `gpt-5.4-mini` | Up to 5 native slugs or `provider/model` ids featured first in Codex's subagent picker. The v2 guidance roster is the configured intersection of Codex's picker-visible, v2-compatible, priority-sorted first five, using canonical catalog slugs and available effort ladders; excluded entries remain configured. An explicit empty list is preserved. |
```

### `docs-site/src/content/docs/ja/reference/configuration.md:33`

Before:

```md
| `subagentModels?` | `string[]` | `gpt-5.5`、GPT-5.6 3種、`gpt-5.4-mini` | Codex サブエージェントセレクターの先頭に表示するネイティブ slug または `provider/model` id。最大 5 つで、明示的な空配列もそのまま保存します。v2 委任案内には利用可能モデルのロスターとしても注入され、各項目がカタログに公表する effort ラダーも併記されます。 |
```

After:

```md
| `subagentModels?` | `string[]` | `gpt-5.5`、GPT-5.6 3種、`gpt-5.4-mini` | Codex サブエージェントセレクターの先頭に表示するネイティブ slug または `provider/model` id。最大 5 つで、明示的な空配列もそのまま保存します。v2 ガイダンスのロスターは、Codex の picker-visible・v2 互換・priority 順の先頭 5 件との設定済みモデルの共通部分で、正規カタログ slug と利用可能な effort ラダーを使います。除外された項目も設定には残ります。 |
```

### `docs-site/src/content/docs/ko/reference/configuration.md:34`

Before:

```md
| `subagentModels?` | `string[]` | `gpt-5.5`, GPT-5.6 3종, `gpt-5.4-mini` | Codex 서브에이전트 선택기 앞쪽에 표시할 네이티브 slug 또는 `provider/model` id. 최대 5개이며, 명시적인 빈 배열도 그대로 보존합니다. v2 위임 안내에는 사용 가능한 모델 로스터로도 주입되며, 각 항목이 카탈로그에 광고하는 effort 사다리가 함께 표기됩니다. |
```

After:

```md
| `subagentModels?` | `string[]` | `gpt-5.5`, GPT-5.6 3종, `gpt-5.4-mini` | Codex 서브에이전트 선택기 앞쪽에 표시할 네이티브 slug 또는 `provider/model` id. 최대 5개이며, 명시적인 빈 배열도 그대로 보존합니다. v2 가이던스 로스터는 설정 목록과 Codex의 picker-visible·v2 호환·priority 순 상위 5개의 교집합이며 정규 카탈로그 slug와 사용 가능한 effort 사다리를 씁니다. 제외된 항목도 설정에는 남습니다. |
```

### `docs-site/src/content/docs/ru/reference/configuration.md:38`

Before:

```md
| `subagentModels?` | `string[]` | `gpt-5.5`, тройка GPT-5.6, `gpt-5.4-mini` | До 5 нативных slug или id вида `provider/model`, отображаемых первыми в селекторе подагентов Codex. Также внедряются в v2-руководство по делегированию как список доступных моделей с аннотацией лестницы уровней рассуждений, которую каждая запись объявляет в каталоге. Явно заданный пустой список сохраняется. |
```

After:

```md
| `subagentModels?` | `string[]` | `gpt-5.5`, тройка GPT-5.6, `gpt-5.4-mini` | До 5 нативных slug или id вида `provider/model`, отображаемых первыми в селекторе подагентов Codex. Список в руководстве v2 — пересечение настроенных моделей с первыми пятью видимыми в селекторе, совместимыми с v2 и отсортированными по priority записями Codex; используются канонические slug каталога и доступные уровни effort, а исключённые элементы остаются в конфигурации. Явно заданный пустой список сохраняется. |
```

### `docs-site/src/content/docs/zh-cn/reference/configuration.md:32`

Before:

```md
| `subagentModels?` | `string[]` | `gpt-5.5`、三款 GPT-5.6、`gpt-5.4-mini` | 最多 5 个原生 slug 或 `provider/model` id，优先显示在 Codex subagent picker 中。显式空数组会被保留。 也会作为可用模型清单注入 v2 委派指南，并标注各模型在目录中公布的 effort 阶梯。 |
```

After:

```md
| `subagentModels?` | `string[]` | `gpt-5.5`、三款 GPT-5.6、`gpt-5.4-mini` | 最多 5 个原生 slug 或 `provider/model` id，优先显示在 Codex subagent picker 中。v2 指引清单是已配置模型与 Codex 中 picker 可见、兼容 v2、按 priority 排序后前五项的交集，并使用规范目录 slug 与可用 effort 档位；被排除的条目仍保留在配置中。显式空数组会被保留。 |
```

## 8. Verification

```bash
bun test tests/multi-agent-compat.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

Manual smoke: default mode with Sol/GPT-5.5/Terra/Luna must inject only Sol/Terra, forced-v2 plus catalog sync must recompute the effective set, and an injection-debug-enabled request must show reasoned exclusions without mutating configured order.

## Follow-up (out of scope)

- A dedicated Subagents-page visualization or management-API DTO for exclusion diagnostics. This change uses the existing injection debug channel to keep #295 at the response/catalog boundary.
- General cleanup of older model-ordering guides and stale source line references unrelated to the corrected guidance contract.
