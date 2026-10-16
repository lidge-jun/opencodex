# wp4 — #1690 retainModels allowlist (two rival PRs)

Issue #1690 (score 58, labels enhancement/catalog). Two open drafts implement it:

| | PR #2860 (rrmlima) | PR #2122 (chilung-cgu) |
| --- | --- | --- |
| size | +132/-2, 3 files | +726/-25, 15 files |
| CI at head | fully green (test 1-4, macos, ci) | only hygiene/label/target ran |
| base | e546c160b, 310 behind dev; cherry-picks cleanly onto `fcf0da257` | same base |
| retention | `shouldRetainConfiguredProviderModel(name, id, prov)` + `modelInList` | new `providerRetainModels` set inside the merge loop |
| ids must also be in `models`? | yes (purely retentive) | no (`retainModels` folded into `configuredIds`) |
| config validation | none (relies on `.passthrough()`) | zod `retainModels` + `nonBlankStringArrayConfigError` |
| management API / DTO | none | none (neither exposes it via PATCH) |
| rename migration | none | adds `retainModels` to `MODEL_ID_LISTS` |
| 404 diagnostic | none | new module state + `warnRetainedModel404Once` wired into 4 request handlers, `CatalogModel.retainedWithoutDiscovery` |
| docs | none | 5 locales, one table row each |

## Decision

Adopt **#2860 as the base commit** (cherry-picked as `2be9d505d` on
`codex/retain-models-1690`), then add the pieces that make the opt-in
discoverable and safe to hand-edit. #2122 is closed as superseded with credit for
the config/migration design.

Why #2860 over #2122: the retention decision belongs in the one predicate the
merge loop already consults; #2122 adds a second set beside it. #2122's 404
diagnostic requires module-level maps keyed by provider, a new `CatalogModel`
field, and edits to `core.ts`, `chat-completions.ts`, `chat-native.ts`,
`claude-messages.ts` — four hot request paths — to print one warning that the
upstream error body already carries (`model_not_found`). That is the wrong
trade for this cycle; the existing `warnDroppedConfiguredIdsOnce` stays as the
diagnostic for ids that are *not* retained.

## What this cycle adds on top of #2860

1. **`retainModels` alone is enough.** `configuredIds` in
   `fetchProviderModelsWithAuth` becomes the ordered union of the Vertex seed,
   `prov.models`, and `prov.retainModels`. An operator who writes
   `"retainModels": ["gemini-3.7-flash"]` should not have to repeat the id in
   `models`; requiring both is the footgun #2122 correctly avoided. #2860's
   "does not invent ids" test flips to assert the union.
2. **Schema + load normalization** (`src/config.ts`): `retainModels:
   z.array(z.string().min(1)).transform(normalizeNonBlankStringArray).optional()`
   next to `noStructuredOutputModels`, plus the same `superRefine` entry so a
   hand-edited `"retainModels": "x"` fails with a path instead of being silently
   passed through.
3. **Management PATCH + DTO** (`src/server/management/provider-routes.ts`):
   `retainModels` accepted like `noStructuredOutputModels` (`null` clears,
   empty array clears, validated with `nonBlankStringArrayConfigError`), and
   returned in the safe provider DTO so the dashboard/API round-trips it.
4. **CLI opt-in** (`src/cli/provider-runtime.ts`):
   `ocx provider edit <name> --retain-models <id,id|->`. This is the easy
   switch: one flag, no JSON editing, `-` clears. Usage string and
   `skills/ocx` surface are regenerated if the capability registry changes
   (it does not — `provider edit` already exists; only the flag list grows).
5. **Rename migration** (`src/providers/model-rename-migration.ts`):
   `"retainModels"` added to `MODEL_ID_LISTS` so a retired id is renamed
   rather than resurrected as a ghost row.
6. **Docs** (`docs-site/.../reference/configuration/providers.md`): one table
   row after `selectedModels`, and a short paragraph in "Static model
   allowlists" contrasting `selectedModels` (narrows) with `retainModels`
   (preserves). English only this cycle; locales already lag on
   `noStructuredOutputModels` and a missing row does not contradict.

## Explicitly not in this cycle

- Seeding `CALLABLE_CONFIGURED_COMPATIBILITY_MODELS` with antigravity
  `gemini-3.7-flash` (issue step 4). That is a product default, and #1683 is a
  separate issue; with the config key available it no longer needs a release.
- GUI field. The dashboard provider editor is untouched; the PATCH contract is
  ready for it, and a later PR can add the input with its screenshot.
- 404-time warning. See "Decision".

## Acceptance criteria

- `retainModels` absent/empty → catalog identical to today (existing
  `tests/codex-catalog.test.ts` retention tests untouched and green).
- `retainModels: ["x"]`, live omits `x`, `x` not in `models` → `x` present
  with provider hints applied; `droppedConfiguredIds` excludes it.
- `retainModels: ["x"]`, live returns `x` → single row, no duplicate.
- `liveModels: false` → `retainModels` ids are part of the static list.
- Config load rejects `retainModels: "x"` / `[""]` with a
  `providers.<name>.retainModels` path; trims and dedupes valid input.
- Management PATCH sets/clears; DTO echoes; CLI flag round-trips through PATCH.
- A test through `fetchProviderModels` (not only `mergeConfiguredModelsIntoLiveCatalog`) proves a retain-only id survives both live discovery and `liveModels: false` (audit r1 blocker 2).
- CLI treats `-` before `csv` so `--retain-models -` clears (audit r1 blocker 3).
- `providerCatalogFingerprint` includes `retainModels`.
- Migration renames a retired id inside `retainModels`.
- `bun x tsc --noEmit` clean, `bun run privacy:scan` clean, focused files:
  `tests/catalog-retain-models.test.ts`, `tests/codex-catalog.test.ts`,
  `tests/management-provider-validation.test.ts`,
  `tests/model-rename-migration.test.ts` (if present), provider-runtime CLI test.

## Files

- `src/codex/catalog/provider-fetch.ts` — configuredIds union (on top of #2860).
- `src/config.ts` — schema + superRefine.
- `src/server/management/provider-routes.ts` — PATCH + DTO.
- `src/server/auth-cors.ts` — `providerManagementConfigError` validation + safe-config DTO key list (audit r1 blocker 1).
- `src/cli/provider-runtime.ts` — `--retain-models`.
- `src/providers/model-rename-migration.ts` — list entry.
- `src/types/provider.ts` — already added by #2860 (doc comment adjusted for union).
- `docs-site/src/content/docs/reference/configuration/providers.md`.
- `tests/catalog-retain-models.test.ts` (extend), `tests/management-provider-validation.test.ts` (extend).

## Closure

PR targets `dev`, `Closes #1690`, description names #2860 as the carried
source commit (`12e69c200`) and #2122 as design input. After landing: close
#1690 with the landing SHA, close #2860 as landed-via-carry (author credited in
the squash trailer), close #2122 as superseded with the reasoning above.
