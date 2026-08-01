# 002 — Investigation: issue #297 catalog clamp removes `max` / `ultra`

Date: 2026-07-23 (Asia/Seoul)  
Repository state inspected: `codex/issue-triage-260723` at `54e0bbf88cebe6a77e0a8584af193cf689680ad6`, identical to `origin/dev` at inspection time.  
Issue: #297, “bug(catalog): clamp in b7ce5aad strips max/ultra from all models regardless of Codex binary version.”

## Executive finding

The reported **mechanism is confirmed**: the final catalog-wide clamp derives one global effort set from every bare-slug entry in the installed Codex binary's bundled catalog, filters every emitted model (including routed models) against that set, and can therefore undo earlier `max` / `ultra` additions. The repository has a focused synthetic test proving exactly that outcome when the probed set ends at `xhigh`.

The reported **current trigger is not confirmed and does not reproduce on this machine**. The installed `codex-cli 0.144.5` bundled catalog contains `max` on all three GPT-5.6 entries and `ultra` on Sol/Terra, so the bare-entry union is all six OpenCodex rungs. The clamp therefore preserves `max` / `ultra` here. Issue #297 does not state the reporter's Codex version or include `codex debug models --bundled` output, so an OpenCodex regression remains conditional on finding a binary whose parser accepts the synthetic labels while its bundled bare entries omit them.

## Evidence and mechanism

### 1. What `codexSupportedReasoningEfforts` scans and derives

The function loads the installed binary's bundled catalog, visits **all models whose `slug` is a string without `/`**, unions every string `supported_reasoning_levels[].effort` and every string `default_reasoning_level`, and returns `null` only when the resulting union is empty. There is no hard-coded native-slug allowlist in this probe.

```ts
// src/codex/catalog.ts:902-916
export function codexSupportedReasoningEfforts(deps: BundledCatalogDeps = {}): Set<string> | null {
  const bundled = loadBundledCodexCatalog(deps);
  if (!bundled) return null;
  const efforts = new Set<string>();
  for (const model of bundled.models ?? []) {
    if (typeof model.slug !== "string" || model.slug.includes("/")) continue;
    const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [];
    for (const level of levels) {
      const effort = (level as { effort?: unknown })?.effort;
      if (typeof effort === "string") efforts.add(effort);
    }
    if (typeof model.default_reasoning_level === "string") efforts.add(model.default_reasoning_level);
  }
  return efforts.size > 0 ? efforts : null;
}
```

The production probe obtains that catalog by invoking `codex debug models --bundled` on the first usable Codex command candidate and requiring a parseable catalog with a native template.

```ts
// src/codex/catalog.ts:713-739
function runCodexDebugModels(command: string, execFile: ExecFile): string {
  const args = ["debug", "models", "--bundled"];
  const invocation = codexExecInvocation(command);
  return execFile(invocation.file, args, {
    encoding: "utf8" as const,
    stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
    timeout: 10_000,
    windowsHide: true,
    shell: invocation.shell,
  });
}

export function loadBundledCodexCatalog(deps: BundledCatalogDeps = {}): RawCatalog | null {
  const useCache = !deps.commandCandidates && !deps.execFileSync;
  if (useCache && bundledCatalogCache && bundledCatalogCache.expiresAt > Date.now()) {
    return bundledCatalogCache.value;
  }
  const candidates = deps.commandCandidates?.() ?? codexCommandCandidates();
  const execFile = deps.execFileSync ?? (execFileSync as unknown as ExecFile);
  for (const command of candidates) {
    try {
      const catalog = parseCatalogJson(runCodexDebugModels(command, execFile));
      if (catalog && findNativeTemplate(catalog)) {
        if (useCache) bundledCatalogCache = { expiresAt: Date.now() + BUNDLED_CATALOG_CACHE_MS, value: catalog };
        return catalog;
      }
    } catch { /* try next candidate */ }
```

On this machine, that exact command path resolved to `/Users/jun/.nvm/versions/node/v24.17.0/bin/codex`; there was no `CODEX_CLI_PATH` override and no OpenCodex shim-state candidate. Read-only runtime evidence was:

