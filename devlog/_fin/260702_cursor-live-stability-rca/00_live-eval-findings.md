# Cursor live stability RCA — live-eval findings

Date: 2026-07-02
Owner: Boss direction; Claude main session live evals + parallel Codex investigation lanes.
Status: research in progress; three Codex lanes running (hang/502, usage semantics,
cross-session contamination), one lane complete (read/write native gap).

## Request

User-reported symptoms on `codex exec -m cursor/composer-2.5` through ocx:

1. File read/write does not go through Codex-native tool paths (`apply_patch`);
   everything appears to funnel through `exec_command`.
2. Long gaps between tool calls; intermittent hangs ending in HTTP 502
   `upstream_server_error` after 49-114s (one marked usage-unreported with 0 tokens).
3. Request log shows cursor tokens as per-request increments without cache figures,
   while other providers show cumulative totals plus `cachedInputTokens`.

## Live-eval runs (this session, ocx PID 75582 started 14:51, working tree)

### Run 1 — `tool use 10개해봐` (15:45)

- Completed in ~15s total. Model emitted all 10 `exec_command` calls in ONE turn
  (parallel batch), exact-count discipline held, no MCP mislabel.
- Exactly 2 cursor upstream requests: turn 1 (9.1s) + final continuation (5.5s).
- Prompt-calibration patch behavior confirmed good on this path.

### Run 2 — greeter.py create/read/modify/verify (15:46)

- 3 cursor requests: 28.6s (in≈38K est), 7.9s (in=0 est), 36.6s (in≈44K est).
- File creation went through `exec_command` heredoc (`cat > greeter.py << EOF`),
  NOT `apply_patch`.
- **CRITICAL**: final continuation turn returned content from an unrelated
  conversation ("smoke harness", "enterprise skill", "P0 bridge contract",
  "Verdict: PATCH ALREADY", "Turn 2 Evidence") wrapping THIS session's tool results
  inside the foreign narrative. Cross-conversation context contamination.
  Task farewell() was claimed complete but the file only contained greet().

### Run 3 — calc.py after catalog sync (15:52)

- Ran `ocx sync` first (see Catalog findings below). Codex CLI's
  "Model metadata for cursor/composer-2.5 not found" warning disappeared.
- 2 cursor requests (13.0s + 7.5s). calc.py was created/modified CORRECTLY —
  but with ZERO codex-visible tool calls for the writes. Codex rollout
  (`~/.codex/sessions/.../rollout-...-019f2199-f279...jsonl`) contains only one
  `function_call exec_command` (the python verification). calc.py was
  created 15:52:53 / modified 15:52:57, before the first codex-visible event.

## Root-cause findings so far

### A. Stale Codex model catalog (confirmed, mitigated live)

- `~/.codex/opencodex-catalog.json` contained only 6 native/template entries and
  NO cursor models (while the running server's `/v1/models` returned 24 incl. 18
  cursor entries). Codex CLI therefore used fallback model metadata, which lacks
  `apply_patch_tool_type` → codex-rs never advertised `apply_patch` for cursor
  models (spec_plan gates apply_patch on `model_info.apply_patch_tool_type`).
- Running `bun run src/cli.ts sync` appended 20 models; `cursor/composer-2.5` now
  carries `apply_patch_tool_type: "freeform"`, `context_window: 200000`,
  `supports_parallel_tool_calls: true`.
- Open question: why the catalog was stale despite `ocx start` calling
  `syncModelsToCodex` (cli.ts:200 swallows errors with `.catch(() => {})`);
  file had been rewritten today 15:25 still without cursor entries.

### B. Cursor-native local exec channel bypasses Codex (confirmed)

- `src/adapters/cursor/native-exec.ts:61-99` executes Cursor's native exec channel
  locally in the ocx process: `readArgs`/`writeArgs`/`deleteArgs`/`lsArgs`/
  `grepArgs` (native-exec-fs), `shellArgs`/`shellStreamArgs`/`writeShellStdinArgs`
  (native-exec-shell), fetch/MCP/computer-use.
- Run 3's file writes went through this channel: fast (in-stream, no codex round
  trip) but invisible to Codex — no approval, no sandbox policy, no diff display,
  no rollout record. This is the real shape of "read/write doesn't go through
  codex native": there are TWO competing tool surfaces, and the Cursor agent
  sometimes picks its own.
- Product decision needed: route file mutations through the Codex client-tool
  round trip (apply_patch) for UX/safety, or keep Cursor-native for speed but
  surface synthetic events/audit to Codex.

### C. Cross-session contamination (observed live; RCA lane running)

- Suspect: Cursor server-side conversation state / checkpoint reuse, plus
  module-level shared blob store `native-exec.ts:44` (`const blobs = new Map()`),
  where `setBlobArgs` lets the server store blobs and `getBlobArgs` serves them
  to any stream.

### D. Usage semantics (confirmed shape; detail lane running)

- Cursor rows are `usageStatus: "estimated"` with `estimated: true`, no
  `cachedInputTokens`; openai/chatgpt rows are `reported` with cache figures.
  Turn-level anomalies: continuation turns can log `inputTokens: 0`.
- So the "incremental" look is local estimation, not upstream-reported cumulative
  usage. 502 paths log usage-unreported/0.

### E. Latency shape and hang/502 (REPRODUCED in run 4)

- Healthy path: turn 1 ~9-29s, continuation ~5-36s per round trip; each client
  tool round trip is a full new upstream request with full prompt replay
  (~38-44K tokens estimated input by turn 3 in run 2).
