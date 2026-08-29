# 010 — Phase 1: pair assistant tool calls with their results in external replay

Depends on: `000_rca.md`
Target file: `src/adapters/cursor/protobuf-request.ts` (MODIFY, only file changed in this phase)
Out of scope: native/composer replay, checkpoint suffix mechanics, `conversationTurns` native
branch, catalog/effort mapping, GUI, docs-site.

## 1. Objective

Make the external-model replayed transcript self-consistent: every `[Tool Result]` entry is
immediately preceded by a visible record of the assistant tool CALL that produced it, matched by
call id. A result whose call is missing must still be replayed (never dropped), and the native
path must be byte-for-byte untouched.

## 2. Current code (before)

### 2.1 `rootPromptMessages` — assistant branch (~line 285)

```ts
    } else if (message.role === "assistant") {
      const text = assistantRootText(message, !externalModel).trim();
      if (text.length > 0) {
        pushDeduped(
          { role: "assistant", content: [{ type: "text", text }] },
          "assistant",
          { messageIndex: i },
          text,
        );
      }
      // Assistant tool CALLS are intentionally NOT replayed as visible "[Tool Call]" text here.
    } else if (message.role === "toolResult") {
      if (!echoToolResultInRoot) continue;
      const prefix = normalizedToolResult(message, contentToText(message.content)).isError ? "[Tool Error]" : "[Tool Result]";
      const text = `${prefix}\n${toolResultToText(message)}`;
      pushDeduped(toolResultRootPayload(text), "toolResult", { messageIndex: i, text }, text);
    }
```

### 2.2 `conversationTurns` — external assistant branch (~line 742)

```ts
        if (externalModel) {
          if (part.type === "text" && part.text.length > 0) {
            current.steps.push(storeCursorBlob(...AssistantMessageSchema, { text: part.text }...));
          }
          continue;
        }
```

A `toolCall` part hits `continue` and vanishes.

## 3. Change (after)

### 3.1 NEW: a call-record formatter

Add next to `toolResultToText` (which owns the mirror-image format for results):

```ts
/**
 * External replay must show the CALL that produced a replayed "[Tool Result]" entry. Without it the
 * result is orphaned: its call_id refers to nothing the model can see, and live grok-4.6 turns then
 * re-issue the same call while narrating a phantom interrupt (devlog 260829 000_rca).
 * Mirrors toolResultToText so a call/result pair reads as one record.
 */
function toolCallToText(part: Extract<OcxAssistantContentPart, { type: "toolCall" }>): string {
  return [
    "[tool_call]",
    `call_id: ${decodeCursorCallId(part.id)}`,
    `name: ${namespacedToolName(part.namespace, part.name)}`,
    "arguments:",
    cursorToolCallArgumentsText(part.arguments),
  ].join("\n");
}
```

**AMENDED by `001_audit_round1.md` F4:** `OcxToolCall.arguments` is `Record<string, unknown>`
(`src/types/request.ts:215`) — always an object, never a string. Serialize with `JSON.stringify`
inside a `try`, falling back to `"[unserializable arguments]"`, so a cyclic or `BigInt`-bearing
argument object cannot throw inside request encoding.

Prefix wording: `[Tool Call]` on the first line to match the `[Tool Result]`/`[Tool Error]`
family. **AMENDED by `001_audit_round1.md` F8:** `ECHO_MARKERS` in `envelope-echo.ts` must gain
`"[Tool Call]"` in the same change, so the existing prefix sniffer and mid-stream observer treat an
echo of a call envelope exactly like an echoed result envelope. `request-builder.ts:223` records a
prior rejection of rendering tool calls as visible text precisely because a model may echo the
marker back; covering the marker is what makes this emission safe rather than a repeat of that
mistake. The `messages` text channel that comment governs is NOT touched by this phase.

### 3.2 MODIFY `rootPromptMessages` assistant branch

Replace the comment-only omission with an emission that is *conditional on the call having a
replayed result in this same history slice*, so a call whose result was pruned does not reintroduce
an orphan in the other direction:

```ts
    } else if (message.role === "assistant") {
      const text = assistantRootText(message, !externalModel).trim();
      if (text.length > 0) { /* unchanged pushDeduped */ }
      // Replay the tool CALL so the paired "[Tool Result]" below is not orphaned (000_rca).
      // Native models receive real mcpToolCall structures on turns[]; only the external
      // text-replay path needs this, and only when results are echoed into root at all.
      // AMENDED by 001_audit_round1.md F2: gate on echoToolResultInRoot ALONE, not on
      // externalModel. externalModel implies echoToolResultInRoot, so the conjunct was dead in one
      // direction and wrong in the other: composer-2.5 (non-fast) is NATIVE yet has
      // echoToolResultInRoot === true, so it writes an orphaned [Tool Result] into root and needs
      // the pairing call too. Invariant: wherever a result is echoed into root as text, its call
      // must be there as well.
      if (echoToolResultInRoot && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type !== "toolCall") continue;
          const callText = `[Tool Call]\n${toolCallToText(part)}`;
          pushDeduped(toolResultRootPayload(callText), "toolResult", { messageIndex: i, text: callText }, callText);
        }
      }
    }
```

