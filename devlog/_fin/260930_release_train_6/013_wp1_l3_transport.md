# L3 — transport

Worktree `/tmp/ocx-rt6-l3`. Items: #6235 (merge in place), #6232 (carry), #6200 (fix-up in place).

## #6235

Review only: a mid-stream upstream reset ends the Claude passthrough stream with a redacted
Anthropic `event: error` and a failed 502 log entry, while client/server cancellation and
already-terminal streams keep their current handling (dev anchor `src/server/claude-messages.ts:429-435`).
Dry-run merge with #6204's head on a disposable never-pushed branch `rt6-dry-l3-6235-6204` to check
`src/server/messages-native.ts`; delete it before the carry and fix-up work, which start from
origin/dev or the named PR head.
Tests: `bun test tests/claude-integration/claude-native-passthrough.test.ts tests/claude-integration/messages-native.test.ts`.

## #6232 carry (branch `codex/rt6-l3-strip-summary-none`)

Cherry-pick; then move the new test cases out of `tests/responses/openai-responses-passthrough.test.ts`
(cap 4809, currently 4809) into NEW `tests/responses/openai-responses-summary-none.test.ts`, registered in
`scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`. Behavior: only the
internal `reasoning.summary: "none"` marker is removed at final outbound serialization
(`src/adapters/openai-responses/passthrough.ts:490-495`); valid summary values survive; parser-side
hide intent kept. `Co-authored-by` cshyang, per the credit rule in 000_plan.md.

## #6200 fix-up (in place, branch `fix/6162-nonstream-responses`, head 17e8433afa at survey time)

Fix the reproduced P2 at `src/server/responses/passthrough-delivery.ts:1000` (PR head): a client
disconnect during the deferred replay yield must not publish a completed terminal/cache result.
Add a disconnect regression to `tests/responses/responses-canonical-nonstream.test.ts`.
`tests/server/server-auth.test.ts` has 154 lines of headroom after this PR; keep new cases out of it.
Commit on top; re-check head before push; no force. Rebase-free update from dev if #6232 lands first.

Verification, per landed item:
- #6235: `bun test tests/claude-integration/claude-native-passthrough.test.ts tests/claude-integration/messages-native.test.ts`
- #6232 carry: `bun test tests/responses/openai-responses-passthrough.test.ts tests/responses/openai-responses-summary-none.test.ts` (the second file is created by the carry)
- #6200 (only if it stays selected): `bun test tests/responses/responses-canonical-nonstream.test.ts tests/usage/request-log-nonstream.test.ts tests/server/server-auth.test.ts` (the first file exists only on the #6200 branch)
- always: `bun test tests/ci-workflows/file-size-ratchet.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts` and `bun run typecheck`.
