# 010 — wp1: PR #2439, fixture-backed OpenAI contract manifest

## Item

`Ingwannu` PR #2439 `ingw/refactor-provider-contracts` -> `dev`, head `0225f2b9`.
Adds a strict V1 compatibility-manifest schema and catalog with one canonical
OpenAI Codex-forward contract for `gpt-5.6-sol`, backed by production-adapter
fixtures, plus synchronized documentation. 13 files.

## Reviewer verdict

`gpt-5.6-sol` high, read-only, exact head `0225f2b9`:

- VERDICT PASS_WITH_NITS, disposition SQUASH_MERGE, risk low.
- `bun test tests/compatibility-manifest.test.ts` 6 pass / 0 fail.
- `bun test tests/core-lab-boundary.test.ts` 13 pass / 0 fail.
- `cd docs-site && bun run build` passed, 393 pages.
- `gh pr checks 2439` 23 passed, 1 intentionally skipped, 0 failed.
- Export and call-site tracing found no dropped exports, no import cycle, no
  core-to-manifest or core-to-Lab edge, no credential or request-body logging.

## The one nit, and why it does not block

`tests/compatibility-manifest.test.ts:67` — the graph guard skips every dynamic
import, so a future direct `import("../compatibility")` from a protected core
file would slip past it. The current tree has no such edge, and
`tests/core-lab-boundary.test.ts` already carries the stricter direct-dynamic
check for the Lab boundary. This is a guard-strength gap in a new test, not a
defect in shipped behavior, so it is recorded rather than held.

## Disposition

Squash-merge. The manifest is additive and sits off the core request path.

## Verification

Post-merge on `dev`: `bun test tests/compatibility-manifest.test.ts
tests/core-lab-boundary.test.ts`, bound to the merged tree by a check receipt.


## Execution record

Squash-merged 2026-08-23 as `2a2f6e68f` on `origin/dev`, branch deleted.

```
gh pr merge 2439 --squash --admin --delete-branch
2a2f6e68f feat(compatibility): add fixture-backed OpenAI contract manifest (#2439)
```

No linked issue: #2439 stands on its own.
