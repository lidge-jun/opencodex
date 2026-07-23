# 003 — Investigation: issues #295 / #300 multi-agent guidance accuracy and kill switch

Date: 2026-07-23 (Asia/Seoul)

Repository state inspected: `codex/issue-triage-260723` at `54e0bbf88cebe6a77e0a8584af193cf689680ad6`, identical to `origin/dev` at inspection time.

Issues: #295, “Multi-agent guidance can advertise rejected spawn models”; #300, “Add a supported kill switch for repeated multi-agent guidance injection.”

## Executive finding

Both reports are valid, but they classify differently. **#295 is a confirmed OpenCodex bug**: the proxy's built-in v2 message unconditionally describes `model` and `reasoning_effort` as hidden, while current Codex can expose those fields; more importantly, the roster checks only whether each configured id has effort metadata somewhere in the injected catalog, not whether that model is eligible for the active v2 collaboration backend. **#300 is a confirmed feature gap**: there is no supported boolean that suppresses both v1 and v2 guidance while leaving the collaboration surface, roster, catalog, routing, and caps unchanged.

The reporter's exact #295 split is explained by the active v2 compatibility filter. The local pinned catalog marks Sol and Terra `v2`, Luna `v1`, and GPT-5.5 unpinned; the inspected upstream Codex handler requires an explicit v2 match during a v2 turn. The configured four-model roster therefore resolved all four for prompt text, while the v2 runtime accepted only Sol and Terra. The upstream five-model constant limits the picker-visible models described by `spawn_agent`; it is not reproduced by OpenCodex's current roster helper.

The #295 workaround mechanics are also confirmed. A non-empty `injectionPrompt` replaces the built-in v2 body, `{{roster}}` expands to the same catalog-resolved roster suffix, and the reporter's suffix placement preserves the roster. Through the management API, `null` and `""` clear the override; whitespace-only input is rejected rather than saved. A space written directly to config remains truthy and yields an effectively blank `<multi_agent_mode>` block, but still rewrites every qualifying request. That is containment, not a supported disabled state.

## Evidence anchors

The following are verbatim anchors used by the findings below.

### A1 — the built-in text makes absolute schema claims

```ts
// src/server/responses.ts:211-217
    if (injectionPrompt) {
      return `<multi_agent_mode>${applyInjectionPlaceholders(injectionPrompt, injectionModel, injectionEffort, roster)}</multi_agent_mode>`;
    }
    let text = "spawn_agent also accepts hidden \"model\" and \"reasoning_effort\" string arguments "
      + "(not in the schema, but parsed and applied) — never claim sub-agent models cannot be selected. "
      + "When setting either, set fork_turns to \"none\" (or e.g. \"3\"; full-history forks reject overrides) "
      + "and make the message self-contained.";
```

### A2 — the roster tests catalog resolution, not active-surface eligibility

```ts
// src/server/responses.ts:254-266
async function subagentRosterText(subagentModels?: string[]): Promise<string> {
  const featured = (subagentModels ?? []).filter(id => typeof id === "string" && id.trim().length > 0);
  if (featured.length === 0) return "";
  const { catalogModelEfforts } = await import("../codex/catalog");
  const efforts = catalogModelEfforts(featured);
  const resolved = featured.filter(id => efforts.has(id));
  if (resolved.length === 0) return "";
  const ladders = new Set(resolved.map(id => efforts.get(id)!.join("/")));
  if (ladders.size === 1) {
    // Shared ladder (the common case: the injected catalog advertises one rung set)
    // -> state it once instead of per model, keeping the roster inside the budget.
    const ids = resolved.map(id => `"${id}"`).join(", ");
    return ` Available models (reasoning_effort ${[...ladders][0]}): ${ids}.`;
```

### A3 — catalog effort lookup accepts any matching catalog row

```ts
// src/codex/catalog.ts:339-349
export function catalogModelEfforts(slugs: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (slugs.length === 0) return out;
  const catalog = readCatalog(readCodexCatalogPath());
  if (!catalog) return out;
  for (const entry of catalog.models ?? []) {
    if (typeof entry.slug !== "string") continue;
    // Tolerate raw legacy config slugs (`provider/vendor/model`) against the
    // Codex-facing encoded catalog slug (`provider/vendor-model`).
    const callerSlug = slugs.find(s => slugsEquivalent(s, entry.slug as string));
    if (callerSlug === undefined) continue;
```

