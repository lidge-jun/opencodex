# 020 — Gap summary (wp3 decade doc)

Severity-ranked incompleteness list for "cursor adapter as a real Codex
Responses backend". Populated at wp3 from 001 (code evidence) + 010
(probe evidence). Skeleton written at wp1 (docs-first roadmap lock).

## Ranking axes

- Severity: how badly it degrades a Codex session (context loss > tool
  fidelity > cost > polish).
- Attribution: ADAPTER / MODEL / CLIENT / MIXED, from control probes.
- Fixability: adapter-side fix surface exists in-tree or not.

## Entries (to fill at wp3)

### G1 — History replay representation destroys agentic turn state (CRITICAL, ADAPTER)

The single root cause behind most of the seed thread's pathology. For
external wire models (grok), prior turns are replayed as flattened root
text: assistant reasoning dropped (protobuf-request.ts:237-240), tool
calls never replayed (:247), tool results as "[Tool Result]" prose
(:248-260). The model reads a foreign transcript instead of resuming its
own state.

Evidence: 001 S1/S6; 010 obs 6 (in_tokens 268 -> 10383 across one tool
boundary = checkpoint fell back to full-replay); 010 obs 7 (S2a ~180x
identical tool-call loop — the model cannot tell "I already verified
this" from prose); seed thread's per-round "Continuing from previous
conversation". Control: xai/grok-4.6 (C1b) keeps native reasoning
(reasoning_tokens=143) — same model, no re-orientation pathology.

Fix surface: checkpoint reuse across trailing_tool_result
(request-builder.ts:430-443 + checkpoint-store.ts invalidation policy),
and/or structured tool-call/result replay for external models.

### G2 — Turn stall / degenerate loop at tool boundaries (CRITICAL, MIXED adapter-leaning)

Two live faces: (a) turn dies immediately after emitting a tool call
(user screenshot 11:57 — "[Tool call: mcp_opencodex-responses_exec] /
input" then turn end); (b) turn never ends (S2a 180x loop). Both are
the same missing invariant: one tool round-trip = one clean
turn-continuation. P13a/b show the SSE sequence itself completes
correctly on curl, so the failure needs conversation depth/state — the
UNKNOWN is whether the adapter emits status:completed prematurely on
some paths or the replay confusion (G1) makes the model emit nothing.
Needs an SSE capture of a stalling app session.

### G3 — Reasoning permanently dropped on cursor route (HIGH, ADAPTER by design)

reasoning_tokens=0 on every cursor probe; xai control returns a real
reasoning item for the identical prompt (C1b). Cursor route neither
requests nor surfaces grok thinking, and never replays it (G1). For a
Responses backend this breaks reasoning-summary UX and weakens
multi-turn quality. Evidence: 010 obs 3, 001 S1.

### G4 — Tool-output corruption on the replay/blob path (HIGH, ADAPTER)

" mar" token spliced inside replayed [tool_result] envelopes and even
structural markers ("is_error mar: false", "[ martool_result]") in the
S2a transcript (010 obs 9). Seed thread's "garbled tool outputs" (001
S3) now has a live signature: token-level splicing at high replay
volume. P12a shows 77KB ANSI/unicode survives a SINGLE round trip —
corruption appears under accumulated replay, pointing at root blob
assembly/hydration (protobuf-request.ts) not one-shot encoding.

### G5 — call_id format breaks Responses id conventions (MEDIUM, ADAPTER)

Every function/custom call exposes call_id as two ids glued with a
literal newline ("call-<uuid>-<n>\nfc_<uuid>_<n>"; P3a/P4a/P6a/P13b).
Round-trips through the adapter itself (P5a), but any client that
splits/validates on line boundaries breaks. Fix surface: single-line
encoding of the composite id.

### G6 — ~10-15K input-token preamble floor (MEDIUM, ADAPTER)

Bare "PONG" request costs 11,913 input tokens; xai identical shape 229.
Default native-toolset advertisement is injected even when the caller
brought no tools (P1a vs P3a in=272 shows the floor collapses when
caller tools are present). Cost + context-budget tax on every Codex
session. Evidence: 010 obs 1.

### G7 — Catalog serves a dead model (MEDIUM, ADAPTER/catalog)

cursor/claude-opus-5 advertised by /v1/models but 100% upstream
"Connect error not_found" (C2a, plain retry too). Catalog honesty gap —
a Codex picker offering a model that cannot answer.

### G8 — SSE spec parity gaps (LOW, ADAPTER)

No response.in_progress event (P2a); non-standard response.heartbeat
emitted (P13b). Codex tolerates both today; strict Responses clients
may not.

### G9 — Model-side residuals (LOW, MODEL — for completeness)

grok-4.6 quoting/argument habits: nested-quote shell failures (001 S5),
wrong arg name for the exec helper ({command} vs {cmd}, P13b). These are
not adapter defects but G1 amplifies them by hiding corrective feedback.

## Verdict

"cursor가 진짜 Responses 백엔드가 되기 위해" 부족한 것 순서:
G1 replay representation (root cause) > G2 turn-boundary stall/loop >
G3 reasoning drop > G4 replay corruption > G5 call_id > G6 token floor >
G7 dead catalog entry > G8 SSE parity. The request surface itself
(P1-P13: plain, stream, tools, apply_patch, prev_response_id chains,
concurrency, 77KB payloads) already works; the incompleteness is
concentrated in multi-turn state representation and turn-boundary
lifecycle, exactly where the seed thread suffered.