```text
$ codex --version
codex-cli 0.144.5

$ codex debug models --bundled | jq <bare-slug projection and effort union>
gpt-5.6-sol       low medium high xhigh max ultra
gpt-5.6-terra     low medium high xhigh max ultra
gpt-5.6-luna      low medium high xhigh max
gpt-5.5           low medium high xhigh
gpt-5.4           low medium high xhigh
gpt-5.4-mini      low medium high xhigh
gpt-5.2           low medium high xhigh
codex-auto-review low medium high xhigh
union             low medium high xhigh max ultra
```

Thus, the exact slugs scanned today are the eight rows above and the derived set is `{low, medium, high, xhigh, max, ultra}`. The reporter's proposed trigger (`{low, medium, high, xhigh}` on a current binary) is false for the locally installed 0.144.5 binary, but this single observation does not establish the bundled catalog of every released or Desktop-embedded Codex version.

### 2. What the entry clamp strips

Given a non-null supported set, the entry clamp retains only levels whose string effort is in that set. If at least one level survives, all unsupported levels are removed; if none survive, it substitutes `low` / `medium` / `high`. It also replaces an unsupported default with the highest surviving effort at or below the original rank (or `medium` for an empty survivor list).

```ts
// src/codex/catalog.ts:930-951
export function clampEntryToCodexSupportedEfforts(entry: RawEntry, supported: Set<string> | null): void {
  if (!supported) return;
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels as Array<{ effort?: string }>
    : null;
  if (levels && levels.length > 0) {
    const kept = levels.filter(level => typeof level?.effort === "string" && supported.has(level.effort));
    entry.supported_reasoning_levels = kept.length > 0
      ? kept
      : CODEX_REASONING_LEVELS
        .filter(level => level.effort === "low" || level.effort === "medium" || level.effort === "high")
        .map(level => ({ ...level }));
  }
  const currentDefault = entry.default_reasoning_level;
  if (typeof currentDefault === "string" && !supported.has(currentDefault)) {
    const surviving = (Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [])
      .flatMap(level => typeof (level as { effort?: string })?.effort === "string"
        ? [(level as { effort: string }).effort]
        : []);
    entry.default_reasoning_level = clampedDefaultEffort(currentDefault, surviving);
  }
}
```

The catalog helper applies that same global set to **every** model without checking whether the slug is native or routed. Therefore a supported set ending at `xhigh` strips `max` / `ultra` from `openrouter/example`, `anthropic/...`, GPT-5.6, and every other reasoning-capable entry alike.

```ts
// src/codex/catalog.ts:953-959
/** Clamp every catalog entry to the reasoning ladder accepted by the installed Codex binary. */
export function clampCatalogModelsToCodexSupport(models: RawEntry[], deps: BundledCatalogDeps = {}): RawEntry[] {
  const supported = codexSupportedReasoningEfforts(deps);
  if (!supported) return models;
  for (const entry of models) clampEntryToCodexSupportedEfforts(entry, supported);
  return models;
}
```

### 3. The clamp can undo the ensure-functions

Both ensure-functions explicitly append the top rungs before final emission. The GPT-5.6 fallback appends `max` and `ultra`; the older-native helper also appends both when a ladder exists.

```ts
// src/codex/catalog.ts:866-878
function ensureGpt56ReasoningLevels(entry: RawEntry): void {
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  const out = [...levels];
  // max is a real native rung on the 5.6 family — always restored; ultra always advertised.
  for (const effort of ["max", "ultra"]) {
    if (out.some(level => level.effort === effort)) continue;
    out.push(CODEX_REASONING_LEVELS.find(level => level.effort === effort)
      ?? { effort, description: `${effort} reasoning` });
  }
  entry.supported_reasoning_levels = out;
}
```

```ts
// src/codex/catalog.ts:885-899
function ensureUltraReasoningLevel(entry: RawEntry): void {
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  if (levels.length === 0) return;
  const wanted = ["max", "ultra"];
  for (const effort of wanted) {
    if (levels.some(level => level.effort === effort)) continue;
    levels.push(
      CODEX_REASONING_LEVELS.find(level => level.effort === effort)
        ?? { effort, description: `${effort} reasoning` },
    );
  }
  entry.supported_reasoning_levels = levels;
}
```

