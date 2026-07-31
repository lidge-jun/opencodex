# 142.10 — Kiro contextUsagePercentage as source of truth

## Problem

The current Kiro adapter ignores Kiro's terminal `contextUsagePercentage` frames and reports only
a current-turn heuristic input delta. That prevents the old full-history nesting regression, but it
also makes Codex's context-window UI collapse to near-zero after short second+ turns because Codex
uses `last_token_usage.total_tokens` as the active context size when a model context window is known.

Kiro Gateway already treats `contextUsagePercentage` as the authoritative context signal:
`total_tokens = (contextUsagePercentage / 100) * max_input_tokens`.

## Plan

1. Extend `/Users/jun/Developer/new/700_projects/opencodex/src/adapters/kiro-events.ts`
   to parse terminal `{"usage": ...}` and `{"contextUsagePercentage": ...}` JSON frames.
2. Extend `/Users/jun/Developer/new/700_projects/opencodex/src/adapters/kiro.ts`
   so `parseKiroStream` stores the latest context percentage and, when a fixed model window is known,
   emits `done.usage.totalTokens` from that Kiro-derived absolute context total.
3. Keep fallback behavior unchanged for `kiro-auto` and streams without context percentage:
   current-turn input heuristic plus output estimate. `kiro-auto` must not inherit provider-level
   `contextWindow`, because Kiro Auto is a router with no fixed source-of-truth window.
4. Extend `/Users/jun/Developer/new/700_projects/opencodex/src/types.ts` and
   `/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts` with optional
   `OcxUsage.totalTokens`, preserving the existing `input + output` default for all other adapters.
5. Update Kiro stream tests to prove:
   - parser preserves `contextUsagePercentage`;
   - known-window Kiro models use percentage-derived `totalTokens`;
   - `kiro-auto` falls back to the existing heuristic even when provider-level `contextWindow` exists;
   - previous "current-turn only" regressions still avoid full-history input recounting.

## Constraint

Codex currently derives both `last_token_usage` and additive `total_token_usage` from the same
Responses `usage` object. opencodex can make the Kiro-provided absolute context visible in
`last_token_usage.total_tokens`, which fixes context-window display and auto-compact decisions, but
opencodex cannot independently tell Codex "use absolute for last and delta for accumulated total"
without a Codex-side protocol change.

## Verification

- `bun test tests/kiro-stream.test.ts`
- `bun test tests/kiro-adapter.test.ts tests/kiro-stream.test.ts tests/bridge.test.ts`
- `bun x tsc --noEmit`
