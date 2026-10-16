# wp4 — Integration, PR, CI

1. Rebase onto latest `origin/dev`; resolve conflicts.
2. Gates: `bun run typecheck`, `bun run test:changed`, the focused files from wp2/wp3,
   `bun run lint:gui`, `bun run build:gui`, `bun run structure:check`, `bun run privacy:scan`,
   the file-size and test-layout guards, and in gui/: `bun test tests` and `bun run lint:i18n` (A10).
3. Rendered QA screenshots at 1440 and 1170 (settings folded and open); upload to the
   `pr-assets` branch and link by commit SHA. Never commit them to the PR branch.
4. `gh pr create --base dev` with the full template (Summary, Verification, Checklist) and a
   follow-up list for the out-of-scope `gpt-5.6-luna` defaults.
5. Watch exact-head CI; fix branch-caused failures; report unrelated ones.