Those helpers run inside catalog construction/merge paths—for example, native derivation invokes them before returning the normalized entry, and preserved older natives invoke the older-native helper before the merged array is returned.

```ts
// src/codex/catalog.ts:1030-1036
      normalizeRoutedCatalogEntry(e, model?.parallelToolCalls === true);
      if (model) applyJawcodeCatalogMetadata(e, model.provider, model.id, model.contextCap);
      applyCatalogModelMetadata(e, model);
    } else {
      applyNativeOpenAiContextOverride(e);
      if (isGpt56NativeSlug(slug)) ensureGpt56ReasoningLevels(e);
      else ensureUltraReasoningLevel(e);
```

```ts
// src/codex/catalog.ts:2066-2070
      const preserved = normalizeServiceTiers({ ...m, priority });
      // Older natives kept from disk still need the mock top tiers (max + ultra always
      // for subagent max spawns; wire-clamped to the model's real top rung).
      if (!isGpt56NativeSlug(slug)) ensureUltraReasoningLevel(preserved);
      return preserved;
```

`syncCatalogModels` calls the catalog-wide clamp only after `mergeCatalogEntriesForSync` has completed, then immediately writes the result. It is therefore the final model mutation in the sync path and can remove the rungs the preceding builders ensured.

```ts
// src/codex/catalog.ts:2200-2208
  // Central WS capability override on the FINAL on-disk catalog (the file Codex reads). Applies to
  // native AND routed so the advertised flag matches the implemented endpoint (phase 120.4) and a
  // native template can never leak supports_websockets while the flag is off.
  const wsEnabled = websocketsEnabled(config);
  catalog.models = mergeCatalogEntriesForSync(catalog.models ?? [], goEntries, baseline, featured, wsEnabled, goIds, template, disabledNativeSlugs(config), gatheredProviderNames, multiAgentMode, exactComboSlugs, hasPhysicalComboProvider);
  clampCatalogModelsToCodexSupport(catalog.models);

  atomicWriteFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
  return { added: goEntries.length, path: catalogPath };
```

### 4. Repository tests prove the mechanism, not today's real trigger

`rg` found the clamp tests only in `tests/codex-catalog.test.ts`. Their bundled catalog is a dependency-injected JSON fixture containing one bare `gpt-5.5`; it is not output captured from an installed Codex binary.

```ts
// tests/codex-catalog.test.ts:1962-1975
describe("Codex reasoning-effort capability clamp", () => {
  function bundledCatalogDeps(efforts: string[]) {
    return {
      commandCandidates: () => ["codex"],
      execFileSync: () => JSON.stringify({
        models: [{
          slug: "gpt-5.5",
          base_instructions: "test",
          supported_reasoning_levels: efforts.map(effort => ({ effort, description: effort })),
          default_reasoning_level: "medium",
        }],
      }),
    };
  }
```

The fixture explicitly proves both branches: an `xhigh`-top probe strips the routed entry's top tiers, while a six-rung probe preserves them.

```ts
// tests/codex-catalog.test.ts:1977-2001
  function routedEntry() {
    return {
      slug: "openrouter/example",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"]
        .map(effort => ({ effort, description: effort })),
      default_reasoning_level: "max",
    };
  }

  test("strips max and ultra when the installed Codex ladder stops at xhigh", () => {
    const models = [routedEntry()];

    clampCatalogModelsToCodexSupport(models, bundledCatalogDeps(["low", "medium", "high", "xhigh"]));

    expect(models[0]!.supported_reasoning_levels.map(level => level.effort))
      .toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("preserves max and ultra when the installed Codex ladder includes them", () => {
    const models = [routedEntry()];

    clampCatalogModelsToCodexSupport(models, bundledCatalogDeps(["low", "medium", "high", "xhigh", "max", "ultra"]));

    expect(models[0]!.supported_reasoning_levels.map(level => level.effort))
      .toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
```

This supports claim (a), the mechanism, unconditionally. It leaves claim (b), the trigger in a particular installed binary, conditional and requiring direct binary output.

## Regression commit intent

`git show b7ce5aad --stat` reports one runtime file and two test files changed (`63` lines in `src/codex/catalog.ts`, `74` in `tests/codex-catalog.test.ts`, and `2` in `tests/google-models-listing.test.ts`; `136 insertions`, `3 deletions`). The commit message states:

