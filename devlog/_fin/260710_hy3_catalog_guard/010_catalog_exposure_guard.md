# WP1 — OpenCode Go HY3 Catalog Exposure Guard

## Outcome

An exact `opencode-go/hy3-preview` row from any catalog source is removed at the final
routed exposure boundary. Future OpenCode Go rows and the same id under another
provider remain visible.

## Diff-level file map

### MODIFY `tests/provider-live-models.test.ts`

1. Add a behavior-named regression under the existing live-discovery describe block.
2. Configure both `opencode-go` and a generic provider with live discovery enabled.
3. Stub `globalThis.fetch` with schema-valid responses that include:
   - `opencode-go`: `hy3-preview`, a known good row, and `future-live-model`;
   - generic provider: `hy3-preview`.
4. Call the public `gatherRoutedModels` seam and assert:
   - `opencode-go/hy3-preview` is absent;
   - `opencode-go/future-live-model` and the known good row are present;
   - `<generic>/hy3-preview` remains present.
5. Clear both provider caches during teardown so the conditional branch is activated
   by the mocked response on every run.

Baseline/red expectation: the new test fails before production changes because the
current successful live mapper accepts `opencode-go/hy3-preview` and the existing media
filter does not match it.

### MODIFY `src/codex/catalog.ts`

1. Near the existing routed catalog policy constants, add a private `Set` containing
   the exact namespaced pair `opencode-go/hy3-preview`, with issue/upstream mismatch
   context and removal criteria.
2. Extend private `shouldExposeRoutedModel` to reject a model when
   `${model.provider}/${model.id}` is in that set before applying existing media-model
   logic.
3. Reapply the same exact-slug policy to `mergeCatalogEntriesForSync` after its
   empty-refresh and absent-provider preservation branches. This prevents a stale
   on-disk routed entry from bypassing the gathered-model filter and being copied back
   into Codex's cache.
4. Do not modify live fetching, caching, jawcode augmentation, user `disabledModels`,
   user `selectedModels`, or request routing.

### MODIFY `tests/codex-catalog-sync-hardening.test.ts`

Add a regression with a pre-existing on-disk `opencode-go/hy3-preview` entry and an
empty routed refresh. Assert the compatibility-excluded row is removed while ordinary
pre-existing routed rows are preserved. This activates the preservation branch that
the live-discovery regression cannot cover.

### MODIFY `structure/03_catalog-and-subagents.md` (C-phase SOT sync)

Add one shared-catalog bullet documenting that exact provider/model compatibility
exclusions run after live discovery and metadata augmentation so upstream-advertised but
uncallable rows do not enter dashboard or Codex pickers. Keep implementation-specific
HY3 chronology in this devlog rather than the general SOT.

## Conditional-path activation evidence

The new namespaced guard is conditional. C must run both focused regressions: the live
mock must actually return the blocked row and observe the blocked exact pair, preserved
future sibling, and preserved unrelated-provider same id; the disk-sync fixture must
start with a stale blocked row, activate the empty-refresh preservation branch, and
observe that ordinary routed rows survive while HY3 does not. A green suite without
both fired-path tests is insufficient.

## Verification gates

1. Red proof before implementation:
   `bun test tests/provider-live-models.test.ts --test-name-pattern 'HY3 compatibility'`
   must fail on the blocked-pair assertion.
2. Focused green: rerun the same command after implementation.
3. Disk-preservation red/green proof:
   `bun test tests/codex-catalog-sync-hardening.test.ts --test-name-pattern 'compatibility-excluded'`.
4. Affected suite:
   `bun test tests/provider-live-models.test.ts tests/codex-catalog.test.ts tests/codex-catalog-sync-hardening.test.ts tests/selected-models.test.ts tests/codex-catalog-golden.test.ts`.
5. Static gate: `bun run typecheck`.
6. Full gate: `bun test ./tests/`.
7. Independent C review of the final diff, dirty-worktree isolation, test activation,
   and issue-comment accuracy.
8. Publication isolation gate: stage complete new/test/doc files normally, but stage
   only the exact HY3 exposure-policy hunk from `src/codex/catalog.ts` (interactive or
   index-only patch). Before commit, inspect `git diff --cached` and prove it contains
   only this unit's guard/test/SOT changes; then inspect `git diff -- src/codex/catalog.ts`
   and prove the pre-existing dated-alias hunks remain unstaged.

## Acceptance criteria

- The exact OpenCode Go HY3 pair cannot appear in gathered/dashboard/catalog model
  lists even when a valid live response advertises it.
- Other OpenCode Go live rows, including previously unknown future ids, remain exposed.
- `hy3-preview` remains exposed for a generic provider, proving the policy is not global.
- Existing cache/fallback/augmentation/allowlist semantics and direct routing are unchanged.
- Typecheck, affected tests, and full suite pass from the dirty baseline.
- Only this unit's hunks/files are staged and published. The pre-commit evidence must
  show both sides of the isolation boundary: an exact scoped `git diff --cached` and
  the unrelated dated-alias `src/codex/catalog.ts` diff still present only in the
  unstaged worktree; all other user changes remain unstaged and unmodified.
- The existing inaccurate #82 reply is corrected with the actual live-catalog cause,
  the published fix commit, verification evidence, and the issue is closed completed.

## Rollback

Remove the exact set member, regression, and SOT bullet in one revert after confirmed
authenticated evidence shows `hy3-preview` is consistently supported by Console Go.
No config migration or persisted-state cleanup is required.