### A4 — OpenCodex deliberately ranks configured models for Codex's five-item surface

```ts
// src/codex/catalog.ts:1091-1104
  // Codex's models-manager sorts by `priority` ASC and advertises the first 5 picker-visible
  // models to spawn_agent (sort_by_key(priority) + MAX_MODEL_OVERRIDES_IN_SPAWN_AGENT=5). Catalog
  // ARRAY order is discarded — so "featuring" a model = giving it the LOWEST priority (0..N-1) so
  // it sorts to the front. This works for native gpt slugs AND routed slugs alike.
  const rank = new Map((featured ?? []).map((slug, i) => [slug, i] as const));
  const out: RawEntry[] = [];
  const collisionSkipped = resolveSlugAliasCollisions(goModels);
  const comboPublicSlugs = new Set(goModels
    .filter(model => model.provider === COMBO_NAMESPACE)
    .map(catalogModelSlug));
  for (const slug of gptSlugs) {
    const e = deriveEntry(template, slug, "OpenAI native model (Codex OAuth passthrough).", 9);
    if (rank.has(slug)) e.priority = rank.get(slug)!;
    out.push(e);
```

### A5 — default surface pins distinguish Sol/Terra from Luna/GPT-5.5

```json
// src/codex/data/upstream-models.json:4,21,118,135,230,247,338,355
      "slug": "gpt-5.6-sol",
      "multi_agent_version": "v2",
      "slug": "gpt-5.6-terra",
      "multi_agent_version": "v2",
      "slug": "gpt-5.6-luna",
      "multi_agent_version": "v1",
      "slug": "gpt-5.5",
      "multi_agent_version": null,
```

### A6 — default mode restores those pins; forced v2 changes all entries

```ts
// src/codex/catalog.ts:545-570
/**
 * Apply the 3-state multi-agent surface override to catalog entries.
 * - "v1": force multi_agent_version = "v1" on ALL entries (override upstream pins)
 * - "default": RESTORE upstream pins — clear stale forced values so entries that were
 *   previously forced to v1/v2 revert to their natural state (upstream-pinned natives
 *   get their snapshot pin, others get null so the codex feature flag decides)
 * - "v2": force multi_agent_version = "v2" on ALL entries (override upstream pins)
 */
function applyMultiAgentMode(entries: RawEntry[], mode: MultiAgentMode): RawEntry[] {
  if (mode === "default") {
    // Restore upstream defaults: clear any stale forced multi_agent_version and
    // re-apply upstream pins from the snapshot for native entries that have one.
    for (const entry of entries) {
      const slug = typeof entry.slug === "string" ? entry.slug : "";
      const upstream = UPSTREAM_NATIVE_ENTRIES.get(slug);
      const upstreamPin = upstream?.multi_agent_version;
      if (typeof upstreamPin === "string") {
        entry.multi_agent_version = upstreamPin;
      } else {
        delete entry.multi_agent_version;
      }
    }
    return entries;
  }
  for (const entry of entries) {
    entry.multi_agent_version = mode;
```

### A7 — upstream Codex applies the v2 backend filter

```rs
// openai/codex@0da13c6c993cbb6de3ce88591b316a40cbd411b1:
// codex-rs/core/src/tools/handlers/multi_agents_common.rs:31-39
pub(crate) const MAX_SPAWN_AGENT_MODEL_OVERRIDES: usize = 5;

pub(crate) fn model_supports_multi_agent_backend(
    model: &ModelPreset,
    multi_agent_version: MultiAgentVersion,
) -> bool {
    multi_agent_version != MultiAgentVersion::V2
        || model.multi_agent_version == Some(multi_agent_version)
}
```

### A8 — upstream can expose the fields, then filters its description to five compatible models

