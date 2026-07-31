# Phase 100 (P0-4) - Resume / tool-result correctness

## Problem

For `previousResponseId`, `kiroPayloadMessages()` uses
`currentTurnInputMessages()`, which currently slices after the last assistant and
filters assistants out:

```ts
return messages.slice(lastAssistant + 1).filter(m => m.role !== "assistant");
```

If the current turn starts with `toolResult`, the transmitted Kiro payload has
`userInputMessageContext.toolResults` but no preceding `assistantResponseMessage`
with matching `toolUses`. Kiro can reject or misinterpret that payload.

## Scope

Repair only resumed tool-result continuations. Keep normal resumed user text
current-turn-only, and keep usage accounting current-turn-only so old tool args
are not re-counted.

## File changes

### MODIFY src/adapters/kiro.ts

1. Split payload slicing from usage slicing:
   - `currentTurnUsageMessages(messages)` = old behavior (`slice(lastAssistant+1)`, no assistant)
   - `currentTurnPayloadMessages(messages)`:
     - if no current toolResult: same as old behavior
     - if current tail has a toolResult: include the minimal prior exchange from
       after the previous assistant through current tail. This preserves:
       `last user/developer -> last assistant(toolUses) -> toolResult(s)`.
2. `kiroPayloadMessages()` should use `currentTurnPayloadMessages`.
3. `estimateKiroInputTokens()` should use `currentTurnUsageMessages` to avoid
   charging old user/tool-call context again.

### MODIFY tests/kiro-adapter.test.ts

Add resumed tool-result tests:

- previousResponseId with `user -> assistant toolCall -> toolResult` includes
  history with the assistant toolUse and currentMessage with toolResults.
- usage for that resumed toolResult remains based only on the tool output (not
  previous user text or huge assistant args).
- normal previousResponseId with latest user text still has no history.

## Verification

- bun x tsc --noEmit
- bun test tests/kiro-adapter.test.ts

## Commit

fix(kiro): preserve tool-use context for resumed tool results
