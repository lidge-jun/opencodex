# 001 — Audit round 1 (direct independent audit, blockers folded)

Auditor: dispatched `explorer` lane (`cursor-plan-auditor`, agent `01a04d5c`) produced no
output across five bounded `wait_agent` cycles (~10 minutes). Per DISPATCH-RETIRE-01 it was
retired, and the audit was performed directly against the codebase with an executable probe
(`.tmp/cursorprobe/audit.ts`) instead of a second paper review. The probe is stronger evidence
than the paper audit would have been: it decodes the real wire payload for both model classes.

## Probe output (verbatim)

```
### grok-4.6-high roots=4 turns=1
  root[0] role=system :: You are a helpful assistant.
  root[1] role=user :: Run echo AAA.
  root[2] role=assistant :: I will run echo AAA.
  root[3] role=assistant :: [Tool Result] | [tool_result] | call_id: call_echo_1 | name: exec_command | is_error: false | output: | AAA
  turn steps=2
    step assistantMessage :: I will run echo AAA.
    step assistantMessage :: [Tool Result] | AAA
### composer-2.5-fast roots=3 turns=1
  root[0] role=system :: You are a helpful assistant.
  root[1] role=user :: Run echo AAA.
  root[2] role=assistant :: I will run echo AAA.
  turn steps=2
    step assistantMessage :: I will run echo AAA.
    step toolCall :: <toolCall>
```

## Findings

### F1 — Root cause CONFIRMED (was claim 1)

For `grok-4.6-high` the tool call is absent from **both** surfaces: roots carry an orphaned
`[Tool Result]` (with `call_id: call_echo_1`) and the turn steps carry only `assistantMessage`
text. For `composer-2.5-fast` the turn carries a real `toolCall` step. The external path is
therefore the only one that loses the call. `000_rca.md` §3 stands.

### F2 — BLOCKER (High): the planned guard is wrong, not merely redundant

`010` §3.2 gated the new emission on `externalModel && echoToolResultInRoot`. Reading
`discovery.ts:212`:

```ts
export function cursorNeedsExternalToolContinuation(modelId: string): boolean {
  if (isCursorExternalWireModel(modelId)) return true;
  const wire = cursorCodexToWireModelId(modelId).trim().toLowerCase();
  return wire === "composer-2.5";
}
```

`externalModel === true` implies `echoToolResultInRoot === true`, so the second conjunct is dead
in that direction. The live case it *excludes* is the one that matters: `composer-2.5`
(non-fast) is native (`externalModel === false`) yet `echoToolResultInRoot === true`, so
`rootPromptMessages` DOES write an orphaned `[Tool Result]` into its root prompt while the
planned guard would have skipped emitting the pairing call for it.

That is not hypothetical. `discovery.ts:200-210` documents `composer-2.5` misbehaving with
exactly the symptom class in `000_rca.md`: it "resumes a tool-result turn with server-side
native tool calls (read/grep/exec) instead of answering, or completes with zero text". The
existing mitigation switched its action shape; it never fixed the orphaned root.

**Fold:** gate the root emission on `echoToolResultInRoot` alone. The invariant is *wherever a
tool result is echoed into root as text, its call must be there too* — which is exactly the set
`echoToolResultInRoot` describes. The `conversationTurns` change stays keyed on
`externalModel`, because the native branch already emits a real `toolCall` step (F1).

### F3 — Which surface the model actually reads

`protobuf-request.ts:186`: "Cursor builds the actual model prompt from
`rootPromptMessagesJson` (`turns[]` is UI/display metadata)". The root change is therefore the
load-bearing fix; the `conversationTurns` change is consistency for the display/structure
surface. Recorded so the test weighting reflects it: the root assertions are the ones that prove
the defect fixed.

### F4 — `arguments` is an object, not a string (was claim 6)

`src/types/request.ts:211-215`:

```ts
export interface OcxToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
```

**Fold:** drop the "string or object" branch from `010` §3.1. Serialize with `JSON.stringify`
inside a `try`, falling back to `"[unserializable arguments]"` — a cyclic or `BigInt`-bearing
argument object must not be able to throw inside request encoding.

### F5 — Helpers exist as assumed (was claim 5)

| Helper | Location |
|--------|----------|
| `decodeCursorCallId` | `src/adapters/cursor/call-id.ts:32` |
| `namespacedToolName(namespace, name)` | `src/types/tools.ts:30` |
| `toolResultRootPayload(text)` | `src/adapters/cursor/protobuf-request.ts:137` |
| `assistantRootText` | `src/adapters/cursor/protobuf-request.ts:180` |
| `rootBlobCandidate` | `src/adapters/cursor/protobuf-request.ts:121` |

