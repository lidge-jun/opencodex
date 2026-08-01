# 010 — Phase 1 (wp9-devlog-gitlink-ci-fix)

> DIFFLEVEL-ROADMAP-01: write this doc to full diff-level precision (exact paths,
> NEW/MODIFY/DELETE, before/after diffs) BEFORE P -> A. An empty scaffold does not
> satisfy the rule; the A-phase reviewer FAILS outline-only phase docs.

## MODIFY / NEW / DELETE map

DELETE gitlink:

- `devlog/_chase/_cca`
  - before: `160000 commit 00114bec1b76d985fd33a8a19f91c22ffed88580`
  - after: path absent from tracked tree
- `devlog/_chase/_litellm`
  - before: `160000 commit be4d0d8439ad6bea5b7a310824c74f2df0c73884`
  - after: path absent from tracked tree
- `devlog/_fin/opencode-cursor`
  - before: `160000 commit 6ab2c913e71b21cb660f7692e05c3c458a6c67f1`
  - after: path absent from tracked tree

No `.gitmodules` file should be added because these devlog chase checkouts are
not runtime/build inputs and were tracked by docs/devlog commits without
submodule metadata.

No source files should change.

## TESTS

No code tests are required because this is repository metadata cleanup only.

Metadata checks:

- Confirm pre-fix mismatch:
  `git ls-tree -r origin/dev | awk '$1 == "160000" {print $3, $4}'`.
- Confirm post-fix removal:
  `git ls-files -s | awk '$1 == "160000" {print $2, $4}'`.
- Confirm submodule enumeration no longer fails:
  `git submodule status --recursive`.

## Verification (C)

- `git diff --check origin/dev` — exit 0.
- `git submodule status --recursive` — exit 0.
- `git ls-files -s | awk '$1 == "160000" {print $2, $4}'` — no output.
- `gh pr checks <fix-pr> --watch` or, if direct merge is blocked, record hosted
  checkout status URL.
