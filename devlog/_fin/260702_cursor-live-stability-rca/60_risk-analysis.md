# Risk analysis — cursor stability work-phases (WP0/WP2/WP2b/WP1/P0/WP3)

Date: 2026-07-02
Owner: Boss (main session). Inputs: live-eval matrix (00_), WP plans (10/20/30/
40/50_), WP2 plan audit, spark research lanes S1-S4 (pending → fold in).

## WP2 — interactionQuery auto-reply

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Rejection loop: server re-issues the same query after `rejected` (askQuestion/switchMode), turn never progresses — stall becomes a busy-loop | Med | High | Per-request counter keyed by query case; after N (e.g. 3) repeats emit an outward error/done so codex ends the turn cleanly; log each reply at diagnostic level. Validate live on the debug instance before default rollout. |
| R2 | `createPlan` success semantics: replying success with empty/placeholder `plan_uri` may confuse the server-side agent (it may reference the plan later) | Med | Med | Echo the agent-provided plan content in the success shape where fields allow; surface plan text to codex as visible output; if live capture shows follow-up plan reads, switch to error-shape reply instead. S1 (jawcode behavior) decides the final default. |
| R3 | Reply write races the revocable grace finalize / stream teardown: writing a frame after cancel/end throws or corrupts the connect stream | Med | Med | Guard on stream writable state and `state.terminated`; post-terminal queries stay inert (no reply, no heartbeat). Unit test both orderings. |
| R4 | `id` echo mismatch (uint32, proto3 default 0 omitted) → server still waits | Low | High | Explicit test: reply id === query id for every case, including id=0 edge. |
| R5 | `isClientToolFrame` narrowing re-opens the parallel client-tool race it guarded (if any legit client-tool lifecycle frame is not `mcpToolCall`, e.g. `truncatedToolCall` wrapping) | Low-Med | High | Keep existing race tests (`cursor-tool-finalize-race.test.ts`) green; add a fixture for truncated/mixed frames; if in doubt, treat `truncatedToolCall` as client-activity too. |
| R6 | Auto-rejecting `webSearchRequestQuery` degrades answers for search-flavored prompts (agent may hallucinate instead of searching) | Med | Low-Med | Acceptable initial default (determinism); WP2b/follow-up can approve + service via the existing web-search sidecar/fetch path behind a config flag. |
| R7 | Behavior change for Cursor IDE-like flows we don't see (queries meant for human UI) | Low | Med | All replies logged; OCX_DEBUG_FRAMES capture retained for one release cycle. |

Open input: S1 (how jawcode answers each query) may flip R2/R6 defaults.

S1/S2 results (landed):

- jawcode (`/Users/jun/Developer/new/700_projects/jawcode/packages/ai/src/providers/cursor.ts:603-621`)
  does NOT handle `interactionQuery` at all — no precedent to copy; our handler
  is first. Its dispatch covers only interactionUpdate/kv/exec/checkpoint.
- Reply shapes are trivial (S2): `CreatePlanSuccess` is an EMPTY message (+
  `planUri: string` on the result), rejections carry `{reason: string}`,
  approvals are empty messages. `SetupVmEnvironmentResult` has ONLY a `success`
  field (no error case) — for setupVm the only valid reply is success or
  silence; choose success + diagnostic log (R-new below).
- R2 revision: `createPlan` success needs no plan echo — empty success +
  optional `planUri` is schema-valid. Keep surfacing plan text to codex.
- NEW RISK (R8, High relevance to WP2b): jawcode EXECUTES `mcpArgs` locally
  via handlers and replies success/toolNotFound/error (`cursor.ts:1155-1167,
  1248-1258, 1937-1953`). ocx instead replies a bridge-suspension ERROR for
  client Responses tools (`native-exec.ts:79-86`). That refusal likely lands in
  the server-side agent's state as a FAILED tool result — explaining the live
  20:41 session where the model saw "MCP exec_command keeps failing" and fell
  back to native Shell, even though codex executed the real calls via the
  round-trip plane. The hybrid (bridge via toolCall frames + refuse via exec
  channel) poisons the model's view. WP2b must make the exec-channel reply
  non-poisonous: either suppress/soften it (neutral deferral result), stop the
  server choosing that plane (advertise location A/B), or accept jawcode-style
  local execution for shell-class tools per WP3 policy.

## WP0 — catalog erosion fix

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Preservation creates zombie routed entries: intentionally removed providers keep stale catalog rows forever | Med | Low | Canonical profile syncs still replace their own providers' rows; `restoreCodexCatalog` remains the explicit cleanup; document. |
| R2 | Call-time CODEX_HOME resolution changes backup-path pairing (`catalogBackupPathFor`) or models-cache sync targets | Low | Med | Implementation matched codex-paths realpath normalization; focused suites passed (52/0); verify backup round-trip in full local suite (C phase). |
| R3 | Employee sandbox could not bind sockets → server-auth/api-usage suites unverified in-sandbox (59 pass/26 fail EADDRINUSE there) | Certain (env) | Med | MUST re-run full suite locally in C phase; treat sandbox failures as environmental only after local green. |
| R4 | Two concurrent syncs interleave (last-write-wins) | Low | Low | atomicWriteFile prevents torn files; per-provider preservation shrinks the blast radius; accept. |
| R5 | The 20:41 catalog write source unidentified (healthy content, but writer unknown) | Med | Low | After C, watch mtime across a test run + an idle hour; erosion recurrence now test-covered. |

