# WP2 plan — Cursor native-tool stall: instrumentation and fix

Date: 2026-07-02
Owner: Boss (Claude main session); implementation per PABCD B phase.
Status: P phase draft.

## Problem (evidence-backed)

Generic task wording ("list files", "read the file") makes `cursor/composer-2.5`
choose Cursor-native tools. Those turns stall: upstream goes silent after the
first assistant text, ocx's stall watchdog trips `upstream_stall_timeout`
(`src/bridge.ts:149`, 90s), codex retries 5x, every upstream request ends
`502 unreported ~98-106s`. Reproduced 12/12 across run 4 and run 6 (healthy
catalog), while run 8 (same dir/sandbox, wording forces `exec_command`)
completed 4 sequential round trips in 39s. Run 3 file WRITES succeeded via the
server-driven native exec channel (`writeArgs` → `native-exec-fs.ts`), so the
stall is specific to the *ToolCall-frame* native path, not native tools broadly.

Structural fact: `mcpArgsFromToolCall` (`src/adapters/cursor/protobuf-events.ts:48`)
returns undefined for any `toolCall.tool.case !== "mcpToolCall"`, so
`toolCallStarted`/`partialToolCall`/`toolCallCompleted` for native tool cases
(`readToolCall`, `editToolCall`, `shellToolCall`, ... per `gen/agent_pb.ts`
ToolCall union) are swallowed: no outward event, no local execution, no reply.
If the server-side agent waits for the client to act on such a call, the turn
hangs by construction.

## Plan

### Step 1 — env-gated frame diagnostics (code, small)

- MODIFY `src/adapters/cursor/live-transport.ts`: in the server-message handler,
  when `OCX_DEBUG_FRAMES=1`, call `debugProviderDiagnostic("cursor", ...)`
  (existing helper in `src/debug.ts`) with: frame case, interactionUpdate inner
  case, toolCall union case + callId + tool name when present, and whether the
  frame was mapped/swallowed. Redaction via existing `redactSecrets`.
- MODIFY `src/adapters/cursor/protobuf-events.ts`: return a tiny classification
  (mapped/swallowed + toolCall case) or export a probe hook so the transport can
  log swallow decisions without duplicating parsing.
- No behavior change with the env var unset.

### Step 2 — capture a stall (no shared-server restart)

- Start a second instance from the working tree:
  `OCX_DEBUG_FRAMES=1 bun run src/cli.ts start --port 10199` with stdout/err to
  a scratch log (instance shares config; do NOT run `ocx stop`).
- Reproduce with the run-4 prompt:
  `codex exec -m cursor/composer-2.5 -c model_providers.opencodex.base_url="http://localhost:10199/v1" ...`
- Confirm which frame(s) arrive last before silence, and which toolCall case was
  swallowed.

### Step 3 — fix: answer `interactionQuery` (STATIC ROOT CAUSE CONFIRMED)

Static schema analysis (2026-07-02, main session) found the concrete stall
mechanism, superseding the original Case A/B tree:

- `AgentServerMessage` union includes `interactionQuery`
  (`gen/agent_pb.ts`, cases: `webSearchRequestQuery`,
  `askQuestionInteractionQuery`, `switchModeRequestQuery`,
  `exaSearchRequestQuery`, `exaFetchRequestQuery`, `createPlanRequestQuery`,
  `setupVmEnvironmentArgs`), each carrying a `uint32 id`.
- The client must reply `AgentClientMessage.interactionResponse` with the
  matching id (`InteractionResponse` fields mirror the query cases).
- ocx has ZERO handling of `interactionQuery` and NEVER sends
  `interactionResponse` (grep over non-generated sources). The server-side
  agent blocks on the answer → silence → watchdog (90s) → codex retry →
  upstream 502 (~100s).
- Fit with the A/B matrix: planning-flavored exploration prompts push composer
  into plan/ask flows (`createPlanRequestQuery` — CreatePlanArgs carries plan/
  todos/phases; `askQuestionInteractionQuery`); "use exec_command" wording
  skips planning entirely (run 8 passed); write tasks skip it too (run 3).
- The exec channel itself is fully answered (all 17 `ExecServerMessage` cases
  handled in `native-exec.ts`), and native ToolCall FRAMES are display-plane
  (`interactionUpdate`), so the earlier "unhandled native ToolCall" framing was
  directionally right (unanswered server expectation) but the actionable plane
  is `interactionQuery`.

Fix design:

1. Add an `interactionQuery` branch in the live-transport server-message
   dispatch, replying `interactionResponse` (matching `id`) per case:
   - `createPlanRequestQuery` → `CreatePlanResult` success (acknowledge; also
     surface the plan text/todos to Codex as assistant reasoning/message so the
     user sees it).
   - `askQuestionInteractionQuery` → non-interactive default: reply
     `AskQuestionResult` with `rejected` (agent proceeds autonomously); log the
     question at diagnostic level. (Future: bridge to Codex
     `request_user_input` when available.)
   - `webSearchRequestQuery` → `approved` (ocx has a web-search sidecar/fetch
     path) or `rejected` behind a config flag; start with `rejected` for
     determinism, revisit.
   - `switchModeRequestQuery` → `rejected` (stay in current mode).
   - `exaSearchRequestQuery`/`exaFetchRequestQuery` → `rejected` initially.
   - `setupVmEnvironmentArgs` → error result (unsupported).
