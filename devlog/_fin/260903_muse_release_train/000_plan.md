# 260903 — Muse release train: regression review, provider mark, v2.41.0

## Why this unit exists

`origin/dev` is 36 commits ahead of `origin/main`, which still carries
`v2.40.0` (published 2026-09-02). Three of those commits are the Meta/Muse
line that landed today:

- `878f75417` (#3317) — Muse Spark 1.3 registered on the 1.2 spec.
- `ff1ac6b8c` (#3321) — the direct Meta Model API provider (`meta-model`).
- `1aa839aa8` (#3337) — the `meta-muse` provider importing the Muse Code CLI
  credential behind a Terms-of-Service warning.

The user asked for three things, in order: regression-review the 36-commit
delta against `main`, give Muse a provider mark in the dashboard, and run the
release through to a published Meta/Muse-carrying version.

## Constraints that shape every phase

- **No local full suite.** `bun run test` and a bare `bun test` are forbidden
  for this unit. Verification is focused `bun test <file>`, `bun run typecheck`,
  and exact-SHA GitHub CI (`ci.yml` + `service-lifecycle.yml`).
- That constraint is load-bearing on the release path. `scripts/release.ts`
  runs the whole suite in its preflight, so the helper cannot be used here.
  The release therefore takes the manual path the helper would otherwise
  automate: bump on the release branch, wait for both exact-SHA workflows,
  then `gh workflow run release.yml` with `version`/`tag`/`expected-sha`.
- `--no-verify` pushes are authorized; PRs target `dev` and merge with admin
  once CI is green.
- `main` and `preview` carry rulesets requiring a pull request. Promotion is
  by PR, not by push.

## Work phases

| Phase | Doc | Deliverable |
|-------|-----|-------------|
| wp0 | this unit | roadmap + review method (docs only) |
| wp1 | `010_wp1_regression_review.md` | per-commit regression record for all 36 commits |
| wp2 | `020_wp2_muse_mark.md` | Meta/Muse SVG + `provider-icons.ts` wiring |
| wp3 | `030_wp3_preview_release.md` | `preview` dist-tag publish, exact-SHA proof |
| wp4 | `040_wp4_main_release.md` | `latest` dist-tag publish, ancestry proof |

wp1 and wp2 are independent of each other and both gate wp3. wp4 consumes
wp3's published preview.

## Review method (wp1)

A 36-commit delta is too large to re-derive from scratch, and re-reading every
diff line would produce a document nobody checks. The review is risk-classed
instead, and the class decides what evidence is required:

- **R0 docs-only** — `devlog/` or `docs-site/` only. Evidence: the diff touches
  no runtime path. No test needed.
- **R1 scoped runtime** — one subsystem, covered by a focused test file that
  already exists. Evidence: the focused test passes at the dev head.
- **R2 cross-cutting** — touches routing, the model catalog, release
  automation, or a shared contract. Evidence: focused tests plus a read of the
  seam the change crosses.
- **R3 credential/security** — auth, tokens, OAuth, keychain, workflow
  permissions. Evidence: line-level read of the credential path plus
  `privacy:scan`.

The Muse commits are R2 (#3317, #3321) and R3 (#3337).

Three more are R3, corrected after audit round 1 (`005`): `7ce0ba518` (#3262)
grants `contents: write` and `pull-requests: write` to a reusable-workflow
call, `7a529a2e8` (#3318) changes `pull_request_target` processing — a declared
trust boundary in `.github/AGENTS.md` — and `3c7c021ec` (#3296) touches
provider credential admission. A workflow-permission grant is a credential
change even when the diff reads like plumbing, which is the hole the first
draft of this table had.

## What "done" means here

`main` carries the reviewed dev SHA, npm `latest` resolves to the stable
version built from it, and `ocx` users installing fresh get Muse Spark 1.3
plus both Meta providers with a real mark in the dashboard.