## WP2b — tool-name surface unification

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Alias acceptance (`mcp_opencodex-responses_exec_command` → `exec_command`) collides with a real third-party MCP server named similarly | Very low | Low | Prefix match only for providerIdentifier === "opencodex-responses". |
| R2 | Removing the bridge-suspension error changes server routing in unknown ways (server may then EXPECT synchronous MCP results on the exec channel) | Med | High | Do NOT just delete the error. A/B on debug instance: advertise client tools via AgentRunRequest.mcpTools vs requestContextResult; pick the shape where the server emits client tool calls (interactionUpdate) instead of exec-channel mcpArgs. S1/S3 inform. |
| R3 | Relaxing exact-name prompt weakens the tool-count discipline wins | Low | Low | Relax ONLY the naming clause; keep count/batch/result-accounting rules intact; rerun tool-count evals. |

## WP1 — usage reporting

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Partial usage on failed/retried requests inflates aggregate token sums (each retry logs a row) | Med | Low | It reflects real upstream consumption; label rows (`usageStatus`) so summaries can separate; document. |
| R2 | New usageStatus value breaks GUI/summary consumers | Med | Med | Grep all consumers of usageStatus before choosing a new enum value; safest: keep `estimated`, add boolean `partial`. |
| R3 | Cross-turn checkpoint carry conflicts with P0 fix (fresh conversationId may change checkpoint cadence) | Med | Med | Sequence WP1 after P0 capture; keep carry logic keyed to the Responses chain, not the Cursor conversationId. |

## P0 — contamination

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Fresh conversationId per request kills server-side context reuse → latency/cost regression, checkpoint token reports may disappear (breaks WP1 data) | Med | Med | Capture first (debug instance): compare resumed vs fresh on latency/checkpoint presence; choose per-REQUEST fresh id only if contamination confirmed to ride ResumeAction. |
| R2 | ResumeAction semantics may be required for tool-result continuation (server may reject a fresh conversation whose first action is a tool-result resume) | Med | High | Fallback shape: replay history as UserMessageAction with embedded tool results (full replay already exists); A/B live. |
| R3 | Blob map scoping (per-conversation) breaks server getBlob of legitimately shared content | Low | Low | Scope by conversation + TTL; serve misses as empty (server re-sends inline). |

## Additional root causes (Boss direct pass, 21:0x)

1. **20:41 catalog write identified**: the user restarted ocx at 20:41 (new
   PID 34360; ocx.pid mtime 20:41). Restart sync wrote the healthy 24-model
   catalog — benign, and explains the clean 21:00 live session. The
   "Proxy already running (PID 5766)" service.log line is from a prior stale
   pid file, not a foreign writer.
2. **Inter-tool latency architecture (the ~5-9s floor)**: every continuation
   rebuilds the FULL conversation as content-addressed blobs
   (`protobuf-request.ts` `rootPromptMessages` iterates all rawMessages) and
   opens a fresh h2 session (`live-transport.ts` connects per run). Wire cost
   is small (blob ids; server fetches unknown blobs), but Cursor re-prefills
   the whole context per turn — no server-side conversation/cache reuse in the
   current replay design. This is also why cache tokens can never appear.
   Fix directions (post-WP2, feeds WP3/latency work-phase):
   - (a) "bridge suspension" proper: hold the exec-channel `mcpArgs` open,
     bridge the codex tool round trip across requests, reply `McpResult` when
     the tool result arrives — eliminates replay + keeps server context warm;
     needs a held-stream state machine with timeouts (user-abort leak risk).
   - (b) incremental resume via cached ConversationStateStructure (jawcode
     `conversationStateCache` precedent, `cursor.ts:342-351, 2570-2590`) —
     but MORE server-state reuse directly tensions with P0 contamination;
     sequence after P0 capture.
3. **Blob store never evicts** (`native-exec.ts`: set/get only): unbounded
   memory growth on a long-running server AND indefinite availability of every
   conversation's stale blobs (contamination enabler — P0 fix candidate #2 is
   now confirmed necessary regardless of the primary contamination mechanism).
   Fix: scope per conversation + TTL/eviction; serve misses as empty.

## Live acceptance / operational

- Restarting the shared ocx (PID 75582) mid-day kills in-flight requests of
  other consumers (kiro/chatgpt lanes observed live). Plan: debug instance on
  :10199 for all captures/evals; restart the main instance only at an
  agreed moment (user confirm) or when traffic is idle.
- Both B lanes ran `bun test` BEFORE WP0's isolation landed → catalog was
  re-eroded during implementation; after C-phase local green, run
  `bun run src/cli.ts sync` once and re-verify 18 cursor entries + mtime
  stability across a follow-up test run.
- WP2 and WP0 diffs land on the same dirty working tree as the existing
  cursor-fixes changes; C phase must re-run the FULL suite locally and
  `git diff --check`, and the eventual commit should be reviewed as one
  coherent branch state (no partial reverts).

## Decision queue for the user

1. WP3 policy: native Cursor writes — block/redirect via codex apply_patch
   (safe, visible, slower) vs allow (fast, invisible). Default proposal:
   redirect once WP2b's advertise-location A/B proves controllable routing.
2. WP2 default for webSearchRequestQuery: rejected (deterministic) vs
   approved+sidecar. Default proposal: rejected now, flag later.
3. Main-instance restart timing for live acceptance of WP2/WP0.
