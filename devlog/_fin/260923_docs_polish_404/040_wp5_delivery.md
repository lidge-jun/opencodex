# 040 wp5 — verification and delivery

1. Rebase check: `git fetch origin dev`; if dev moved, rebase `codex/docs-polish-404` and rerun the parity
   hash (README.md may have moved) and the link guard.
2. Gates, fresh, exit codes recorded: `bun test tests/ci-workflows/docs-link-targets.test.ts` alone, with
   its pass lines counted; `bun run typecheck`;
   `bun test tests/ci-workflows/docs-*.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/ci-workflows/file-size-ratchet.test.ts`;
   `bun run structure:check`; `bun run privacy:scan`; `git diff --check origin/dev...HEAD`;
   `cd docs-site && bun install --frozen-lockfile && bun run build` (the Layer A check verifies every
   internal href, src and rendered fragment); a scratch audit of README/source `https://opencodex.me/…#frag`
   URLs against `docs-site/dist` ids; dist contains
   `guides/macos-menu-bar/index.html` and `guides/desktop-app/index.html` for all eight locales.
   The full `bun run test` runs locally at the rebased head (AGENTS.md default before review readiness);
   its pass/fail/skip counts go into the PR Verification section, with any environment-only failures named.
3. Push `codex/docs-polish-404` to origin and open a PR to `dev` with the repository template (Summary,
   Verification, Checklist). No GUI change, so no screenshot requirement; title and body avoid the word
   "gui".
4. Inspect exact-head CI per job (`gh pr view --json headRefOid,statusCheckRollup`, check-runs API);
   queued, skipped or cancelled is missing evidence.
5. The final report names the live step: after merge, `dev → main` promotion triggers Deploy Docs.

## wp5 P revision

origin/dev is at 6d5d501a6d (two commits past the base, #5595 and #5601), neither touching a file this branch changes. B rebases onto it, reruns the 040 gates at the rebased head, pushes `codex/docs-polish-404` to origin, opens one PR to dev, attaches it, and inspects exact-head CI. The PR body notes: #5593 overlap (identical ISSUE_TEMPLATE line; it appends a Copilot section to English integrations.md that the new ja/ko/ru/zh-cn copies will then lag), #5340 overlap (README and all seven locale READMEs plus the manifest: whichever lands second must regenerate the manifest hash), and that the live 404 was fixed by the approved redeploy (run 35778046041) and future link breaks now fail the docs build.

Reflection fold (Plato): if #5340 lands first, resync its README prose into all seven locale READMEs before recomputing the manifest hash; if #5593 lands first, translate its added English integrations section into the four new locale copies. A test-layout JSON rebase conflict keeps both entries and reruns the layout tests. No screenshot is required: the gate keys on changed gui/ paths (.github/scripts/pr-quality.cjs:540-549), not on the word.
