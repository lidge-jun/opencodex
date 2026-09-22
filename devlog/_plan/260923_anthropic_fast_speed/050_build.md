# 050 Build and verification (wp1)

## What landed

- `src/providers/fastwire.ts`: `anthropic-speed` is available on the `anthropic` adapter; an observation with `upstreamDeclinedFast` reports `response-declined` instead of `wire-unavailable`.
- `src/providers/anthropic-fast.ts` (new): the beta constant, narrow refusal recognition, and a case-insensitive `anthropic-beta` merge.
- `src/adapters/anthropic.ts`: a `set` decision on the declared wire sends `speed: "fast"` with the beta; the adapter owns `tierLog`; `usage.speed` is observed in `message_start`, `message_delta` and buffered bodies.
- `src/providers/registry/entries-core.ts`: `anthropic` and `anthropic-apikey` declare the wire and classify `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`.
- `src/server/responses/adapter-dispatch.ts` + `core-opaque-recovery.ts`: one budget-reserved standard resend on a recognized fast refusal, before every 429 arm.
- Recovery kind `anthropic-fast-downgrade` (cause `parameter-rejected`, metrics class `fast_downgrade`, log label in ten locales); 2x confirmation-gated pricing rules; docs and structure owners.

## Live smoke (real OAuth token, repository adapter, 2026-09-23)

| Leg | Sent | Result | Tier outcome |
|---|---|---|---|
| claude-opus-5-5, registry-eligible, set | `speed: fast` + beta | 429 "Usage credits are required for fast mode.", recognized as a fast refusal | applied / assumed at send |
| same request after downgrade | no speed, no fast beta | 200 "OK" | downgraded / response-declined |
| claude-opus-4-6 with an operator capability override, set | `speed: fast` + beta | 200 "OK", `usage.speed: "standard"` | downgraded / response-declined (live echo) |

## Checks

- `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`, `bun run lint:gui`, `bun run skill:surface:check`, `git diff --check`: pass on the rebased head.
- New tests: `tests/adapters/anthropic/anthropic-fast-speed.test.ts`, `tests/responses/responses-anthropic-fast-downgrade.test.ts`, `tests/usage/usage-anthropic-fast-pricing.test.ts` (30 pass).
- Flipped/extended pins: `tests/routing/fastwire-policy.test.ts` (registry roster, anthropic eligibility), `tests/codex-integration/fast-row.test.ts`, `tests/server/management-metrics-export.test.ts`.
- Directory runs: see the PR Verification section.

## Delegation

gpt-6-sol leaves: Helmholtz (Aside docs research), Nash (code map, reflection), Kant (independent audit, three rounds), Avicenna (log label + locales), Heisenberg (pricing), Nietzsche (docs), Cicero (new tests).

## Rendered request-log label

An isolated in-process proxy (throwaway OPENCODEX_HOME, local fake Anthropic upstream answering the fast send with the credits 429) served one request end to end: the fast send was refused, the standard resend answered, and the request detail shows the new recovery label. Capture: `evidence/logs-fast-downgrade.png`.
