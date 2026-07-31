# 10 — Implementation Plan: Provider Context-Cap Toggle

This work-phase implements the design from `00_design.md`.

## User-visible outcome

Every provider group on the Models page gets a `Cap 350k` switch near
`All on` / `All off`. Turning it on saves a provider-level context cap in
opencodex config and refreshes the Codex-visible catalog. Models with a known
context window above 350,000 are advertised as 350,000; models at or below the
cap, and models with no known context metadata, remain unchanged.

## Files to change

- ADD `src/provider-context-cap.ts`
- MODIFY `src/types.ts`
- MODIFY `src/config.ts`
- MODIFY `src/codex-catalog.ts`
- MODIFY `src/server.ts`
- MODIFY `gui/src/pages/Models.tsx`
- MODIFY `gui/src/i18n/en.ts`
- MODIFY `gui/src/i18n/ko.ts`
- MODIFY `gui/src/i18n/zh.ts`
- MODIFY `tests/codex-catalog.test.ts`
- MODIFY `tests/server-auth.test.ts`
- MODIFY `devlog/_plan/260629_provider-context-cap/10_implementation.md`

Do not modify:

- `src/adapters/kiro.ts`
- `tests/kiro-stream.test.ts`

They were dirty before this work-phase and are unrelated to the context-cap UI.

## Implementation details

### `src/provider-context-cap.ts`

Create small pure helpers:

- `DEFAULT_PROVIDER_CONTEXT_CAP = 350_000`
- `providerContextCap(config, provider)`
- `applyProviderContextCap(contextWindow, cap)`
- `setProviderContextCap(config, provider, enabled)`

`applyProviderContextCap()` must only lower known context values. It must return
`undefined` when the original context is unknown.

### `src/types.ts`

Add root config:

```ts
providerContextCaps?: Record<string, number>;
```

This is intentionally separate from provider `contextWindow` and
`modelContextWindows` so toggling off is reversible and does not mutate provider
metadata.

### `src/config.ts`

Extend the root config schema with explicit optional validation:

```ts
providerContextCaps: z.record(z.string(), z.number().positive()).optional()
```

This keeps manually edited `config.json` honest instead of relying only on
`.passthrough()`.

### `src/codex-catalog.ts`

Thread provider caps from `gatherRoutedModels(config)` into each provider model
resolution path:

- configured static models
- live `/models` results
- fresh cache
- stale cache fallback
- jawcode augmentation when provider config metadata adds model windows

Apply the cap after existing provider/model hints so it can lower any known
context window but never invent one.

### `src/server.ts`

Add `GET /api/provider-context-caps` and `PUT /api/provider-context-caps`.

`PUT` behavior:

- require `{ provider: string, enabled: boolean }`;
- validate provider name and existence;
- update `config.providerContextCaps`;
- `saveConfig(config)`;
- `clearModelCache(provider)`;
- refresh the Codex catalog best-effort;
- return `{ ok: true, caps }`.

Extend `GET /api/models` rows with `contextCap` and `contextCapped` so the UI can
show when the cap affected a model.

### `gui/src/pages/Models.tsx`

Load models and provider cap state together. Add a provider header switch:

```tsx
<Switch on={contextCaps[provider] === 350000} ... />
<span>{t("models.cap350k")}</span>
```

Rows with `contextCapped` show a small `350k cap` marker.

### i18n

Add keys:

- `models.cap350k`
- `models.capApplied`
- `models.capSaveFailed`
- `models.contextCapped`

## Verification plan

Run:

```bash
bun test tests/codex-catalog.test.ts tests/server-auth.test.ts
bun x tsc --noEmit
cd gui && bun run build
```

Independent read-only verification must confirm:

- cap lowers >350k models;
- cap does not raise smaller/unknown models;
- API persists on/off state;
- UI sends the correct endpoint payload;
- config schema accepts valid cap maps and rejects invalid cap maps;
- dirty Kiro files remain untouched by this work-phase.

## Build record

Implemented in B phase.

Changed files:

- ADD `src/provider-context-cap.ts`: shared fixed 350k cap constant, cap lookup,
  cap application, and on/off config mutation helpers.
- MODIFY `src/types.ts`: added root `providerContextCaps?: Record<string,
  number>`.
- MODIFY `src/config.ts`: added explicit positive integer schema validation for
  `providerContextCaps`.
- MODIFY `src/codex-catalog.ts`: threaded provider caps through configured,
  live, fresh-cache, stale-cache, and jawcode-augmentation paths; cap metadata
  rides on `CatalogModel`.
- MODIFY `src/server.ts`: added `GET/PUT /api/provider-context-caps`; extended
  `/api/models` rows with `contextCap` and `contextCapped`; provider deletion
  now removes any stale context cap for that provider.
- MODIFY `gui/src/pages/Models.tsx`: loads provider caps, renders a visible
  `Cap 350k` provider switch for every provider group, and marks capped rows.
- MODIFY `gui/src/i18n/en.ts`, `gui/src/i18n/ko.ts`,
  `gui/src/i18n/zh.ts`: added cap UI strings.
- MODIFY `tests/codex-catalog.test.ts`: added cap semantics coverage for wide,
  small, unknown, static no-context, stale cached, and jawcode metadata models.
- MODIFY `tests/config.test.ts`: added explicit config schema validation for
  cap maps.
- MODIFY `tests/server-auth.test.ts`: added API persistence and model-row
  annotation coverage, plus provider-deletion cleanup coverage.

Files intentionally not touched:

- `src/adapters/kiro.ts`
- `tests/kiro-stream.test.ts`

Verification:

- `bun test tests/config.test.ts tests/codex-catalog.test.ts tests/server-auth.test.ts`
  -> 94 pass, 0 fail, 388 expect calls.
- `bun x tsc --noEmit`
  -> exit 0, no diagnostics.
- `cd gui && bun run build`
  -> TypeScript project build and Vite production build succeeded.

Additional B-phase regression correction:

- Independent verifier Newton found that jawcode catalog metadata could restore
  a 1M context window after provider cap logic and that jawcode-appended models
  needed cap metadata before `buildCatalogEntries()`.
- `src/codex-catalog.ts` now passes provider cap metadata into
  `applyJawcodeCatalogMetadata()` and constructs jawcode-appended
  `CatalogModel` objects with official context/input metadata before applying
  provider hints.
- `tests/codex-catalog.test.ts` now locks both regressions:
  - `provider context-cap applies before jawcode catalog metadata reaches Codex`
  - `opencode-go catalog sync appends jawcode rows with provider context-cap metadata`

Fresh evidence logs:

- `/tmp/opencodex-provider-context-cap-tests-final.log`
- `/tmp/opencodex-provider-context-cap-tsc-final.log`
- `/tmp/opencodex-provider-context-cap-gui-build-final.log`