```text
fix(codex): clamp catalog reasoning efforts to installed binary's ladder

Adopts the approach from PR #223 by @Bricol1982 with safe-fallback improvements:
when ALL efforts are unsupported, fall back to universal [low,medium,high] instead
of preserving the unsupported ladder. Prevents Codex 0.133.0 catalog parse failure.
```

The present code still describes the boundary as removing efforts the installed binary cannot deserialize, and its fallback intentionally avoids emitting a wholly unsupported ladder.

```ts
// src/codex/catalog.ts:929-941
/** Remove reasoning efforts the installed Codex binary cannot deserialize from one entry. */
export function clampEntryToCodexSupportedEfforts(entry: RawEntry, supported: Set<string> | null): void {
  if (!supported) return;
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels as Array<{ effort?: string }>
    : null;
  if (levels && levels.length > 0) {
    const kept = levels.filter(level => typeof level?.effort === "string" && supported.has(level.effort));
    entry.supported_reasoning_levels = kept.length > 0
      ? kept
      : CODEX_REASONING_LEVELS
        .filter(level => level.effort === "low" || level.effort === "medium" || level.effort === "high")
        .map(level => ({ ...level }));
```

That compatibility goal must be preserved: the original failure occurs while Codex deserializes the catalog, before any request reaches OpenCodex's native or routed wire-clamping logic.

## Evaluation of the reporter's options

### Option A — seed from `CODEX_REASONING_LEVELS`

**Functional effect:** This would keep all six OpenCodex labels regardless of the probed bundled catalog because the constant already contains `max` and `ultra`, and the entry clamp only removes labels absent from `supported`.

```ts
// src/reasoning-effort.ts:4-12
// Descriptions mirror the upstream bundled models.json canonical wording (openai/codex PR #31684).
export const CODEX_REASONING_LEVELS: { effort: string; description: string }[] = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
  { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
  { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
  { effort: "ultra", description: "Maximum reasoning with automatic task delegation" },
];
```

**Correctness and risk:** Reject. Seeding all known labels turns the compatibility clamp into a no-op for the exact labels that broke Codex 0.133.0. Request-time `nativeEffortClamp` cannot make that safe because it is reached only for a request and explicitly distinguishes native wire behavior from routed adapter mapping.

```ts
// src/codex/catalog.ts:270-281
/**
 * Mock-max wire clamp (devlog/260709_v2_gated_ultra): the catalog advertises `ultra`
 * on natives whose REAL upstream ladder stops below max (gpt-5.5/5.4/…); codex-rs
 * converts ultra -> max at its inference boundary, and the ChatGPT backend then
 * rejects `max` for those models ("Invalid value: 'max'"). Returns the model's
 * highest real effort when the requested top-tier effort (max/ultra) is not in the
 * native ladder; null when no clamp is needed (routed slugs, real-max natives,
 * ordinary efforts, unknown slugs).
 */
export function nativeEffortClamp(slug: string, effort: string | undefined): string | null {
  if (!effort || (effort !== "max" && effort !== "ultra")) return null;
  if (slug.includes("/")) return null; // routed models map efforts in their adapters
```

### Option B — version-gate the catalog clamp

**Functional effect:** A gate can preserve the `xhigh` cap for known strict-enum binaries while allowing labels on a binary version proven to deserialize them even if that version's bundled native model rows happen not to advertise them. This is the only proposed option that can preserve the original compatibility boundary and address a genuine parser/catalog mismatch.

**Correctness and risk:** Recommend conditionally. The parser-acceptance threshold must be established from real binaries; `0.133.0` is known strict and local `0.144.5` advertises all six, but this investigation did not establish the first accepting version. The implementation must probe the version of the **same command candidate** whose bundled catalog is used; the current loader loops candidates internally and returns only the parsed catalog, so probing `codex --version` independently could gate against a different installation.

