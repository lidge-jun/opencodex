# 010 — Phase 1 (cursor-web-approve)

## MODIFY: src/adapters/cursor/live-transport.ts

### Imports (top schema block, ~17-25)

- ADD: `WebSearchRequestResponse_ApprovedSchema`,
  `ExaSearchRequestResponse_ApprovedSchema`,
  `ExaFetchRequestResponse_ApprovedSchema`.
- REMOVE (now unused after the flip): `WebSearchRequestResponse_RejectedSchema`,
  `ExaSearchRequestResponse_RejectedSchema`, `ExaFetchRequestResponse_RejectedSchema`.
- KEEP: `SwitchModeRequestResponse_RejectedSchema` (switchMode still rejected).

### Doc comment above planInteractionQueryReply (~176-189)

Change the `switchMode / webSearch / exaSearch / exaFetch: reject` line to say
webSearch/exaSearch/exaFetch are now APPROVED (empty approval) so Cursor's server
runs the search and injects results; switchMode stays rejected. Note the tradeoff:
approval consumes the user's Cursor web-search/Exa quota.

### Branch bodies

webSearchRequestQuery (238-248):
```
result: { case: "rejected", value: create(WebSearchRequestResponse_RejectedSchema, { reason: NON_INTERACTIVE_REASON }) },
replyCase: "webSearchRequestResponse:rejected",
```
->
```
result: { case: "approved", value: create(WebSearchRequestResponse_ApprovedSchema, {}) },
replyCase: "webSearchRequestResponse:approved",
```

exaSearchRequestQuery (249-259): same shape with `ExaSearchRequestResponse_ApprovedSchema`, replyCase `exaSearchRequestResponse:approved`.

exaFetchRequestQuery (261-271): same shape with `ExaFetchRequestResponse_ApprovedSchema`, replyCase `exaFetchRequestResponse:approved`.

askQuestion (214) + switchMode (~227-234): UNCHANGED (rejected).

## TESTS: tests/cursor-interaction-query.test.ts

- Import the 3 `*RequestResponse_Approved` schemas are NOT needed (test reads
  `plan.response.result.value.result.case`).
- Split the current `test.each` (lines ~58-69) that asserts switchMode + web + exa
  all `rejected`:
  - Keep a `test` (or single-row each) asserting `switchModeRequestQuery` -> replyCase
    `switchModeRequestResponse`, inner result case `rejected`.
  - New `test.each` over the 3 web/exa cases asserting replyCase `*RequestResponse`
    and inner `value.result.case === "approved"`, id preserved (11).

## Verification (C)

- `bun test tests/cursor-interaction-query.test.ts` -> pass (0 fail).
- `bun test tests/cursor-*.test.ts` -> 0 fail.
- `bun x tsc --noEmit` -> no errors in live-transport.ts / test file.
- `git diff --stat` -> only live-transport.ts + test + plan unit.
