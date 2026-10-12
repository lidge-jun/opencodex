# 260826 cursor responses gap — unit plan (P artifact, docs-only cycle)

Goal: document what the cursor adapter still lacks to serve as a real Codex
Responses backend, seeded by thread 01a03beb-a886-74f2-83be-5bf998f9fa4a
("Test apply_patch 적용", cursor-routed Codex app session) and measured by a
live probe campaign against `cursor/grok-4.6` through the local proxy
(port 10100, opencodex 2.32.1-preview.20260825).

## Loop-spec header

- Archetype: spec-satisfaction (documentation unit; verifier = docs exist +
  probe evidence recorded + src/ untouched).
- Trigger: user request to analyze cursor incompleteness with repeated
  grok-4.6 probing and record it in devlog.
- Goal: severity-ranked gap catalog with file:line citations + >=10 probe
  evidence rows.
- Non-goals: fixing the adapter, provider config changes, issues/PRs, pushes.
- Verifier: `ls devlog/_fin/260826_cursor_responses_gap` (docs),
  `git status --short src/` (must be empty), probe-count grep in 010 doc.
  All three run and read the change target (this unit's files / src tree).
- Stop: all three docs written and consistent; bounds = ~40min probing,
  <=30 live probes, <=3 retries per probe class.
- Memory artifact: this unit.
- Terminal outcomes: DONE / BLOCKED (cursor pool refuses all probes) /
  BUDGET_EXHAUSTED (probe shortfall stated) / NEEDS_HUMAN.
- Escalation: cursor account/token actions (rotation, login) are user-owned.

## Seed-thread symptom list (evidence base for 001)

From codex://threads/01a03beb-a886-74f2-83be-5bf998f9fa4a (full turn read):

1. Every reasoning block restarts with "Continuing from previous
   conversation / 이전 대화에서 이어서" — the model re-orients every tool
   round-trip as if the conversation was replayed, repeats working-directory
   checks 3+ times, and re-announces the same commentary.
2. All commandExecution items report `durationMs: 0`.
3. Model self-reports "previous tool results were garbled" and "the exec
   tool only returned a working directory check" — tool output loss or
   truncation on the wire.
4. apply_patch first attempt failed: "first line lacked the required
   `*** Begin Patch` header" (decorated/mangled envelope emitted by the
   cursor-trained model).
5. Repeated shell quoting failures (python3 -c with nested quotes) — model
   behavior, but amplified by lost tool feedback.
6. Task that should be ~3 tool calls took 179s and ~15 tool rounds.

## File-change map (docs only)

- ADD 000_plan.md (this doc).
- ADD 001_seed_thread_failure_catalog.md — symptom -> code-path map with
  file:line into src/adapters/cursor/* and src/server/responses/core.ts;
  UNKNOWN rows carry the stated evidence gap.
- ADD 010_probe_campaign.md — decade doc for wp2: probe matrix (8 classes),
  per-probe evidence rows appended during wp2.
- ADD 020_gap_summary.md — decade doc for wp3: severity-ranked gaps.
- OUT of scope: any file outside this unit directory.

## Probe matrix (consumed by wp2)

| # | Class | Method |
|---|-------|--------|
| P1 | plain completion | curl /v1/responses stream=false |
| P2 | streaming | curl stream=true, inspect SSE event sequence |
| P3 | single tool call | curl with one function tool, check call fidelity |
| P4 | multi tool call | two tools, parallel-call handling |
| P5 | tool-result round trip | 2-turn: function_call_output back in input |
| P6 | apply_patch freeform | custom tool shaped like Codex apply_patch |
| P7 | multi-turn continuity | previous_response_id + history replay |
| P8 | reasoning handling | reasoning items in replayed input |
| P9 | parallel/concurrent | 3 simultaneous requests |
| P10 | native subagent | spawn_agent model=cursor/grok-4.6 real task |
| P11 | checkpoint reuse | >=3 turns, tool results interleaved, same thread — exercises trailing_tool_result invalidation (checkpoint-store.ts) |
| P12 | tool-output stress | large (>=64KB), multi-line, ANSI/unicode tool result payloads round-tripped |
| C1 | cross-provider control | replay P5/P7/P8 through xai/grok-4.6 (same base model, different adapter) |
| C2 | cross-model control | cursor/claude-opus-5 and cursor/gemini-3.7-flash through same adapter |
| S1 | subagent fleet (parallel) | parallel spawn_agent dispatches; sol medium reviewers + cursor/grok-4.6 workers side by side |
| S2 | subagent plugin surface | cursor-model subagents driving plugin/tool surfaces (computer-use screenshot-read, browser read, exec/apply_patch) — full tool-catalog exposure test |

Each probe records: request shape, HTTP/status, response/stream behavior,
usage block, pass/fail, raw snippet. Repeats within bounds count as extra
probes toward the >=10 minimum.

### Audit fold-back (round 1, GO-WITH-FIXES blockers=4)

1. (High) Control probes added: C1 cross-provider (xai/grok-4.6 live in
   catalog, verified) and C2 cross-model — separates adapter gaps from
   grok-4.6 training behavior.
2. (High) Subagent fence: P10/S1/S2 subagent tasks are pinned read-only or
   to `mktemp -d` scratch workspaces; no writes outside scratch + this
   devlog unit. Plugin-surface tests (S2) use observation-only actions
   (screenshot/read); no destructive or account-mutating plugin calls.
3. (Medium) Code-path anchors corrected: primary surfaces are
   protobuf-request.ts:225-260 (root replay flattening + reasoning drop for
   external wire models), protobuf-events.ts:702/:896 (apply_patch grammar
   repair + structured-edit conversion, #1017), checkpoint-store.ts:11-27
   (TTL/invalidation), tool-result-normalize.ts, native-exec-shell.ts:136.
   message-mapper.ts / thread-continuity.ts are thin and demoted to
   secondary references. durationMs:0 is plausibly Codex-client-side —
   001 carries it as UNKNOWN with the evidence gap stated.
4. (Medium) Probe-count verifier is now concrete:
   `rg -c '^\| (P|C|S)[0-9]' devlog/_fin/260826_cursor_responses_gap/010_probe_campaign.md`
   must report >= 10 evidence rows (pass condition), and each row carries a
   pass/fail column.

### User scope addition (mid-A, 2026-08-26)

The user extended wp2: dispatch sol medium subagents in parallel, run cursor
models themselves as subagents, and exercise plugin surfaces (Computer use
et al.) across the board — captured as S1/S2 above. Rate-limit spend on the
user's Cursor account is bounded by the existing <=30-probe budget; probe
failures from quota/rotation are recorded as evidence, not retried past 3.

## Accept criteria (testable)

- c1: every symptom row in 001 names file:line or UNKNOWN + gap.
- c2: >=10 probe rows in 010 spanning all classes P1-P10.
- c3: 020 ranks gaps by severity with evidence pointers.
- c4: numbered filenames only; `git status --short src/` empty at close.

## Conditional paths

Docs-only cycle: no production conditional paths are added, so
C-ACTIVATION-GROUNDING-01 rows are N/A; probe classes themselves are the
activation scenarios for wp2 evidence.
