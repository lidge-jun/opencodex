# Discovered Model Display Names Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable provider scoped display names for discovered models, with safe config handling, catalog propagation, and a management API, without changing routing identity.

**Architecture:** Store operator labels in `providers.<provider>.modelDisplayNames`, keyed by the exact native model ID. Apply the label at the shared provider catalog hint boundary, expose the effective name and source in management rows, and mutate one label through a provider scoped API route that persists safely and converges the Codex catalog.

**Tech Stack:** Bun, TypeScript, Zod, Bun test, OpenCodex management API, Astro documentation.

## Global Constraints

- Base all work on the latest `upstream/dev` commit.
- Keep native provider IDs, model IDs, routed slugs, aliases, pricing, effort metadata, context metadata, modalities, fallbacks, and outbound requests unchanged.
- Operator display names take precedence over trusted provider metadata, which takes precedence over the existing fallback.
- Unknown or temporarily absent model IDs remain stored.
- A reset removes only the selected entry.
- Invalid hand edits degrade entry by entry and must not remove the provider.
- Management writes restore the in memory state if persistence fails.
- Catalog convergence runs exactly once after a successful persistence.
- Do not read or modify the user's live OpenCodex config, credentials, or Codex catalog.
- Write every production behavior test first and observe the expected failure.
- The core pull request and dashboard pull request remain separate.
- Do not push or open a pull request until the user sees the verified result.

---

## File Map

- `src/types/provider.ts`: declares the provider scoped display name map.
- `src/config/provider-validation.ts`: validates exact model ID keys and safe display values.
- `src/config.ts`: adds schema validation and safe load degradation.
- `src/codex/catalog/provider-fetch.ts`: resolves operator display names at the shared catalog boundary.
- `src/server/management/model-rows.ts`: exposes effective display names and their source.
- `src/server/management/model-routes.ts`: sets and resets one provider model display name.
- `tests/provider-config-validation.test.ts`: covers strict validator behavior.
- `tests/config-load-degrade.test.ts`: covers safe hand edited config loading.
- `tests/config-user-edits.test.ts`: covers persistence and concurrent unrelated map edits.
- `tests/codex-catalog.test.ts`: covers label precedence and routing invariants.
- `tests/model-display-names-management-api.test.ts`: covers read and mutation API behavior.
- `docs-site/src/content/docs/reference/configuration/providers.md`: documents the field and exact key rules.
- `structure/02_config-and-codex-home.md`: records the new persisted provider field.
- `structure/03_catalog-and-subagents.md`: records display precedence at catalog assembly.

---

### Task 1: Provider Config Contract

**Files:**
- Modify: `src/types/provider.ts`
- Modify: `src/config/provider-validation.ts`
- Modify: `src/config.ts`
- Test: `tests/provider-config-validation.test.ts`
- Test: `tests/config-load-degrade.test.ts`

**Interfaces:**
- Produces: `OcxProviderConfig.modelDisplayNames?: Record<string, string>`
- Produces: `modelDisplayNamesConfigError(value: unknown, field?: string): string | null`
- Produces: load normalization that trims valid labels and removes only invalid entries.

- [ ] **Step 1: Add failing strict validation tests**

Add table driven tests that call `modelDisplayNamesConfigError` directly. The valid cases are an absent map, an empty plain map, native IDs containing `/`, and a trimmed label up to 128 characters. The invalid cases are an array, a class or prototype shaped object, more than 2,000 entries, blank keys, keys longer than 1,024 characters, nonstring values, blank values, values longer than 128 characters, `/`, and control characters.

Use literal expectations such as:

```ts
expect(modelDisplayNamesConfigError({ "models/grok-4.6": "Grok 4.6" })).toBeNull();
expect(modelDisplayNamesConfigError({ "grok-4.6": "Grok/4.6" })).toContain("must not contain /");
expect(modelDisplayNamesConfigError({ "grok-4.6": "Grok\n4.6" })).toContain("control characters");
```

- [ ] **Step 2: Run strict tests and confirm RED**

Run:

```text
bun test tests/provider-config-validation.test.ts
```

Expected: failure because `modelDisplayNamesConfigError` does not exist.

- [ ] **Step 3: Implement the minimal validator and type**

Add this field beside `modelAliases`:

```ts
/** Display-only labels for exact native model ids discovered under this provider. */
modelDisplayNames?: Record<string, string>;
```

