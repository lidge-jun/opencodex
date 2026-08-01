# 010 — Work-phase 1 implementation record

Status: DONE; P/A/B/C/D complete with every goal criterion evidenced and validated.

## P

- Goalplan registered and host armed.
- Baseline timeout path, request-log contract, adapter parsers, retry helpers, history, and dirty
  overlap inspected.
- Three independent sol-medium design audits rejected a larger non-streaming total timeout and
  converged on internally streamed, fully buffered iterations.
- Baseline focused gate before implementation: 137 pass, 0 fail, 396 assertions across
  web-search, sidecar abort, Google/Kiro retry, adapter terminal/usage/signature, bridge, and
  request-log suites (`bun test ...`, 5.41 s).

## A

- Round 1 verdict: FAIL.
- Accepted blockers:
  1. terminal `error` could coexist with a synthetic search and still dispatch sidecar work;
  2. provider-specific response-body timeout signals could survive header acquisition;
  3. adapter-event progress alone cannot observe long buffered tool-argument streams.
- Plan revisions: pre-scan terminal validator, raw-byte progress collector, Google/Kiro
  header-timer hardening, bounded non-2xx body reads, and explicit JSON-vs-SSE phase policy.
- Round 2 verdict: FAIL. Accepted blockers: make parent/cumulative-header/body-stall ownership
  explicit; require a capacity-one rendezvous queue and deterministic shutdown; state the exact
  bridge maximum including the new stall clock. Accepted warnings: locally validate the config,
  name bounded pre-SSE error-body reads, and add exact classification/log/cleanup tests.
- Round 3 plan revisions encoded those requirements in `000_plan.md`.
- Queue specialist warning accepted: the single-slot queue is local source/parser/collector
  backpressure only. The plan now requires HWM 0, acknowledged semantic delivery, nonblocking
  one-bit progress offers, terminal-first teardown, and makes no claim about the bridge's existing
  downstream buffering.
- Red-harness wording warning accepted: `000_plan.md` now freezes literal header/body timeout
  messages. Both contain `timeout`, so existing 504 classification is activation-tested before any
  decision to touch shared error heuristics.
- Round-3 blocker revisions: successful `done` is now provisional until adapter-iterator completion
  under a separate 5 s post-terminal drain guard; errors reject immediately. Web-search requests
  ask Google/Kiro for raw final non-2xx responses, so the loop clears its cumulative header timer
  before its own bounded/redacted error-body read. The timer range is explicitly capped, and the
  WebSocket request-log finalizer is included for 504 parity.
- Round-4 warnings addressed: stale AdapterFetchContext/terminal summaries were corrected; the raw
  error reader is fixed at 64 KiB plus independent 5 s total/inactivity limits; README files are
  explicitly untouched while the two necessary dirty-file edits stay in non-overlapping hunks.
- Round 4 verdict: PASS from both the revision reviewer and an independent sol-medium reviewer;
  no blockers remain. Final warnings (exact JSON envelope, bounded-reader rendering, dirty overlap)
  were frozen in `000_plan.md` before B.

## B checklist

- [x] Add and run red-first BUG-R86 tests against the current implementation.
- [x] Add the raw-byte progress collector with abort/stall cleanup tests.
- [x] Split loop header preparation from streamed body collection.
- [x] Add final-terminal validation before search interception.
- [x] Resolve and thread `routedModelStallTimeoutMs`.
- [x] Make Google/Kiro successful response-body lifetimes independent of header timers.
- [x] Make intermediate Google/Kiro retry-body cancellation nonblocking under hostile streams.
- [x] Update exact timeout/log wording and migrate all focused legacy fixtures.
- [x] Synchronize SOT and EN/KO/ZH docs.

### Red-first activation evidence

Command: `bun test tests/web-search.test.ts -t "BUG-R86"`

Baseline result: exit 1, 0 pass, 3 fail (24 filtered), 65 ms.

- stream-only routed iteration expected HTTP 200 but received 502 because the loop forced
  `stream:false` and called the `parseResponse` sentinel;
- fast headers plus raw progress expected HTTP 200 but received 502 after the 25 ms iteration-wide
  signal aborted an otherwise progressing body;
- buffered `web_search` followed by terminal error expected zero sidecar calls but observed one.

This is the required non-accidental activation proof: all three failures exercise the exact old
mechanisms that the plan changes.

### B implementation and green evidence

- Routed iterations now request `stream:true`; only the first iteration's final response
  headers/status are acquired eagerly. A successful body is parsed inside the Responses SSE bridge.
