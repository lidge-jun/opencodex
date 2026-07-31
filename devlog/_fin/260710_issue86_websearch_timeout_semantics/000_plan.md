# 000 — Issue #86 web-search timeout-semantics repair plan

Status: P/A/B/C/D complete; implementation, verification, evidence, and archive gates passed.

## Objective and work class

Resolve issue #86 as a C3 cross-boundary timeout-lifecycle repair. A routed model used by the
web-search loop must not have its entire generation cut off by the global connection/header
deadline. The repaired path must remain finite, preserve search interception and ordering, keep
initial HTTP failures distinct from failures after downstream SSE starts, and leave cancellation,
429 rotation, signed-thinking replay, and unrelated dirty-worktree changes intact.

Entry point: `src/server/responses.ts` -> `planWebSearch()` -> `runWithWebSearch()`.

## Evidence-backed hypotheses

- **H1 — provider-only slowness. Rejected.** The exact 200000 ms value is supplied by OpenCodex,
  and the error text is constructed locally in `src/web-search/loop.ts`.
- **H2 — hosted search-sidecar timeout. Rejected.** The first routed-model iteration is drained
  before `runWebSearch()` can execute; the hosted sidecar was not reached in the reported failure.
- **H3 — timeout lifecycle mismatch. Accepted.** The loop forces `stream:false` and keeps the
  documented connection/header timeout alive through the full JSON generation and parse. LM Studio
  therefore cannot expose connection success or generation progress before the local 200 s abort.

## No-code options gate

- Do nothing: rejected; the behavior is deterministic and the current test suite codifies the
  misleading total-generation cutoff.
- Raise or disable `connectTimeoutMs`: rejected; it moves the threshold, changes every routed
  provider, retains incorrect phase naming, and can remove finite hang protection.
- Add a larger non-streaming total-generation timeout only: rejected; a finite total still kills a
  healthy but progressing local model and cannot distinguish connection wait from inference.
- Reuse `webSearchSidecar.timeoutMs`: rejected; that clock belongs to the hosted ChatGPT search
  request, not the routed model that decides whether to search.
- Reuse existing streaming parsers and bridge heartbeats: accepted as the implementation base.

## Audited design

1. Every routed-model loop iteration is built with `stream:true`. Its adapter stream is fully
   buffered before `scanEventsForWebSearch()` decides whether to suppress the synthetic tool,
   execute the sidecar, or replay ordinary output. No routed semantic delta is exposed early.
2. Only the first iteration's final response headers/status are acquired eagerly before the
   downstream response is returned.
   Initial connect/header failures, HTTP errors, and exhausted 429 rotation remain non-2xx JSON.
   Once an upstream 2xx response has committed downstream SSE, body stalls and parser failures are
   phase-accurate `response.failed` events under HTTP 200.
3. Deadline ownership is explicit and non-overlapping:
   - the turn/client `signal` owns the whole request and remains directly linked to every body;
   - one loop-owned header `AbortController`/timer is composed as
     `AbortSignal.any([turnSignal, headerDeadline.signal])`, reused cumulatively across that
     iteration's 429 rotations, and its timer is cleared (never aborted) after final headers;
   - Google/Kiro may add a per-attempt clearable header timer inside their bounded retry helper,
     while the outer composite still enforces the cumulative deadline;
   - a separate reader-owned inactivity timer starts only after successful headers and cancels the
     source reader on continuous body silence.
   Consequently `connectTimeoutMs` never bounds a successful response body, while parent abort
   remains attached after every header timer is cleared. `AdapterFetchContext` keeps its existing
   signal/timer fields, tightens their header-only contract, and adds the scoped raw-error flag in
   item 7.
4. Add advanced config `webSearchSidecar.routedModelStallTimeoutMs` (default `200_000`). It is a
   continuous raw-byte inactivity guard, not a total generation deadline. Invalid runtime values
   fall back to the default; the value stays config-file-only, matching existing sidecar controls.
5. A new focused web-search stream collector owns the sole reader of the original body and feeds a
   tapped, demand-driven body (`highWaterMark: 0`) to `adapter.parseStream()`. A single-slot
   acknowledged queue bounds only the source/parser/collector boundary (the existing bridge's
   outbound client buffering is explicitly unchanged and no end-to-end backpressure claim is
   made). Lossless semantic `deliver()` resolves only when foreground `receive()` accepts it;
   nonblocking `offerProgress()` stores at most one coalesced bit and never displaces semantic work.
   The caught parser pump awaits each nonterminal semantic delivery and foreground is the only
   consumer. A rejecting `error` terminates immediately; a `done` is not delivered to foreground
   until the provisional validation in item 6 completes. `fail/close/return` settle foreground
   producer/consumer waits and clear the inactivity timer/listeners exactly once; reader and
   iterator cleanup is best-effort, never blocks the foreground, and observes every rejection.
   Every non-empty source chunk resets inactivity even when its invisible
   `{type:"heartbeat"}` progress offer is dropped/coalesced; synthetic progress never resets the
   upstream clock by itself.