- Run 4 (sequential 8-step exploration, 15:57+) reproduced the user's hang:
  - codex reported `Reconnecting... 2/5 (stream disconnected before completion:
    Incomplete response returned, reason: upstream_stall_timeout)` — that reason
    string is ocx's OWN stall watchdog (`src/bridge.ts:149`), which fires after
    `stallTimeoutSec` (default 90s) with no upstream activity, then codex retries.
  - `15:58:33 ocx-mr35l2u6-nv 502 unreported 106079ms` — a cursor upstream
    request hung ~106s and got HTTP 502 from Cursor itself, logged with
    usage-unreported/0 (the exact "미보고" row shape the user reported).
- Watchdog liveness mapping exists: `live-transport.ts` maps swallowed progress
  frames (toolCallStarted/partialToolCall/toolCallDelta/tokenDelta/
  conversationCheckpointUpdate) to bridge heartbeats (`isCursorProgressFrame`),
  so the stall that trips the watchdog is genuine upstream silence.
- STRONG HYPOTHESIS linking to prior live RCA
  (`260702_cursor-toolcall-mcp-empty-rca/01_live-codex-exec-stall-alias-spec.md`):
  that RCA proved `exec_command` as the Cursor-facing shell tool name can produce
  heartbeat-only first-turn stalls on composer-2.5/sonnet, while `run_shell` +
  compact `{cmd}` schema completed. The current working tree adopted
  `exec_command` as the canonical wire name (run_shell kept only as mapped
  compatibility). The user's intermittent stall→502 pattern matches the
  documented exec_command stall signature. Candidate WP2 fix: flip the advertised
  alias to `run_shell` (return-path mapping already exists) and re-eval.

## Run 4/5/6 — catalog erosion and the stall correlation (15:56-16:10+)

- Run 4 (sequential 8-step exploration): 6/6 attempts stalled. Model announced
  "Starting step 1: listing files" each attempt, then the upstream went silent;
  every cursor request logged `502 unreported ~98-106s` (six rows 15:56-16:05).
  Codex retried 5 times and gave up. ZERO tool calls executed in ~10 minutes.
- Run 4 started with "Model metadata not found" — the catalog had ALREADY been
  eroded between 15:52 (run 3 healthy) and 15:56:54.
- A later write (mtime 15:59:20) left only 4 native models (wildcards gone too).
  `~/.opencodex/service.log` shows a foreign `ocx start` attempt ("Proxy already
  running (PID 5766)") — suspected concurrent/config-profile clobber; RCA lane
  dispatched (see 01_catalog-erosion doc when it lands).
- Run 5 (forced exec_command wording, catalog still eroded): instant HTTP 400
  from codex-rs: "The 'cursor/composer-2.5' model is not supported when using
  Codex with a ChatGPT account" — with the model absent from the catalog,
  ChatGPT-auth codex refuses it outright. Catalog erosion = total cursor outage
  under ChatGPT auth.
- Correlation so far: catalog present (run 1/3) → healthy runs; catalog eroded
  (run 4) → 6/6 first-turn stall with fallback metadata; catalog eroded harder
  (run 5) → 400. Run 6 re-ran the exact run-4 prompt after re-syncing the
  catalog (24 models, 18 cursor) to validate the correlation live.
- Contamination RCA lane returned: continuation turns reuse the SAME Cursor
  `conversationId` and send `ResumeAction` (request-builder.ts:84-88,
  protobuf-request.ts:295-315, responses/state.ts:49-78), so Cursor server-side
  resume state is the top contamination suspect; ocx never sends checkpoints
  back; process-global blob map (native-exec.ts:44) serves stale blobs if the
  server references old ids. Recommended capture points: dump encoded run
  request at live-transport.ts:453, log blob fetches, log previous_response_id
  resolution at server.ts:260-266.

## Final A/B matrix (runs 1-8)

| run | wording | dir | sandbox | catalog | result |
|---|---|---|---|---|---|
| 1 | tool-count demo | scratchpad | default | stale | OK ~15s (tools filtered to bare exec) |
| 2 | generic write task | ws2 | write | stale | tools OK via exec heredoc; final turn CONTAMINATED |
| 3 | generic write task | ws3 | write | fresh | OK ~21s (native write via exec channel, invisible to codex) |
| 4 | generic exploration | _chase | read-only | eroded | STALL 6/6, 502 ~100s each |
| 6 | generic exploration | _chase | read-only | fresh | STALL 6/6 |
| 7 | generic exploration | scratchpad ws7 | write | eroded | STALL 6/6 |
| 8 | exploration, exec_command forced | _chase | read-only | eroded | OK 39s, 4 sequential round trips |

Verdict: generic READ/exploration wording → model picks Cursor-native read/ls
ToolCall-frame tools → ocx swallows them (`protobuf-events.ts:48`
`mcpArgsFromToolCall` requires `mcpToolCall`) → server waits on the client
forever → watchdog 90s → codex retry → upstream 502 ~100s. Independent of
workdir, sandbox, and catalog state. Writes survive because they ride the
server-driven native exec channel (`writeArgs`), a different plane.

Catalog erosion recurred at 16:16:59 (~7 min after resync) — separate WP0 bug,
periodic writer suspected; RCA lane running.

## Operational notes

- The running ocx instance carries concurrent live traffic from other consumers
  (kiro/chatgpt/openai rows: cli-jaw instances, codex rescue jobs). Do NOT restart
  ocx while investigation jobs are in flight.
- Codex CLI `--json` event stream does not surface Cursor-native writes at all —
  when auditing runs, check the codex rollout AND `~/.opencodex/usage.jsonl`.
