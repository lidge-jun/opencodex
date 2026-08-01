# 00 — Provider Context-Cap Toggle Design

Goal: add a provider-level "Cap 350k" switch to the Models page for every
provider group. The setting is intentionally provider-generic, not Kiro-only.
If a provider has no model above 350,000 context, turning the switch on is a
safe no-op.

## Part 1 — Easy explanation

The Models page already lets a user turn individual models on/off and bulk
enable/disable a provider. This change adds one more provider-level switch:
when it is on, opencodex will advertise that provider's large-context models to
Codex as at most 350k context. Smaller models stay unchanged, and the upstream
request path is not modified. The setting is saved in opencodex config, so it
survives restart and refreshes the Codex model catalog after each toggle.

## Current repository shape

- Runtime/config: `src/config.ts`, `src/types.ts`
- Management API: `src/server.ts`
- Catalog generation: `src/codex-catalog.ts`
- In-memory model cache: `src/model-cache.ts`
- Dashboard UI: `gui/src/pages/Models.tsx`, `gui/src/ui.tsx`,
  `gui/src/i18n/{en,ko,zh}.ts`, `gui/src/styles.css`
- Focused tests: `tests/codex-catalog.test.ts`, `tests/server-auth.test.ts`

Existing docs read:

- `README.md`
- `structure/01_runtime.md`
- `structure/03_catalog-and-subagents.md`
- `structure/05_gui-and-management-api.md`
- `docs/codex-app-model-catalog.md`
- `docs/codex-path-investigation.md`

Existing dirty files observed before design:

- `src/adapters/kiro.ts`
- `tests/kiro-stream.test.ts`

These are unrelated Kiro adapter/stream edits and must not be touched,
staged, reverted, or used as completion evidence.

## Decision

Store provider context caps as root config, not inside
`providers[provider].modelContextWindows`.

```ts
providerContextCaps?: Record<string, number>;
```

Reasoning:

- It preserves original provider/model metadata.
- It makes "off" reversible without reconstructing the old
  `modelContextWindows` map.
- It allows the UI to apply one provider switch without editing every model row.
- It can support a different cap value later without a migration.

The current UI only writes the fixed value `350_000`.

## Behavior contract

- `GET /api/models` returns each model plus:
  - `contextWindow?: number`
  - `contextCap?: number`
  - `contextCapped?: boolean`
- New endpoint:
  - `GET /api/provider-context-caps`
    returns `{ caps: Record<string, number> }`.
  - `PUT /api/provider-context-caps`
    accepts `{ provider: string, enabled: boolean }`.
    When enabled, saves `caps[provider] = 350000`; when disabled, removes the
    provider from the map.
- The endpoint rejects unknown/invalid provider names.
- Each PUT saves config, clears that provider's model cache, and refreshes the
  Codex catalog best-effort just like model visibility changes.
- The Models page shows a `Cap 350k` switch for every provider header, next to
  `All on` / `All off`.
- Providers with no model over 350k still show the switch; enabling it is
  harmless because the catalog cap only lowers existing context windows.

## Catalog cap semantics

Given a model's resolved context window:

```ts
if providerContextCaps[provider] is a positive number:
  contextWindow = min(resolvedContextWindow, cap)
```

Important edge case:

- If a model has no context metadata at all, the cap does not invent `350000`.
  The existing catalog defaulting behavior remains in charge.

This preserves the user's "no-op if nothing exceeds the cap" expectation.

## PABCD work-phase map

### Work-phase 0 — Design PABCD

Files:

- NEW `devlog/_plan/260629_provider-context-cap/00_design.md`

Checks:

- Plan audit verifies real paths and integration points.
- Commit only the design file.

### Work-phase 1 — Implementation PABCD

Files:

- ADD `src/provider-context-cap.ts`
- MODIFY `src/types.ts`
- MODIFY `src/codex-catalog.ts`
- MODIFY `src/server.ts`
- MODIFY `gui/src/pages/Models.tsx`
- MODIFY `gui/src/i18n/en.ts`
- MODIFY `gui/src/i18n/ko.ts`
- MODIFY `gui/src/i18n/zh.ts`
- MODIFY `tests/codex-catalog.test.ts`
- MODIFY `tests/server-auth.test.ts`
- MODIFY `devlog/_plan/260629_provider-context-cap/10_implementation.md`

Checks:

- `bun test tests/codex-catalog.test.ts tests/server-auth.test.ts`
- `bun x tsc --noEmit`
- `cd gui && bun run build`
- Independent read-only implementation audit.

## Diff-level implementation plan