Implement one pure validator using `MODEL_DISCOVERY_MAX_MODELS` and `isValidModelDiscoveryModelId` from `src/providers/model-discovery-limits.ts`:

```ts
export function modelDisplayNamesConfigError(
  value: unknown,
  field = "modelDisplayNames",
): string | null;
```

The validator accepts only a plain own property object, at most 2,000 entries, exact valid model IDs no longer than 1,024 characters, and string labels whose trimmed form is 1 through 128 characters with no `/` or control characters.

- [ ] **Step 4: Run strict tests and confirm GREEN**

Run:

```text
bun test tests/provider-config-validation.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Add failing schema and load degradation tests**

Add tests proving:

```ts
expect(validateConfigCandidate(validConfigWithNames).ok).toBe(true);
expect(validateConfigCandidate(configWithBlankName).ok).toBe(false);
```

Write a real config file fixture containing one valid and one invalid label. Assert that `loadConfig()` keeps the provider and its unrelated fields, trims the valid label, removes the invalid entry, and logs no raw value or secret shaped provider name. Also test a nonobject map and a future absent model ID.

- [ ] **Step 6: Run config tests and confirm RED**

Run:

```text
bun test tests/config-load-degrade.test.ts tests/provider-config-validation.test.ts
```

Expected: the candidate accepts unvalidated values or the load path does not sanitize them.

- [ ] **Step 7: Add schema refinement and safe load sanitizer**

Declare the field in `providerConfigSchema`:

```ts
modelDisplayNames: z.record(z.string(), z.string()).optional(),
```

Call `modelDisplayNamesConfigError` in the outer provider refinement and report the redacted path:

```ts
["providers", redactSecretString(name), "modelDisplayNames"]
```

Add `sanitizeModelDisplayNamesForLoad(parsed)` before `configSchema.safeParse(parsed)`. It must delete a malformed whole map, remove invalid entries one at a time, trim valid values, omit an empty map, and log only redacted provider names and JSON escaped model IDs. It must never log label values.

- [ ] **Step 8: Run config tests and confirm GREEN**

Run:

```text
bun test tests/config-load-degrade.test.ts tests/provider-config-validation.test.ts
```

Expected: all tests pass with no unexpected warnings.

- [ ] **Step 9: Commit the config contract**

```text
git add src/types/provider.ts src/config/provider-validation.ts src/config.ts tests/provider-config-validation.test.ts tests/config-load-degrade.test.ts
git commit -m "feat(config): add discovered model display names"
```

---

### Task 2: Catalog Display Precedence

**Files:**
- Modify: `src/codex/catalog/provider-fetch.ts`
- Test: `tests/codex-catalog.test.ts`

**Interfaces:**
- Consumes: `OcxProviderConfig.modelDisplayNames`
- Produces: `configuredModelDisplayName(provider, modelId): string | undefined`
- Produces: `applyProviderConfigHints` with operator first display precedence.

- [ ] **Step 1: Add failing catalog behavior tests**

Add focused tests that create real `CatalogModel` inputs and assert:

```ts
const output = applyProviderConfigHints("xai", provider, discovered);
expect(output.id).toBe("grok-4.6");
expect(catalogModelSlug(output)).toBe("xai/grok-4.6");
expect(output.displayName).toBe("Grok 4.6");
```

Cover exact case sensitive matching, same native ID under two providers, operator override over provider metadata, metadata fallback when the override is absent, reset fallback, discovery success, stale cache fallback, configured fallback after discovery failure, and repeated gathers. Compare all non display fields before and after, including cost, context, max input, compact limit, modalities, efforts, service tier, priority, alias, and fallback targets. Assert no duplicate routed slug appears. Assert custom model display names remain unchanged.

- [ ] **Step 2: Run catalog tests and confirm RED**

Run:

```text
bun test tests/codex-catalog.test.ts
```

Expected: the discovered row keeps its old metadata or slug instead of the configured label.

- [ ] **Step 3: Implement the exact display resolver**

Add:

```ts
export function configuredModelDisplayName(
  provider: OcxProviderConfig,
  modelId: string,
): string | undefined {
  if (!provider.modelDisplayNames || !Object.hasOwn(provider.modelDisplayNames, modelId)) return undefined;
  const value = provider.modelDisplayNames[modelId];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
```

In `applyProviderConfigHints`, spread the configured display name after the incoming model so it overrides trusted metadata only when present. Do not call `modelRecordValue`, case fold IDs, or use the routed slug as the lookup key.

Add `modelDisplayNames` to `providerCatalogFingerprint`, because `gatherFlightKey` decides which active gather promise may be reused before the full provider graph identity is compared.

- [ ] **Step 4: Run catalog tests and confirm GREEN**

Run:

```text
bun test tests/codex-catalog.test.ts
```

Expected: all catalog tests pass and routing identity stays byte equivalent.

- [ ] **Step 5: Commit catalog propagation**

```text
git add src/codex/catalog/provider-fetch.ts tests/codex-catalog.test.ts
git commit -m "feat(catalog): apply provider model display names"
```

---

### Task 3: Management Read and Mutation API

**Files:**
- Modify: `src/server/management/model-rows.ts`
- Modify: `src/server/management/model-routes.ts`
- Create: `tests/model-display-names-management-api.test.ts`

**Interfaces:**
- Produces: `ManagementModelRow.displayNameSource?: "operator" | "provider" | "fallback"`
- Produces: `ManagementModelRow.displayNameOverride?: string`
- Produces: `effectiveManagementDisplayName(config, model): { displayName: string; displayNameOverride?: string; displayNameSource: "operator" | "provider" | "fallback" }`
- Produces: `PUT /api/providers/:provider/model-display-names`
- Consumes body: `{ modelId: string; displayName: string | null }`

- [ ] **Step 1: Add failing read surface tests**

Use `listManagementModelRows` with a real provider model fixture. Assert the row contains the effective `displayName`, stored `displayNameOverride`, and source `operator`. Test provider metadata source and fallback source separately. Assert serialized rows contain no API key, headers, account email, or unrelated provider config.

- [ ] **Step 2: Run read tests and confirm RED**

Run:

```text
bun test tests/model-display-names-management-api.test.ts
```

Expected: `displayNameOverride` and `displayNameSource` are absent.

- [ ] **Step 3: Add effective name metadata to management rows**

Add one pure helper and use it for routed nonnative rows. Look up the exact provider and native ID. Return:

```ts
displayNameOverride?: string;
displayNameSource?: "operator" | "provider" | "fallback";
```

Use `operator` when the exact configured map owns the ID, `provider` when `CatalogModel.displayName` exists without an override, and `fallback` otherwise. The fallback display name is the existing routed catalog slug, so the read surface always gives the dashboard the exact visible text. Do not add these fields to native OpenAI rows in this core change. Keep custom rows on their existing custom model contract.

- [ ] **Step 4: Run read tests and confirm GREEN**

Run:

```text
bun test tests/model-display-names-management-api.test.ts
```

Expected: read tests pass.

- [ ] **Step 5: Add failing mutation tests**

Call `handleModelRoutes` with real `Request` objects and an in memory config. Cover:

- set trims and stores one label
- set works for a temporarily absent model ID
- reset removes only the target and omits an empty map
- unknown provider returns 404
- malformed JSON, missing fields, blank model ID, blank label, slash, control character, oversized label, and nonstring value return 400
- validation failure does not persist or converge
- successful set and reset persist once and converge once
- persistence failure restores the previous map and does not converge
- convergence failure keeps the persisted label and returns the existing catalog disposition or bounded error pattern
- two sequential updates preserve neighboring entries

Use a persistence seam that clones the actual config snapshot. Assert final state, not only mock call counts.

- [ ] **Step 6: Run mutation tests and confirm RED**

Run:

```text
bun test tests/model-display-names-management-api.test.ts
```

Expected: route returns `null` or 404 because it is not registered.

- [ ] **Step 7: Implement provider scoped mutation route**

Match:

```ts
const displayNameMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/model-display-names$/);
```

Decode the provider, reject the reserved `keys` route, verify provider ownership with `hasOwnProvider`, parse the bounded JSON body, validate the exact native model ID and a one entry map through `modelDisplayNamesConfigError`, and use `null` only for reset.

Build a detached next map and assign it only after validation. Keep a detached copy of the old map. Wrap `persistConfig(config)` in `try/catch`; on failure restore the old field exactly, including absence, then rethrow so the management boundary returns its normal bounded server error. After persistence succeeds, call `convergeCodexCatalog()` once. Read the resulting routed row through `listManagementModelRows(config)` and use `effectiveManagementDisplayName`; if the temporarily absent ID has no row, return the stored operator label or `routedSlug(name, modelId)` as the fallback. Return:

```ts
{
  ok: true,
  provider: name,
  modelId,
  displayName: effectiveDisplayName,
  displayNameOverride: storedNameOrNull,
  displayNameSource,
  catalogRefresh,
}
```

Do not require the model ID to exist in live discovery.

- [ ] **Step 8: Run mutation tests and confirm GREEN**

Run:

```text
bun test tests/model-display-names-management-api.test.ts
```

Expected: all API tests pass.

- [ ] **Step 9: Add concurrent config merge regression**

In `tests/config-user-edits.test.ts`, start with two labels. Change one label in the live config, change the other on disk, call `saveConfigPreservingClaudeCode`, and assert both changes survive. Add a second test where the live writer removes one label while the disk writer adds a different label.

- [ ] **Step 10: Run persistence tests and confirm RED or existing support**

Run:

```text
bun test tests/config-user-edits.test.ts
```

If the first run passes, record that the existing recursive provider merge already satisfies the contract and do not add production merge code. If it fails, make the smallest generic merge correction in `src/config.ts`, then rerun until green.

- [ ] **Step 11: Commit the management API**

```text
git add src/server/management/model-rows.ts src/server/management/model-routes.ts tests/model-display-names-management-api.test.ts tests/config-user-edits.test.ts src/config.ts
git commit -m "feat(api): manage discovered model display names"
```

---

### Task 4: Documentation and Architecture Sync

**Files:**
- Modify: `docs-site/src/content/docs/reference/configuration/providers.md`
- Modify: `structure/02_config-and-codex-home.md`
- Modify: `structure/03_catalog-and-subagents.md`

**Interfaces:**
- Documents: exact native ID keys, precedence, reset behavior, and API contract.

- [ ] **Step 1: Update the provider configuration reference**

Add a short example:

```json
{
  "providers": {
    "xai": {
      "modelDisplayNames": {
        "grok-4.6": "Grok 4.6"
      }
    }
  }
}
```

State that the key is the exact native model ID, not `xai/grok-4.6`, the value is display only, unknown IDs are retained, and removing an entry resets the label.

- [ ] **Step 2: Update structure records**

Add `modelDisplayNames` to the persisted provider field list and record the precedence `operator > trusted provider metadata > fallback`. State that catalog identity and outbound routing never consume the label.

- [ ] **Step 3: Run documentation checks**

Run the repository's existing docs check or Astro build command found in `docs-site/package.json`. Expected: success with no broken links or schema errors.

- [ ] **Step 4: Commit documentation**

```text
git add docs-site/src/content/docs/reference/configuration/providers.md structure/02_config-and-codex-home.md structure/03_catalog-and-subagents.md
git commit -m "docs: explain discovered model display names"
```

---

### Task 5: Full Verification and User Preview

**Files:**
- Review: every file changed by Tasks 1 through 4.
- Do not modify: the user's installed OpenCodex configuration or catalog.

**Interfaces:**
- Produces: test evidence and a disposable preview for the user.

- [ ] **Step 1: Review the complete diff twice**

Run:

```text
git diff upstream/dev...HEAD --check
git diff upstream/dev...HEAD
```

Check exact ID matching, no route identity changes, no secret fields in DTOs, no broad config fallback, and no unrelated changes.

- [ ] **Step 2: Run focused tests**

```text
bun test tests/provider-config-validation.test.ts tests/config-load-degrade.test.ts tests/config-user-edits.test.ts tests/codex-catalog.test.ts tests/model-display-names-management-api.test.ts
```

Expected: all pass.

- [ ] **Step 3: Run repository gates**

```text
bun run typecheck
bun run test
bun run privacy:scan
```

Expected: all pass with no new warnings, failures, secrets, emails, tokens, or personal paths.

- [ ] **Step 4: Run a disposable end to end preview**

Create a temporary config directory outside the repository using the operating system temporary directory. Configure one local fake provider with two discovered models and one operator label. Start the branch build on an unused port, call the real management API, run catalog convergence twice, restart the disposable server, and verify:

```text
effective display name = Grok 4.6
routed slug = xai/grok-4.6
native model id = grok-4.6
second model unchanged
label survives restart and repeated sync
reset restores fallback
temporary discovery failure keeps the stored label
```

The fake provider must receive the unchanged native model ID in a test request. Delete only the disposable temporary directory after the preview.

- [ ] **Step 5: Show the result before submission**

Report the exact test counts, commands, relevant catalog JSON before and after, API request and response examples, and any limitations. Do not push the branch and do not open a pull request until the user explicitly approves the verified result.