2. Add `interactionQuery` to `isCursorProgressFrame` so the watchdog sees
   liveness while a reply is produced.
3. Keep Step 1 diagnostics: log every interactionQuery case + id + reply case.
- Hardening regardless: when the watchdog fires, log the last-seen frame case
  at diagnostic level; usage finalize on error paths still emits partial usage
  (ties into WP1).

### Step 4 — tests

- Unit: native ToolCall frames are either declared-away or executed+replied
  (fixture protobuf frames for readToolCall/editToolCall path).
- Regression: existing cursor suites stay green (`bun test tests/cursor-*.test.ts`).
- Full: `bun test ./tests/` + `bun x tsc --noEmit`.

### Step 5 — live acceptance

- Run-4 prompt completes with tool calls executing (no stall) on the debug
  instance, then on the main instance after restart at a user-approved moment.
- Run-8-style forced exec still works; run-1 tool-count demo still works.

## Implementation pass — 2026-07-02 (Boss direct, after employee lanes stalled)

Live-capture pivot: with full frame diagnostics on the debug instance
(:10199, isolated OPENCODEX_HOME), the stall repro showed NO `interactionQuery`
frames. The actual sequence before silence: `toolCallStarted(shellToolCall)` →
`requestContextArgs` → `setBlobArgs`×3 → `execServerMessage: shellStreamArgs`
→ checkpoint/toolCallDelta → heartbeats forever. ocx answered `shellStreamArgs`
with start/stdout/stderr/exit only. jawcode's reference handler documents the
missing piece verbatim: "Cursor can keep the turn pending when it receives only
stream deltas. Send the final structured shellResult as completion
acknowledgement" — followed by an exec `streamClose` control frame
(`jawcode/packages/ai/src/providers/cursor.ts:850-856, 1230-1244`).

### Changes

- `src/adapters/cursor/native-exec-shell.ts` — shellStreamExec now appends the
  structured `shellResult` (success/failure with stdout/stderr/exitCode/
  executionTime) and an `execClientControlMessage.streamClose` after the `exit`
  stream event. THIS is the stall fix.
- `src/adapters/cursor/native-exec-common.ts` — added `execStreamCloseBytes`
  helper (mirrors jawcode `sendExecClientStreamClose`).
- `src/adapters/cursor/live-transport.ts` — (1) `interactionQuery` handler:
  replies `interactionResponse` with matching id per case (createPlan→success +
  plan text surfaced to Codex; askQuestion/switchMode/webSearch/exaSearch/
  exaFetch→rejected with reason; setupVm→success (schema has no error case);
  unknown→empty response), plus liveness heartbeat — protective infrastructure
  for the query-blocking stall mode even though the live repro didn't need it;
  (2) `isClientToolFrame` narrowed to `mcpToolCall` frames with our provider
  (native ToolCall frames no longer revoke a pending client-tool finalize);
  (3) OCX_DEBUG_FRAMES diagnostics: per-frame case dump
  (`describeCursorServerFrame`) and interaction-query reply logging.
- `src/adapters/cursor/protobuf-events.ts` — exported `mcpArgsFromToolCall`.
- `tests/cursor-interaction-query.test.ts` (new, 11 tests) — reply case + id
  echo per query case, plan surfacing, isClientToolFrame narrowing fixtures.
- `tests/cursor-native-exec-shell.test.ts` (new, 2 tests) — shellStream reply
  sequence ends with structured shellResult + streamClose, success and failure.
- `tests/cursor-native-exec.test.ts` — updated shellStream expectations for the
  completion frames.

### Verification

- `bun test ./tests/` → 1317 pass, 0 fail. `bun x tsc --noEmit` → clean.
  `git diff --check` → clean. Catalog md5 unchanged across the full suite
  (WP0 isolation fix holding).
- Live acceptance (debug instance :10199, run10): the exact prompt that
  stalled 18/18 (runs 4/6/7/9) completed in 79s with ZERO reconnects — native
  ls/read/grep/shellStream all served (2× shellStreamArgs, 3× readArgs,
  1× grepArgs), correct on-task final summary, no contamination observed.
- Main instance (PID 34360→97816 lineage, port 10100) still runs pre-fix code;
  restart at the user's convenience activates the fix there.

## Files

- MODIFY: `src/adapters/cursor/live-transport.ts` (diagnostics; native ToolCall
  routing if Case A-2)
- MODIFY: `src/adapters/cursor/protobuf-events.ts` (swallow-probe; native case
  mapping if needed)
- MODIFY (Case A-2): `src/adapters/cursor/native-exec.ts` / `native-exec-fs.ts`
  (reuse executors)
- MODIFY (Case A-1): `src/adapters/cursor/protobuf-request.ts` (declare client
  tool surface)
- NEW tests: `tests/cursor-native-toolcall.test.ts` (or extend
  `cursor-protobuf-events.test.ts`)

## Risks

- Frame shape for native tool replies is undocumented; wrong shape could confuse
  the server-side agent (mitigate: capture real frames first, mirror jawcode
  reference implementation if present).
- Declaring a reduced tool surface might change Cursor-side planning quality.
- Debug instance shares ~/.opencodex config/usage files with the main instance
  (append-only usage: acceptable; no config writes planned).
