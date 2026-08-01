# Phase 1: PR #38 dependency/tooling merge

## Goal

Merge PR #38 onto `dev` and verify docs/dashboard/tooling still build.

## Planned Verification

- `bun run typecheck`
- `bun test tests`
- `cd gui && bun run build`
- `cd docs-site && bun run build`

## Notes

PR #38 is low-risk relative to #39. It updates docs-site and GUI dependency lockfiles plus workflow checkout versions.
