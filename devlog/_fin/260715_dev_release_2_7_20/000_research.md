# 2.7.20 dev integration and release research

Date: 2026-07-15
Work class: C4 (release surface)

## Loop specification

- Archetype: repair-and-promote release integration
- Trigger: `origin/dev` received maintainer PR #134 while local `dev` retained three unpushed cross-platform fixes
- Goal: preserve both histories, verify the combined candidate, promote it through `dev` -> `main` -> `preview`, and publish `@bitkyc08/opencodex@2.7.20`
- Non-goals: rewrite public history, force-push, redesign PR #134, add dependencies, or broaden the release beyond the five divergent commits
- Verifier: repository prepush gates, GUI lint/build and rendered browser QA, GitHub Cross-platform CI for each pushed release head, release workflow success, npm registry/dist-tag, Git tag, GitHub Release, and clean install smoke
- Stop condition: all three protected branches contain the release commit, npm `latest` is 2.7.20, the tag/release point to that commit, and install smoke succeeds
- Memory artifact: this unit plus GitHub workflow URLs and screenshot paths appended during Check/Done
- Expected terminal outcomes: DONE; NOOP if no new release content; BLOCKED if a correctness/a11y finding, failed gate, moved remote head, or consumed version cannot be resolved safely
- Escalation condition: any requirement for force-push/tag rewrite, destructive cleanup, credential intervention, or accepting a High/Critical finding

## Repository facts

- Base for both divergent lines: `d3f299fa` (`origin/main`, `origin/preview` at research time).
- Remote line: `1379a15b` plus merge `a0e910e1` from PR #134, 19 changed files, 741 additions and 265 deletions. The exact remote head already passed Cross-platform CI run `29411968558`.
- Local line: `fe1a5ea2`, `9eaff979`, `05b0ec81`, 13 changed files, 457 additions and 23 deletions.
- Divergence: local `dev...origin/dev` = 3 ahead / 2 behind. Both lines descend from `d3f299fa`; neither should be dropped.
- Release source of truth: `structure/06_docs-and-release.md`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, and `scripts/release.ts`.
- Current public version: package/npm/GitHub latest = 2.7.19. npm 2.7.20, tag `v2.7.20`, and GitHub Release `v2.7.20` are unused at research time.
- Durable docs convention: existing `devlog/_plan/` is reused; `devlog/` is gitignored, so this unit is local evidence rather than release payload.

## Initial risk inventory

1. History loss: replacing local `dev` with `origin/dev` would discard three unpushed fixes. Mitigation: merge `origin/dev` into local `dev`, never reset or rebase shared history.
2. GUI regression: PR #134 changes the design token foundation, typography, responsive shell, twelve React/CSS surfaces, and a Vite development proxy. Mitigation: changed-file review, token-contract scans, GUI lint/build, multi-viewport screenshots, keyboard/focus and console checks.
3. Cross-platform regression: local commits alter Windows executable resolution, shell spawning, Claude path parsing, and Codex home containment. Mitigation: affected regression suites plus full cross-platform CI.
4. Release race: another maintainer can move `dev` or `main` during validation. Mitigation: fetch and compare exact SHAs before every push/promotion; stop on unexpected movement.
5. Partial public release: npm, tag, and GitHub Release can diverge. Mitigation: use `scripts/release.ts`, verify all four metadata surfaces, and choose a new version rather than rewriting a consumed one.
6. Stale live proxy: the running `ocx` process can keep old code. This release is GUI/cross-platform focused; restart is recorded as an operational follow-up only if live local smoke is used.

## Necessity gate

- Do nothing rejected: new `origin/dev` content is not on `main`/`preview` or npm.
- Delete rejected: both divergent lines contain intentional work and tests.
- Configure-only rejected: branch integration and release metadata require commits/pushes.
- Reuse chosen: existing merge topology, repo-native gates, `scripts/release.ts`, OIDC release workflow, and documented design-system QA contract.

## Search and inspection evidence

- Terms: `release`, `preview`, `npm publish`, `dev/main/preview`, `fontSize`, `fontWeight`, `lineHeight`, `borderRadius`, `OPENCODEX_PROXY_TARGET`.
- Inspected: `package.json`, `scripts/release.ts`, `.github/workflows/release.yml`, `structure/06_docs-and-release.md`, PR #134 metadata/diff, all 19 remote changed-file paths, all 13 local changed-file paths, and the design-system ADR/docs.
- Reuse decision: no new runtime abstraction or dependency is planned. Any repair must stay in the existing GUI token/CSS/component owners or the touched cross-platform modules.

