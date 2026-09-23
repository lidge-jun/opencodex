# 010 — GPT-6 three-model default roster

## Problem

`DEFAULT_SUBAGENT_MODELS` still ships the Astra-plus-GPT-5.6 roster
(`gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5`). The default
should be exactly `gpt-6-astra, gpt-6-sol, gpt-6-luna`.

## Diff

`src/config/subagent-models.ts`

- `SUBAGENT_MODELS_VERSION` 1 → 2.
- `DEFAULT_SUBAGENT_MODELS = [NATIVE_GPT6_ASTRA_MODEL, NATIVE_GPT6_SOL_MODEL, NATIVE_GPT6_LUNA_MODEL]`.
- Keep the v1 list as a private `V1_DEFAULT_SUBAGENT_MODELS` constant.
- `migrateSubagentModels`: version < 1 runs the existing Astra upgrade (an unset
  list receives the new defaults); then, for version < 2, a stored list that is
  element-for-element equal to `V1_DEFAULT_SUBAGENT_MODELS` becomes the new
  defaults. Any other list — reordered, trimmed, custom, empty — is untouched.
  The version marker is written in both cases so the step runs once.
  The comparison runs after the v1 step. A version-1 list is compared as stored,
  so a reordered version-1 roster is untouched. An unversioned list that the v1
  step itself turns into the exact old default was produced by migration (the
  pre-Astra generated default is the known case), so it continues to the trio.

Consumers (`proxy-env.ts` fresh config, `hub-state.ts`, `claude/agents-inject.ts`,
management routes) read the constant and need no edit.
`rewriteLegacyOpenAiModelList` only rewrites `openai-multi/` ids, so it cannot
disturb the exact-equality check on bare native ids.

Tests. `tests/server/config.test.ts` sits exactly at its file-size cap, so the
"Astra-first subagent upgrade" describe moves into
`tests/routing/subagent-roster-migration.test.ts` (registered in
`scripts/test-layout/layout.json` explicit and
`tests/fixtures/test-layout-expected.json`); the moved block is then edited so
that:

- fresh defaults are the trio at version 2;
- legacy (unversioned) cases keep their v1 results except where the v1 result is
  the old generated default, which continues to the trio;
- a version-1 config holding the exact old default migrates to the trio; a
  version-1 config holding anything else keeps it and only gains version 2;
- the save/load preservation test uses versions 2 and 3.
- "repair does not invent migration version" expects a version-1 config to gain
  version 2 without touching its list.

`tests/server/server-startup-reconcile-resilience.test.ts` asserts the
post-migration roster and version; update to the version-2 outcome.

Docs: `docs-site/src/content/docs/{,fr,ja,ko,ru,tr,zh-cn,zh-tw}/reference/configuration/agents.md`
default cell → `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`; English upgrade
section gains the version-2 rule. Locale pages link to the English anchor.

## Verification

`bun test tests/server/config.test.ts tests/routing/subagent-roster-migration.test.ts
tests/server/server-startup-reconcile-resilience.test.ts tests/routing/subagent-roster-retention.test.ts
tests/test-layout.test.ts tests/test-layout-tooling.test.ts`, the file-size ratchet test,
`bun run test:changed`, `bun run typecheck`, `bun run structure:check`.
