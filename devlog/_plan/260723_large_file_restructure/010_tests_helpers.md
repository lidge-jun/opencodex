# 010 — Phase 1: tests/helpers extraction + management-block splits

Surface: tests only. Zero src changes. The runner discovers `./tests/`
recursively (`package.json:39` → `bun test --isolate ./tests/`), so new test
files are picked up automatically.

## Existing helpers (do not collide)

- `tests/helpers/fake-chatgpt-jwt.ts:1` → `fakeChatGptJwt`.
- `tests/helpers/isolated-codex-home.ts:5,10` → `IsolatedCodexHome`,
  `installIsolatedCodexHome`.

## Split A — `tests/combos.test.ts` (1286) → keep pure-combo, move management API

The management API block is **18 tests** (corrected from the census "17"),
`tests/combos.test.ts:676-1262`:

1. PUT/DELETE clear only mutated combo cooldowns `:676-704`
2. GET sorted + PUT upserts normalized whole values `:705-734`
3. PUT stores aliases + GET exposes public model `:735-758`
4. PUT rejects invalid/duplicate aliases `:759-778`
5. PUT renames atomically, migrates public refs, clears both ids `:779-869`
6. PUT rename migrates canonical refs when public alias unchanged `:870-895`
7. PUT rename rejects missing source/existing dest `:896-918`
8. PUT alias changes migrate public refs without renaming `:919-935`
9. GET subagent models exposes combo alias `:936-958`
10. GET models round-trips disabled combo alias `:959-1023`
11. PUT clearing alias dedupes migrated refs in stable order `:1024-1044`
12. PUT rejects malformed JSON / non-record / non-string ids `:1045-1067`
13. POST and PATCH cannot create/update combos `:1068-1080`
14. invalid PUT and all-disabled PUT leave config/disk unchanged `:1081-1107`
15. DELETE is own-property safe + removes final combo map `:1108-1122`
16. DELETE refresh retires final managed combo catalog row `:1123-1173`
17. provider deletion guarded by sorted combo deps until cleanup `:1174-1200`
18. PATCH skips disabled member, persists all-disabled, 503 envelope `:1201-1262`

NEW `tests/combo-management-api.test.ts` receives those 18 tests plus the
management-only setup they share:

- `baseConfig` `:40-63`, `withTempHome` `:91-108`, `writeRawConfig` `:110-112`,
  `comboApi` `:114-131`, `comboApiRaw` `:133-143`, `responseJson` `:145-149`.
- The file-wide `afterEach` combo-state cleanup `:151-154` — duplicate it into
  the new file (both files need it once the block moves).

MODIFY `tests/combos.test.ts`: remove `:676-1262`; keep the pure-combo tests
(primitives, request cloning, cooldown/failure policy, deterministic
selection) and whichever of the setup helpers those still use. Re-check
imports after removal (drop now-unused management/filesystem imports).

Decision: the six setup helpers are small and used by BOTH files after the
split. Rather than a third shared module now, COPY them into the new file
(they are test-local fixtures; duplication of a 6-helper fixture block is
acceptable and keeps each test file self-contained). If a later phase wants
them shared, move to `tests/helpers/combo-api.ts` then — out of scope here.

## Split B — `tests/server-auth.test.ts` (2926) → move provider-management validation

The provider-management validation tests are NOT one contiguous block. The
core run is `tests/server-auth.test.ts:349-1280` (17 sub-sections, see
inventory: external forward-auth rejection through provider PATCH field-mask
validation, the field-mask test closing at `:1280`), but further
provider-management tests reappear AFTER the safeConfigDTO test (e.g.
`provider context-cap API persists toggles and annotates model rows` at
`:1296`). Therefore Split B is done by TEST IDENTITY, not a single line range:
at B, enumerate every `test(...)` name in the file and classify each as
management-validation (MOVE) vs auth/safeConfigDTO (STAY). NEW
`tests/management-provider-validation.test.ts` receives that block plus the
shared setup it needs:

- `config` `:31-49`, `canonicalDirect` `:51-57`, `poolProviders` `:59-63`,
  `redirectCanonicalCodexTo` `:65-76`.
- The `beforeEach` isolated-home setup `:78-80` (uses
  `installIsolatedCodexHome`) and the global cleanup/env-restore/
  account-health/temp-dir teardown `:82-98` — replicate into the new file.

STAY in `tests/server-auth.test.ts`:

- Server timeout/auth primitives `:102-166`.
- safeConfigDTO tests `:179-278` and the freeTier-badge test `:1282-1294`
  (verified anchors; `:1263-1280` is still inside the field-mask test and
  MOVES with it).
- `/v1/models` API-auth + Origin `:305-348`.
- Management Origin/CORS + websocket admission/auth `:1433-1678`.
- Routed/direct/pool/API credential propagation `:1802-2919`.

Both files import `handleManagementAPI` (`:29`); the new file keeps that
import. The per-test MOVE/STAY classification (including the post-`:1294`
provider-management tests such as context-cap) is finalized at B against the
real file and recorded in the B-phase commit message; C verifies the
case-name set is preserved (no test deleted, none duplicated).

## Split C — shared SSE helper (small, optional but cheap)

`tests/web-search.test.ts` repeats an inline `text/event-stream` `Response`
stub ~14 times (`:424-1190`) and has a reusable parser `collectSse`
`:218-236`. NEW `tests/helpers/sse.ts` exporting a `sseResponse(events)`
builder + re-export of `collectSse`; refactor web-search stubs to use it.
This is behavior-preserving (same bytes on the wire). If the refactor proves
touchy, DROP this sub-split and keep A+B only (record as a deviation in D).

NOT moved: `nativeTemplate()` (`tests/codex-catalog.test.ts:662-690`) and the
catalog JSON `/models` fetch stubs are catalog-local, not duplicated — leave
them.

## Verification (C)

1. `bun run test` — total pass count must be UNCHANGED (cases moved, not
   deleted). Capture before/after pass counts as evidence.
2. `bun run typecheck`; `bun run privacy:scan`.
3. `rg "test\(" tests/combos.test.ts tests/combo-management-api.test.ts` and
   the server-auth pair — confirm the case-name set is identical pre/post
   (every moved test name appears exactly once across the pair).
4. New files are discovered: confirm they appear in the `bun test` run list.

## Out of scope

No src/ edits. No changes to test assertions or expected values — moves only.
