# 020 — Phase 2: regression tests, remote verification, delivery

Depends on: `010_phase1_call_result_pairing.md` (landed)
Targets: `tests/cursor-tool-call-replay.test.ts` (NEW), PR against `dev`
Out of scope: touching `src/` again except to fix a defect this phase's tests expose.

## 1. NEW test file — `tests/cursor-tool-call-replay.test.ts`

Follows the decode harness already established by `tests/cursor-repetition-breaker.test.ts` and
`tests/cursor-blob.test.ts`: encode through `encodeCursorRunRequest`, then resolve every
`rootPromptMessagesJson` blob through the real `handleCursorNativeKv` blob store. No mocks —
a mocked blob store would not prove what the wire carries.

```ts
import { describe, expect, test } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { encodeCursorRunRequest } from "../src/adapters/cursor/protobuf-request";
import { handleCursorNativeKv } from "../src/adapters/cursor/native-exec";
import { AgentClientMessageSchema, GetBlobArgsSchema, KvServerMessageSchema } from "../src/adapters/cursor/gen/agent_pb";
import type { OcxMessage } from "../src/types";

function blobData(blobId: Uint8Array): Uint8Array { /* same helper as cursor-repetition-breaker */ }
function rootTexts(bytes: Uint8Array): string[] { /* JSON.parse each root, return content[0].text */ }

const CALL_ID = "call_echo_1";
function historyWithCall(resultId = CALL_ID): OcxMessage[] {
  return [
    { role: "user", content: "Run echo AAA.", timestamp: 1 },
    { role: "assistant", content: [
        { type: "text", text: "I will run echo AAA." },
        { type: "toolCall", id: CALL_ID, name: "exec_command", arguments: { cmd: "echo AAA" } },
      ], timestamp: 2 },
    { role: "toolResult", toolCallId: resultId, toolName: "exec_command", content: "AAA", isError: false, timestamp: 3 },
  ];
}
```

### Test cases

| Test | Asserts | Maps to |
|------|---------|---------|
| `external replay pairs a tool call with its result` | a root contains `[Tool Call]` + `call_id: call_echo_1` + `exec_command` + `echo AAA`; its index is LESS than the index of the `[Tool Result]` root | A1 |
| `a replayed tool result is never orphaned` | for every root matching `[Tool Result]` with `call_id: X`, some earlier root carries `[Tool Call]` with the same `X` | A1 (the invariant, stated directly) |
| `an unmatched result is still replayed` | `historyWithCall("call_other")` → the `[Tool Result]` root is still present (no silent drop) | A2 |
| `a trailing call with no result encodes` | history ending at the assistant `toolCall` → no throw, `[Tool Call]` root present | A3 |
| `native replay does not gain a tool-call text entry` | same history at `composer-2.5-fast` → no root contains `[Tool Call]` | A4 |
| `arguments serialize for string and object forms` | `arguments` given as a JSON string and as an object both surface the `cmd` value | §3.1 defensive serialization |

The orphan-invariant test is the load-bearing one: it is written to FAIL on the pre-fix code
(run it before the `src` change to confirm red), which is what makes it a regression test rather
than a restatement of current behavior.

## 2. Remote verification (user instruction: never run the local suite)

```bash
ssh lidge 'cd <checkout> && git fetch origin && git checkout <branch> && bun install --frozen-lockfile'
ssh lidge 'cd <checkout> && bun x tsc --noEmit'
ssh lidge 'cd <checkout> && bun test tests/cursor-tool-call-replay.test.ts tests/cursor-blob.test.ts \
    tests/cursor-repetition-breaker.test.ts tests/cursor-request-builder.test.ts'
```

Because the change touches shared request construction for every Cursor model, the full
`bun run test` suite also runs on lidge before the PR is marked review-ready (AGENTS.md requires
typecheck + test before a non-trivial PR is review-ready).

## 3. Live grounding (A5)

Re-run the exact reproduction from `000_rca.md` against the patched proxy:

```bash
OPENAI_BASE_URL=http://127.0.0.1:10100/v1 codex exec --json --skip-git-repo-check \
  -m cursor/grok-4.6 '...echo AAA then echo BBB... reply DONE2'
```

Pass condition: exactly one `command_execution` item per requested command, and zero occurrences of
`interrupted` in `agent_message` text. The proxy must be restarted onto the patched code first —
the running service is a separate long-lived process (pid observed at 62773), so an unrestarted
proxy would test the old bytes. Record the restarted pid alongside the transcript.

## 4. Delivery

- Branch `codex/cursor-tool-call-replay-pairing` off current `dev`.
- PR targets `dev` (never `main`), fills Summary / Verification / Checklist from
  `.github/PULL_REQUEST_TEMPLATE.md`. No `gui` mention, so no screenshot requirement.
- Commits are pushed with `--no-verify` per the user's explicit instruction; the independent
  gates are the remote lidge runs plus repository CI at the exact head SHA.
- Merge: `--admin` once CI is green at the exact head SHA, per the user's explicit
  authorization for this task. Verify CI is reported for the SHA that is actually being merged,
  not an earlier push.

## 5. Terminal outcomes

- `DONE` — A1-A5 green, remote gates green, PR merged into `dev` with the merge commit recorded.
- `BLOCKED` — lidge unreachable or CI infrastructure failure.
- `NEEDS_HUMAN` — the live re-run still shows duplicate calls after the fix, meaning the root
  cause is broader than replay pairing (would reopen at P with the new trace, not be patched blind).

