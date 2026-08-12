# Mac mini failed-run RCA and re-run procedure

Date: 2026-08-01

## Scope and evidence identity

This RCA is read-only with respect to the measurement host. No new harness run or
CPU-heavy workload was started, and no remote file was changed. The inspected host
and checkout were:

- SSH alias: `macmini-cf` (not bare `macmini`).
- Checkout: `~/rss-measure/opencodex`.
- Remote state at inspection: clean `dev...origin/dev`, HEAD
  `afe2aa3d7e1e02b8b71a22ac93272fd31a62addb`.
- The remote and local copies of `scripts/macos-rss-retention-harness.ts` both had
  SHA-256 `8d842e36a69d55387547804d862e4d3c8071148ee270ed4fe0c6dd5c4b13e3c6`.
- Recorded runtime in both session manifests: Darwin arm64, Apple M4, Bun 1.3.14.

Artifact paths below are relative to the remote checkout unless shown as source
paths. Line numbers refer to the immutable JSON/JSONL files as inspected.

## Verdict

| Session | Exact outcome | Cause |
|---|---|---|
| `2026-07-31T04-34-53-014Z-54374` | Deliberately invalid smoke artifact | Calibration passed, but `writeSummary` forced `smoke:true` and `valid:false`; it is a plumbing check, not measurement evidence. |
| `2026-07-31T04-36-07-513Z-54708` | Full workload session aborted during `cal-2-on` warmup | The wall-clock duration gate observed 59,999 ms, one millisecond below `WARM`. The child had not exited. Cleanup subsequently sent SIGTERM and produced the misleading-but-expected `run-end exitCode:0`. |

## Run 1: passed calibration, invalid by smoke contract

Artifact root:
`.tmp/macos-rss-retention/2026-07-31T04-34-53-014Z-54374/`

Evidence:

1. `summary.json:2-9` records `valid:false`, `calibrated.passed:true`, and
   `smoke:true` together. The calibration result itself was successful.
2. `manifest.jsonl:2` records smoke-sized constants (`events:20`,
   `waveMs:4000`), rather than the registered full-run values (`events:400`,
   `waveMs:120000`).
3. `manifest.jsonl:325-326` records a clean final `cal-6-off` run end and
   `session-end`; there is no `session-failed` row.
4. The source contract at `scripts/macos-rss-retention-harness.ts:45-59` says smoke
   changes durations only, while `scripts/macos-rss-retention-harness.ts:1261-1269`
   stamps every smoke summary with `smoke:true, valid:false` even when the internal
   summary was valid.

Therefore this session did not fail calibration. Its only invalidation cause was
intentional smoke self-stamping. It must never be compared with a full measurement.

## Run 2: the child did not exit during warmup

Artifact root:
`.tmp/macos-rss-retention/2026-07-31T04-36-07-513Z-54708/`

### Causal sequence

1. `manifest.jsonl:3930-3931` starts `cal-2-on` and its warm phase at wall time
   `1785473227971`.
2. `manifest.jsonl:4289` ends warmup at wall time `1785473287970` and records
   `actualMs:59999`.
3. The active source gate at
   `scripts/macos-rss-retention-harness.ts:803-810` evaluates
   `Date.now() - warm < WARM || measured.process.exitCode !== null` and throws the
   undifferentiated `Error("warm invalid")`. The recorded 59,999 ms makes the first
   operand true.
4. `runs/cal-2-on/child.jsonl:303` is a child self-sample at wall time
   `1785473288391`, 421 ms **after** `warm-end`. It has sampler index 302 and
   monotonic `actual:60526.017417`. A process cannot emit this row if it had already
   exited at the warm gate.
5. `runs/cal-2-on/child.stderr.log` is zero bytes, providing no crash or natural-exit
   diagnostic.
