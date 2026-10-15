# 010 — wp1: recover a pre-output upstream refusal on the native Codex pool

Research and evidence: [000_plan.md](000_plan.md). Base `dc45bb2ca9`.

## Loop-spec header

- Class: C3 (transport contract change on a shared path; no persistence or credential change).
- Outcome: an authoritative upstream 5xx refusal that arrives on the Codex WebSocket before any
  output reaches the existing same-account transient ladder and the pool alternate-account move;
  compact moves accounts on a surviving transient 5xx. Exhausted recovery delivers exactly what the
  client receives today.
- Tool/credential scope: local checkout, isolated temp homes and fake sockets only. No live
  `~/.opencodex`, :10100 service, Codex app or GOAT server. Write scope: the files below.
- Resource bounds: none stated; host limits apply.
- Terminal outcomes: DONE (PR open, review PASS, exact-head CI green), BLOCKED/NEEDS_HUMAN only for
  secrets, cost, publication or permission decisions.

## Architect consultation (round 1, gpt-6.1-sol high) and dispositions

| ID | Proposal | Disposition |
| --- | --- | --- |
| D1 | Internal opt-in threaded ProviderFetchOptions → codexWsUpstreamFetch → codexWsExchange; canonical metadata exchanges only; no native control, sidecars or combos-by-accident | Accepted. Enabled only on Pool forward sends (`usesCodexForwardPoolAuth`), fixed Pool accounts included (same-account ladder only). |
| D2 | Hold only structurally empty lifecycle frames, check every held snapshot; freeze prelude headers and `metadata.commit()` at the first Responses event; non-resetting 10 s bound | Accepted. Bound = `min(10_000, floor(connectMs / 2))`. |
| D3 | Strict refusal identity: correlation first, no foreign `stream_id`, empty preamble and empty terminal output, explicit structured evidence only; no message-text authorization | Accepted. See "Refusal identity". |
| D4 | Commit before failing only when a Responses preamble was actually held | Accepted. |
| D5 | Restore immediately after the Pool block on every loop pass, carrying WS/quota markers and the same stage object; single use | Accepted. Affinity diagnostics (captured before the Pool block) record the true refusal status; they are diagnostics only. |
| D6 | Compact: transient predicate, guards kept, quota precedence kept, admission secured before cancelling A, no promise of B promotion | Accepted. |
| D7 | Exactly-once health outcome: unmoved projection must not be recorded both in the retry helper and by the restored stream's terminal recorder | Accepted as the exactly-once marker (audit dispositions 2 and 4). |
| D8 | Amend the "only precommit 4xx" comment and the transport contract doc | Accepted. |
| Alt | Route Pool over HTTP | Rejected: loses WS latency, still misses HTTP in-stream refusals. |

## Refusal identity (codex-ws-wire.ts, new `codexWsPreOutputRefusalStatus(payload)`)

Returns a status only for:

1. `type: "error"`, no `stream_id`, exactly one integer wrapper alias (`codexWsWrapperStatus`) with
   `isTransientUpstreamStatus`; or no wrapper alias at all and `recognizedUpstreamError(error)` is the
   overload class (503).
2. `type: "response.failed"` whose `response.output` is absent or empty and whose
   `response.error` is the recognized overload class (503).

Never for: a rate-limit/quota code (`recognizedUpstreamError` 429, `insufficient_quota`,
`usage_limit_reached`, `rate_limit_*`), a message that `isRateLimitOrQuotaFailureMessage` reads as
quota, a 4xx, competing aliases, a malformed `error` member.

## Reflection round 2 (MISALIGNED, narrow) — corrections folded