```rs
// openai/codex@0da13c6c993cbb6de3ce88591b316a40cbd411b1:
// codex-rs/core/src/tools/handlers/multi_agents_spec.rs:103-119
    let available_models_description = options.expose_spawn_agent_model_overrides.then(|| {
        spawn_agent_models_description(&options.available_models, options.multi_agent_version)
    });
    let inherited_model_guidance = (options.expose_spawn_agent_model_overrides
        && !options.hide_agent_type_model_reasoning)
        .then_some(SPAWN_AGENT_INHERITED_MODEL_GUIDANCE);
    let mut properties = spawn_agent_common_properties_v2(&options.agent_type_description);
    if !options.expose_agent_type {
        properties.remove("agent_type");
    }
    if options.hide_agent_type_model_reasoning {
        properties.remove("service_tier");
    }
    if !options.expose_spawn_agent_model_overrides {
        properties.remove("model");
        properties.remove("reasoning_effort");
    }
```

```rs
// openai/codex@0da13c6c993cbb6de3ce88591b316a40cbd411b1:
// codex-rs/core/src/tools/handlers/multi_agents_spec.rs:781-790
fn spawn_agent_models_description(
    models: &[ModelPreset],
    multi_agent_version: MultiAgentVersion,
) -> String {
    let visible_models: Vec<&ModelPreset> = models
        .iter()
        .filter(|model| model.show_in_picker)
        .filter(|model| model_supports_multi_agent_backend(model, multi_agent_version))
        .take(MAX_SPAWN_AGENT_MODEL_OVERRIDES)
        .collect();
```

### A9 — runtime model validation uses the same backend filter

```rs
// openai/codex@0da13c6c993cbb6de3ce88591b316a40cbd411b1:
// codex-rs/core/src/tools/handlers/multi_agents_common.rs:402-419
    available_models
        .iter()
        .find(|model| {
            model.model == requested_model
                && model_supports_multi_agent_backend(model, multi_agent_version)
        })
        .map(|model| model.model.clone())
        .ok_or_else(|| {
            let available = available_models
                .iter()
                .filter(|model| model.show_in_picker)
                .filter(|model| model_supports_multi_agent_backend(model, multi_agent_version))
                .take(MAX_SPAWN_AGENT_MODEL_OVERRIDES)
                .map(|model| model.model.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            FunctionCallError::RespondToModel(format!(
                "Unknown model `{requested_model}` for spawn_agent. Available models: {available}"
```

### A10 — placeholder substitution is direct and global

```ts
// src/server/responses.ts:241-246
/** {{model}}/{{effort}}/{{roster}} substitution for the user-configured injectionPrompt. */
function applyInjectionPlaceholders(prompt: string, model?: string, effort?: string, roster?: string): string {
  return prompt
    .replaceAll("{{model}}", model ?? "")
    .replaceAll("{{effort}}", effort ?? "")
    .replaceAll("{{roster}}", roster ?? "");
}
```

### A11 — empty management-API prompts clear the override

```ts
// src/server/management-api.ts:1135-1143
    // `prompt` key semantics mirror `effort`: absent -> unchanged; null/"" -> clear;
    // non-empty string -> set (custom <multi_agent_mode> body, {{model}}/{{effort}}/{{roster}} placeholders).
    if ("prompt" in body) {
      if (typeof body.prompt === "string" && body.prompt.trim().length > 0) config.injectionPrompt = body.prompt;
      else if (body.prompt === null || body.prompt === "") delete config.injectionPrompt;
      else return jsonResponse({ error: "prompt must be a string or null" }, 400);
    }
    saveConfig(config);
    return jsonResponse({ ok: true, model: config.injectionModel ?? null, effort: config.injectionEffort ?? null, prompt: config.injectionPrompt ?? null });
```

### A12 — the request call site has no guidance-enabled gate

```ts
// src/server/responses.ts:904-908
  {
    const guidance = await multiAgentGuidanceText(parsed, config.injectionModel, config.injectionEffort, config.subagentModels, config.injectionPrompt);
    if (guidance) {
      injectDeveloperMessage(parsed, guidance);
      if (isInjectionDebugEnabled()) injectionDebugLog(`[opencodex] ${route.modelId}: multi-agent guidance injected (surface=${collabSurface(parsed)}, ${guidance.length} chars)`);
```

### A13 — config is passthrough, defaults seed a roster, and no guidance flag exists

```ts
// src/types.ts:400-407
  /**
   * Custom override for the injected multi-agent guidance body (the text inside the
   * <multi_agent_mode> tags). When set, it replaces the built-in prompt on whichever
   * collab surface would have fired; firing gates are unchanged. Placeholders:
   * `{{model}}` -> injectionModel, `{{effort}}` -> injectionEffort, `{{roster}}` ->
   * the resolved sub-agent roster block ("" when nothing resolves).
   */
  injectionPrompt?: string;
```