### ADD `src/provider-context-cap.ts`

Exports:

```ts
export const DEFAULT_PROVIDER_CONTEXT_CAP = 350_000;
export function providerContextCap(config: Pick<OcxConfig, "providerContextCaps">, provider: string): number | undefined;
export function applyProviderContextCap(contextWindow: number | undefined, cap: number | undefined): number | undefined;
export function setProviderContextCap(config: OcxConfig, provider: string, enabled: boolean): void;
```

Rules:

- A cap is valid only when it is a finite positive number.
- `applyProviderContextCap(undefined, 350000)` returns `undefined`.
- `applyProviderContextCap(500000, 350000)` returns `350000`.
- `applyProviderContextCap(64000, 350000)` returns `64000`.

### MODIFY `src/types.ts`

Before:

```ts
  /** Routed model ids ("<provider>/<model>") hidden from Codex (excluded from the catalog + /v1/models). */
  disabledModels?: string[];
```

After:

```ts
  /** Routed model ids ("<provider>/<model>") hidden from Codex (excluded from the catalog + /v1/models). */
  disabledModels?: string[];
  /** Provider-level Codex-visible context caps. Values only lower known model context windows. */
  providerContextCaps?: Record<string, number>;
```

### MODIFY `src/codex-catalog.ts`

Before:

```ts
function applyProviderConfigHints(name: string, prov: OcxProviderConfig, model: CatalogModel): CatalogModel {
  void name;
  const contextCap = configuredContextWindow(prov, model.id);
```

After:

```ts
function applyProviderConfigHints(name: string, prov: OcxProviderConfig, model: CatalogModel, providerContextCap?: number): CatalogModel {
  void name;
  const contextCap = configuredContextWindow(prov, model.id);
```

Then apply the provider cap after existing provider/model hints:

```ts
const hinted = { ...model, ... };
const cappedContextWindow = applyProviderContextCap(hinted.contextWindow, providerContextCap);
return cappedContextWindow === hinted.contextWindow ? hinted : { ...hinted, contextWindow: cappedContextWindow };
```

Update `fetchProviderModels()` and stale-cache paths to receive the provider cap
from `config.providerContextCaps`.

### MODIFY `src/server.ts`

Extend `/api/models` rows:

```ts
return { ...m, namespaced, disabled, contextCap, contextCapped };
```

Add `/api/provider-context-caps`:

```ts
GET -> { caps: config.providerContextCaps ?? {} }
PUT body { provider, enabled }
```

On PUT:

- validate `provider` with `isValidProviderName()`;
- require `hasOwnProvider(config.providers, provider)`;
- call `setProviderContextCap(config, provider, enabled)`;
- save config;
- `clearModelCache(provider)`;
- `refreshCodexCatalogBestEffort()`;
- return `{ ok: true, caps }`.

### MODIFY `gui/src/pages/Models.tsx`

Before:

```ts
interface ModelRow { provider: string; id: string; namespaced: string; disabled: boolean }
```

After:

```ts
interface ModelRow {
  provider: string;
  id: string;
  namespaced: string;
  disabled: boolean;
  contextWindow?: number;
  contextCap?: number;
  contextCapped?: boolean;
}
```

Add state:

```ts
const [contextCaps, setContextCaps] = useState<Record<string, number>>({});
```

Load models and caps together.

Header layout:

```tsx
<Switch on={contextCaps[provider] === 350000} ... label={t("models.cap350k")} />
<span className="muted mono">{t("models.cap350k")}</span>
<button>All on</button>
<button>All off</button>
```

Model rows can show a small `350k cap` marker when `contextCapped` is true.

### MODIFY i18n files

Add keys:

- `models.cap350k`
- `models.capApplied`
- `models.capSaveFailed`
- `models.contextCapped`

### MODIFY tests

`tests/codex-catalog.test.ts`:

- cap lowers live metadata from `500_000` to `350_000`;
- cap does not raise `64_000`;
- cap does not invent a value for no-context static models;
- stale cached metadata also receives the cap.

`tests/server-auth.test.ts`:

- GET returns caps map;
- PUT enables a provider cap and persists it;
- PUT disables it and removes the provider from the map;
- unknown provider is rejected;
- `/api/models` includes cap metadata.

## Verification and commit plan

Design commit:

```text
docs(models): design provider context cap toggle
```

Implementation commit:

```text
feat(models): add provider context cap toggles
```

Final verification:

```bash
bun test tests/codex-catalog.test.ts tests/server-auth.test.ts
bun x tsc --noEmit
cd gui && bun run build
```
