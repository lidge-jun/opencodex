# D — cycle summary (phases 1-2 + follow-up phase 3)

## Outcome: DONE

## What shipped
### Bug A — `{"detail":"Unsupported parameter: previous_response_id"}` (ChatGPT Codex backend 400)
- src/adapters/openai-responses.ts: `stripPreviousResponseId` now ALWAYS strips the field in
  `authMode:"forward"` (backend rejects it categorically; Codex WS turns are converted to
  internal HTTP so no raw-WS chaining exists to break). API-key mode unchanged: strip only
  after proxy expansion (platform /v1/responses has real storage).
- src/server.ts passthrough branch: records completed passthrough responses into the replay
  store via new `onCompletedResponse` callbacks on `consumeForInspection` /
  `consumeForResponseLogMetadata` + JSON path, so the NEXT chained turn expands locally instead
  of arriving as a naked delta. Guarded: never records a body whose own previous_response_id
  failed to expand (would store truncated history). Warns on unexpanded miss for diagnosability.
- src/responses/state.ts: `rememberResponseState(..., { force: true })` bypasses only the
  store:false skip (codex-rs sends store:false everywhere non-Azure; WS inherits it).

### Bug B — Anthropic `assistant message prefill` 400
- src/adapters/anthropic.ts `messagesToAnthropicFormat`: if wire messages are empty or end with
  role assistant, append user "(continue)" (kiro precedent). Covers previous_response_id
  expansion with empty input, interrupted-turn replay, web-search sidecar first iteration.

## Evidence (fresh)
- `bun test ./tests/`: 1498 pass, 0 fail, 157 files, exit 0.
- `bun x tsc --noEmit`: exit 0.
- New regression tests: tests/openai-responses-passthrough.test.ts (forward always-strip +
  api-key two-mode matrix), tests/responses-state.test.ts (force record → expansion),
  tests/anthropic-tail-guard.test.ts (4 cases). Worker evidence:
  .codexclaw/evidence/260706_phase2_anthropic_tail_guard_attempt1.txt.
- Audit: gpt-5.5 reviewer verdict PASS-WITH-FIXES; both fixes applied (WS-path analysis,
  guarded recording instead of unguarded).

## What did not change / residual risk (LOOP-PESSIMIST-01)

## Phase 3 follow-up (same day): orphan-input 400 after the strip
- User hit `No tool call found for function call output with call_id ...`: stripping
  previous_response_id on a miss forwards a delta whose function_call_output has no paired
  function_call. Fix: `repairOrphanedInputItems` in src/adapters/openai-responses.ts —
  runs on every forward request (no-op when pairs intact); orphan
  function_call_output/custom_tool_call_output → user input_text message (info preserved);
  function_call_output pairs with function_call AND local_shell_call (codex-rs emits shell
  outputs as function_call_output); reasoning items dropped only on unexpanded miss
  (orphan rs_* items 400 with "provided without its required following item").
- Evidence: bun test ./tests/ 1501 pass 0 fail (exit 0), tsc exit 0; 3 new regression tests
  in tests/openai-responses-passthrough.test.ts. Audit: gpt-5.5 (Gauss) design verdict applied.

## Residual risk (updated)
- Routed adapters (openai-chat/anthropic/google/kiro/cursor) still silently degrade to
  delta-only context on an expansion miss (no 400, but context loss). The new passthrough
  warn does not cover routed paths. Watch item, not a defect fix candidate yet.
- State store remains in-memory (restart still loses chains); passthrough recording narrows
  the miss window but does not eliminate it. Disk persistence was declared out of scope.
- A miss now degrades to reduced context (tool outputs as user text, reasoning dropped)
  instead of a 400; the model may lose nuance on that one turn. Acceptable trade-off.
- The RUNNING ocx instance must be restarted to pick these fixes up.