```ts
// src/types.ts:442-448
  /**
   * 3-state multi-agent surface override:
   * - "v1": force ALL models to v1 surface (override upstream pins)
   * - "default" | undefined: respect upstream model pins (sol/terra=v2, luna=v1, rest=codex flag)
   * - "v2": force ALL models to v2 surface (override upstream pins)
   */
  multiAgentMode?: "v1" | "default" | "v2";
```

```ts
// src/config.ts:412-419
const configSchema = z.object({
  port: z.number().int().min(0).max(65535).default(10100),
  providers: z.record(z.string(), providerConfigSchema),
  defaultProvider: z.string().min(1).default("openai"),
  openaiProviderTierVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  providerContextCaps: z.record(z.string(), z.number().int().positive()).optional(),
  contextCapValue: z.number().int().positive().optional(),
}).passthrough().superRefine((config, ctx) => {
```

```ts
// src/config.ts:731-753
export function getDefaultConfig(): OcxConfig {
  // Fresh-install default: works out of the box with Codex's ChatGPT OAuth (no API key).
  // gpt-* requests forward the caller's incoming OAuth headers to the ChatGPT backend.
  // Adding extra providers (e.g. opencode-go) and switching defaultProvider is a user/runtime choice.
  return {
    port: 10100,
    // Fresh/re-initialized configs are already written in the current three-tier
    // OpenAI shape. Mark them as such so startup does not mistake them for a
    // legacy config and collide with an immutable backup from an earlier setup.
    openaiProviderTierVersion: OPENAI_PROVIDER_TIER_VERSION,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    defaultProvider: "openai",
    subagentModels: [...DEFAULT_SUBAGENT_MODELS],
    websockets: false,
    codexAutoStart: true,
  };
}
```

### A14 — guidance configuration belongs to `/api/injection-model`; generic settings do not expose it

```ts
// src/server/management-api.ts:232-248
  if (url.pathname === "/api/settings" && req.method === "GET") {
    return jsonResponse({
      codexAutoStart: codexAutoStartEnabled(config),
      port: config.port,
      hostname: config.hostname ?? "127.0.0.1",
    });
  }

  if (url.pathname === "/api/settings" && req.method === "PUT") {
    let body: { codexAutoStart?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (typeof body.codexAutoStart !== "boolean") {
      return jsonResponse({ error: "codexAutoStart boolean is required" }, 400);
    }
    config.codexAutoStart = body.codexAutoStart;
    saveConfig(config);
    return jsonResponse({ ok: true, codexAutoStart: codexAutoStartEnabled(config) });
  }
```

```ts
// src/server/management-api.ts:1094-1112
  if (url.pathname === "/api/injection-model" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const disabled = new Set(config.disabledModels ?? []);
    const { listCatalogNativeSlugs } = await import("../codex/catalog");
    const { CODEX_REASONING_LEVELS } = await import("../reasoning-effort");
    const nativeModels = listCatalogNativeSlugs()
      .filter(slug => !disabled.has(slug))
      .map(slug => ({ provider: "openai", model: slug, namespaced: slug }));
    const routedModels = uniqueCatalogModelsForPublicList(models)
      .map(m => ({ provider: m.provider, model: m.id, namespaced: catalogModelSlug(m) }))
      .filter(m => ![...disabled].some(stored => (
        stored === m.namespaced || slugEquals(stored, m.provider, m.model)
      )));
    return jsonResponse({
      model: config.injectionModel ?? null,
      effort: config.injectionEffort ?? null,
      prompt: config.injectionPrompt ?? null,
      efforts: CODEX_REASONING_LEVELS.map(l => l.effort),
      available: [...nativeModels, ...routedModels],
    });
```

### A15 — the GUI has model/effort guidance state but no prompt or enabled state

