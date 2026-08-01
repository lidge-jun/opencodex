# Verification plan - openai-chat EOF fail-closed

Date: 2026-07-01
Status: SCAFFOLD (to run during B/C of the fix).

## Red tests first (must fail before the fix)

Drive parseStream with a mock Response whose body is a ReadableStream of SSE
frames, then collect yielded events.

1. EOF with no [DONE] and no finish_reason => terminal error
   - frames: one content delta chunk, then stream closes (no [DONE])
   - assert the LAST event is { type: "error" }, NOT { type: "done" }
   - (pre-fix: FAILS - currently yields done)

2. clean [DONE] => done (no regression)
   - frames: content delta, then "[DONE]"
   - assert last event is { type: "done" } with usage passed through

3. EOF after finish_reason but no [DONE] => done (Option B acceptance)
   - frames: choices chunk with finish_reason "stop", then close
   - assert last event is { type: "done" } (provider omitted [DONE] but turn
     completed)

4. inline error envelope => error (existing behavior preserved)
   - frames: { error: { message } }
   - assert { type: "error" }, return; confirms we did not regress the
     already-fail-closed path

## Bridge-level check

- Confirm a { type: "error" } from parseStream maps to a classified
  response.failed in bridge.ts (case "error"), so truncation surfaces as a
  failed turn, not a truncated-but-completed one. Add/extend a bridge test if
  not already covered.

## Gates

- bun x tsc --noEmit -> exit 0
- bun test tests/<openai-chat-stream>.test.ts -> new cases green
- bun test tests/bridge.test.ts -> error mapping intact
- bun test ./tests/ -> no regressions
- bun run privacy:scan -> passed

## Done criteria

- Silent EOF (no [DONE], no finish_reason) => failed turn, never a clean done.
- Providers that finish via finish_reason but omit [DONE] still succeed.
- [DONE] and inline-error paths unchanged.
