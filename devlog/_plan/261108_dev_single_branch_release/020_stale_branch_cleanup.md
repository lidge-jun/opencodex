# Stale `main`/`preview` reference cleanup

**Trigger:** owner deleted the `main` and `preview` branches on 2026-11-09 and
made `dev` the repository default. This unit already assumed a single-branch
line; the branch deletion leaves references that now address branches that do
not exist, or that describe a default-branch state which has changed.

**Scope:** remove or correct only those stale references. This is a cleanup,
not a CI-policy change.

## What changes

- **Dead workflow triggers.** `.github/workflows/codex-queue-helpers.yml` and
  `.github/workflows/issue-quality-tests.yml` drop `push.branches: [main,
  preview]` and keep `pull_request` (plus `workflow_dispatch` where present).
  `cleanup-orphaned-workflows.yml` drops its one-time `push` on `main` and keeps
  the daily `schedule`; `react-doctor.yml` drops its `push` on `main` and keeps
  the PR scan. No dead push is replaced with a `dev` push — the CI policy
  forbids a `dev` push trigger.
- **Service lifecycle.** `service-lifecycle.yml` narrows PR `branches: [main,
  dev]` to `[dev]`, which still excludes stacked-child head bases exactly as
  before (the old list matched `main`, never stacked heads either).
- **Trusted checkout refs.** `enforce-pr-target.yml` and `pr-hygiene.yml` select
  the trusted script checkout with a fixed `dev` ref. `status` events in
  `enforce-pr-target.yml` keep using `github.event.repository.default_branch`,
  which is now `dev`. PR base/head never selects the ref.
- **Obsolete main-ancestry policy.** `enforce-pr-target.yml`,
  `.github/scripts/pr-quality.cjs` and `pr-quality-messages.cjs` lose the
  `main...head` compare and the `wrong_ancestry` failure built on it. The
  readiness claim check against the PR's own base (`behindBase`,
  `READINESS_LATEST_DEV_BEHIND_MAX`, fail-closed on unknown) is separate policy
  and stays. Stacked-child exemption stays.
- **Comments/docs.** `ci.yml` default-branch comments, workflow loader comments
  in `enforce-issue-quality.yml`, `pr-labeler.yml`, `stale-needs-info.yml`,
  `closed-pr-branch-cleanup.yml`, `AGENTS.md`, `MAINTAINERS.md`,
  `structure/ops/docs-and-release.md`, `structure/desktop-shell.md`, and the
  workflow/doc tests that pin those strings.

## What does not change

Historical `main`/`preview` **tag** mappings, release-lineage policy, the
`protected historical TAG mappings` in release evidence, lidge runner routing,
the PR-only security boundary, the `status` default-branch semantics, stacked
PR support, or the no-`dev`-push / no-PR-macOS-Windows CI policy.

`ci.yml` is edited only in comments. Because the release evidence policy pins
its blob, the final fingerprint entry is appended (history preserved), which
also repairs the pre-existing drift from `28b38f9150` (that commit changed
`ci.yml` without appending a policy entry).

## Verification

Failing-first: the workflow-trigger, trusted-checkout, and ancestry tests are
updated to the intended contract and run red before the implementation. Then:
targeted `node --test` script tests, targeted Bun workflow tests,
`bun run typecheck`, `structure:check`, `test-layout`/ratchet/Lab guards,
`privacy:scan`, `release-evidence.test.cjs` + `policy-check`, and
`actionlint`.

### Recorded results (this branch, based on `28b38f9150`)

Failing-first: the workflow-trigger, trusted-checkout, default-branch and
ancestry contract tests were rewritten to the intended behaviour and run red
against the old tree before the implementation. After the implementation:

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `bun run typecheck` | pass (2,341 files) |
| Privacy | `bun run privacy:scan` | pass |
| Structure SSOT | `bun run structure:check` | pass |
| Lab / ratchet / layout guards | `bun test tests/lab/core-lab-boundary.test.ts tests/ci-workflows/file-size-ratchet.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts` | 63 pass |
| Workflow suite | `bun test tests/ci-workflows` | 1,864 pass, 27 skip, 0 fail |
| Script suites | `node --test` on `pr-quality`, `pr-quality-messages`, `enforce-pr-target`, `pr-hygiene`, `release-evidence` | 195 pass |
| README parity | `bun test tests/ci-workflows/docs-readme-translation-parity.test.ts` and `docs-readme-memory-inventory.test.ts` | 53 + 33 pass |
| Generated client matrix | `bun run docs:clients:check` | current |
| Evidence policy | `node .github/scripts/release-evidence.cjs policy-check` | fingerprints match |
| actionlint | changed workflows | only the two pre-existing findings, identical at `28b38f9150` (3× `SC2016` in `ci.yml`; `copilot-requests` scope unknown to actionlint in `enforce-issue-quality.yml`) |

Consequences: the deleted branch pushes are gone rather than retargeted, so no
`dev` push trigger was added; PR, schedule, and manual coverage is retained.
`react-doctor.yml` loses its per-push health-score trend scan, and
`service-lifecycle.yml` now fans out on `dev`-based pull requests only, exactly
as it already excluded stacked-child bases. The release-evidence policy gains a
new final fingerprint entry (earlier entries untouched), which also repairs the
pre-existing `ci.yml` drift at `28b38f9150`.

The `docs-site` build was run on this tree: 641 pages, 93,177 internal links
checked, Pagefind index built.

Not run: full `bun run test`. This change touches workflows, docs, and
GitHub-script tests; the suites above cover every changed area, and the
repository permits focused validation when a full local run is
disproportionate. CI owns the remainder.
