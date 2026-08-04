# WP3 verification and closeout

## Verification matrix

| Layer | Check | Expected evidence |
|---|---|---|
| Canonicalizer | focused reverse-map table test | every known base/wire/alias maps to the documented base; unknown unchanged |
| Summary model rows | focused `usage-summary` test | one Flash and one Pro row; exact request/token/status/cost sums |
| Daily grid | focused `usage-summary` test | no historical/wire IDs in `days[].models` |
| API | `api-usage` test | canonical model output and no divergent Antigravity `resolvedModel` |
| Regression | `bun run typecheck` | pass |
| Regression | `bun run test` | pass |
| Privacy | `bun run privacy:scan` | pass |
| GUI static | `bun run lint:gui` | pass if GUI changes |
| GUI build | `bun run build:gui` | pass if GUI changes |

## Live checks after rebuilding/restarting the local service

1. Capture pre/post totals from `GET /api/usage?range=30d`; summary/provider requests and tokens must be unchanged.
2. Filter `models` to `provider == "google-antigravity"`.
3. Expect the sampled historical Flash IDs to combine into `gemini-3.6-flash` with 216 requests (87 + 65 + 62 + 2), and sampled Pro IDs to combine into `gemini-3.1-pro` with 53 requests (30 + 13 + 10). Identity Claude/Opus/GPT rows remain separate. Recompute against the live file if new requests arrive.
4. Assert no known wire/historical ID remains in API `models` or `days[].models`.
5. Open Providers -> Google Antigravity -> Usage in the browser. Confirm canonical names, one row per picker base, correct expansion behavior, unchanged provider totals, and no console duplicate-key warning.
6. Exercise one base-model call with explicit effort; verify the request still uses the expected CCA wire ID while the subsequent Usage row remains under the base name.

## Risks and non-goals

- Risk: canonicalizing only `buildModels` leaves daily charts fragmented.
- Risk: changing aggregation keys without cost lookup keys drops displayed cost.
- Risk: retaining the first historical `resolvedModel` makes display order-dependent.
- Risk: stale daemon or stale `gui/dist` can make source/tests green while live UI remains old.
- Non-goal: rewriting `usage.jsonl`, changing CCA wire routing, removing compatibility aliases, changing pricing, or canonicalizing unrelated providers.

