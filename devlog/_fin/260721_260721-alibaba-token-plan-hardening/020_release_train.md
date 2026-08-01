# 020 Release Train

## Scope

Promote the verified Alibaba Token Plan/Qwen 3.8 changes from `dev` through
`preview` and `main`, then publish the preview and stable npm dist-tags.

## WP2 — Dev release readiness

- Cherry-pick `04e9f854` from `feat/ru_support_1`; this is the exact 13-key Russian
  i18n fix for the current `origin/dev` CI failure.
- Verify `bun run build:gui`, `bun run typecheck`, `bun test --isolate tests`, and
  `bun run privacy:scan`.
- Dispatch a fresh `gpt-5.6-sol` review over `main..dev`, with explicit focus on
  provider correctness, release blockers, branch ancestry, and test adequacy.
- Push `dev`, then require successful `ci.yml` and `service-lifecycle.yml` for the
  exact pushed SHA before promoting to `preview`.

## WP3 — Preview publish

- Use the next unused prerelease `2.7.31-preview.20260721` unless npm or Git tags
  already contain it.
- Run `bun scripts/release.ts 2.7.31-preview.20260721 --publish` on `preview`.
- The helper must pass local preflight, push the release commit, wait for both CI
  workflows, dispatch `release.yml`, and watch it to success.
- Verify `npm view @bitkyc08/opencodex dist-tags --json` points `preview` at the
  new prerelease.

## WP4 — Stable publish and convergence

- Merge `preview` into `main` without rewriting history.
- Run `bun scripts/release.ts 2.7.31 --publish` on `main`.
- Verify the `latest` dist-tag, GitHub Release workflow, exact remote SHAs, and
  intended ancestry among `dev`, `preview`, and `main`.

## Stop conditions

- Stop on unresolved Sol Critical/High findings.
- Stop if either required CI workflow fails for the exact release SHA.
- Stop if npm version/tag/GitHub Release metadata is already partially occupied.
- Preserve a clean worktree throughout; no force pushes.
