# Phase 1 — Verification record (web_search_call native UI)

Date: 2026-06-30
PABCD: P→A→B→C→D complete for this work-phase.

## What shipped

- `src/types.ts`: new `AdapterEvent` variant
  `{ type: "web_search_call"; id; query; status? }`.
- `src/bridge.ts`: streaming (`bridgeToResponsesSSE`) emits a self-contained
  `response.output_item.added` + `response.output_item.done` pair for the new
  event (same `event.id` on both, `action: { type: "search", query }`), and the
  non-stream `buildResponseJSON` pushes the equivalent completed item.
- `src/web-search/loop.ts`: records searches that actually hit the sidecar (only
  the `runWebSearch` branch — not empty/limit/repeat placeholders) and prepends
  them as `web_search_call` events before the final answer.
- Tests: `tests/bridge.test.ts` (streaming + non-stream item shape),
  `tests/web-search.test.ts` (loop emits the item ahead of the message; empty
  query does not emit one).

## Audit (A gate)

gpt-5.5 independent reviewer: APPROVE, no P0/P1. Confirmed against codex-rs:
- SSE deserializes `event.item` directly into `ResponseItem::WebSearchCall`
  (`codex-api/src/sse/responses.rs`); the id field is `id`, not `call_id`, and
  is read on deserialize despite `skip_serializing` (`protocol/src/models.rs`).
- `action: { type: "search", query }` is the valid shape.
- Emitting both added and done matches the native lifecycle; a single done would
  also work.
- Refinements folded in: use `event.id` (not a fresh uuid), record only in the
  real `runWebSearch` branch, add a loop-level test.

## Check (C gate) — fresh evidence

- `bun x tsc --noEmit` → exit 0.
- `bun run privacy:scan` → "Privacy scan passed", exit 0.
- `bun test tests/bridge.test.ts tests/web-search.test.ts tests/sidecar-abort.test.ts`
  → 29 pass, 0 fail (4 new tests included).
- `bun test tests` → 1563 pass / 71 fail / 13 errors. The 71 failures + 13
  errors are pre-existing and environmental (cursor-agent path tests, logger
  file tests, missing `@opencode-ai/plugin/tool` local module); the baseline on
  a clean stash was identical at 71/13, and pass count rose from 1559 to 1563
  (the 4 new tests). No new failures introduced. CI (fresh `--frozen-lockfile`
  install) does not see these local-env failures.

## Scope honored

No changes outside `src/types.ts`, `src/bridge.ts`, `src/web-search/loop.ts`,
and the two test files. Kiro/timeout commits untouched. No vision sidecar change.
Sidecar `sources`/citations not relayed in this phase (cell only needs the query);
annotations remain a possible later phase.
