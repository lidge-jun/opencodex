# Phase 160/170 (P2) - Kiro estimated usage tagging and redacted diagnostics

## Trigger

Kiro/CodeWhisperer does not return authoritative token usage. opencodex now
estimates usage so Codex display and auto-compact work, but internal usage logs
still classify those numbers as `reported`. The parity review also asks for
redacted diagnostics that make Kiro auth/region/model/debugging easier without
leaking prompts, tokens, profile ARNs, or local paths.

## Current state

- `src/types.ts` `OcxUsage` has token fields but no estimated marker.
- `src/usage-log.ts` already has `UsageStatus = "estimated"`, and
  `usage-summary.ts` already counts `estimatedRequests`, but
  `usageStatusForFinalLog()` currently returns `reported` for any usage object.
- Kiro emits heuristic usage from `parseKiroStream()` and `parseResponse()` via
  `done.usage`.
- Request logging extracts usage from the Responses SSE/JSON that the bridge
  sends downstream. That means adapter-only metadata is not preserved unless
  request-log finalization marks Kiro usage as estimated by provider.
- `src/debug.ts` has opt-in `OCX_DEBUG_FRAMES=1` diagnostics for dropped frames,
  but no structured redacted provider breadcrumb helper.
- `src/usage-debug.ts` already writes redacted JSONL records behind
  `OPENCODEX_USAGE_DEBUG=1`.

## Diff plan

### MODIFY `src/types.ts`

- Add optional `estimated?: boolean` to `OcxUsage`.
- This is an internal metadata flag; bridge response usage should keep the
  OpenAI-compatible token shape.

### MODIFY `src/usage-log.ts`

- Add `usageForFinalLog(provider: string, usage: OcxUsage | undefined)`:
  - returns `undefined` when no usage exists.
  - returns `{ ...usage, estimated: true }` for provider `kiro`.
  - preserves an already-estimated usage object for other providers.
- Change `usageStatusForFinalLog()`:
  - no usage -> `unreported`
  - usage.estimated -> `estimated`
  - otherwise -> `reported`
- Preserve `estimated: true` in `normalizeUsageValue()` while continuing to
  strip unknown runtime fields.

### MODIFY `src/server.ts`

- In `addFinalRequestLog()`, derive `const finalUsage =
  usageForFinalLog(logCtx.provider, logCtx.usage)`.
- Use `finalUsage` for:
  - `usageStatusForFinalLog(finalUsage)`
  - `usageTotalTokens(finalUsage)`
  - persisted/request-log `usage`
  - `usage-debug` `extractedUsage`
- Do not expose the estimated flag through `bridge.ts` Responses usage.

### MODIFY `src/adapters/kiro.ts`

- Keep Kiro `done.usage` values heuristic, but add `estimated: true` for direct
  adapter consumers/tests.
- Add an opt-in redacted diagnostic breadcrumb after `buildKiroPayload()`:
  - adapter/provider: `kiro`
  - auth/runtime region
  - requested model id
  - body byte length
  - message/tool counts
  - booleans only for profile ARN presence and previous response state
- Do not log raw request body, prompt content, image bytes, bearer tokens, or
  profile ARN values.

### MODIFY `src/debug.ts`

- Add `debugProviderDiagnostic(adapter, event, details)` behind existing
  `OCX_DEBUG_FRAMES=1`.
- Redact via `redactSecrets()` before JSON serialization.
- Keep failure-safe behavior: diagnostics must never throw back into request
  handling.

### MODIFY tests

- `tests/usage-log.test.ts`
  - `usageStatusForFinalLog({ estimated: true })` returns `estimated`.
  - `usageForFinalLog("kiro", usage)` marks usage estimated.
  - persisted usage JSONL preserves only the boolean `estimated` metadata and
    still strips unknown fields.
