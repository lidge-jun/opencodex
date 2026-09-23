# Log served-model echo — plan

loop-spec: C2 single work-phase (wp1), goal = remove the false reroute arrow for Anthropic rows at its source.

## Problem

The Logs model column renders `claude-opus-5-5 → anthropic/claude-opus-5-5` for every
Anthropic-routed request. Live row shape (usage.jsonl, 2026-09-23):

```
provider=anthropic model=claude-opus-5-5 requestedModel=anthropic/claude-opus-5-5
resolvedModel=claude-opus-5-5 wireModel=claude-opus-5-5 servedModel=anthropic/claude-opus-5-5
```

## Root cause

- `src/server/responses/core-normalize.ts` keeps the Codex-facing selector for Anthropic
  routes (`parsed._responseModelId`), and every delivery path writes it into `response.model`.
- `src/server/request-log.ts` `applyResponseLogMetadata` reads `response.model` from that
  client-facing payload and stores it as `servedModel` — ocx's own echo, recorded as if the
  upstream had reported it.
- `gui/src/pages/logs-model-title.ts` `isModelRerouted` compares `servedModel` with
  `wireModel ?? model` and draws the arrow. #5609 made the wire model explicit; the echo
  itself predates it.

## Changes (diff level)

| File | Change |
|---|---|
| src/usage/log.ts | export `isClientSelectorEcho(source, served)`; `modelIdentityLogFields` and `normalizeUsageEntry` drop an echo `servedModel` (and a `resolvedModel` that only repeated it) |
| src/server/request-log.ts | internal `responseModelEcho` on RequestLogContext; `applyResponseLogMetadata` ignores an echo payload model |
| src/server/responses/core-normalize.ts | set `logCtx.responseModelEcho` in the block that already records `wireModel` |
| tests/server/response-model-identity.test.ts | bridged JSON/SSE and passthrough rows never carry the echo as servedModel |
| tests/usage/request-log-served-model.test.ts | capture skip, real reroute still recorded, legacy row repaired on read |

Field chain for `responseModelEcho`: creation core-normalize → consumed by applyResponseLogMetadata
and modelIdentityLogFields → never serialized (internal, like `preserveResolvedModelFromRoute`).

## Scope

IN: capture-time and read-time served-model identity. OUT: GUI rendering (it is correct once the
data is), response.model contract to clients (unchanged), pricing.

## Acceptance

1. Anthropic bridged JSON/SSE: `logCtx.servedModel` is not the namespaced selector.
2. A real upstream model difference (e.g. `claude-opus-5-1`) is still recorded as servedModel.
3. A legacy persisted row with `servedModel = provider/wire` normalizes without servedModel.
4. Existing served-model sanitization test still passes.
5. `bun run typecheck`, focused files, exact-head CI green; PR merged into dev.


## Architect consultation (devin/swe-2, agent 01a0cc84-dad4-7962-8dc1-f5a9b5ebf040)

- D1 responseModelEcho on RequestLogContext only — ACCEPT. Combo parents inherit it via
  `Object.assign(logCtx, childLog, …)` in core-combo.ts.
- D2 predicate — AMEND, adopted: also match the persisted `requestedModel`, because a bare combo
  selector sets neither `requestedAlias` nor a slash form, so legacy combo rows are repairable only
  through `requestedModel`. Final predicate: served differs from `wireModel ?? model` and equals
  one of `responseModelEcho`, `requestedAlias`, `requestedModel`, or `provider/(wireModel ?? model)`.
- D3 capture skip in applyResponseLogMetadata — ACCEPT. It is the only body-derived writer; the
  `openai-model` header writer in passthrough-delivery.ts is a real observation and stays.
- D4 read-time repair — ACCEPT with the D2 amendment.
- Noted, out of scope: passthrough-dispatch.ts:623 hands the selector to `notifyResponseComplete`
  (recall, not logs). On adapter paths the true upstream model is not observable at all, so a genuine
  Anthropic-side reroute now shows as no arrow instead of a false one; the code comment says so.

Explorer (devin/swe-2, agent 01a0cc85-0426-78a2-931c-31ea0d27a739): no consumer requires servedModel
on Anthropic rows; the echo also produced a duplicate `anthropic/claude-opus-5-5` option in the
Logs model filter (logs-filter.ts:126,169), which the same fix removes. Pricing and CLI read `model`.
Test note: tests/usage/request-log.test.ts is at its file-size cap (2075), so new assertions go to
request-log-served-model.test.ts and response-model-identity.test.ts.


## Reflection (same architect): ALIGNED, gaps folded into acceptance

6. Combo parent: a row with `provider = combo`, `requestedModel = mycombo` and an inherited
   echo `servedModel = mycombo` keeps no servedModel (capture via inherited responseModelEcho,
   read via requestedModel).
7. Legacy bare-selector row (`servedModel === requestedModel`, provider slash form absent) normalizes
   without servedModel.
8. Acceptance 2 is a capture-level unit: `applyResponseLogMetadata` with a non-echo model still sets
   servedModel. Adapter paths cannot observe a real upstream reroute; only passthrough can.


## Audit round 1 (devin/swe-2 auditor 01a0cc89-541e-7ca3-9dda-149704c31ce5): FAIL, 1 blocker — folded

Blocker: src/server/request-log.ts is 1999 lines and untracked by the ratchet (THRESHOLD 2000 in
scripts/file-size-ratchet.ts:4); any net addition fails NEW_OVERSIZED.

Fold: extract the served-model write out of `applyResponseLogMetadata` into
`recordObservedServedModel(target, value)` in src/usage/log.ts, beside `sanitizeServedModel` and
`modelIdentityLogFields`, which already own served-model identity. The five-line block becomes one
call, which pays for the `responseModelEcho` field and its comment. request-log.ts must end ≤ 1999
lines (checked in C with `wc -l` and the file-size ratchet test).