```tsx
// gui/src/pages/Dashboard.tsx:194-198,262-269
  const [injectionModel, setInjectionModel] = useState<string>("");
  const [injectionEffort, setInjectionEffort] = useState<string>("");
  const [injectionEfforts, setInjectionEfforts] = useState<string[]>([]);
  const [injectionAvailable, setInjectionAvailable] = useState<Array<{ provider: string; model: string; namespaced: string }>>([]);
  const [injectionSaving, setInjectionSaving] = useState(false);

          const imRes = await fetch(`${apiBase}/api/injection-model`);
          if (imRes.ok) {
            const imData = await imRes.json() as { model?: string | null; effort?: string | null; efforts?: string[]; available?: Array<{ provider: string; model: string; namespaced: string }> };
            setInjectionModel(imData.model ?? "");
            setInjectionEffort(imData.effort ?? "");
            setInjectionEfforts(imData.efforts ?? []);
            setInjectionAvailable(imData.available ?? []);
```

## Issue #295: precise divergence chain

1. `config.subagentModels` is used as a featured ordering input during catalog sync, and OpenCodex assigns configured native ids low priorities. This is intended to align with Codex's priority-sorted, five-item picker description (**A4**: `src/codex/catalog.ts:1091-1104`, “sorts by `priority` ASC and advertises the first 5 picker-visible models”).
2. `multiAgentGuidanceText` does not consume that effective five-item, surface-compatible set. It passes the raw configured list to `subagentRosterText`, which retains every id for which `catalogModelEfforts` found any catalog row (**A2**: `src/server/responses.ts:254-266`, `const resolved = featured.filter(id => efforts.has(id))`; **A3**: `src/codex/catalog.ts:339-349`, matching only the slug).
3. Codex independently builds the active `spawn_agent` description from picker-visible models, filters them for the active collaboration backend, and takes five (**A8**: upstream `multi_agents_spec.rs:781-790`). Runtime validation repeats the backend filter before accepting an explicit model (**A9**: upstream `multi_agents_common.rs:402-419`). Thus catalog presence is necessary for roster resolution but is not sufficient for a v2 spawn override.
4. In the default catalog, Sol and Terra are explicitly v2; Luna is explicitly v1; GPT-5.5 is unpinned (**A5**: `src/codex/data/upstream-models.json:4,21,118,135,230,247,338,355`). For a v2 turn, upstream requires `model.multi_agent_version == Some(V2)` (**A7**: upstream `multi_agents_common.rs:31-39`). This yields the reporter's exact split: OpenCodex advertised all four catalog-resolved configured ids, while runtime acceptance/error disclosure contained only `gpt-5.6-sol` and `gpt-5.6-terra`.
5. `multiAgentMode: "v2"` would stamp every catalog entry v2, while default mode restores the upstream pins (**A6**: `src/codex/catalog.ts:545-570`). That can change the accepted set, but it does not repair the architectural mismatch: the guidance helper still computes a different set from the runtime and can drift again through visibility, priority, surface pins, stale session/catalog cache, or more than five configured entries.
6. The wording defect is independent of the roster defect. The built-in text always says `hidden`, `not in the schema`, and `never claim` whenever v2 guidance fires (**A1**: `src/server/responses.ts:211-217`). Current upstream can retain `model` and `reasoning_effort` in the v2 schema when override exposure is enabled, so an absolute schema claim is not valid for every session; the reporter's active schema was one such session.

The first-five constant needs a precise interpretation. It caps the model list described to the model and shown in the error (**A8**, **A9**); the inspected handler's exact-name validation can accept a compatible model outside that displayed five because its initial `.find(...)` is not picker/take-limited (**A9**: upstream `multi_agents_common.rs:402-414`). OpenCodex guidance should nevertheless advertise no broader set than Codex itself describes for that turn. Computing the same picker-visible + backend-compatible + priority-sorted first five is a safe subset of runtime acceptance and matches the user-visible contract.

## Workaround verification

The reporter's custom text is a real replacement, not an appended amendment. On v2, a truthy `injectionPrompt` returns immediately with the custom body inside `<multi_agent_mode>` (**A1**: `src/server/responses.ts:211-212`). `applyInjectionPlaceholders` replaces every `{{model}}`, `{{effort}}`, and `{{roster}}` occurrence with the current values (**A10**: `src/server/responses.ts:241-246`). Because `subagentRosterText` returns a suffix beginning with one space (**A2**: `src/server/responses.ts:265-266`), the reporter's `self-contained.{{roster}}` produces correctly separated neutral guidance plus the resolved Sol/Terra roster.