6. Before any synthetic search can execute, terminal safety is proven at the adapter-iterator
   boundary. A yielded `error` rejects immediately and cancels the body, so it can never authorize
   sidecar work. A yielded `done` is held provisionally while the pump continues to iterator
   `{done:true}`; any later event, second terminal, throw, or missing terminal becomes a protocol
   error. A dedicated 5,000 ms **post-terminal drain** guard (not a generation deadline) prevents an
   adapter that yields `done` and never returns from hanging forever. Only a verified held `done` is
   published out-of-band to foreground and then allowed through `scanEventsForWebSearch()`.
7. Google and Kiro retry helpers replace non-clearable `AbortSignal.timeout()` attempt signals with
   clearable header timers whose parent-abort linkage remains active for returned bodies. Extend
   `AdapterFetchContext` with `returnRawErrors?: boolean`; the web-search loop sets it so a final
   non-2xx response is returned without adapter-owned normalization, allowing the loop to clear its
   cumulative header timer at the true fetch-return boundary before reading the error body.
   Google raw-error mode keeps bounded status retries but skips body-dependent quota peeking; normal
   routed calls retain their current provider-specific normalization. The loop then owns one raw
   error-body read capped at 64 KiB, 5,000 ms total, and 5,000 ms between non-empty chunks; it
   cancels on any limit, formats only a complete display-safe body through an adapter-owned safe
   formatter, otherwise falls back to status-only text, and preserves the HTTP status. Thus no
   continuously trickling or oversized non-2xx body can defer initial JSON indefinitely, and no
   hidden non-2xx read remains under the header clock on the web-search path.
8. The outer bridge watchdog is exactly
   `max(stallTimeoutSec ?? 90, connectTimeoutMs/1000, routedModelStallTimeoutMs/1000,
   sidecarTimeoutMs/1000) + 30s`. Thus the inner phase-specific header/body timers always win before
   the bridge's generic incomplete watchdog. Search/429/query seam heartbeats remain in place.
9. Adapter wire policies otherwise remain unchanged. In particular, Anthropic's usage-backed EOF
   completion and Google's current clean EOF behavior are not broadened into this repair.

Exact client/log messages are frozen for implementation and tests:

- header phase: `Provider response-header timeout after <ms>ms during web-search`
- body phase: `Routed model generation timeout after <ms>ms without response bytes during web-search`

The initial pre-SSE JSON error envelope remains exactly
`{"error":{"message":"<header message>","type":"upstream_error","code":null}}` with HTTP 504.
Post-SSE body timeout is a `response.failed` carrying the exact body message in both `error` and
`last_error` and classifying as HTTP/log 504.

Both intentionally contain `timeout`, so the existing narrow adapter-error classifier maps an
in-stream body stall to HTTP 504 / `server_error` / `upstream_server_error` without broadening
generic error heuristics.

## Diff-level change map

- ADD `src/web-search/progress-stream.ts`: raw-byte progress collector, inactivity error, cleanup.
- ADD `src/lib/bounded-body.ts`: original-reader error-body drain with a 64 KiB cap, 5 s total and
  5 s inactivity limits, exact parent-abort propagation, and no clone/tee.
- MODIFY `src/web-search/loop.ts`: streaming request mode, header/body phase split, eager header
  preparation, buffered-terminal validation, phase-specific errors, sidecar safety, cancellation.
- MODIFY `src/web-search/index.ts`: resolve the routed-model stall budget and include it in the
  effective bridge watchdog calculation.
- MODIFY `src/types.ts`: document `webSearchSidecar.routedModelStallTimeoutMs`.
- MODIFY `src/server/responses.ts`: thread the resolved stall budget into the loop.
- MODIFY `src/adapters/google-http.ts` and `src/adapters/kiro-retry.ts`: header-scoped clearable
  attempt timers and bounded error-body reads.
- MODIFY `src/adapters/base.ts`: document that `abortSignal` owns the returned body lifetime and
  `timeoutMs` is a per-attempt response-header/error-normalization bound, not generation duration;
  add the scoped `returnRawErrors` capability used by the web-search loop.
