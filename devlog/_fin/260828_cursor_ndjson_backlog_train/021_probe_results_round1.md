# 021 — wp3 probe results, round 1 (macmini-cf, 2026-08-28 02:34-02:50 KST)

Stack under test: probe proxy 2.35.0 = origin/dev + codex/runturn-backlog-coalesce
(4cd1b99f0), port 10199, isolated OPENCODEX_HOME/CODEX_HOME
(~/ocx-probe-260828/{home,codex-home}), launchd 10100 untouched.
Instrument: codex exec --json -m cursor/grok-4.6 (codex-cli 0.146.0).
Evidence: macmini-cf ~/ocx-probe-260828/evidence/{N1,N2,N3,N4,SMOKE}/.

## Results

| Probe | Runs | Result | Evidence |
|---|---|---|---|
| SMOKE | 1 | PASS | "probe-ok", 17245 in / 13 out tokens |
| N1 5-step chain | 6 | 4 PASS / 2 anomalies | run-01/02/04/05: avg=84, 10-24 cmdexec, 0 restarts. run-03: task COMPLETED (avg=84) but see F1/F2/F3. run-06: premature final after 2 calls, no task output (F4) |
| N2 10-step chain | 1 | PASS | all files correct, 24 cmdexec |
| N3 zero-stdout x3 | 1 | PASS | bridge empty-result marker delivered verbatim for all 3 empty outputs; model quoted it and stayed on track — gap-7/8 fix healthy on the wire |
| N4 stalled consumer 60s | 1 | PASS | 509KB SSE buffered behind a 60s-stalled reader, 4560 output_text.delta, response.completed arrived, NO backlog abort — wp2 coalescing fix live-validated (pre-fix cap = 1024 events) |

## Findings

- F1 (adapter, NEW): mid-message envelope echo evades the sniffer. run-03's
  agent_message contains THREE verbatim "[Tool Result] [tool_result]
  call_id: ... name: exec ... output: ..." blocks INSIDE the message body.
  CursorEnvelopeEchoSniffer (envelope-echo.ts) sniffs only the FIRST
  MAX_SNIFF_BYTES=40 of a turn's output; an echo after legitimate leading
  text streams straight to the client. Fix surface: newline-anchored
  mid-stream marker detection.
- F2 (adapter/upstream, watch item #4 CONFIRMED ON WIRE): call-id corruption
  inside an echoed envelope: "fc_63367283 mar-2aec-9a25-b7df-9b125bd8d1b5_0"
  vs the correct "fc_63367283-2aec-9a25-b7df-9b125bd8d1b5_0" later in the
  SAME message — "-" replaced by " mar-". The corruption is in what the
  model SAW (replayed flattened history), matching 080's "mar" signature.
  Boundary still unknown (our serializer vs Cursor blob store vs model
  echo-typo): needs the 030 trace instrumentation.
- F3 (env, transient): mid-run "Cursor rate limit exceeded: Connect error
  resource limit exceeded" -> Codex reconnect 1/5 -> turn recovered and
  completed. Honest error surface; no adapter defect.
- F4 (model-class): run-06 ended turn after loading a skill file and
  announcing step 1 — premature final matching inventory #9; no adapter fix.
- Empty tool-result delivery (inventory #1): NOT reproduced in 6 N1 runs +
  N2 + N3 (bridge marker arrived intact every time). Remains bounded to
  deeper checkpoint sessions; N2-class deep probing continues in wp5
  closure round on the patched stack.
- Zero-stdout native marker (030 conditional): N3 proves the BRIDGE path
  explains empties correctly; the native unsafe channel was not exercised
  (policy-gated). 030's native marker stays CONDITIONAL and is NOT shipped
  this round.

## wp4 implication

PR B1 = F1 fix (mid-stream echo detection + retry wiring reuse) + F2 trace
instrumentation (call-id/byte/digest correlation, env-gated). Native marker
deferred. Diff spec: 031.