1. The whole new refusal path, first-frame and held, runs only under `holdEnabled && sent && !responseCommitted`; opt-out and native-control exchanges are byte-identical to today.
2. A replay-eligibility latch, independent of correlation being present: it drops on any frame carrying a `stream_id`, on a lifecycle or `response.failed` frame whose `response.id` differs from the first held id, and on any non-empty snapshot. Once dropped, the exchange commits and behaves as today. Cold, reused and one-shot sockets all apply it.
3. First-frame and held refusals settle identically: the terminal frame goes through today's frame-size and queue checks, is recorded as `terminalEvent`, enqueued, the stream closed, the session released as a failed terminal, and only then the projection resolves. A restore therefore always carries the full original bytes.
4. Tests add: foreign id on a cold socket, metadata during the hold (restored headers equal the frozen prelude), queue overflow during the hold, denied alternate admission keeping the original body, single health/quota record, combo consumer receiving restored SSE.

## Audit round 1 (FAIL, 3 blockers) — dispositions

1. **Foreign terminal on a cold socket (accepted).** The latch drops on every identity signal
   `CodexWsCorrelation.accept` reads, independent of `strict`: any `stream_id`; a lifecycle or
   `response.failed` frame whose `response.id` or top-level `response_id` differs from the first held
   `response.created` id; a frame carrying two different ids; an `error` frame whose `response_id`
   differs from the held id. A refusal with no held id may carry at most one id and no `stream_id`.
   Test: held id A, then `response.failed` with `response.id = A`, `response_id = B` → one send.
