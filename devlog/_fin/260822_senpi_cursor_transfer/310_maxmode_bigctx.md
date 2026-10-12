# 310 — big-context maxMode A/B (billing approved)

## Question

Does RequestedModel.maxMode=true actually EXTEND usable context on a
maxMode-capable model (claude-opus-4-8-high-fast, static window 200K)?
Small-turn A/B showed the server accepts both values with no delta; the
decisive test is a payload ABOVE the normal window.

## Design (2 runs, billing approved by user)

- Payload: ~230K tokens of filler text + a needle question (verify the
  needle to prove the context was actually consumed, not truncated).
- Run A: maxMode=false -> expect bare RE (overflow) or truncation.
- Run B: maxMode=true -> if it completes AND answers the needle, maxMode
  extends context: IMPLEMENT propagation (discovery retains maxMode per
  model; protobuf-request sets RequestedModel.maxMode for capable ids;
  registry context window bump gated on the flag).
- If B fails identically: NOOP — flag is cosmetic on this plan; record and
  keep hardcoded false.

## Hygiene

Transcripts redacted; raw dumps in probe-host scratch, deleted after
verdict. Cost cap: exactly 2 runs (~460K input tokens total). Abort rule:
if run A errors before body completes upload, do not burn run B; record
BLOCKED-transport.

## Executed results (260822, claude-opus-4-8-high-fast)

Round 1 (single ~230K-token message): BOTH arms failed identically with
Connect invalid_argument (~16-19s in). Not overflow, not maxMode: a
PER-MESSAGE BYTE CAP.

Round 2 (cap bisection + multi-message):
- single ~150K tokens (~1.06MB) -> invalid_argument.
- single ~120K tokens (~850KB)  -> SUCCESS, needle answered
  ("TANGERINE-4471"). Cap sits between ~0.85MB and ~1.06MB — consistent
  with a 1 MiB UserMessage blob limit.
- multi-message history summing well past the window, needle in EARLY
  history: model answers "no launch code" on BOTH maxMode arms — server
  keeps recent context and drops old history; maxMode does not change
  retention.

## Verdict: NOOP for maxMode propagation

maxMode=true produced no behavioral difference in any shape (small turn,
oversize single message, over-window history). The flag stays hardcoded
false. Re-open only if Cursor documents maxMode semantics or a Max-mode
plan shows different retention.

## Side findings (feed the readiness audit)

1. Single messages over ~1MiB fail as invalid_argument. The adapter's
   invalid_argument handling includes a fresh-conversation replay fallback —
   an oversized message could burn a pointless replay. P2: consider a
   pre-flight size guard with a clear client error before the wire call.
2. Over-window history is silently truncated server-side (old turns
   dropped). Matches the checkpoint/context-usage design assumption; no
   action.
