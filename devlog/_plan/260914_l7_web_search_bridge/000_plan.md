# L7 — web-search bridge: mixed-tool continuation and a search fallback

Lane R2-L7. Two issues, one PR against `dev`, branch `codex/260914-l7-web-search-bridge`.

## Units

- 010 — mixed-tool continuation (residual of issue 4429).
- 020 — /v1/alpha/search without a ChatGPT forward provider (issue 2730).

## Write scope

`src/web-search/*`, `src/server/search.ts`, and their tests. No new config-schema
field: another lane owns `src/config.ts` and `src/types/config.ts` this round.
`src/server/responses/core.ts` is deliberately untouched — see 010 for what that
costs and why the remainder is recorded rather than reached for.

## Verification posture

This worktree has no `node_modules`, so nothing local runs: no suite, no
typecheck, no focused file. Hosted CI at the exact final head is the only proof.

