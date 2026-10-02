# wp1 — carry #6262 (LazyCodex role model picker)

Source: LilMGenius:feat/codex-role-models head `ada7ec14b1`, layer `961a4b569..ada7ec14b1` (18 commits, 39 files, +1636/-31).

## Steps

1. `git switch -c codex/omo-lazycodex-role-models origin/dev` (this branch also carries this unit's docs).
2. Assert `git rev-parse refs/omo/6262` = `ada7ec14b1b089f461e43e208d54750591fd26f9`, then `git cherry-pick 961a4b569512bd568106c4ea67a21a346e002779..ada7ec14b1b089f461e43e208d54750591fd26f9` oldest first (gate 1). On conflict reconcile per gate 3: `dev` additions in i18n catalogs, `scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json`, `structure/clients/integrations.md`; `src/lib/jsonc.ts` (the series only modifies it; it exists unchanged on `origin/dev` and at the pinned base, blob `dda3c392`. An earlier accidental trial cherry-pick in the main checkout hit a modify/delete conflict only because that checkout's local `dev` was stale at `9177663665`; the trial was aborted and the checkout restored).
3. `git diff --check origin/dev...HEAD`; `git merge-tree --write-tree origin/dev HEAD` must be clean.
4. Push; open PR to `dev` titled `feat(codex): pick the model for each LazyCodex agent role (carry #6262)` with the PR template filled, the three-variant table and screenshots from #6262 (LilMGenius pr-assets SHA `d0a29e1c` links), "Carried from #6262 by @LilMGenius", `Co-authored-by: LilMGenius <smsmeee@naver.com>`, Verification "local suites not run (maintainer instruction); hosted CI at exact head", security-review request, and the maintainer-integration record.
5. Wait for every required check on the exact head; fix mechanical carry failures only (escalate otherwise).
6. Squash-merge with the co-author trailer; resolve #6262 open threads with a pointer; leave #6262 open until wp3 closes all three.

## Files (layer L1)

docs-site guides/integrations.md, reference/cli/agents.md; gui i18n ×10, main.tsx, pages/Integrations.tsx, pages/integrations/LazyCodexRoleModels.tsx, styles/lazycodex-role-models.css, tests/lazycodex-role-models.test.tsx; scripts/test-layout/layout.json; skills/ocx/references/01_management_surface.md; src/cli/agent.ts, cli/capabilities.ts, clients/lazycodex.ts, clients/omo-role-models.ts, codex/agent-role-models.ts, codex/prompt-layers/toml-edit.ts, codex/subagent-model-fallback.ts, lib/jsonc.ts, server/management-api.ts, server/management/codex-agent-role-routes.ts, route-registry.ts, sibling-guard.ts; structure/clients/integrations.md, structure/subagents.md; tests cli-headless-parity, lazycodex-detection, omo-role-models, codex-agent-role-models, codex-agent-role-routes; tests/fixtures/test-layout-expected.json.

## Acceptance

- Exact-head required checks all `pass` (`gh pr checks <n> --required`).
- PR diff equals layer L1 plus this unit's docs and any listed "fix(carry)" compatibility commits (no #6269/#6274 files). All shared gates (1–10) in 000_plan.md apply.
- Co-author trailer present in the squash commit on `dev`.
- Conditional paths are covered by the carried tests: no LazyCodex → GET returns no roles and PUT 409 (`tests/server/codex-agent-role-routes.test.ts`); unreadable mirror → `unreadable` (`tests/clients/omo-role-models.test.ts`); escaped/multiline keys (`tests/routing/codex-agent-role-models.test.ts`).