`toolResultRootPayload` is reused because it already produces the `{role:"assistant"}` wire shape
that external workers accept (the `role` label passed to `pushDeduped` is internal bookkeeping used
by the pruner, and `toolResult` is the correct class for "part of the active tool block" so the
pruner's `activeStart` walk keeps a call attached to its result).

**Ordering guarantee:** the call is emitted while processing the assistant message at index `i`,
and its result arrives at a later index, so call-before-result ordering follows from the existing
loop order — no sorting needed.

### 3.3 MODIFY `conversationTurns` external branch

```ts
        if (externalModel) {
          if (part.type === "text" && part.text.length > 0) { /* unchanged */ }
          else if (part.type === "toolCall") {
            current.steps.push(storeCursorBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
              message: { case: "assistantMessage", value: create(AssistantMessageSchema, {
                text: `[Tool Call]\n${toolCallToText(part)}`,
              }) },
            })), requestScope));
          }
          continue;
        }
```

Still an `assistantMessage` step — never a native `mcpToolCall` — preserving the constraint the
existing comment records (native structures make external workers reject the turn with
`invalid_argument` after `stepCompleted`).

### 3.4 Pruner interaction (`activeStart` walk, ~line 322)

```ts
    while (activeStart > 0 && history[activeStart - 1]?.role === "toolResult") activeStart -= 1;
```

Because call entries are classed `toolResult`, this walk already treats a call+result block as one
active unit. The orphan guard below it (`while (historyEntries[0]?.role === "assistant" || ... === "toolResult")`)
also keeps behaving correctly: a leading call with no result is shifted off with the rest.

Byte-budget note: each call record adds roughly the length of the arguments JSON. The existing
`CURSOR_EXTERNAL_ROOT_BYTE_LIMIT` (512 KiB) and `CURSOR_EXTERNAL_ROOT_BLOB_LIMIT` (192) still
bound it, and `truncateToolResultBlob` applies to the active block. No limit change in this phase.

## 4. Accept criteria (testable)

| # | Criterion | Activation scenario (C-ACTIVATION-GROUNDING-01) |
|---|-----------|--------------------------------------------------|
| A1 | External continuation roots contain a `[Tool Call]` entry carrying the call id, tool name and arguments, positioned before its `[Tool Result]` entry | Decode `rootPromptMessagesJson` for a grok history with one call+result; assert index(call) < index(result) and both share the call id |
| A2 | A result with no matching call is still replayed | History with a `toolResult` whose id matches no call → result entry still present |
| A3 | A call with no result does not crash and does not desync ordering | Assistant `toolCall` as the last message → encode succeeds, call entry present |
| A4 | Native/composer replay is unaffected | Same history encoded with `composer-2.5-fast`: no `[Tool Call]` text entry appears in roots |
| A5 | Live behavior | `codex exec --json -m cursor/grok-4.6` with two sequential echo commands → exactly one `command_execution` per command, zero "was interrupted" strings |

A1-A4 are logic assertions in `tests/`. A5 is the live grounding that closes the reported symptom.

## 5. Verifier commands (PLAN-VERIFIER-REAL-01)

Verified before writing this doc:

| Command | Exit | Reads this change target? |
|---------|------|---------------------------|
| `bun run .tmp/cursorprobe/wire.ts` | 0 | Yes — imports `encodeCursorRunRequest` from the target file directly; this is the probe that produced §3 of `000_rca.md` |
| `bun test tests/cursor-blob.test.ts` | to run on lidge | Yes — decodes `rootPromptMessagesJson` from `encodeCursorRunRequest` |
| `bun x tsc --noEmit` | to run on lidge | Yes — strict project-wide typecheck includes `src/adapters/cursor/**` |
| `codex exec --json -m cursor/grok-4.6` | 0 in run2 | Yes — traverses the live proxy through this exact encode path (`turnType: tool-continuation` confirmed in provider logs) |

Per the user's instruction the bun suites run on `ssh lidge`, not locally.

## 6. Field chain (PLAN-FIELD-CHAIN-01)

No new type field or enum value is introduced. The chain for the value that IS added (a replayed
call record) is:

| Stage | Location |
|-------|----------|
| Creation | `toolCallToText` (new) fed from existing `OcxAssistantContentPart` `toolCall` parts already present in `rawMessages` |
| Serialization | `toolResultRootPayload` → `rootBlobCandidate` → `storeCursorBlob` (existing) |
| Deserialization | N/A — the blob is consumed by Cursor upstream, not re-read by opencodex. Tests decode it via `handleCursorNativeKv`, the same path `tests/cursor-blob.test.ts` already uses |
| Consumers | Root pruner (`activeStart` walk, orphan guard, byte budget) and the token estimate via `serialized` — both handled in §3.4 |

## 7. Bypass / enforcement (PLAN-BYPASS-NAMED-01)

This phase adds no enforcement gate; it changes request construction. For completeness:
tier E1 (unit test), executing surface `bun test` in CI, known bypass — a caller constructing a
Cursor request without `rawMessages` skips replay entirely (unchanged pre-existing behavior),
residual risk — none for the echoed-marker case, which F8 closed by adding `[Tool Call]` to
`ECHO_MARKERS`; the remaining residual is that an oversized call record can be truncated by
`truncateToolResultBlob` (accepted, 001 F6), wording downgrade — none. Final enforcement layer:
none beyond CI tests.

