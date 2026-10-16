# 100 — Wire/NDJSON QA (n1, 2026-08-26 오후)

Service: gap-8 stack (ecc9aad0d). Captures: /tmp/ocx-wire/*.sse.
NDJSON: ~/.opencodex/usage.jsonl (31,466 lines).

## Scenario table

| # | Scenario | Result | Wire evidence |
|---|---|---|---|
| W1 | plain stream | PASS | created -> in_progress (gap-1 live) -> deltas -> completed; 29 lines |
| W2 | single tool stream | PASS | function_call args delta/done; single commentary line, no duplicate emission |
| W3 | parallel-10 stream | PASS | 11 output_item.added (1 msg + 10 calls, seq 2..47), each probe exactly once — the earlier "22" was event+data line double-count, NOT a wire duplicate. Double-batch echo NOT reproduced at the wire; 090 S2b echo attributed to model-side commentary repetition, not stream duplication |
| W4 | empty tool-result round trip | PASS* | model received empty output and answered "The tool returned this, verbatim: (blank)" — honest handling; 112 text deltas, no retry spiral at API layer |
| W5 | single image stream | PASS | "Green.", 38 lines |
| W6 | 3x same-color images | PASS* | "lime green, yellow, red" — model hallucinated variety on identical images |
| W6b | 3x distinct images (R,G,B) | PASS | "red, green, blue" correct order; 30.1s wall, in=13575 — slow but correct. App image loop NOT reproduced at API layer |
| W7 | kimi-k3-1m stream | PASS | full clean sequence incl. in_progress |
| W8 | apply_patch custom stream | PASS | custom_tool_call_input delta/done, valid envelope |

## NDJSON (usage.jsonl) integrity — last 300 rows

- 0 malformed lines; cursor rows 238.
- usageStatus: estimated 235, unreported 1 (the single 502 row — 10.8s
  upstream failure, usage honestly unreported, no fake zeros).
- true zero-input rows: 1 (= the 502). Schema: nested usage{inputTokens...},
  tierOutcome, firstOutputMs, requestedEffort all populated.
- Verdict: NDJSON pipeline healthy; no corruption class found.

## 090 follow-up dispositions

1. Wire-level empty exec output: NOT reproduced in W4 (deliberate empty
   round-trips handled honestly). Remaining suspicion narrows to the
   in-session (checkpoint/replay-depth) path, not the API surface —
   signature still open, now bounded to multi-round sessions.
2. Double-batch echo: wire ruled out (W3); model-side commentary
   repetition under replay confusion — folds into G1 umbrella.
3. App image loop: API layer healthy (W5/W6b, codex exec -i PASS in 090
   S5b). Bounded to Codex-app-side attachment handling; needs app-session
   capture — out of this repo's fix surface for now.

## Verdict

No new adapter-fixable defect surfaced in this round; gap-9 not needed.
All three follow-ups bounded with evidence; W6 same-color hallucination is
MODEL-class. Campaign continues to be green on the gap-8 stack.