6. After the gate throws, `execute` catches the error and enters cleanup
   (`scripts/macos-rss-retention-harness.ts:841-878`). `stopChildProcess` sends
   SIGTERM when the child is still alive (`scripts/macos-rss-retention-harness.ts:558-572`).
   The child handles SIGTERM by stopping the sampler and server, then resolves its
   top-level wait (`scripts/macos-rss-retention-harness-child.ts:68-95`), which is a
   normal exit with code 0.
7. Only after that cleanup does `manifest.jsonl:4290` record `run-end` with
   `exitCode:0`; `manifest.jsonl:4291-4292` then records `session-failed` and
   `session-end`. `summary.json:2-3` correctly preserves `valid:false` and
   `Error: warm invalid`.

The manifest ordering therefore does **not** show a pre-gate child exit. `run-end`
is intentionally logged after cleanup, and the child sample after `warm-end`
directly rejects that interpretation.

### Clock evidence

The artifacts prove the predicate failure exactly: the `Date.now()` duration was
59,999 ms. They do not record `performance.now()` at the exact two warm endpoints,
so they cannot prove that `Bun.sleep(60_000)` itself returned early. Concurrent
dual-clock samples do show why `Date.now()` is not a valid duration clock here:

- During the immediately preceding `cal-1-off` observation,
  `manifest.jsonl:363,3926` span 599,573 ms in `wallMs` but 599,677.612417 ms in
  monotonic `actual`. Wall time lost about 104.612 ms relative to the monotonic
  clock. The corresponding `observation-end` at `manifest.jsonl:3927` records only
  599,899 ms for a requested 600,000 ms.
- During `cal-2-on` warmup, `manifest.jsonl:3933,4288` span 59,726 ms in `wallMs`
  but 59,729.66575 ms in monotonic `actual`. Wall time lost another approximately
  3.666 ms over the sampled interior.

The root harness defect is thus the use of adjustable wall time for a minimum-duration
validity gate. A one-millisecond wall-clock shortfall was treated as a bad run even
though the measured child remained healthy. Whether the underlying sleep woke a
fraction early is not observable from this artifact and is not required to explain
the failure.

### Competing hypotheses and falsifiers

| Hypothesis | Falsifier | Result |
|---|---|---|
| H1: the measured child exited naturally during warmup | A child-originated row after `warm-end` | Rejected by `child.jsonl:303`, emitted 421 ms after the gate. |
| H2: the duration operand was true | `warm-end.actualMs >= 60000` | Accepted: `manifest.jsonl:4289` records 59,999 ms. |
| H3: an external child failure produced exit code 0 before the gate | Crash stderr or telemetry ending before `warm-end` | Rejected: stderr is empty, telemetry continues after the gate, and the parent cleanup path explains SIGTERM plus exit 0. |

## Proposed harness patch (proposal only)

Do not weaken or remove the warm validity gate. Make all requested pauses clamp to a
monotonic deadline, measure warm and observation durations with `performance.now()`,
retain wall elapsed as a diagnostic, and split child-exit and duration errors. The
child exit check comes first so a genuine child death is never mislabeled as timer
jitter. The observation validator must likewise consume the monotonic duration;
Run 2 already demonstrates a 101 ms wall-clock shortfall in `cal-1-off` observation.

Apply the following hunks in a separate implementation task; this RCA does not modify
`scripts/`:

