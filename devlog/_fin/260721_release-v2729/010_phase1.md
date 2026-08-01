# 010 — Phase 1 (release-v2729)
# Phase 1: Merge + Release

## Steps
1. `git checkout main` — switch to main
2. `git merge dev` — fast-forward or merge commit
3. `bun scripts/release.ts 2.7.29 --publish` — runs:
   - tsc --noEmit (typecheck)
   - bun test --isolate tests (full suite)
   - bun run privacy:scan
   - npm version 2.7.29 --no-git-tag-version
   - git commit + push
   - wait CI (ci.yml + service-lifecycle.yml)
   - dispatch release.yml → npm publish
4. Verify: `npm view @bitkyc08/opencodex dist-tags --json` → latest: 2.7.29

## Files changed by this phase
- package.json: version bump 2.7.28 → 2.7.29
- No source code changes (all changes are from dev merge)
> DIFFLEVEL-ROADMAP-01: write this doc to full diff-level precision (exact paths,
> NEW/MODIFY/DELETE, before/after diffs) BEFORE P -> A. An empty scaffold does not
> satisfy the rule; the A-phase reviewer FAILS outline-only phase docs.

## MODIFY / NEW / DELETE map

(fill in: exact file paths with before/after diffs — a copy-paste-executable PRD)

## TESTS

(fill in: test files + cases)

## Verification (C)

(fill in: exact commands + expected exit codes)
