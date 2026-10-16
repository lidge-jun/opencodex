# 020 — wp3: landing

1. `bun run typecheck`
2. `bun run privacy:scan`
3. `bun run test` — PR-ready gate; compare every failure against clean `dev` first.
4. Branch `codex/260904-flagship-native-always-visible` off current `dev`, targeting `dev`.
5. PR with `.github/PULL_REQUEST_TEMPLATE.md` fully filled, naming the pool-routing trade
   explicitly so a multi-account user is not surprised by it.
6. Push `--no-verify` and merge on green CI; both owner-approved for this unit.

`dev` moved four times during the previous unit, so rebase before each push rather than assuming
the branch point is still current.
