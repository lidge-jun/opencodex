# 260716 Release train v2.7.21 — plan MOC

## Objective

Ship v2.7.21: sync local dev → origin/dev, integrate PRs #136/#137 onto dev with
hardening follow-ups, verify locally + CI, merge dev → main and → preview, publish
npm `latest` (2.7.21) and `preview` (2.7.21-preview.20260716) via release.yml.

## Repo state snapshot (2026-07-16, verified)

- Local `dev` = `f44dd916`, strictly ahead of `origin/dev` by 5:
  `977c4d5c` fix(claude): guard routed agents from blocked skills,
  `ff0b6896`/`57c18932`/`49e77f32`/`f44dd916` usage-surface-filter unit (docs+feat).
- `origin/dev` == `origin/main` == `origin/preview` == `ee5f6ad2` (release: v2.7.20).
- npm dist-tags: `latest: 2.7.20`, `preview: 2.7.11-preview.20260713`.
- Open PRs (base main): #136 MustangRider `fix/anthropic-passthrough-header-deadline`
  (src/server/claude-messages.ts + tests/claude-messages-endpoint.test.ts);
  #137 Wibias `codex/gui-i18n` (gui-wide i18n enforcement + eslint plugin).
- `git merge-tree --write-tree dev origin/pr/136` → clean; same for pr/137 → 0 conflicts.
- `clearableDeadline` exists on dev at `src/lib/abort.ts:26` (PR 136's import resolves).

## Release machinery (verified from .github/workflows/release.yml + scripts/release.ts)

- release.yml is workflow_dispatch from `main` (dist-tag `latest`, stable semver) or
  `preview` (dist-tag `preview`, version must match `*-preview.*`).
- Gate 1: successful ci.yml run for the exact release commit SHA.
- Gate 2: if files matching `src/service.ts|src/cli.ts|src/cli/index.ts|src/lib/bun-runtime.ts|package.json|bun.lock|service-lifecycle.yml`
  changed since last v-tag → successful service-lifecycle.yml run for the SHA.
  Version bumps touch package.json ⇒ this gate ALWAYS applies; service-lifecycle
  triggers automatically on push (paths include package.json), so pushing the bump
  commit starts it. CAVEAT (audit finding 4): the two path lists are NOT fully
  synchronized — `src/cli.ts` gates release.yml but does not trigger
  service-lifecycle.yml. Harmless for this train (package.json is a real trigger);
  workflow fix is a separate, out-of-scope change.
- `bun scripts/release.ts <version> --tag <t> --publish`: preflight (clean tree,
  typecheck, tests, privacy scan) → bump package.json → commit+push → wait CI →
  dispatch release.yml → watch. Runs on the CURRENT branch.
- Publish is tokenless OIDC trusted publishing; no NPM_TOKEN involved.

## Work-phase map (dependency-ordered; one PABCD cycle each)

| WP | Doc | Deliverable |
|----|-----|-------------|
| WP0 | 000 (this) | roadmap locked, goalplan finalized |
| WP1 | 010_dev_sync.md | origin/dev fast-forwarded to f44dd916 |
| WP2 | 020_pr_integration.md | PRs 136+137 merged into dev + hardening commit, pushed |
| WP3 | 030_verification.md | local gates + CI green on integrated dev |
| WP4 | 040_release.md | main+preview merged, 2.7.21 latest + preview published |

## Constraints / boundaries

- No force-push, no history rewrite on published branches.
- Author credit: integrate PR head commits via `--no-ff` merge so GitHub marks
  #136/#137 merged when their head SHAs become reachable from `main`.
- Sol subagents (`gpt-5.6-sol`) for audit/review lanes (user directive).
- Push/publish pre-approved by user for exactly: origin dev/main/preview + release.yml dispatch.

## Out of scope

- Full response-body occupancy/backpressure redesign (504/499 + size caps) explored in
  the prior Claude session — recorded as follow-up candidate, not in this release train.
  Only the bounded timer-leak fix on the fetch-reject path rides WP2.