- VERIFY `src/lib/errors.ts` without modification unless red evidence disproves the existing
  `timeout` classifier; exact classification and deferred-log assertions are mandatory.
- MODIFY `src/server/index.ts` narrowly so WebSocket deferred logs use
  `httpStatusForRequestLogTerminal(status, logCtx)` just like HTTP SSE. Preserve the user's unrelated
  Images routing hunk; add focused request-log/WS activation evidence without editing the dirty
  `tests/server-auth.test.ts` file.
- MODIFY focused tests: `tests/web-search.test.ts`, `tests/sidecar-abort.test.ts`,
  `tests/google-vertex-http.test.ts`, `tests/kiro-retry.test.ts`, and `tests/ws-endpoint.test.ts`;
  add `tests/web-search-progress-stream.test.ts`, `tests/web-search-timeout-contract.test.ts`,
  `tests/web-search-timeout-plan.test.ts`, `tests/bounded-body.test.ts`, and
  `tests/clearable-deadline.test.ts` to isolate queue/reader/timer and wire-contract races.
- MODIFY source-of-truth/docs: `structure/04_transports-and-sidecars.md` plus EN/KO/ZH
  configuration references and sidecar guides.
- MODIFY this implementation unit throughout B/C/D.

No change is planned for the GUI, `/api/sidecar-settings`, bridge wire protocol, sidecar executor,
provider catalogs, dependencies, credentials, or remote GitHub state.

## Red-first and verification contract

Mandatory red evidence on the current implementation:

1. A scripted adapter requires `stream:true` and makes `parseResponse` unusable; the current loop
   fails before a healthy slow stream can complete.
2. Headers arrive within `connectTimeoutMs`, raw chunks continue beyond that deadline, and a search
   call eventually completes. Current behavior fails; repaired behavior remains alive and searches.
3. A buffered `web_search` followed by `error` must never invoke the hosted sidecar.

Green matrix:

- initial header timeout -> exact JSON 504, zero sidecar calls;
- initial provider HTTP/429 exhaustion -> original status with bounded, safely formatted JSON;
- post-header routed-model inactivity -> HTTP 200 + phase-specific `response.failed` and log reason;
- raw byte progress without adapter events resets inactivity and bridge activity;
- the capacity-one queue never buffers unbounded chunks/events; foreground teardown is bounded on
  parser failure, stall, parent abort, and consumer return, while best-effort cleanup observes every
  rejection;
- collector tests assert HWM-0/no-prefetch behavior, semantic-over-progress priority, one-bit
  heartbeat coalescing, strict exactly-one-final-terminal validation, and explicitly avoid claiming downstream
  client backpressure from the unchanged eager bridge;
- later-iteration stall -> one prior sidecar call, then one SSE failure and no completion;
- one cumulative header deadline across 429 rotation;
- parent/client cancellation remains distinct and settles all readers/timers;
- exactly one final terminal event is required before scan/search;
- `done` is authorized only after adapter iterator completion; post-terminal data/duplicates,
  post-terminal drain timeout, and cancellation all produce zero sidecar calls;
- invalid/overflow/fractional/non-number stall config falls back locally to 200000 without
  invalidating or rewriting the user's config; an explicit valid config-file value participates in
  the bridge maximum and is threaded into the loop;
- accepted timer values are bounded to `1..2_147_483_647` inclusive;
- the exact stall sentence classifies/logs as HTTP 504, `upstream_server_error`, terminal failed;
- HTTP SSE and WebSocket request logs both use captured terminal HTTP status for the exact 504;
- signed/redacted thinking, mixed real+web tools, forced-answer cap, search ordering, and no
  synthetic-tool leakage remain green;
- successful Kiro/Vertex/Antigravity bodies can outlive `connectTimeoutMs`, while parent abort after
  headers still cancels them;
- focused suites, `bun run typecheck`, relevant docs consistency searches, and `bun test ./tests/`
  pass; an independent sol-medium reviewer reports no blockers.

## Dirty-worktree boundary

User changes already exist in README/catalog/server/images/auth-test and transport documentation
surfaces. They are preserved. README files are explicitly not edited. Planned dirty-file overlaps
are limited to a narrow WebSocket log line/import in `src/server/index.ts` and the timeout section of
`structure/04_transports-and-sidecars.md`; their unrelated Images code/documentation hunks are
outside the edit and must remain byte-for-byte intact. The dirty `tests/server-auth.test.ts` remains
untouched and runs only as regression coverage.
