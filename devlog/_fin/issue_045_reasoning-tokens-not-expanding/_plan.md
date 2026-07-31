# Issue #45 — documentation PABCD plan (jawdev folder)

Documentation ONLY. Zero src/gui edits. Build issue_045 into a jawdev-style
folder (143/500 convention): design decision + diff-level plan + test plan +
alternatives/risk + open-questions + verification matrix.

## Decision recorded (from conversation with user)
Route chat-completions `reasoning_content` through the SUMMARY channel so
codex-rs renders an expandable trace. codex-rs renders the persisted/expandable
block from `summary[]` (confirmed in 01_codex-rs-consumer-trace.md). Non-OpenAI
chat providers send no separate condensed summary, so their full
`reasoning_content` IS the human-visible thinking and belongs in `summary`.

## Files to add
| File | Content |
|---|---|
| `10_fix-design.md` | Decision + chosen approach (summary-path) vs mirror-both; why summary-only is cleaner |
| `11_bridge-diff-plan.md` | Diff-level src/bridge.ts plan (streaming + non-streaming), file:line anchors |
| `12_test-plan.md` | tests/bridge.test.ts assertions (summary non-empty, no duplicate) |
| `20_alternatives-and-risk.md` | Approach 1 (mirror) vs 2 (reroute), provider-gating option, risk |
| `90_open-questions.md` | content[] keep-or-drop, provider gating, dedupe |
| `95_verification-matrix.md` | per-change verification + evidence |
Keep: `00_review.md`, `01_codex-rs-consumer-trace.md`. Add `_plan.md` (this).

## Anchors confirmed (for diff-level docs — NO edits this cycle)
- Streaming: `src/bridge.ts:193` `closeCurrentRawReasoning` (summary:[]),
  `src/bridge.ts:298` `reasoning_raw_delta` case (emits response.reasoning_text.delta).
- Summary path template: `src/bridge.ts:174` `closeCurrentReasoning`,
  `:276` `thinking_delta` case (emits response.reasoning_summary_text.delta).
- Non-streaming: `:476` `flushRawReasoning` (summary:[]), `:468` `flushSummaryReasoning`
  (summary:[{summary_text}]), `:530` `reasoning_raw_delta` case.
- Tests: `tests/bridge.test.ts:30` raw reasoning test asserts summary:[] today.

## Discipline
Doc-only, atomic commit, no scope creep. Each doc carries problem/decision/
diff-level plan/verification like 143.
