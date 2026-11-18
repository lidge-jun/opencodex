# 020 carry #8814: keep caller restrictions visible to the Chat adapter guard

Author: luvs01 (Co-authored-by trailer). Source head 39085c25b8.

## Change

- MODIFY `src/claude/chat-tool-dispatch.ts` `projectChatToolDispatch`: `if (tools.some(toolRestrictsCallers)) return null;` before any projection, so the existing Chat adapter guard rejects the unsupported declaration before dispatch.
- MODIFY `structure/data-planes/claude-tool-loading.md` and the en/es/ko `guides/claude-code.md` paragraph (from the PR).
- MODIFY `tests/claude-integration/claude-chat-tool-dispatch-routes.test.ts`: the PR's caller-restriction describe block (imports `projectChatToolDispatch`, `resolveAdapter`).
- Excluded (security review): the PR's `fetch: stubbedProviderFetch` provider fields in both dispatch test files are unnecessary (the files pass on dev and on the PR head without them) and move the tests onto the caller-executor branch real users do not take; the rewrite of `tests/responses/sse-untyped-credential-mask.test.ts` is unrelated and drops the time bound on the full rewrite path.

## Proof

New route tests fail with the `src/` line removed and pass with it. `bun test tests/claude-integration/claude-chat-tool-dispatch-routes.test.ts tests/claude-integration/claude-chat-tool-dispatch.test.ts`.

