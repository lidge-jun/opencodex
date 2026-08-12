# 060 — Issue #938: UUID item IDs leave Codex stuck on Thinking

Composes with 050's JSON→client-event boundary (implement after 050).
Research: explorer batch E (read PR #940 fully, 1473 lines).
Decision: **supersede PR #940 with a narrow reimplementation.**

## Verified current state

- Repair state knows only configured placeholder sets + missing-terminal
  behavior: `src/server/responses-item-id-repair.ts:53`; `rememberMappedId()`
  mints only for exact placeholders (`:84`); activation recognizes the three
  existing options (`:220`). Public type + strict schema have no invalid-ID
  option: `src/types.ts:920`, `src/config.ts:596`. Rewrite is client-facing,
  confined to the SSE branch (`core.ts:1967`), raw snapshots preserved.
- #940's ID-prefix idea is equivalent to the needed fix, but the 15-file,
  ~750-line PR bundles response-ID rewrites + continuation aliases, dropped
  `response.in_progress`/raw reasoning events, synthesized envelopes,
  logprobs stripping, relay surgery, eager-relay changes, `[DONE]` synthesis —
  all beyond #938's acceptance boundary. Draft, conflicting, changes
  requested.

## Diff-level plan

MODIFY `src/types.ts` — add `repairInvalidIds?: boolean` to
`ResponsesItemIdRepairConfig`: for message/reasoning items, an existing ID is
invalid when it lacks the expected `msg_`/`rs_` prefix.

MODIFY `src/config.ts` — add the boolean to the strict provider schema
(unknown nested keys still rejected).

MODIFY `src/server/responses-item-id-repair.ts` — extend state with
`repairInvalidIds`; extract one type-scoped resolver used by item objects and
lifecycle `item_id` fields; mint when exact-placeholder OR
(`repairInvalidIds` and wrong type prefix); maps stay keyed by item type +
`output_index`; NEVER rewrite `function_call.id`, `function_call.item_id`,
or `call_id`; recognize the option in `hasResponsesItemIdRepair()`; do NOT
rewrite `response.id` in this patch (no evidence response IDs block
completion; avoids previous-response aliasing).

MODIFY `src/providers/registry.ts` — registry-only `responsesItemIdRepair`;
enable `{ repairInvalidIds: true, repairMissingTerminalIds: true }` for
built-in DeepSeek; never seeded into saved config.

MODIFY `src/providers/derive.ts` — fill the registry policy only when the
runtime provider has no explicit policy; deep-clone `message`/`reasoning`
arrays.

MODIFY `src/server/responses/core.ts` — keep raw-SSE-only rewrite; ALSO
apply the same client normalization when 050 converts bounded JSON to HTTP
SSE or WS events; raw state recording happens before normalization.

MODIFY `tests/config.test.ts`, `tests/responses-item-id-repair.test.ts`,
`tests/service-tier-capability.test.ts`.
ADD `tests/deepseek-responses-item-id-repair.test.ts`.
DOCS: five provider-reference locale files.

## Tests / activation

Primary stream: UUID reasoning item added→delta→done; UUID message item
added→delta→done; UUIDs repeated in `response.completed.response.output`;
terminal + `[DONE]`. Assert stable `rs_ocx_*`/`msg_ocx_*` IDs across every
lifecycle occurrence; function-call ID/`call_id` byte-unchanged; raw
snapshot replayable; client stream reaches terminal.

Matrix: invalid UUIDs; canonical IDs unchanged; legacy placeholders still
repaired; missing terminal IDs backfilled; type separation on shared
`output_index`; delta-before-added; disabled → byte passthrough;
malformed/unknown events unchanged; translator-budget bounds; explicit
provider config overrides registry default; 050 bounded-JSON HTTP + WS
paths normalize identically.

Ablation: ID-only normalization first; only if the reporter still stalls,
evaluate #940's reasoning-event conversion or response-ID aliasing separately.

## Accept criteria

- Primary stream + matrix green; composition with 050 proven; gates as 030.
