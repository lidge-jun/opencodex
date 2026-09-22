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
   The full `bun run test` is not run locally: the change touches no runtime code and the suites above
   read every changed file; CI runs the full suite at the exact head.
3. Push `codex/docs-polish-404` to origin and open a PR to `dev` with the repository template (Summary,
   Verification, Checklist). No GUI change, so no screenshot requirement; title and body avoid the word
   "gui".
4. Inspect exact-head CI per job (`gh pr view --json headRefOid,statusCheckRollup`, check-runs API);
   queued, skipped or cancelled is missing evidence.
5. The final report names the live step: after merge, `dev → main` promotion triggers Deploy Docs.
