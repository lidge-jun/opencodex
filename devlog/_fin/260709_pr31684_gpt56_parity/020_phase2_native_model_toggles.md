# 020 — WP2: native GPT model on/off toggles

## Design decision
Reuse `config.disabledModels` (single choke point) with BARE slugs for natives —
routed ids are always namespaced `provider/id`, so no key collision. Disabled native
entries are NOT removed from the on-disk catalog; their `visibility` flips to
`"hide"` (codex-rs `ModelVisibility::Hide`) so the template, backup and restore paths
survive, and re-enabling restores `"list"` deterministically on the next sync.

## A-phase fold-back round 2 (same reviewer, VERDICT GO-WITH-FIXES blockers=3)

- **B1 (High, ACCEPTED):** the WP1 upgrade-to-upstream branch returns snapshot entries
  with visibility "list", which would clobber a hide flag. Amendment: compute
  `visibility` once per supported native slug at the top of the map callback and assign
  it on BOTH return paths (upgraded + preserved).
- **B2 (Medium, ACCEPTED — design simplified):** "skip backfill when disabled" made
  re-enable depend on nativeOpenAiSlugs composition for custom catalogs. Amendment:
  do NOT skip — backfill synthesizes the entry normally and sets `visibility: "hide"`
  when disabled. The entry always exists on disk; enable/disable is a pure visibility
  flip, symmetric by construction. Catalog-shaped emissions (on-disk sync AND
  /v1/models?client_version) include hidden entries (codex-rs hides them from the
  picker itself); only the bare OpenAI list shape filters disabled slugs out.
- **B3 (Medium, ACCEPTED):** GUI `allCapped` aggregate counts every group. Amendment:
  compute cap aggregate over routed groups only (native rows excluded).
- Confirmed-good (reviewer): default-path nativeOpenAiSlugs reads the binary bundle,
  so on-disk hide cannot poison the helper input; hidden rows restorable by sync;
  /v1/models both shapes flow through one native slug list; static native rows avoid
  the re-enable chicken-and-egg; subagent available drop of hidden natives harmless;
  GUI groups/collapse/toggles tolerate native rows.

## Diff plan

### 0. P re-verify amendments (post-WP1, 2026-07-09)
- B2 fold-back landed in WP1: `nativeOpenAiContextWindow(slug)` is already exported by
  catalog.ts — management-api uses it (no private map import).
- Testability amendment: `/v1/models` native filtering lives in the server closure, so
  the filter becomes a PURE exported helper `visibleNativeSlugs(config)` in catalog.ts
  (nativeOpenAiSlugs minus bare disabled entries) unit-tested directly; the server
  branch is a one-line consumer. Native GUI rows likewise come from a pure helper
  `nativeModelRows(config)` (slug/disabled/native/contextWindow) unit-tested directly;
  management-api maps it into the /api/models response. New test file
  `tests/native-model-toggle.test.ts` covers helpers + merge-sync visibility both ways;
  no live-server spin needed (wiring is 1-2 lines per endpoint, covered by existing
  server-auth smoke paths).
- i18n: `models.subtitle` copy also updated to mention native GPT toggles (en/ko/zh).

### 1. `src/codex/catalog.ts` (MODIFY)
- NEW `export function disabledNativeSlugs(config: Pick<OcxConfig,"disabledModels">): Set<string>`
  = bare (slash-free) entries of `disabledModels`.
- `mergeCatalogEntriesForSync`: new optional param `disabledNative: Set<string>`
  (default empty).
  - Native `.map` path: for slugs in `SUPPORTED_NATIVE_OPENAI_SLUGS`, set
    `visibility = disabledNative.has(slug) ? "hide" : "list"` (restore path included).
    Non-supported natives keep current dropping behavior.
  - Backfill loop: `if (disabledNative.has(slug)) continue;` (no synthesized entry for
    a disabled slug; re-enable re-backfills next sync).
- `syncCatalogModels`: compute `disabledNativeSlugs(config)` and pass through.
- `buildCatalogEntries`: unchanged (callers filter slugs) — server passes filtered
  native slug list.

### 2. `src/server/index.ts` (MODIFY)
`/v1/models` branch: `const nativeSlugs = nativeOpenAiSlugs().filter(s => !disabledNative.has(s))`
with `disabledNative = disabledNativeSlugs(config)`; applies to BOTH the
client_version catalog shape and the bare OpenAI list shape.

### 3. `src/server/management-api.ts` (MODIFY)
- `GET /api/models`: prepend native rows —
  `{ provider: "openai", id: slug, namespaced: slug, disabled: disabled.has(slug), native: true, contextWindow? }`
  for each of `NATIVE_OPENAI_MODELS` (static supported set — independent of visibility
  flips so a disabled model remains listed for re-enabling); contextWindow from
  `NATIVE_OPENAI_CONTEXT_OVERRIDES` when known. Routed rows unchanged.
- `PUT /api/disabled-models`: unchanged (already accepts arbitrary strings; bare slugs
  flow through). `GET /api/subagent-models`: already filters `!disabled.has(ns)` —
  bare slugs work as-is; add regression test.

### 4. `gui/src/pages/Models.tsx` (MODIFY)
- `ModelRow` gains `native?: boolean`.
- Group sort: "openai" native group pinned first (`groups` memo: native group before
  alphabetic routed groups).
- For the native group: NO allowlist switch, NO context-cap switch (those PUT against
  `config.providers`, which has no "openai" entry); rows render the existing on/off
  Switch only. Header shows `t("models.nativeGroupLabel")` badge next to "openai".
- Existing toggle plumbing (`apply` -> PUT /api/disabled-models with the full merged
  set) works unchanged because disabled state is one Set of strings.

### 5. `gui/src/i18n/{en,ko,zh}.ts` (MODIFY)
`models.nativeGroupLabel` ("OpenAI native" / "네이티브" / "原生") +
`models.nativeHint` one-liner ("Passthrough models served via ChatGPT OAuth; toggling
off hides them from the Codex picker." + translations).

### 6. Tests
- `tests/codex-catalog.test.ts` (or sync-hardening): mergeCatalogEntriesForSync with
  `disabledNative = {"gpt-5.4"}` -> preserved gpt-5.4 entry has `visibility: "hide"`;
  without it -> `"list"` restored; disabled 5.6 slug is not backfilled.
- Server test (existing /v1/models coverage file — locate at B; else new
  `tests/native-model-toggle.test.ts`): bare list + client_version shape exclude
  disabled natives; management /api/models returns native rows with `native: true`
  and disabled flags; subagent-models available excludes disabled bare slugs.

### 7. SoT docs
`docs/codex-app-model-catalog.md` (native toggle mechanism: bare slugs in
`disabledModels`, visibility hide semantics), `structure/03_catalog-and-subagents.md`,
GUI-facing doc lines (docs-site models guide) if they enumerate the Models page.

## Scope boundary
- IN: files above + this unit. OUT: provider allowlist semantics, context caps for
  natives, codex-rs, account pool.

## Accept criteria (activation-grounded)
1. Disable->sync->hide / enable->sync->list test green (activation: the visibility
   branch fires both ways).
2. /v1/models exclusion + /api/models native rows + subagent filter tests green.
3. `bun x tsc --noEmit` exit 0; full `bun test` exit 0; GUI build passes.
4. C-RENDER-GROUNDING-01: dev GUI screenshot shows the native group with toggles;
   observation recorded in D summary (C3: narrative note; screenshot persisted to this
   unit).
5. Docs synced same cycle.
