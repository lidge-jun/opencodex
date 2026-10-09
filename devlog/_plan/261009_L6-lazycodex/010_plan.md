# L6 LazyCodex role carry — plan

Lane L6 of the 2026-10-09 coordinator round (thread 01a11e2e). One work-phase, one carry PR.

## Problem

Three open PRs by @LilMGenius fix the LazyCodex (Codex-based omo) role-model surface:

| PR | Defect today on `dev` | Change |
| --- | --- | --- |
| #6760 | A dashboard or `ocx agent roles set` pick is mirrored into `codex.agents.<role>.model` in `~/.omo/omo.jsonc`. LazyCodex reads `"[codex]".agents.<role>`; its loader strips the bare `codex` key as unknown, so the mirrored pick never reaches a role. | Read and write the `"[codex]"` key; update messages in 11 locales, docs, structure docs, tests. |
| #6761 | Auto-assign takes a routed model's effort ladder only from the provider row. A row that declares no `reasoningEfforts` yields an empty ladder, so the proposal carries no effort even though the written Codex catalog shows one. | `catalogModelLadders()` reads ladder + default from the written catalog; auto-assign falls back to it. |
| #6762 | The LazyCodex role section sits on the Codex tab, while the user looks for omo settings on the omo tab. | Render `<LazyCodexRoleModels>` on the omo tab only (it already renders nothing unless LazyCodex is detected), separate it visually, update docs. |

Evidence for #6760: LazyCodex 5.1.27 published bundle (`plugins/omo/dist/cli/index.js` at origin/HEAD of the sisyphuslabs marketplace checkout) declares `"[codex]": OmoTypedHarnessConfigSchema` in a `.strict()` top-level schema, reads overrides via `recordAt(recordAt(scope, "[codex]"), "agents")`, and reports unknown top-level keys as `config: <file>: codex ignored (unknown key)`.

## Approach

1. Branch `codex/lazycodex-roles-carry` from `origin/dev` (c15037b324) in `.tmp/lanes/L6-lazycodex`.
2. Cherry-pick the original commits in order #6760 (3), #6761 (1), #6762 (3), keeping their authorship. `git merge-tree` shows each merges cleanly into `dev`.
3. Fold findings from the independent architect review (P) and auditor (A) as separate maintainer commits.
4. A user's existing bare `codex` key is left byte for byte as it is (it may be hand-written). Docs say that LazyCodex ignores it and that it can be removed. No migration.

## Files

- `src/clients/omo-role-models.ts`, `src/clients/lazycodex.ts`, `src/server/management/codex-agent-role-routes.ts` (comments)
- `src/codex/catalog.ts`, `src/codex/catalog/effort.ts`, `src/server/management/codex-role-auto-assign.ts`
- `gui/src/pages/Integrations.tsx`, `gui/src/styles/lazycodex-role-models.css`, `gui/src/i18n/*.ts` (3 keys x 11 locales)
- `docs-site/src/content/docs/guides/integrations.md`, `docs-site/src/content/docs/reference/cli/agents.md`, `structure/clients/integrations.md`, `structure/subagents.md`
- Tests: `tests/clients/omo-role-models.test.ts`, `tests/server/codex-agent-role-routes.test.ts`, `tests/server/codex-role-auto-assign-routes.test.ts`, `gui/tests/integrations-surfaces.test.tsx`. No new test files, so no layout registration.

None of these files is in `tests/fixtures/file-size-baseline.json`; i18n files are exempt.

## Invariants kept

From `devlog/_fin/261001_omo_lazycodex_carry/`: LazyCodex detection still requires `omo@sisyphuslabs` enabled plus `lazycodex-install.json`; the role TOML write still refuses invalid TOML with `invalid_role_file`; the mirror never creates omo.jsonc, never rewrites a file with comments, rejects symlinks and non-regular files, and error text carries no paths or UIDs.

## Verification

Local, minimal (user limit):

```
bun test tests/clients/omo-role-models.test.ts tests/server/codex-agent-role-routes.test.ts tests/server/codex-role-auto-assign-routes.test.ts
(cd gui && bun test tests/integrations-surfaces.test.tsx)
bun test tests/test-layout.test.ts tests/ci-workflows/file-size-ratchet.test.ts
bun run typecheck
bun run structure:check
```

Hosted: exact-head CI on the carry PR (full suite, all platforms). Screenshot of the omo tab section uploaded to `pr-assets` and linked by SHA.

## Out of scope

Merging, closing #6760/#6761/#6762 or commenting on them, pushing to the contributor fork, release. Other lanes (L1-L5, L7).


## Architect review (P, gpt-6-sol, verdict PASS-WITH-FIXES)

| # | Finding | Decision |
| --- | --- | --- |
| 1 | #6760 keeps `{ ...entry, model }`; a strict `OmoAgentDefSchema` could reject an entry carrying an unknown user field, so `written` could be misleading. | **Rebut.** LazyCodex 5.1.27 `validateConfigLayer` strips unrecognized keys at any nested path (`stripUnrecognizedKeys` walks `issue.path`) before `readAgentOverrides` parses the entry, and only an invalid *value* drops the entry. opencodex writes only a string `model`; other fields are the user's. Re-implementing LazyCodex's schema here would couple opencodex to a third-party schema that changes per release. |
| 2 | #6761: a routed row that declares a ladder but no default loses the written catalog default; `mapEffortToLevel` then falls back to the middle rung, which can differ from what Codex shows. | **Fold.** Use the written default when the row has none and it is on the row's ladder. Regression case where middle and default differ. |
| 3 | #6761: `row.reasoningEfforts?.length` treats an explicit `[]` (registry "no effort control") as absent and falls back to the written ladder. | **Fold.** Only an absent `reasoningEfforts` falls back; `[]` stays empty. Regression case. |
| 4 | `structure/subagents.md` auto-assign contract does not mention the catalog fallback. | **Fold.** One sentence in the "Mapping is deterministic code" bullet. |

Fold commit: one maintainer commit on top of the cherry-picks, touching `src/server/management/codex-role-auto-assign.ts`, `tests/server/codex-role-auto-assign-routes.test.ts`, `structure/subagents.md`.

## Audit (A, gpt-6-sol, verdict NEAR-PASS)

The auditor confirmed the finding-1 rebuttal (`OmoAgentsConfigSchema = record(string, OmoAgentDefSchema)`; layer validation strips nested unrecognized keys before `readAgentOverrides`) and the semantics of folds 2 and 3 (the written catalog synthesizes a ladder for an absent declaration and writes none for an explicit `[]`). Two residuals, both folded here:

- Attribution: the fold commit and the PR description carry `Co-authored-by: LilMGenius`, so the squash keeps the credit. The cherry-picked commits keep their original author.
- Guard path corrected to `tests/ci-workflows/file-size-ratchet.test.ts`.
