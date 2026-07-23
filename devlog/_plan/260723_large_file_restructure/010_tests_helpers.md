# 010 — Phase 1: tests/helpers extraction + management-block splits

Surface: tests only. Zero src changes. The runner discovers `./tests/`
recursively (`package.json:39` → `bun test --isolate ./tests/`), so new test
files are picked up automatically.

## Verified structure (wp1 P stale-check, tree unchanged since wp0)

- `tsconfig.json` has `"include": ["src"]` and NO `noUnusedLocals` —
  **tests are NOT covered by `bun run typecheck`**. Unused imports in a test
  file are therefore harmless. Consequence: each NEW test file copies the FULL
  import header of its source file verbatim; we do NOT hand-partition imports.
  The correctness gate for this phase is `bun test` (every case still runs;
  total pass count unchanged), not tsc.
- `tests/combos.test.ts` (1286 lines, 49 `test()` total) layout:
  - imports `:1-42`; `VALID_COMBO` `:44`;
  - helpers `:46-149`: `baseConfig`:46, `rrConfig`:68, `successfulPicks`:86,
    `withTempHome`:95, `writeRawConfig`:114, `comboApi`:118, `comboApiRaw`:133,
    `responseJson`:145;
  - file-wide `afterEach` (clearComboSelectionState/clearComboTargetCooldowns)
    `:151-154`;
  - `describe("combo namespace primitives", …)` `:156-674` (pure-combo tests,
    inside the describe);
  - **management slice `:676-1286` (to EOF)**: tests #1-17 are top-level
    `test()` calls (`:676-1197`); test #18 ("PATCH skips one disabled member…")
    is wrapped in `describe("supported disabled-provider activation")`
    `:1200-1286`. The `describe("combo namespace primitives")` block closes at
    `:674`, so the cut is clean: keep `:1-674`, move `:676-1286`.

## Existing helpers (do not collide)

- `tests/helpers/fake-chatgpt-jwt.ts:1` → `fakeChatGptJwt`.
- `tests/helpers/isolated-codex-home.ts:5,10` → `IsolatedCodexHome`,
  `installIsolatedCodexHome`.

## Split A — `tests/combos.test.ts` (1286) → keep pure-combo, move management API

The management API block is **18 tests** (corrected from the census "17"),
`tests/combos.test.ts:676-1286` (the slice runs to EOF; the final test is
wrapped in `describe("supported disabled-provider activation")` `:1200-1286`):

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
17. provider deletion guarded by sorted combo deps until cleanup `:1174-1197`
18. PATCH skips disabled member, persists all-disabled, 503 envelope `:1201-1285` (inside describe `:1200-1286`)

NEW `tests/combo-management-api.test.ts` receives those 18 tests plus the
management-only setup they share (copy verbatim from combos.test.ts):

- the FULL import header `:1-42` (unused imports are harmless — see above);
- the ENTIRE const+helper+afterEach region `:44-154` verbatim — `VALID_COMBO`
  `:44`, `baseConfig` `:46`, `rrConfig` `:68`, `successfulPicks` `:86`,
  `withTempHome` `:95`, `writeRawConfig` `:114`, `comboApi` `:118`,
  `comboApiRaw` `:133`, `responseJson` `:145`, and the `afterEach` `:151-154`.
  `VALID_COMBO` is USED by the management tests (`:680, :741, :762, :770, :876,
  :884, :900, :906-907, :926, :928, :940, :963, :986, :1006, :1029, :1034,
  :1059, :1074, :1086, :1095, :1100, :1113, :1152, :1179-1180`), so it MUST be
  copied. `rrConfig`/`successfulPicks` are describe-block-only but are copied
  anyway (harmless — tests are not typechecked). Copying the whole `:44-154`
  region verbatim is the simplest correct approach.

MODIFY `tests/combos.test.ts`: keep `:1-674` (imports, all helpers, afterEach,
and the `describe("combo namespace primitives")` block `:156-674`); remove
`:675-1286` (management slice `:676`→EOF `:1286`). No import/helper pruning.

Decision: NEW file = lines `:1-154` (imports + VALID_COMBO + all helpers +
afterEach) verbatim, then lines `:676-1286` (management slice) verbatim.
Duplication keeps each file self-contained; since tests are not typechecked,
unused members carry no cost. A shared `tests/helpers/combo-api.ts` is a
later-phase option, out of scope here.

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
