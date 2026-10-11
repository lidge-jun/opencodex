# L1 — provider and client compatibility

Worktree `/tmp/ocx-rt6-l1`, base `origin/dev`. Items: #6230, #6236, #6225 (carry), #6242 (fix).

## #6230 and #6236 (merge in place)

No code work unless review finds a defect. Worker tasks: read each diff against dev, check
- #6230: `src/adapters/cursor/native-exec.ts` keeps the deny decision; the hint names freeform `exec`
  / nested `tools.exec_command` only when code mode is the visible contract, and keeps the flat-shell
  wording otherwise (dev anchor `src/adapters/cursor/native-exec-shell.ts:94-99`).
- #6236: routed `comp_hash` becomes unknown instead of the synthetic `"opencodex"`
  (dev anchors `src/codex/catalog/build-entries.ts:786-789`, `parsing.ts:636`, `derive-entry.ts:147-151`);
  native markers survive.
Run `bun test tests/providers/cursor/cursor-native-exec-policy.test.ts tests/codex-integration/catalog-routed-comp-hash.test.ts`
on a local checkout of each PR head (fetch `pull/<n>/head` into the lane worktree), plus typecheck.
Report verdict; the coordinator approves fork CI and merges.

## #6225 carry

Branch `codex/rt6-l1-devin-retry-advice`. Cherry-pick the PR's commits onto origin/dev
(`git fetch origin pull/6225/head`). Keep behavior: typed Devin 429 errors carrying valid delay hints
put the longest delay first in the Codex-parsed message (`src/lib/errors.ts:445-454,617-619`,
`src/lib/retry-delay.ts:57-73`); typed errors without a valid delay and local send-budget refusals keep
their classification. PR body: Summary, Verification, Checklist, "Carries #6225", and the `Co-authored-by` trailer per the
credit rule in 000_plan.md.
Tests: `bun test tests/responses/responses-grok-devin-preflight.test.ts tests/server/retry-delay-hardening.test.ts tests/adapters/adapter-error-inline.test.ts`.

## #6242 Qwen late system message (evidence-gated)

Branch `codex/rt6-l1-qwen-leading-system`. Two steps; the second happens only if the first succeeds.

1. Evidence. The reported upstream text "System message must be at the beginning." must be matched to
   a public source that produces it (for example the Qwen chat template's `raise_exception`), and the
   same source must say what it does with a `developer` role and with a later `user` message. Cite the
   file and revision. Current dev behavior: `src/adapters/openai-chat/messages.ts:163-194` keeps later
   developer items in their slot; `src/adapters/openai-chat/developer-role.ts:21-37` folds them to
   `system` when `foldDeveloperRoleToSystem` is unrecorded; the pinned sequence is
   `tests/adapters/openai/openai-chat-developer-position.test.ts:69-96`. There is no model-family hint in
   developer-role.ts today, so any selector is new and must be named.
2. Fix, only if step 1 establishes the contract. The worker writes a fixture reproducing the
   template's rule and proposes the smallest change that satisfies it without altering behavior for
   other destinations (either a documented existing knob, if one suffices, or a narrow new selector).
   Tests in a new sibling file registered in both test-layout manifests; existing position test unchanged.

If step 1 is inconclusive the worker stops, #6242 stays open, and the coordinator may post the
evidence on the issue. No guessed reorder ships.
