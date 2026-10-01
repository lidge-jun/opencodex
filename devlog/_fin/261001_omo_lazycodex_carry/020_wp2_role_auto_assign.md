# wp2 — carry #6269 (role auto-assign)

Source: LilMGenius:feat/codex-role-auto-assign head `6c97ca9a4f`, layer `ada7ec14b1..6c97ca9a4f` (19 commits, 43 files, +2206/-174).

## Steps

1. After wp1 merges: `git fetch origin dev && git switch -c codex/omo-lazycodex-role-auto-assign origin/dev`.
2. Assert `git rev-parse refs/omo/6269` = `6c97ca9a4fdec6c59901fa115be341d9cc590a15` and the wp1 squash SHA is an ancestor of `origin/dev`, then `git cherry-pick ada7ec14b1b089f461e43e208d54750591fd26f9..6c97ca9a4fdec6c59901fa115be341d9cc590a15` (gates 1–3), reconciling in particular `src/server/management/agent-settings-routes.ts` (dev native picker-order acceptance), `src/config/schema/config-schema.ts` and `src/types/config.ts` (dev Codex-credit additions).
3. Line-count check for uncapped files near 2,000 (`agent-settings-routes.ts`).

**Re-verification at P (2026-10-01, dev `a6114b62ed`).** wp1 landed as #6366 with a maintainer security fix (`70f696593c`): `writeCodexAgentRoleModel` validates the role TOML before and after the edit (`invalid_role_file`), and the route answers a fixed `write_failed` message. A probe replay showed the second L2 commit `a0e3ac8d39` (role `model_reasoning_effort` write) conflicts with that fix in `src/codex/agent-role-models.ts` and `tests/routing/codex-agent-role-models.test.ts`. Resolution (gate 3, union, no behavior dropped from either side):
- `AgentRoleModelErrorCode` keeps `invalid_effort` and `invalid_role_file` (plus the existing codes).
- `writeCodexAgentRoleModel`: `assertValidRoleToml(role, before, "before")` → `withModel = setTomlRootModel(...)` → `after = effort === undefined ? withModel : setTomlRootReasoningEffort(withModel, validateAgentRoleEffort(effort))` → unchanged check → `assertValidRoleToml(role, after, "after")` → write.
- Tests: keep the invalid-TOML refusal test and both new effort tests.
Later L2 commits are replayed after this resolution; any further conflict in these two files follows the same union rule. Because the effort path now also passes the after-validation, gate 7 re-review covers the effort writer.
4. PR `feat(codex): auto-assign LazyCodex role models by sizing each role (carry #6269)`; same template/credit/security/integration records; screenshots from #6269 body.
5. Exact-head CI, squash merge, resolve threads.

## Files (layer L2)

As listed by `git diff --name-only refs/omo/6262 refs/omo/6269`: role-auto-assign/sizing modules, local-chat-completion, codex-role-auto-assign routes, LazyCodexRoleAutoAssign.tsx, config schema/types (`codexRoleTiers`), i18n ×10, docs, tests (codex-role-auto-assign, codex-role-sizing, local-chat-completion, codex-role-auto-assign-routes, lazycodex-role-auto-assign GUI), layout maps.

## Acceptance

- Exact-head required checks pass; diff equals L2 plus listed "fix(carry)" commits. All shared gates (1–10) apply; branch only after wp1 squash SHA is an ancestor of origin/dev.
- Without LazyCodex, `POST /api/codex-agent-roles/auto-assign` returns 409 before calling the sizing model (`tests/server/codex-role-auto-assign-routes.test.ts`); oversized sizing response is cut while streaming (`tests/lib/local-chat-completion.test.ts`).
