# Phase 125 (P1 residual) - Kiro tool fallback hardening

## Trigger

Phase 120 closed JSON Schema sanitization only. The external code review still
flags three Kiro tool-compatibility gaps:

- Long tool descriptions are hard-truncated to 1024 chars.
- Tool results can still be sent as structured `toolResults` when no tool
  definitions are present.
- Orphaned tool results can still be sent as structured `toolResults` when the
  transmitted payload no longer contains the matching assistant `toolUse`.

## Current state

- `src/adapters/kiro-tools.ts` sanitizes schemas and returns raw Kiro tool
  specifications, but it truncates descriptions.
- `src/adapters/kiro.ts` converts every assistant `toolCall` to Kiro
  `toolUses`, and every `toolResult` to pending structured `toolResults`.
- Resume repair from Phase 100 preserves the previous assistant context for
  ordinary resumed tool-result turns, but malformed/no-tools inputs still need
  fail-closed text fallback.

## Diff plan

### MODIFY `src/adapters/kiro-tools.ts`

- Add a `convertKiroToolContext(parsed)` export returning:
  - `tools: unknown[]`
  - `systemAdditions: string[]`
- Keep `convertKiroTools(parsed)` as a compatibility wrapper returning only
  `tools`.
- If a tool description is over 1024 chars:
  - Replace the Kiro tool definition description with a short pointer such as
    `Tool documentation moved to the system prompt: <tool-name>.`
  - Add the full description to `systemAdditions` under a deterministic heading.
- Preserve existing schema sanitization behavior from Phase 120.

### ADD `src/adapters/kiro-wire.ts`

Keep `src/adapters/kiro.ts` below the 500-line project limit by moving existing
wire helpers out before adding fallback logic:

- `fingerprint()`
- `osTag()`
- `mapModelId(id)`
- `normalizeToolId(id)`

The functions keep their current behavior exactly. This is a mechanical
extraction only.

### MODIFY `src/adapters/kiro.ts`

- Remove local wire helpers and import them from `src/adapters/kiro-wire.ts`.
- Import `convertKiroToolContext()` instead of only `convertKiroTools()`.
- Append `systemAdditions` to the payload system prefix. Unlike the stable
  system prompt, tool documentation additions should be present whenever the
  request includes tool definitions, including resumed requests, because Kiro
  receives the tool specs on the current request.
- Track structured assistant tool-use IDs while building the transmitted
  payload.
- If `parsed.context.tools` converts to zero Kiro tools:
  - Do not emit `assistantResponseMessage.toolUses`.
  - Do not emit `userInputMessageContext.toolResults`.
  - Render assistant tool calls and tool results as plain text context.
- If a `toolResult` has no matching earlier assistant tool-use ID in the
  transmitted payload:
  - Convert it to a plain user text entry.
  - Do not attach it as structured `toolResults`.
- Preserve current behavior for valid tool-call continuation payloads: matching
  assistant `toolUses` remain structured and matching `toolResults` stay
  adjacent.

### MODIFY `tests/kiro-adapter.test.ts`

Add regression coverage:

- Long tool descriptions are not lost: Kiro tool definition has a short pointer
  and the full description appears in the user/system-prefixed payload.
- No-tools fallback converts assistant tool calls and tool results to text and
  emits no structured `toolUses`/`toolResults`.
- Orphaned tool results with tools present convert to text and emit no
  structured `toolResults`.
- Existing resumed tool-result context test remains green.

## Verification

- `bun x tsc --noEmit`
- `bun test tests/kiro-adapter.test.ts`
- `wc -l src/adapters/kiro.ts src/adapters/kiro-tools.ts src/adapters/kiro-wire.ts tests/kiro-adapter.test.ts`

## Commit

`a63aa76 fix(kiro): harden tool fallback payloads`

## Completion evidence

- Implemented `convertKiroToolContext()` in `src/adapters/kiro-tools.ts`.
- Added `src/adapters/kiro-wire.ts` and `src/adapters/kiro-tool-fallback.ts`
  to keep the Kiro adapter below the 500-line project limit.
- Updated `src/adapters/kiro.ts` so long tool docs are appended to the
  current request prompt, unsafe tool calls/results degrade to plain text, and
  matching tool-use/tool-result continuations remain structured.
- Split stream tests into `tests/kiro-stream.test.ts` and added payload
  regressions in `tests/kiro-adapter.test.ts`.

Verification:

- `bun x tsc --noEmit` passed.
- `bun test tests/kiro-adapter.test.ts tests/kiro-stream.test.ts tests/kiro-images.test.ts tests/kiro-retry.test.ts tests/kiro-oauth.test.ts`
  passed: 66 pass, 0 fail.
- Read-only Backend verifier reran the same typecheck, targeted Kiro tests,
  line counts, and reported DONE.
- C-stage root test sweep passed with `bun test tests/*.test.ts`: 717 pass,
  0 fail.
- `bun test tests` is not used as the C-stage pass gate because Bun also
  discovers archived `devlog/opencode-cursor/tests/**` fixtures from the
  repository snapshot; that broader command currently fails in those archived
  tests and is unrelated to this Kiro adapter phase.
- Line counts after the split:
  - `src/adapters/kiro.ts`: 481
  - `src/adapters/kiro-wire.ts`: 50
  - `src/adapters/kiro-tool-fallback.ts`: 36
  - `src/adapters/kiro-tools.ts`: 44
  - `tests/kiro-adapter.test.ts`: 237
  - `tests/kiro-stream.test.ts`: 333

## Explicit non-goals

- No truncation recovery state machine; Phase 150 owns stream/tool truncation.
- No payload-size trimming; this phase preserves long tool docs in the prompt
  but does not implement history trimming.
- No new tool schema sanitization beyond Phase 120 behavior.
