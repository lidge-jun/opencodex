# L1: content-free Codex WS upstream stage instrumentation (#4191)

Class C2. Stack bottom, base `dev`. Branch
`codex/260912-ws-stage-instrumentation`. Diagnosis instrumentation only:
no behavior change to success paths, no retry/fallback change.
Second revision: folds the wp2 A-audit FAIL (2 blockers, 2 majors, 1
minor) into the design. First revision's `recordCodexWsStage`-on-context
design is retracted — the exchange has no `RequestLogContext`
(codex-ws-exchange.ts:11-18,85) and cannot get one without inverting
layers.

## Problem

#4191 fails as WS 1006 or "response prelude timed out" only through the
proxy. The content-free stage record already exists as
`CodexWsFailureStage` (src/server/responses/codex-ws-wire.ts:100-144) and
`failureStage()` (src/server/responses/codex-ws-exchange.ts:148-159), but
it is only interpolated into failure message strings. Durable logs keep
neither the message nor a typed code: the eager relay collapses stream
errors to `upstream_reset` + `streamAborted` (wire.ts:218-229 comment;
relay.ts:1417-1430), and the 504 pre-response JSON path never reaches the
relay at all. `/api/logs` and usage.jsonl are explicit per-field copies,
so a field added only to `RequestLogContext` is dropped on write and on
restart hydrate.

## Contract (from #4191 + maintainer bounds)

Record, per upstream exchange: create-frame bytes, send completion,
close code (numeric only), elapsed ms and first-frame ms, frame counters
(upstream/control/relayed, pings/pongs), pool reuse boolean, OCX version,
Bun runtime version. Never record conversation text, headers, close-reason
text, or account identifiers. No `responseCommitted === false`
auto-retransmit fallback. Client CLI version is not on the handshake
(`user-agent` is not in FORWARD_HEADERS,
src/adapters/openai-responses.ts:43-61) — the limitation is documented in
the PR, not worked around by parsing `frameText`.

## Changes

MODIFY `src/server/responses/codex-ws-wire.ts`
- New exported type `CodexWsStageRecord =
  Omit<CodexWsFailureStage, "requestBytes"> & {
  requestBytes: number | null; closeCode: number | null; reused: boolean;
  ocxVersion: string; bunVersion: string }` (Omit, not an intersection —
  an intersection cannot widen `requestBytes`). Extend the privacy
  comment: numeric/boolean/semver fields only; close-reason text stays out
  of every durable record.
- New `markCodexWsStage(response, record)` / `readCodexWsStage(response)`
  over a `WeakMap<Response, CodexWsStageRecord>` — the same
  Response-marker seam `markCodexWsResponse` already uses.
- `ocxVersion` comes from a module-local package.json IIFE, the exact
  pattern already duplicated in management-api.ts:87-93, gui-static.ts:6-9,
  client/machine-listener.ts:21, update/index.ts:147. Do NOT import
  management-api (layer inversion + cycle).

MODIFY `src/server/responses/codex-ws-exchange.ts`
- `ExchangeOptions` gains optional `bunVersion?: string` and nothing
  else; no context, no callback registry.
- Snapshot once in `failStream` (the funnel every failure site already
  calls: armSilence :206, connect-deadline :256, onClose :426, onError
  :437, and the onMessage sites :330-402) and once in `commitResponse`
  (:160). After the existing settle decision, call
  `markCodexWsStage(response, record)` on the Response being resolved —
  both the SSE 200 and the `codexWsPreResponseFailure` JSON paths resolve
  a Response, so one marker covers success and failure.
- `requestBytes`: computed at failure time only (current deferred
  behavior). On the committed-success record it is `null` — the happy
  path must not byte-count megabyte replay frames (the deferral comment at
  :143-147 is the contract).
- `closeCode` is captured in `onClose` from the event (numeric only) and
  carried into the `failStream` call it makes; other sites pass `null`.
- `reused` is `session.reused`; `bunVersion` from the new option.
- No control-flow change at any site: emissions happen after the settle
  decision, never instead of it.

MODIFY `src/server/responses/ws-upstream.ts`
- Pass `bunVersion: typeof runtime === "string" ? runtime : runtime.version`
  (the gate input at :62-64 may be a plain string) through
  `codexWsUpstreamFetch` into `codexWsExchange`. Signature gain is one
  optional field.

MODIFY `src/server/responses/core.ts`
- Adopt the stage onto the attempt at the handleResponses send path, not
  only at `retryCodexPoolOnAlternateAccount` (:1532-1556 is the pool
  retry, not the primary send): `readCodexWsStage(upstreamResponse)`;
  when present assign `logCtx.activeAttempt.codexWsStage`. Apply at every
  adopted `upstreamResponse`: the primary send (:5304-5320), the
  post-retry assignment (:5824) — or once on the final response after the
  ladder (~5758); B picks the single funnel that covers every adopted
  response and tests it. This covers the 504/502 pre-response JSON path
  that never reaches relay.ts, and needs no relay.ts change: the relay
  collapse only sets `streamAborted` alongside the stage. (First
  revision's relay.ts MODIFY is retracted.)

MODIFY `src/usage/log.ts`
- `PersistedUsageAttempt` gains `codexWsStage?: CodexWsStageRecord`
  with a comment naming #4191 and the content-free invariant.
- Attempt serializer allowlist (:445-480 region): carry `codexWsStage`
  through a `normalizeCodexWsStageRecord` guard (numeric fields via
  isNonNegativeFiniteNumber-style checks, booleans strictly, versions as
  capped semver strings, `requestBytes: number | null`) so a hand-edited
  row cannot inject strings into the DTO.
- `normalizeUsageEntry` (:527-612) carries it via the attempts
  normalization above; no entry-level copy (stage is per-attempt).

MODIFY `src/server/request-log.ts`
- `RequestLogEntry` needs no new field: `attempts` already projects.
  `requestLogEntryFromPersistedUsage` (:280-330) keeps copying
  `attempts` wholesale. Verify `addFinalRequestLog` (:1037-1086) passes
  the attempt objects (with the stage) into `addLog` — if it re-derives
  attempt rows field-by-field, add `codexWsStage` there instead. B
  confirms which of the two attempt paths is authoritative and tests it.

## Tests (red-first)

MODIFY `tests/responses/ws-upstream.test.ts`
- Through `handleResponses` (the :399-408 pattern — the only path that
  owns a logCtx): upstream 1006 persists `codexWsStage` on the logged
  attempt with `closeCode: 1006` and `sent: true`; prelude-timeout
  persists `firstFrameMs: null`, `upstreamFrames: 0`; a committed
  success records exactly one stage with `requestBytes: null`.
MODIFY `tests/responses/ws-failure-stage.test.ts`
- Record carries closeCode/reused/versions; the serialized record never
  contains reason text, header names, or body substrings.
NEW `tests/usage/usage-log-ws-stage.test.ts`
- Round trip: `normalizeUsageEntry` + attempt serializer keep a valid
  stage; corrupt stage shapes (string frames, object closeCode) are
  dropped, not passed through. layout.json explicit +
  tests/fixtures/test-layout-expected.json entries (domain `usage`).

## Docs / ownership

L1 touches owned `src/server/responses/*`, `src/usage/log.ts`, and
`src/server/request-log.ts`: sync structure/transports/responses.md and
structure/runtime.md in this PR (structure:check must stay green).

## Out of scope

Any WS behavior fix, SSE-fallback policy change, prelude-timeout tuning
(#3976/#4083), pool policy, inbound client-socket metrics
(codexWebSocketAdmissionMetrics is the client side — do not touch),
auto-retransmit on `responseCommitted === false`.