```ts
// src/codex/catalog.ts:725-743
export function loadBundledCodexCatalog(deps: BundledCatalogDeps = {}): RawCatalog | null {
  const useCache = !deps.commandCandidates && !deps.execFileSync;
  if (useCache && bundledCatalogCache && bundledCatalogCache.expiresAt > Date.now()) {
    return bundledCatalogCache.value;
  }
  const candidates = deps.commandCandidates?.() ?? codexCommandCandidates();
  const execFile = deps.execFileSync ?? (execFileSync as unknown as ExecFile);
  for (const command of candidates) {
    try {
      const catalog = parseCatalogJson(runCodexDebugModels(command, execFile));
      if (catalog && findNativeTemplate(catalog)) {
        if (useCache) bundledCatalogCache = { expiresAt: Date.now() + BUNDLED_CATALOG_CACHE_MS, value: catalog };
        return catalog;
      }
    } catch { /* try next candidate */ }
  }
  if (useCache) bundledCatalogCache = { expiresAt: Date.now() + BUNDLED_CATALOG_CACHE_MS, value: null };
  return null;
}
```

**`nativeEffortClamp` interaction:** This separation is sound. The version gate controls catalog deserialization compatibility; after a capable client accepts `max` / `ultra`, old-ladder native requests are still reduced to the snapshot's highest real effort, while routed requests remain owned by provider maps/adapters.

```ts
// src/codex/catalog.ts:279-301
export function nativeEffortClamp(slug: string, effort: string | undefined): string | null {
  if (!effort || (effort !== "max" && effort !== "ultra")) return null;
  if (slug.includes("/")) return null; // routed models map efforts in their adapters
  const entry = UPSTREAM_NATIVE_ENTRIES.get(slug);
  const levels = Array.isArray(entry?.supported_reasoning_levels)
    ? entry.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  if (levels.length === 0) {
    // Not snapshot-covered. gpt-5.6 natives have a REAL max rung (ensureGpt56ReasoningLevels
    // restores it even off-snapshot) -> never clamp. Every other bare native (gpt-5.5/5.4/
    // 5.4-mini/5.3-codex-spark and future old-ladder slugs) really stops at xhigh — the
    // ChatGPT backend error names exactly none..xhigh — so clamp the synthetic top tier.
    return isGpt56NativeSlug(slug) ? null : "xhigh";
  }
  const supported = levels.flatMap(l => typeof l.effort === "string" ? [l.effort] : []);
  if (supported.includes(effort)) return null;
  const rank = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const highest = supported
    .filter(e => rank.includes(e))
    .sort((a, b) => rank.indexOf(a) - rank.indexOf(b))
    .at(-1);
  return highest ?? null;
}
```

Routed mapping separately converts `ultra` to `max`, applies provider aliases, and clamps to configured supported tiers before producing the wire value.

```ts
// src/reasoning-effort.ts:115-135
export function mapReasoningEffort(provider: OcxProviderConfig, modelId: string, requested: string | undefined): string | undefined {
  if (!requested) return undefined;
  if (modelInList(provider.noReasoningModels, modelId)) return undefined;

  // Upstream codex-rs converts ultra -> max before ANY provider request (core/src/client.rs
  // `reasoning_effort_for_request`), so "ultra" must never influence the provider wire — not even
  // through a raw alias. Apply the boundary before alias/clamp resolution.
  const boundary = requested === "ultra" ? "max" : requested;

  const wireMap = reasoningEffortMapFor(provider, modelId);
  if (wireMap && Object.prototype.hasOwnProperty.call(wireMap, boundary)) return wireMap[boundary];

  const supported = configuredReasoningEfforts(provider, modelId);
  const codexEffort = supported !== undefined ? clampToSupportedCodexEffort(boundary, supported) : requestToCodexEffort(boundary);
  if (!codexEffort) return undefined;

  // Belt for the odd config where the supported ladder is ultra-only and the clamp lands on it.
  const wire = codexEffort === "ultra" ? "max" : codexEffort;
  if (wireMap && Object.prototype.hasOwnProperty.call(wireMap, wire)) return wireMap[wire];
  return wire;
}
```

### Option C — run ensure-functions after the clamp

**Functional effect:** Reject. The ensure-functions are native-entry helpers, not a universal routed-model restoration pass. Existing routing construction calls `applyReasoningLevels` for routed entries and calls the ensure-functions only in the native branch, so moving/re-running the ensure-functions does not by itself restore `max` / `ultra` to every routed provider named in the report.

