# Cursor Fast pricing correction

## Objective

Price Cursor Claude Opus Fast usage at Cursor's published Fast rates for Opus 4.8, 5 and 5.5.

## Scope

- Modify `src/usage/expected-prices.ts` to recognize explicit Cursor Claude `-fast` IDs and register Cursor Fast multipliers for base model selections.
- Modify `src/usage/cost.ts` to apply the explicit-ID rate after user overlays have won and before the final expected-price result is returned.
- Add focused usage tests covering explicit fast IDs, persisted `tierOutcome` from `computeEntryCost`, standard turns, and user overlay precedence.
- Do not modify request logging: `src/adapters/cursor.ts:138-148` creates a `cursor-variant` tier outcome, `src/server/request-log.ts:767-790` stores it, and `src/usage/summary.ts:270-292` consumes it.

## Rates

Cursor's official model pages ([Opus 4.8](https://cursor.com/docs/models/claude-opus-4-8),
[Opus 5](https://cursor.com/docs/models/claude-opus-5), [Opus 5.5](https://cursor.com/docs/models/claude-opus-5-5)) publish:

- Opus 4.8: standard 5/25/0.5/6.25; Fast 10/50/1/12.5.
- Opus 5: standard 5/25/0.5/6.25; Fast 10/50/1/12.5.
- Opus 5.5: standard 4/20/0.2/5; Fast 8/40/0.4/10.

Opus 4.7 Fast is excluded because Anthropic says Fast requests error for that model.

## Acceptance

- Explicit Cursor Claude `-fast` IDs resolve to an official Fast tuple through the cost resolver.
- A persisted Cursor `tierOutcome` with `canonical:"priority", wireKind:"cursor-variant", wireValue:"fast", fastOutcome:"applied"` doubles the base rate for the three supported models.
- Standard and user configured prices remain correct.
- Focused usage tests and typecheck pass.