```diff
diff --git a/scripts/macos-rss-retention-harness.ts b/scripts/macos-rss-retention-harness.ts
--- a/scripts/macos-rss-retention-harness.ts
+++ b/scripts/macos-rss-retention-harness.ts
@@ -284,7 +284,14 @@ function host() {
 }
 
 async function pause(ms: number): Promise<void> {
-  await interruptible(Bun.sleep(ms));
+  const deadline = performance.now() + Math.max(0, ms);
+  for (;;) {
+    const remaining = deadline - performance.now();
+    if (remaining <= 0) return;
+    // Bun.sleep may wake fractionally before the requested deadline. Re-sleep
+    // instead of weakening a pre-registered duration.
+    await interruptible(Bun.sleep(Math.ceil(remaining)));
+  }
 }
 
 function frame(type: string | null, payload: unknown): Uint8Array {
@@ -801,12 +808,25 @@ async function execute(root: string, log: Log, run: Run): Promise<void> {
     });
 
     phase = "warm";
-    const warm = Date.now();
+    const warmWall = Date.now();
+    const warm = performance.now();
     log.add({ type: "warm-start", run: run.id });
     await pause(WARM);
-    log.add({ type: "warm-end", run: run.id, actualMs: Date.now() - warm });
-    if (Date.now() - warm < WARM || measured.process.exitCode !== null) {
-      throw new Error("warm invalid");
+    const warmActualMs = performance.now() - warm;
+    const warmWallActualMs = Date.now() - warmWall;
+    const warmExitCode = measured.process.exitCode;
+    log.add({
+      type: "warm-end",
+      run: run.id,
+      actualMs: warmActualMs,
+      wallActualMs: warmWallActualMs,
+      exitCodeAtGate: warmExitCode,
+    });
+    if (warmExitCode !== null) {
+      throw new Error(`child exited during warm: exit code ${warmExitCode}`);
+    }
+    if (warmActualMs < WARM) {
+      throw new Error(`warm duration invalid: ${warmActualMs}ms < ${WARM}ms`);
     }
 
     if (run.kind === "workload") {
@@ -820,14 +840,22 @@ async function execute(root: string, log: Log, run: Run): Promise<void> {
       }
     } else {
       phase = "observation";
-      const start = Date.now();
+      const observationWall = Date.now();
+      const start = performance.now();
       log.add({ type: "observation-start", run: run.id });
       await pause(OBSERVE);
+      const observationActualMs = performance.now() - start;
       log.add({
         type: "observation-end",
         run: run.id,
-        actualMs: Date.now() - start,
+        actualMs: observationActualMs,
+        wallActualMs: Date.now() - observationWall,
       });
+      if (observationActualMs < OBSERVE) {
+        throw new Error(
+          `observation duration invalid: ${observationActualMs}ms < ${OBSERVE}ms`,
+        );
+      }
       log.add({
         type: "client-cadence",
         run: run.id,
@@ -1102,12 +1130,13 @@ function analysis(
   work.forEach(run => validateWorkload(all, run));
 
   const envelope = (run: Run, field: MetricField) => {
+    const observationEnd = all.find(row => (
+      row.run === run.id && row.type === "observation-end"
+    ));
     const start = Number(all.find(row => (
       row.run === run.id && row.type === "observation-start"
     ))?.wallMs);
-    const end = Number(all.find(row => (
-      row.run === run.id && row.type === "observation-end"
-    ))?.wallMs);
-    if (!start || !end || end - start < OBSERVE) {
+    const end = Number(observationEnd?.wallMs);
+    if (!start || !end || Number(observationEnd?.actualMs) < OBSERVE) {
       throw new Error("observation interval");
     }
```

Why this preserves validity:

- It never shortens `WARM`, `OBSERVE`, inter-chunk delay, wave waits, or settle waits;
  `pause` returns only after the monotonic deadline.
- It does not add tolerance after seeing a result. The same exact registered minimums
  remain mandatory.
- It keeps adjustable wall time for artifact correlation while removing it from the
  duration decision.
- It captures `exitCodeAtGate` before cleanup, eliminating the current ambiguity
  between pre-gate child death and parent-initiated clean shutdown.
- A genuine child exit still invalidates immediately at the warm boundary with a
  specific error. Later child checks and cleanup behavior remain unchanged.

## Re-run runbook for `macmini-cf`

This is a future operator procedure. It was not executed during this RCA.

### 1. Land and verify the harness correction

Implement the proposed patch in the owning task, run the script-focused review plus
`bun run typecheck`, and synchronize one reviewed commit to the dedicated remote
checkout. Before any harness invocation:

```bash
ssh macmini-cf
cd ~/rss-measure/opencodex
git status --short --branch
git rev-parse HEAD
shasum -a 256 scripts/macos-rss-retention-harness.ts
bun --version
uname -s
uname -m
pgrep -fl macos-rss-retention
```

Required preconditions:

- The checkout is clean and points to the reviewed commit.
- Host is Darwin arm64 and the runtime/version is recorded with the artifact.
- No earlier harness or competing CPU-heavy measurement is running.
- The harness is never run on the local workstation.

### 2. Run one remote smoke calibration

Smoke only proves plumbing and must remain invalid measurement evidence:

```bash
cd ~/rss-measure/opencodex
smoke_id="$(date -u +%Y-%m-%dT%H-%M-%S)-smoke"
smoke_dir="$PWD/.tmp/macos-rss-retention/$smoke_id"
OCX_RSS_HARNESS_SMOKE=1 bun scripts/macos-rss-retention-harness.ts \
  --mode calibration --output "$smoke_dir"
jq -e '.valid == false and .smoke == true and .calibrated.passed == true' \
  "$smoke_dir/summary.json"
```

Do not carry the smoke environment variable into the real session.

### 3. Start the full workload in `tmux`

Use `tmux` so an SSH disconnect does not suspend the process. In particular, never
press Ctrl-Z and never send SIGSTOP/SIGCONT.

```bash
tmux new-session -s ocx-rss-full
```

Inside the tmux session:

```bash
cd ~/rss-measure/opencodex
unset OCX_RSS_HARNESS_SMOKE
full_id="$(date -u +%Y-%m-%dT%H-%M-%S)-full"
full_dir="$PWD/.tmp/macos-rss-retention/$full_id"
bun scripts/macos-rss-retention-harness.ts \
  --mode workload --output "$full_dir"
```

Detach only with the tmux detach chord (Ctrl-B, then D). Do not suspend/resume the
harness. The registered workload takes roughly 7 h 24 m before retries.

Monitor from a separate read-only SSH session with `tmux attach -t ocx-rss-full` or
`tail` the selected `manifest.jsonl`; monitoring must not alter process scheduling.

### 4. Accept or discard the result

After the command exits, in the same checkout and with `$full_dir` set to the emitted
artifact root:

```bash
jq -e '
  .valid == true
  and (.smoke // false) == false
  and .calibrated.passed == true
  and .analysis.valid == true
' "$full_dir/summary.json"

jq -s -e '
  ([.[] | select(.type == "run-end")] | length) == 24
  and ([.[] | select(.type == "session-failed")] | length) == 0
  and ([.[] | select(.type == "run-start" and .kind == "calibration")] | length) == 6
  and ([.[] | select(.type == "run-start" and .kind == "parent-pressure")] | length) == 9
  and ([.[] | select(.type == "run-start" and .kind == "workload")] | length) == 9
' "$full_dir/manifest.jsonl"

find "$full_dir/runs" -name child.stderr.log -size +0 -print
```

`summary.valid:true` is emitted only after the built-in sampler integrity, cadence,
shape, chain, calibration, envelope, and analysis validators have passed. The final
`find` must print nothing; inspect any non-empty stderr before accepting the session.

If the session is interrupted, records `sampler gap >1s`, exceeds wave drift, or
otherwise writes `valid:false`, preserve that artifact as failed evidence and start a
fresh full sequence in a fresh output directory. Never resume a stopped process and
never splice partial sessions.

## Verification performed for this RCA

- Read `000_plan.md` and the complete `010_measurement_harness.md` first.
- Inspected both remote summaries and numbered manifest evidence over
  `ssh macmini-cf`.
- Compared child self-sample timing, parent dual-clock timing, stderr size, source
  cleanup ordering, remote git identity, and script hash.
- Started no new measurement and changed no source or script file.