```ts
// src/codex/catalog.ts:1015-1036
    // Routed (namespaced) models inherit the gpt template — correct its OpenAI/GPT identity
    // and advertise the reasoning ladder Codex accepts.
    if (isRouted) {
      // Native id for identity text + metadata lookups — the slug may be an encoded
      // alias (`provider/vendor-model`); the model object carries the native id.
      const modelName = model?.id ?? slug.slice(slug.indexOf("/") + 1);
      if (typeof e.base_instructions === "string") {
        // Proxy-neutral: keep the GPT-5/OpenAI disclaimer but never advertise the opencodex proxy
        // (leaking that into base_instructions is a non-first-party signature → ToS risk).
        e.base_instructions = e.base_instructions.replace(
          CODEX_GPT5_IDENTITY_LINE,
          `You are a coding agent powered by the ${modelName} model. Do not claim to be GPT-5 or made by OpenAI.`,
        );
      }
      applyReasoningLevels(e, model?.reasoningEfforts, model?.defaultReasoningEffort, preserveExact);
      normalizeRoutedCatalogEntry(e, model?.parallelToolCalls === true);
      if (model) applyJawcodeCatalogMetadata(e, model.provider, model.id, model.contextCap);
      applyCatalogModelMetadata(e, model);
    } else {
      applyNativeOpenAiContextOverride(e);
      if (isGpt56NativeSlug(slug)) ensureGpt56ReasoningLevels(e);
      else ensureUltraReasoningLevel(e);
```

**Correctness and risk:** High regression risk. Re-adding labels after the compatibility boundary would send the same unknown enum variants to old strict clients that the regression commit was designed to protect. Wire clamping cannot prevent a catalog parse failure that occurs before a request. Expanding Option C into a universal post-clamp restoration would simply become Option A at a later line and retain the same safety failure.

## Required validation before any code change

1. Obtain the reporter's exact `codex --version`, executable path, and `codex debug models --bundled` bare-slug effort union.
2. Demonstrate the mismatch condition: the client successfully parses a minimal catalog containing `max` / `ultra` while its own bundled bare-entry union omits one or both.
3. For Option B, identify the first parser-capable version with a binary matrix spanning at least known-strict `0.133.0`, the proposed threshold's immediate predecessor, the threshold, and current CLI/Desktop candidates.
4. Add tests tying version and catalog probe results to one command candidate; retain the current synthetic strip, preserve, no-probe, fallback, and default-repair cases.
5. Run `bun run typecheck`, the focused catalog/reasoning tests, and the full `bun run test` suite because the final emission boundary affects native and routed models globally.

## Verdict

**opencodex-bug: conditional, not confirmed on today's inspected binary.** The global stripping mechanism is proven from source and tests. The claimed present-day trigger is disproven for local `codex-cli 0.144.5` and remains unsupported for the reporter because no exact version/bundled-catalog output was provided. The behavior is correct and necessary for a binary such as 0.133.0 whose parser rejects unknown rungs.

Bucket judgment: reclassify #297 from Bucket 2 (“investigate now”) to Bucket 1 (“answer + close / needs exact-version reproduction”). A reply should show the 0.144.5 six-rung union and ask for the three runtime artifacts above; reopen or restore Bucket 2 only if they demonstrate a parser-capable/bundled-ladder mismatch.

## Recommended direction

**Option B, conditionally; no immediate source change without the missing trigger evidence.** If a mismatched binary is demonstrated, version-gate the clamp using a validated parser-acceptance threshold and bind version/catalog probing to the same candidate. This preserves the 0.133.0 safety behavior while allowing capable clients to retain synthetic tiers. Do not use Option A or C: both bypass the catalog-deserialization guard, and C is additionally incomplete for routed entries.

## Effort estimate

**Medium: 0.5–1 engineer day after a reproducible binary/version is available.** The code delta should be small, but establishing the threshold, preventing multi-install candidate skew, adding the binary-version fixture matrix, and running full cross-surface tests dominate the work. If no mismatch evidence is produced, the remaining work is only an evidence-backed issue reply/close (approximately 30 minutes, no code change).
