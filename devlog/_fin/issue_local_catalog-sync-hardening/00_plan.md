# Catalog-sync hardening — keep the Codex model picker correct

Diagnosed live (2026-06-29): the on-disk catalog `~/.codex/opencodex-catalog.json`
had only 7 entries (4 supported natives + 3 legacy: gpt-5.3-codex, gpt-5.2,
codex-auto-review) and ZERO routed (kiro/*, opencode-go/*), while the live
`/v1/models` correctly served 9. `ocx sync` re-appended +5 routed → 12 entries.
Two real gaps in `syncCatalogModels` (src/codex-catalog.ts:734).

## Gap A — transient empty routed fetch overwrites good routed
`syncCatalogModels` writes `catalog.models = [...native, ...goEntries]`
unconditionally (codex-catalog.ts:790-797). If `gatherRoutedModels` returns []
(provider fetch empty/flaky/cache miss), the on-disk catalog loses ALL routed
entries and the picker shows only natives — exactly today's symptom.

### Fix A (preserve-on-empty)
Before writing, if `goEntries.length === 0` AND the pre-sync catalog (or its
backup/cache) HAD routed entries, do not blow them away:
- Reuse existing helper `catalogHasRoutedEntries(catalog)` (codex-catalog.ts:513).
- If `orderedGoModels.length === 0` and the prior catalog had routed entries,
  preserve the prior routed entries (carry the existing `"/"` slugs forward)
  instead of writing an empty routed set. Log a one-line warning.
- Net: a transient empty fetch never wipes kiro/opencode-go from disk.

## Gap B — legacy natives persist on disk (picker can show them)
The native-preserve filter (codex-catalog.ts:763) keeps every bare slug:
`.filter(m => !m.slug.includes("/") && !goIds.has(m.slug))`. So legacy/internal
natives (gpt-5.3-codex, gpt-5.2, codex-auto-review) stay in the FILE with
`visibility:"list"`. The live `/v1/models` path filters them via
`filterSupportedNativeSlugs` / `SUPPORTED_NATIVE_OPENAI_SLUGS`, but the on-disk
write path does NOT — so a picker reading the file can surface unsupported natives.

### Fix B (allowlist on disk too)
Add `&& SUPPORTED_NATIVE_OPENAI_SLUGS.has(m.slug)` to the native-preserve filter
so only supported natives are kept on disk. Keep the existing
`nativeOpenAiSlugs()` top-up (codex-catalog.ts:775) which already adds the
supported set. Result: file picker == live /v1/models native set.
- Note: `codex-auto-review` is `visibility:hide` (already hidden); the visible
  offenders are gpt-5.3-codex / gpt-5.2.

## Changed surface
- `src/codex-catalog.ts` `syncCatalogModels` only (one filter clause + one
  empty-routed guard). No signature changes; no other callers affected.

## Tests (tests/codex-catalog.test.ts)
1. Gap B: a catalog containing gpt-5.2 / gpt-5.3-codex → after sync, those are
   absent from `catalog.models`; gpt-5.5/5.4/5.4-mini/5.3-codex-spark remain.
2. Gap A: stub `gatherRoutedModels` → [] with a prior catalog that had routed
   entries → after sync, routed entries are preserved (not wiped).
3. Regression: normal sync with routed models still appends them (existing behavior).

## Verification
- `bun test tests/codex-catalog.test.ts tests/codex-catalog-restore.test.ts`
- `bun x tsc --noEmit`
- Live re-check: `bun run src/cli.ts sync` then confirm the file has routed +
  no legacy natives.

## Risk
- Low-medium. Gap B removes legacy natives from the picker — intended; a user who
  deliberately used gpt-5.2 loses it from the picker (documented; bare id still
  routable if a provider serves it). Confined to syncCatalogModels.