The override does not bypass firing gates. Roster resolution and `if (!injectionModel && roster === "") return null` run before the custom-prompt branch (**A1/A2**: `src/server/responses.ts:209-212`); a custom prompt alone cannot cause a bare v2 turn to fire. The reporter retained a resolvable roster, so the override did fire.

The management-API claim is confirmed with one terminology correction. `prompt: null` and `prompt: ""` delete `config.injectionPrompt`; an absent key leaves it unchanged; a whitespace-only string fails validation with 400 instead of being deleted (**A11**: `src/server/management-api.ts:1135-1143`). A literal single space written directly into the config bypasses that API validation because the config schema is passthrough (**A13**: `src/config.ts:412-419`), and it is truthy at the v2 branch (**A1**: `src/server/responses.ts:211-212`). The result is `<multi_agent_mode> </multi_agent_mode>`, so request mutation still occurs and the workaround is undocumented.

## Issue #300: supported configuration flow

There is currently no expressible off state. `OcxConfig` has `injectionPrompt` and `multiAgentMode` but no guidance boolean, the default config seeds `subagentModels` without a switch, and the schema merely passes unknown fields through (**A13**: `src/config.ts:412-419,731-753`; `src/types.ts:400-448`). At the execution boundary, every request calls `multiAgentGuidanceText` without an enable check (**A12**: `src/server/responses.ts:904-908`). Consequently, changing v2 mode changes the collaboration surface, clearing `subagentModels` changes the roster/catalog intent, and clearing `injectionPrompt` restores the built-in body; none means “keep all behavior except proxy-authored guidance.”

A supported `multiAgentGuidanceEnabled` flow should be:

1. **Type + load/default semantics:** add `multiAgentGuidanceEnabled?: boolean` to `OcxConfig`; explicitly add `z.boolean().optional()` to `configSchema` despite `.passthrough()` so malformed values are rejected; expose `true` in `getDefaultConfig` for discoverability; and use `config.multiAgentGuidanceEnabled !== false` at runtime so existing valid configs that omit the new field remain enabled. The need for explicit validation/default compatibility follows from **A13** (`src/config.ts:412-419,731-753`).
2. **Management API:** extend `/api/injection-model` GET/PUT with `multiAgentGuidanceEnabled`, using absent → unchanged and boolean → persist. This endpoint already owns `injectionPrompt`, model, and effort (**A14**: `src/server/management-api.ts:1094-1112`), whereas `/api/settings` currently accepts only `codexAutoStart` (**A14**: `src/server/management-api.ts:232-248`). Keeping the flag on the guidance endpoint avoids coupling “off” to `/api/v2` surface transitions.
3. **GUI:** add enabled state and a switch to the Dashboard guidance/injection panel, loaded and saved through `/api/injection-model`. The current state/response type contains model, effort, ladders, and available models but omits both prompt and enable state (**A15**: `gui/src/pages/Dashboard.tsx:194-198,262-269`). The existing Models-page v1/default/v2 control should remain a separate collaboration-surface control, not double as the kill switch.
4. **Injection boundary:** make `multiAgentGuidanceText` return `null` immediately when disabled, before surface-specific v1/v2 behavior; pass a structured options object or a final enabled option from the call site. The current unconditional call is **A12** (`src/server/responses.ts:904-908`). This guarantees false suppresses both v1 Proactive text and v2 model guidance without touching catalog generation, `subagentModels`, effort caps, routing, or `multiAgentMode`.

## Combined fix and regression points

Implement #295 and #300 together because they share the same public configuration and injection boundary, while preserving separate issue classification.