`OcxToolCall.namespace` exists (`request.ts:226`), so `namespacedToolName(part.namespace, part.name)`
is correct and mirrors the result formatter's `namespacedToolName(message.toolNamespace, message.toolName)`.

### F6 — Pruner bookkeeping is safe (was claim 3)

`messageIndex` is used only for (a) `truncateToolResultBlob` carry-over and (b)
`historyMessageStart = firstKept?.messageIndex` (`:372-373`), which feeds `conversationTurns`'s
`start`. A call entry carries the SAME `messageIndex` as its assistant message, so the
computed `historyMessageStart` can only equal a value the assistant entry would already have
produced — it cannot point past a retained message, and `conversationTurns` slices by message
index, not entry count, so no turn is duplicated. Classing the entry `toolResult` also makes the
`activeStart` walk (`:322`) keep a call attached to its result as one active block, which is
the desired behavior.

One real consequence: `truncateToolResultBlob` will now also truncate an oversized CALL entry
(it accepts any `role === "toolResult"` entry with `text`). That is acceptable — a call whose
arguments exceed the budget is better truncated than dropped — and is noted rather than changed.

### F7 — Repetition breaker (was claim 4)

`pushDeduped` collapses only *consecutive byte-identical* entries. Two different calls differ by
`call_id`, so no collapse. Two identical retried calls (same id, same arguments) would collapse
with a `produced N times in a row` note, which is the intended signal. No conflict.

### F8 — BLOCKER (Medium): a documented prior rejection of this exact rendering

`src/adapters/cursor/request-builder.ts:223-235`, `contentPartToText`:

```ts
    case "toolCall":
      // Cursor does not accept OpenAI Responses assistant tool-call parts as native history here.
      // Rendering them as visible "[tool_call]" text leaks synthetic protocol markers back into
      // model output and can halt multi-tool continuations. The paired tool result carries the
      // call id/name/output Cursor needs for the next action.
      return undefined;
```

This is a THIRD site (the `messages` text channel, `CursorRequestMessage`) and it explicitly
rejects rendering tool calls as `[tool_call]` text. Two honest observations:

1. That channel is not the wire root replay — it feeds `activePromptText` and omission-marker
   reconstruction. This phase does not touch it, and the plan must say so instead of pretending
   the concern does not exist.
2. Its stated risk — the model echoing synthetic markers back — is REAL and applies to the new
   root entries. Note that root already carries `[tool_result]` markers, so the risk is already
   accepted for results; adding the paired call is symmetric, not novel.

**Fold:** convert that residual risk into a covered one. Add `"[Tool Call]"` to `ECHO_MARKERS` in
`src/adapters/cursor/envelope-echo.ts` so the existing prefix sniffer and mid-stream observer
treat an echoed call envelope exactly like an echoed result envelope (retry with the existing
continuation text). This also answers audit question 10, and it means `010` §3.1's "recorded as
residual risk, not fixed here" is superseded — it IS fixed here.

### F9 — Verifier reality (was claim 7)

`bun run .tmp/cursorprobe/wire.ts` and `.tmp/cursorprobe/audit.ts` both ran with exit 0 and both
import `encodeCursorRunRequest` from the change target directly. `bun x tsc --noEmit` is strict
and project-wide. `tests/cursor-blob.test.ts` decodes `rootPromptMessagesJson` from the same
function. All four observe this change. The live `codex exec` run traverses it (provider log
confirmed `turnType: tool-continuation`).

## Disposition

| Finding | Severity | Disposition |
|---------|----------|-------------|
| F2 guard excludes `composer-2.5` | High | FOLDED into `010` §3.2 — gate on `echoToolResultInRoot` |
| F8 echoed-marker risk uncovered | Medium | FOLDED into `010` §3.1 — add `[Tool Call]` to `ECHO_MARKERS` |
| F4 `arguments` type mismatch | Medium | FOLDED into `010` §3.1 — object-only serialization with throw guard |
| F3 turns[] is display metadata | Low | Recorded; test weighting reflects it |
| F6 truncation now applies to calls | Low | Accepted, documented |
| F1/F5/F7/F9 | — | Confirmed, no change needed |

VERDICT: GO-WITH-FIXES (blockers=3)

