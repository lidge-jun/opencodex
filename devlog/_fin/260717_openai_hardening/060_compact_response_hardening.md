# Cycle 060 — Compact Response Hardening

## Objective

Harden the `/v1/responses/compact` path for all three OpenAI tiers. The compact
handler must buffer upstream responses with a strict 32 MiB incremental reader,
cancel on Content-Length overflow before reading, stop on chunked overflow mid-stream,
produce exactly one `/api/logs` and JSONL row per outcome (success, 4xx, 5xx,
client cancel, body-read failure), and never relay partial bytes on overflow.

## Scope

- `COMPACT_RESPONSE_MAX_BYTES = 32 * 1024 * 1024` constant and `bufferCompactResponse` reader
- Content-Length pre-check cancels before first read
- Chunked accumulation stops and cancels reader at cap
- Client abort during fetch or body read returns 499
- Body-read/connect failure returns 502
- Upstream 4xx/5xx relayed after buffering
- `handleResponsesCompact` signature change to accept `logCtx`
- `src/server/index.ts` allocates requestId/start, wraps in try/catch, calls `addFinalRequestLog` exactly once
- Pro virtual id maps to base in compact, reasoning stripped

## Activation tests

- `tests/openai-api-virtual-models.test.ts` "OpenAI API compact transport" test
- Three Pro ids → base model, no reasoning in upstream body, API key forwarded
- upstream-400, upstream-500, connect-error, body-error, declared-overflow, chunked-overflow
- fetch-abort and body-abort via AbortController
- Local 400 (empty model) without upstream fetch
- Each outcome produces exactly one log row with correct status and model identities

## Evidence

- Consolidated implementation and activation evidence is indexed in
  [`190_consolidated_finish_plan.md`](./190_consolidated_finish_plan.md), with the final
  Cycle-B integration and gate receipts in [`050_integration_verification.md`](./050_integration_verification.md).

## Status

`done — verified by consolidated Cycle A/B sweep, see 190 + 050 evidence`
