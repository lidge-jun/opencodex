# Lane ownership, ordering and acceptance shape

The first audit round of `000_plan.md` returned blocking findings: the lanes were
described by symptom without an owned-file set, two lanes overlapped on the send
path, one lane depended on two others without saying so, and two lanes named an
acceptance unit that no test can observe. This document answers those and is the
binding half of the unit.

## Owned files

A lane changes files in its own row. A file in another row is read-only for it.
Anything outside every row is open, but a second lane touching it has to say so in
its pull request.

| Lane | Owns |
|---|---|
| L1 | `src/server/chat-completions.ts` error path, `src/server/chat-native.ts` error path, `src/server/responses/passthrough-error.ts`, the replay-verdict carrier it extracts, and tests for those |
| L2 | `src/chat/inbound.ts`, `src/responses/parser.ts` where the Chat path needs it, and its own tests |
| L3 | `src/adapters/openai-chat/passthrough.ts`, `src/adapters/openai-chat/messages.ts` role selection, and its own tests |
| L4 | `src/codex/history-provider.ts`, `src/codex/inject.ts`, `tests/codex-integration/*` |
| L5 | `src/server/grok-responses-snapshot-repair.ts`, `src/server/responses-undeclared-tool-guard.ts`, `src/server/responses/passthrough-dispatch.ts` call sites, and its own tests |
| L6 | `src/clients/config-export/`, `src/integrations/registry.ts` entry for that client, and its own tests |
| L7 | `structure/providers/chat-compat.md`, `docs-site` provider reference, and the generated binding check |
| L8 | `src/lib/request-execution-budget.ts`, `src/lib/request-resend-gate.ts`, and send-count tests |

L1 and L8 both live near the send path and are split by question. L1 owns what the
client is told when a replay is refused — code, status, retry header, and the
carrier that stops each wrapper re-deriving it. L8 owns how many sends one logical
request may make and which leg may spend the shared reserve. L8 does not change an
error body; L1 does not change an allowance.

## Ordering

L7 lands last. It writes down the single developer-role policy, and that policy is
not settled until L2 fixes where the message sits and L3 fixes which role it
carries. Until both are on `dev`, L7 keeps its branch rebased and its pull request
open. Every other lane is independent and merges in whatever order its evidence
arrives.

## Acceptance that a test can hold

Static reading is how a lane reviews itself; hosted CI on the exact head is what
decides. A lane whose acceptance sentence names something no job can observe has
to restate it:

- L1 and L8 count sends against a recorded fetch, so the number is an assertion and
  not an inference. L1 additionally asserts the response the client receives.
- L4 drives a temporary home with fixtures: enable, create, resume, restore. It
  asserts the destination recorded for an existing conversation and for a new one,
  and it asserts the refusal that an admission-token home still receives. The
  refusal path already has coverage; the transition and the post-transition
  destinations are the new part.
- L6 cannot prove what a third-party client does at runtime. Its assertion is that
  the file the current client release reads carries the intended provider after
  enable and refresh, and carries nothing after disable — with the client's own
  published schema quoted in the pull request as the reason that file is the one
  that matters. If the lane cannot establish the schema, it reports the write as
  ineffective instead, which is the honest half of the original instruction.
- L5 asserts on the block rewrite directly: `tool_choice: none`, a narrowed
  allow-list, an empty catalog after normalisation, and a forbidden call arriving
  beside ordinary text, which must survive.
- L7 asserts that the documented default is derived from the code, so a default
  change fails a check rather than only a review.

## Baseline

The lanes are cut from `dev` after the September 20 batch, so the paginated
transition and the per-request resend gate are already present. A lane that finds
its premise already satisfied says so in its pull request and narrows to the part
that is not, rather than reimplementing what landed.