- `tests/request-log.test.ts`
  - Kiro deferred SSE logging records `usageStatus: "estimated"` and usage with
    `estimated: true`, while the SSE usage payload itself stays standard.
- `tests/kiro-stream.test.ts`
  - Kiro done usage includes `estimated: true`.
- `tests/debug.test.ts`
  - provider diagnostic helper stays silent by default and redacts secrets when
    enabled.
- `tests/usage-debug.test.ts`
  - usage-debug record can store `extractedUsage.estimated === true` without
    leaking secret fields.

## Verification

- `bun x tsc --noEmit`
- `bun test tests/usage-log.test.ts tests/request-log.test.ts tests/kiro-stream.test.ts tests/debug.test.ts tests/usage-debug.test.ts tests/usage-summary.test.ts`
- `wc -l src/types.ts src/usage-log.ts src/server.ts src/adapters/kiro.ts src/debug.ts tests/usage-log.test.ts tests/request-log.test.ts tests/kiro-stream.test.ts tests/debug.test.ts tests/usage-debug.test.ts`

## Commit

`fix(kiro): mark heuristic usage as estimated`

## Explicit non-goals

- No raw prompt or full Kiro payload logging.
- No full raw AWS eventstream frame capture.
- No public Responses API schema change for usage; estimated status is for
  opencodex logs/debugging.

## Completion evidence

- Implementation commit: `e50ca23 fix(kiro): mark heuristic usage as estimated`.
- `src/types.ts` now carries internal `OcxUsage.estimated`.
- `src/usage-log.ts` marks provider `kiro` usage as estimated at final log time,
  preserves only the boolean metadata in JSONL, and still strips unknown runtime
  fields.
- `src/server.ts` uses the final normalized usage for request logs and
  `usage-debug` extracted usage, without changing downstream Responses usage.
- `src/adapters/kiro.ts` emits `done.usage.estimated = true` and logs only
  opt-in redacted request breadcrumbs through `debugProviderDiagnostic()`.
- `src/debug.ts` keeps provider diagnostics behind `OCX_DEBUG_FRAMES=1`, redacts
  secrets/profile ARNs/tokens, and swallows diagnostic failures.
- Local verification passed:
  - `bun x tsc --noEmit`
  - `bun test tests/usage-log.test.ts tests/request-log.test.ts tests/kiro-stream.test.ts tests/debug.test.ts tests/usage-debug.test.ts tests/usage-summary.test.ts`
  - `65 pass, 0 fail`
- Backend verifier returned `DONE`, confirmed public Responses usage shape stays
  unchanged, request logs mark Kiro usage `estimated`, usage-debug preserves
  `estimated`, provider diagnostics are opt-in/redacted, and `src/adapters/kiro.ts`
  is 489 lines.

## Follow-up: Request Logs should show full-context estimates

User observed that Kiro request log rows showed only ~100-800 tokens while
ChatGPT rows showed large context-sized totals. Root cause: Kiro's downstream
Responses usage intentionally reports only current-turn input delta so Codex's
own cumulative session accounting does not double count old history. The GUI
Request Logs, however, should answer a different question: approximate context
size/cost for that request.

Patch plan:

- Keep public Responses/SSE Kiro usage unchanged (`input_tokens` remains
  current-turn delta).
- Add adapter-internal `AdapterRequest.usageLog.inputTokens`.
- Have Kiro fill `usageLog.inputTokens` with a full Codex-context estimate:
  system prompt, tools, user/developer messages, assistant text/tool calls,
  and tool results.
- Have server request-log finalization use that internal estimate only for
  persisted/logged usage totals.
- Keep `estimated: true` on Kiro logs.

Verification:

- `bun x tsc --noEmit`
- `bun test tests/kiro-stream.test.ts tests/request-log.test.ts tests/usage-log.test.ts tests/usage-summary.test.ts tests/usage-debug.test.ts`
- `63 pass, 0 fail`
- `src/adapters/kiro.ts` is 494 lines.