1. **Neutral default copy:** replace the absolute “hidden / not in the schema / never claim” sentence with schema-agnostic wording such as “When the active `spawn_agent` surface supports `model` or `reasoning_effort` overrides, use only models listed for this collaboration surface.” Retain the verified `fork_turns` and self-contained-message rule. Update the stale explanatory comment and the existing test that currently requires the problematic phrase (**A1**: `src/server/responses.ts:214-217`; `tests/multi-agent-compat.test.ts:84-98`).
2. **One effective roster helper:** derive guidance candidates from the final on-disk catalog using the same order and predicates as Codex's described override set: priority ascending, picker-visible, active-surface compatible, then first five. Intersect configured `subagentModels` with that set before adding effort ladders. **A4** supplies OpenCodex's priority intent; **A7-A9** supply the upstream compatibility and cap semantics. Do not mutate the configured list when filtering.
3. **Consistency diagnostics:** at catalog sync or management GET, report configured ids excluded for missing catalog row, hidden visibility, incompatible `multi_agent_version`, or five-item displacement. This makes stale-cache/session cases observable while ensuring the injected roster itself never exceeds the computed accepted/advertised subset. The existing API already returns configured `chosen` separately from `available` (**`src/server/management-api.ts:1174-1202`**: “`return jsonResponse({ chosen: config.subagentModels ?? [], available });`”), so adding derived `advertised`/`excluded` metadata can preserve user intent.
4. **Supported off switch:** add the boolean flow above with default-enabled backward compatibility. When false, return `null` before both surface branches and leave every non-guidance subsystem untouched (**A12**: `src/server/responses.ts:904-908`).

Regression coverage should include:

- `tests/multi-agent-compat.test.ts`: assert the default body omits `hidden`, `not in the schema`, and `never claim`; assert a default-mode v2 roster configured as Sol/GPT-5.5/Terra/Luna emits only Sol/Terra; assert forced-v2/catalog-compatible ordering is capped to the same first five; retain `{{model}}` / `{{effort}}` / `{{roster}}` replacement coverage already present at `tests/multi-agent-compat.test.ts:215-233`.
- `tests/multi-agent-compat.test.ts`: add disabled + v1/max → `null`, disabled + v2 + non-empty roster/injection model → `null`, and true/unset parity cases. Confirm no developer message reaches either parsed messages or raw input; the call-site dual-write behavior is currently covered at `tests/multi-agent-compat.test.ts:325-335`.
- `tests/injection-model-api.test.ts`: add GET/PUT round trip for true/false, absent-key preservation, malformed non-boolean rejection, persisted reload, and confirm existing `prompt: null` / `""` clear semantics remain unchanged (**A11** and `tests/injection-model-api.test.ts:60-74`).
- Catalog/management tests: with guidance disabled, `/api/subagent-models` returns the same `chosen`/`available`, catalog priorities and `multi_agent_version` remain unchanged, and the v2 setting remains unchanged. The separation boundary is evidenced by the current independent `/api/subagent-models` persistence/sync path at `src/server/management-api.ts:1174-1202` and the independent response injection call at **A12**.
- GUI: add the switch's load/save/error-state test if a component harness is introduced; otherwise require `bun run lint:gui`, `bun run build:gui`, and a manual Dashboard smoke proving the switch survives reload and disables logs/injected developer messages without changing the Models-page v2 selection.

## Verdict

**#295 — confirmed OpenCodex bug; keep Bucket 2.** The proxy generates inaccurate absolute schema wording and computes guidance roster membership from catalog resolution rather than the active `spawn_agent` contract (**A1-A9**). The observed Sol/Terra-only runtime result is consistent with the pinned v2 metadata and upstream v2 compatibility filter. Reclassify the issue label to `bug` (multi-agent / guidance), not upstream-only and not needs-repro.

**#300 — confirmed feature request / product gap; keep Bucket 2 and link to #295.** Empty override values cannot represent disabled behavior through the API, and the call site has no boolean gate (**A11-A14**). Reclassify/label as `enhancement` or `feature`; implement in the same change set as #295 but close each issue against its own acceptance tests.

## Recommended direction

Ship one backward-compatible combined change: neutral schema-agnostic default wording; an effective roster derived from Codex-equivalent picker visibility, v2 compatibility, priority order, and five-item cap; diagnostics for configured-vs-advertised exclusions; and `multiAgentGuidanceEnabled` with unset/true = enabled and false = no v1/v2 injection. Put the API/GUI switch on the existing guidance (`/api/injection-model`) surface, not on the v2 collaboration-mode transition. Preserve `injectionPrompt` and `{{roster}}` as an advanced override when guidance is enabled.

## Effort estimate

**Medium: 1–2 engineer days.** The core response change is small, but faithfully deriving the runtime-compatible roster, adding persisted config/API/GUI state and translations, updating focused tests, and running `bun run typecheck`, focused suites, full `bun run test`, `bun run lint:gui`, `bun run build:gui`, and `bun run privacy:scan` make this a cross-surface change rather than a copy-only patch.
