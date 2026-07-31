# Plan: Request log "Effort" column

Goal ID: 0693b941-5d1

## Objective
Add a single "Effort" column to the opencodex request logs (`/api/logs` + GUI Logs table).
Show the **requested reasoning effort label** (e.g. `xhigh`) as one final value — NOT the
mapped wire value (`max`). All providers, including `kiro`, display the requested label
verbatim (kiro shows `xhigh`, not a budget %).

## Source of truth
- Requested effort lives at `parsed.options.reasoning` (`src/responses/parser.ts:391`),
  one of `none/minimal/low/medium/high/xhigh/max`.
- Wire mapping (`mapReasoningEffort`, `src/reasoning-effort.ts`) is intentionally NOT used here.

## File change map
1. `src/server.ts`
   - `RequestLogContext` (~:100): add `requestedEffort?: string`.
   - `handleResponses` (~:364): set `logCtx.requestedEffort = parsed.options.reasoning`.
   - `RequestLogEntry` (~:710): add `requestedEffort?: string`.
   - `addFinalRequestLog` (~:919): include `requestedEffort` when present.
   - (No filter changes; `/api/logs` serves `requestLog` directly.)
2. `gui/src/pages/Logs.tsx`
   - Add `requestedEffort?: string` to `LogEntry`.
   - Add `<th>{t("logs.col.effort")}</th>` after Model column.
   - Render cell: requested effort label or `-`.
3. `gui/src/i18n/{en,ko,zh}.ts`
   - Add `"logs.col.effort"` key.

## Persistence decision
Effort is an in-memory log field only (like `requestedServiceTier`). Not added to
`PersistedUsageEntry` — usage.jsonl is for token accounting, and effort is not needed there.

## Verification
- `bunx tsc --noEmit` (root + gui)
- `bun test tests/request-log.test.ts`
- Extend request-log test to assert `requestedEffort` passes through `addFinalRequestLog`.