- `parseStreamWithProgress()` owns the original response reader, resets a distinct inactivity
  clock on non-empty raw chunks, buffers semantic events, holds `done` until iterator completion,
  and bounds post-terminal drain to 5 seconds.
- A bounded original-reader error-body primitive caps retention at 64 KiB and independently bounds
  total time and inactivity. A same-turn EOF/parent-abort regression additionally proves parent
  cancellation wins the race.
- Google/Kiro response-header timers are clearable while parent cancellation stays attached to
  successful bodies. The loop requests raw final errors and applies only adapter-owned safe
  formatters after a complete bounded read.
- `webSearchSidecar.routedModelStallTimeoutMs` resolves locally to a finite integer and participates
  in the bridge maximum. HTTP and WebSocket terminal logging use the captured in-stream error
  status.
- Exact runtime contracts pass 7/7: the original five header/body/later/cancel/429 cases plus
  leak-negative asynchronous and synchronous non-2xx body-read failures.
- Primitive/config/runtime contracts pass 44/44 across bounded body (10), clearable deadline (3),
  progress stream (20), timeout plan (4), and runtime timeout contracts (7).
- Legacy web-search and sidecar-abort fixtures now use `parseStream`; their aggregate passes 35/35,
  including explicit 499 cancellation and a 30-second routed-model budget in the 120-second plan
  assertion.
- Independent documentation review passed all seven SOT/EN/KO/ZH files and `git diff --check`.
- Independent implementation review found no loop/progress/server production defect. It did find
  one accepted adapter blocker: intermediate Google/Kiro retry responses awaited `body.cancel()`,
  so a hostile never-settling cancel could outlive the header deadline. Both adapters now observe
  cancellation without awaiting it and tolerate synchronous throws; never-settling regressions
  pass in both suites (30/30 combined), typecheck passes, and an independent delta re-review reports
  PASS.
- A subsequent error-safety audit found one new blocker: an exception thrown by a non-2xx body
  reader could escape the bounded reader, leak its raw message, and replace the provider status
  with 502. The loop now preserves the original status, returns exact status-only
  `Provider error <status>`, and bypasses formatter/parser/sidecar work on both asynchronous body
  errors and synchronous `getReader()` failure. The runtime contract suite passes 7/7 and an
  independent delta re-review reports PASS.
- An adversarial collector audit found that a synchronous throw from the original reader's
  `cancel()` could replace an already-selected abort/timeout/return outcome. Cancellation cleanup
  is now synchronous-throw-safe while asynchronous rejection remains observed. The two new
  parent-abort and consumer-return regressions bring the progress suite to 20/20; an independent
  delta re-review reports PASS.

## C checklist

- [x] Focused red/green activation evidence.
- [x] Web-search, sidecar-abort, request-log, adapter/retry, bridge, and progress suites.
- [x] `bun run typecheck`; `package.json` has no distinct non-GUI project build gate.
- [x] Full `bun test ./tests/`.
- [x] Diff/dirty-overlap/source-of-truth inspection.
- [x] Independent sol-medium code review with normalized verdict.

### C verification evidence

- Green activation: `bun test tests/web-search.test.ts -t "BUG-R86"` passes 3/3 after the baseline
  0/3 red run recorded above.
- Focused migration gate: `bun test tests/web-search.test.ts tests/sidecar-abort.test.ts` exits 0
  with 35 tests and 106 assertions in 4.33 seconds.
- Affected aggregate: 21 files, 271 tests, 795 assertions, 0 failures in 7.87 seconds. It includes
  web-search, timeout, progress, abort, logging, WebSocket, Google/Kiro retry/stream, adapter EOF,
  usage/signature, bridge lifecycle, bounded-body, and deadline coverage.
- Project gate: `bun test ./tests/` exits 0 with 199 files, 2,003 tests, 8,505 assertions, and
  0 failures in 28.79 seconds.
- `bun run typecheck` exits 0. `git diff --check` exits 0 with no output.
- Independent documentation, config, LM Studio wire-path, raw-error safety, timeout lifecycle,
  cleanup, server logging, and dirty-overlap reviews all report PASS after their accepted blockers
  were fixed and re-reviewed.
- Final sol-medium code review reports `VERDICT: PASS` with 192 focused tests across 15 suites,
  typecheck, and diff-check green; it found no production, security, cleanup, or LM Studio blocker.

## D checklist

- [x] Capture commands/results in this record.
- [x] Mark every goal criterion with evidence and validate the goalplan.
- [x] Close the work phase, archive `_plan` to `_fin`, and report terminal outcome.
