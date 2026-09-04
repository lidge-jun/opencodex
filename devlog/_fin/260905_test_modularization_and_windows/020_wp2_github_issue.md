# 020 - wp2: the modularization proposal issue

## Class call

C1: one GitHub issue through the feature template. No code.

## Why an issue at all

The user asked for the proposal to be public ("이슈 올리는 pabcd"). The
migration lands as six move PRs plus one tooling PR plus one CI PR; a tracking
issue is where those link back to, and it is the place a contributor with an
open PR touching `tests/` learns why their paths moved.

## Template

`.github/ISSUE_TEMPLATE/feature_request.yml` (Feature proposal). Headings must
stay exactly as generated; `enforce-issue-quality` closes anything else.
Fill it through `gh issue create --template feature_request.yml` is not
supported for forms, so the body is assembled by hand with the form's section
headings copied verbatim from the YAML `label:` fields, then created with
`gh issue create -R lidge-jun/opencodex --title ... --body-file ... --label enhancement`.
Read the YAML first and copy the headings; do not guess them.

## Body (content, to be pasted under the form headings)

Title: `[Feature]: move tests/ into domain directories and shard the macOS CI leg`

Problem
- `tests/` holds 1061 `*.test.ts` files, 1045 of them flat at the root
  (`001_test_inventory.md` §1). 102 exceed 800 lines; the largest is 6807.
- Ownership is by filename prefix only. `rg --files tests | wc -l` is the only
  way to find "the server tests".
- CI: macOS runs the whole suite unsharded and is the critical path on 10/10
  recent green `dev` runs (mean 14.9 min vs Linux max 4.7;
  `003_ci_timing_baseline.md` §2).

Proposal
- Directory taxonomy of 25 domains mirroring `src/` (`030` §2), moved with
  `git mv` in six PRs so history and blame survive.
- A repo-root helper for source-oracle tests, a mover/rewriter/verifier under
  `scripts/test-layout/`, and a layout test that fails when a file is placed
  outside its domain.
- macOS 2-way shard (`--shard=k/2`), unsharded control kept on
  `workflow_dispatch`. Linux stays at 4 (measured: 6/8 saves 0 wall minutes
  while macOS is the CP). Windows stays `workflow_dispatch`-only.

Non-goals
- No test deleted, no assertion weakened, no Windows product change.

Links
- devlog unit `devlog/_plan/260905_test_modularization_and_windows/`
- PRs appended as they open.

## Evidence to capture

Issue URL in `cxc loop meet-criterion --id c-5`.

## Outcome

Filed 2026-09-05 as https://github.com/lidge-jun/opencodex/issues/3497
(`enforce-issue-quality` accepted it: all eight form headings, label
`enhancement`). PR links are appended there as wp3/wp4 open them.
