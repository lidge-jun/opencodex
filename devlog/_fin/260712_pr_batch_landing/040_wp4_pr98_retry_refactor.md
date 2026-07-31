# WP4 — Land #98 (shared upstream retry/error refactor) as-is

Reviewer: MERGE-WITH-NITS (behavior-equivalent; nit = adapter-level regression tests, deferred).
No code changes. After #96+#97 merge, effective diff = `6bb3aecf` only.

## Steps

1. If GitHub reports conflicts post-predecessor-merges: merge origin/main into fork branch, push.
2. Local check on branch tip: `bun test tests/upstream-retry.test.ts tests/upstream-http-error.test.ts` + full `bun test`.
3. Checks green → `gh pr ready 98` → `gh pr merge 98 --merge`.

## Accept criteria

- c5: full suite 0 fail; #98 MERGED.
- Expected repository diff: none beyond merging existing `6bb3aecf` (merge-only WP).