2. **Late alternate-admission denial (accepted; revised after audit round 2).** The helper's
   order is NOT changed (moving A's record/identity after admission charged B's permit under A's
   spend identity and lost A's outcome on the credits-off exit). Instead an exactly-once marker:
   `noteCodexWsPreOutputRefusalOutcome(projection)` is set whenever the helper records A's outcome for
   a projection (`recordFirstOutcome`, `recordUnmovedTransientOutcome`); `recordUnmovedTransientOutcome`
   skips a projection already marked (late window/permit denial after `recordFirstOutcome`); the
   restore carries the marker to the restored response; delivery's terminal recorder skips the
   health write for a marked restored response while still running its other terminal callbacks.
   An unmarked restored projection (fixed account, non-Pool forward account, no move attempted) is
   recorded once by delivery. Credits-off keeps today's order: A recorded, then the policy refusal.
   Residual, pre-existing and shared with the HTTP 5xx path: after a late denial the attempt's log
   identity already names B while A's (restored) bytes are delivered; health is attributed to A.
   Tests: no alternate available, window denial → one A outcome, A's bytes, zero B sends.
3. **Compact admission and spend identity (accepted, without an early reservation).** The transient
   arm switches `logCtx.accountLogLabel`/`outcomeCtx` to B and runs `sendSingleCompactAttempt` for B
   with A's body still uncancelled, so every budget/spend check runs under B's identity. A
   `SendBudgetExhaustedError` from that helper is always pre-send; on it the arm restores A's label
   and context, releases B's probe lease and continues with A's response untouched (recorded once at
   the end as today). After B is actually sent (success, HTTP failure or transport failure) A is
   recorded with its real 5xx and its body cancelled. `permit.use()` failure inside the helper now
   releases its reservation. The quota arm keeps its current order. Tests: B admitted → B serves;
   B refused (budget spent) → A's 503 body and one A outcome.

4. **Abort or local refusal during the same-account backoff (audit rounds 3-4, accepted).** The
   initial-send closure in `passthrough-dispatch.ts` keeps the last projection it observed together
   with the account context that produced it. One owner per exceptional exit of
   `fetchWithTransientRetry`:
   - caller abort (`options.abortSignal`/`req.signal` aborted) or `SendBudgetExhaustedError`:
     `transportFailureResponse` writes no account health on these exits (it returns at its first two
     branches), so the dispatch catch records the unmarked projection once as its real 5xx against
     the producing account, marks it, then calls `transportFailureResponse` unchanged;
   - any other exception (a later send's timeout/connection error wrapped in
     `UpstreamRetryEvidenceError`): the dispatch catch writes nothing and `transportFailureResponse`
     remains the single writer, as today.
   Recording happens before `transportFailureResponse` releases the probe lease. Tests: abort during
   the first backoff → no second socket, exactly one A transient write; 503 then timeout and 503
   then connection error → exactly one A write.
5. **Compact verification matrix (audit rounds 3-4, accepted; all mandatory).** B served from
   remaining base sends; B admitted from the final recovery reserve after A's three sends; B refused by
   a spent budget (A's body and outcome intact, B's probe released, zero B sends); reservation granted
   then `permit.use()` fails → reservation released; caller cancellation while B is in flight; unequal
   A/B identity balances on both the base and the reserve path (B's identity governs admission), using
   the ledger fixtures from `tests/lib/execution-budget-permits.test.ts`.

Notes taken: the 10 s hold starts at the first lifecycle event and `fetchWithTransientRetry`
returns an attempt slower than 15 s as-is, so "three same-account sends" holds for refusals within
that budget (tests use an immediate refusal and one slow case). Combo children
(`options.comboAttempt`) do not opt in — their preflight already hops on a zero-output terminal.
401-refresh and rebuild legs do not opt in (documented limitation). Tests assert the restored
attempt's `sendCount`, `recoveryKinds` and `codexWsStage` counters.

## File change map

### MODIFY `src/server/responses/codex-ws-wire.ts`
- ADD `codexWsPreOutputRefusalStatus(payload)` (above).
- ADD `isEmptyCodexWsLifecycleEvent(payload)`: `response.created` / `response.in_progress` /
  `response.queued` whose `response` is an object with `output` absent or `[]`.
- ADD restore registry: `markCodexWsPreOutputRefusal(projection, restore)`,
  `isCodexWsPreOutputRefusal(response)`, `restoreCodexWsPreOutputRefusal(response)` (single use;
  returns the response unchanged when not a projection).

### MODIFY `src/server/responses/codex-ws-exchange.ts`
- ExchangeOptions: `preOutputRefusalHoldMs?: number`.
- `holdEnabled = hold > 0 && metadata && !nativeControl`.
- On a non-control frame while `sent && !responseCommitted`, after correlation:
  - first frame is a refusal → project (no preamble).
  - `isEmptyCodexWsLifecycleEvent` and holdEnabled → on the first held event freeze
    `heldHeaders = metadata.snapshot()`, `metadata.commit()`, arm one non-resetting hold timer
    (`commitResponse` on expiry); enqueue the frame; do not resolve.
  - held preamble and the frame is a refusal → enqueue, close, `session.release(null)`-style
    dispose, resolve the projection.
  - anything else → `commitResponse()` (uses `heldHeaders` when present), then today's code.
  - The existing pre-commit 4xx projection only runs when nothing was held (today's boundary).
- Projection: JSON `{error:{type,code,message}}` from the frame (bounded via existing
  `rejectionHeaders`), the frame's status, `markCodexWsPreludeProjection`, stage record, NOT
  non-replayable; restore builds the 200 SSE over the same closed stream with the markers
  `commitResponse` sets and the same stage object.
- `failStream` / `cancelExchange`: when a preamble is held, `commitResponse()` first so the
  settle is today's committed body failure (no socket-death marker, no new 502/504).
- Clear the hold timer in `cleanup` and `commitResponse`. Amend the "only precommit 4xx" comment.

### MODIFY `src/server/responses/ws-upstream.ts`, `fetch-helpers.ts`
- `ProviderFetchOptions.preOutputRefusalHoldMs`; pass through `codexWsUpstreamFetch` (new trailing
  parameter) to the exchange.

### MODIFY `src/server/responses/passthrough-dispatch.ts`
- Initial send closure inside `fetchWithTransientRetry` (~1027): pass
  `preOutputRefusalHoldMs` when `usesCodexForwardPoolAuth(admissionState.authCtx, route.provider)`
  and the leg carries no native control.
- Immediately after the Pool block (~1704), every loop pass:
  `upstreamResponse = restoreCodexWsPreOutputRefusal(upstreamResponse)`.

### MODIFY `src/server/responses/core-codex-account.ts`
- Alternate-account providerFetch (~917): pass the same hold so a second refusal is also a
  projection (restored by dispatch). Hold value threaded via `CodexPoolAccountRetryArgs`.
- Exactly-once marker as in audit disposition 2 (record + mark; skip when marked).
- Update the `shouldRetryCodexPoolAccountTransient` doc comment.

### MODIFY `src/server/responses/compact.ts`
- Alternate condition gains a transient arm: `shouldRetryCodexPoolAccountTransient(upstream)` and
  not body-confirmed quota (`shouldRetryCodexPoolAccountQuota`), same guards. Transient arm skips
  the workspace-scope quota check and the quota-cache refresh, admits B's send before cancelling A,
  records A with its real 5xx (transient) after B was sent and before every B return (success, HTTP failure, transport failure), keeps the conversation-state scrub. Spend/budget identity is B by construction: the label switches before the helper runs and both the base reporter and the reserve path read it lazily.

### Tests (NEW, registered in `scripts/test-layout/layout.json` and
`tests/fixtures/test-layout-expected.json`)
- `tests/responses/ws-pre-output-refusal.test.ts` — exchange-level: first-frame 503/502 and
  after-preamble refusals project with status, stage and restore; output/tool/non-empty snapshot,
  socket death and silence before/after preamble, 4xx/429 frames, quota-coded 5xx, foreign
  `stream_id`, conflicting aliases, native control, hold expiry, opt-out (no hold option) keep
  today's results.
- `tests/responses/responses-pool-overload-failover.test.ts` — handleResponses pool end to end
  with fake sockets: single account (3 same-account sends, original stream), two accounts all
  overloaded (3 + 1 sends, original stream from B), recovery on B, fixed account (no move), output
  started (1 send), abort during backoff (no further send), health recorded once.
- `tests/responses/compact-transient-alternate.test.ts` — compact A 503×3 → B success; B 503;
  fixed account; quota-bodied 5xx keeps today's path.

### Docs
- `structure/transports/responses-wire-shapes.md` (WS prelude contract) and
  `structure/transports/responses-failover.md` (pool transient move, compact) — the exception and
  its bounds.

## Accept criteria with activation scenarios

| Path | Activation | Observable proof |
| --- | --- | --- |
| Refusal after preamble | fake socket sends created, in_progress, `{type:error,status:503}` | dispatch sends again; second socket succeeds; client gets the success stream |
| Same-account bound | every socket refuses, one account | exactly 3 sockets; client body is the original created/in_progress/error stream |
| Account move | two accounts, all refuse | 3 + 1 sockets, B's frame carries B's token |
| Output started | created, output_item.added, error 503 | 1 socket; client sees the error in-stream |
| Socket death / silence | close after created; 90 s silence before any event | today's 200 body error / 504 non-replayable |
| Abort in backoff | abort during first backoff | no second socket |
| Fixed account | pinned Pool account | ≤3 sockets, never another account |
| Compact | A 503 thrice, B 200 | 4 HTTP sends, B serves, A recorded transient |

## Verifiers (run in C)

`bun run typecheck`; `bun test` on the three new files plus `tests/responses/ws-*.test.ts`,
`tests/responses/responses-pool-*.test.ts`, compact suites; `bun run test:changed`;
`bun run structure:check`; `bun run privacy:scan`; `bun test tests/test-layout*.test.ts`.

## Residual risk

HTTP SSE in-stream zero-output refusals and frames with an unrecognized code and no wrapper status
stay unrecovered. Native steering/injection exchanges keep today's behaviour.

## Implementation review follow-ups

- Review round 1 (gpt-6.1-sol high, FAIL): projection headers built before any settle, falling
  back to committed delivery when they cannot be projected; `rate_limit*`/`*quota*` veto; dispatch
  logic moved to `PoolPreOutputRefusals` in `core-codex-account.ts` for the 2,000-line ratchet;
  real spend-ledger, queue-overflow, non-resetting-deadline and header-timeout tests. Round 2: PASS.
- PR review (Codex connector): the hold is now `{ maxMs, until }`, with `until` set per send to
  half of `connectTimeoutMs` after it starts, so a late first lifecycle frame cannot hold past the
  header deadline; compact keeps A whenever B never physically dispatched (tracked through
  `onPhysicalDispatch`), not only on a spent budget.
