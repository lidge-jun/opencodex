# 011 — Conflict map (measured)

Method: `git merge-tree --write-tree origin/dev refs/pr/<n>` and the actual cherry-picks in
the carry worktree.

| Layer | Conflicting file | Nature | Resolution |
|-------|------------------|--------|------------|
| L1 | none | `tests/providers/provider-registry-parity.test.ts` auto-merged | — |
| L1 | `tests/codebuddy-adapter.test.ts`, `tests/codebuddy-protocol.test.ts` | Not a git conflict; layout guard (`tests/test-layout.test.ts`) rejects root test files since `260905_test_modularization_and_windows` | Move to `tests/providers/`, rewrite `../src` → `../../src`, `./helpers` → `../helpers`; register in `scripts/test-layout/layout.json` `explicit` and `tests/fixtures/test-layout-expected.json`. Commit `769e4208f`. |
| L2 | `tests/providers/provider-connection-test.test.ts` | Import block: dev moved the file into `tests/providers/`; the PR adds one `setFetchQoderModelsForTests` import against the old path | Keep dev's `../../src` paths, add the Qoder import at the same depth. |
| L2 | `tests/qoder-adapter.test.ts`, `tests/qoder-live-models.test.ts` | Layout guard, as L1 | Same move + registration. Commit `094cb93d0`. |
| L3 | `tests/providers/qoder-adapter.test.ts`, `tests/providers/qoder-live-models.test.ts` | The CN commit edits the same import lines the L2 layout commit moved | Take the CN import set (adds `QODER_CN_PROFILE`, `resolveQoderProfile`) at the new depth. |

Auto-merged without conflict (git content merge, needs the wp2 audit to confirm semantics):
`README.md`, `docs-site/.../guides/providers.md`, `docs-site/.../reference/configuration/providers.md`,
`src/codex/catalog/provider-fetch.ts`, `src/providers/registry.ts`,
`src/server/management/provider-routes.ts`, `tests/adapters/adapter-*-conformance.test.ts`,
`tests/adapters/adapter-registry-authority.test.ts`, `tests/providers/provider-registry-parity.test.ts`.

Known dev-side drift since the PR base (`81a1fc1cc`, 2026-09-03) that touches carried files:
provider namespace ownership (`bbea77a48`), Nous catalog limits (`5cd71ec91`), OrcaRouter
PKCE (`c41232aa5`), keychain restore ownership (`924b65799`), BigModel repairs. The wp2 audit
reads each of these against the carried edits in `provider-fetch.ts`, `model-cache.ts`, and
`registry.ts`.
