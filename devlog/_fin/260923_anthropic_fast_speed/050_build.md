# 050 Build and verification (wp1)

## What landed

- `src/providers/fastwire.ts`: `anthropic-speed` is available on the `anthropic` adapter; an observation with `upstreamDeclinedFast` reports `response-declined` instead of `wire-unavailable`.
- `src/providers/anthropic-fast.ts` (new): the beta constant, narrow refusal recognition, and a case-insensitive `anthropic-beta` merge.
- `src/adapters/anthropic.ts`: a `set` decision on the declared wire sends `speed: "fast"` with the beta; the adapter owns `tierLog`; `usage.speed` is observed in `message_start`, `message_delta` and buffered bodies.
- `src/providers/registry/entries-core.ts`: `anthropic` and `anthropic-apikey` declare the wire and classify `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`.
- `src/server/responses/adapter-dispatch.ts` + `core-opaque-recovery.ts`: one budget-reserved standard resend on a recognized fast refusal, before every 429 arm. The physical resend charges the root workflow once; the request permit is not charged twice.
- Recovery kind `anthropic-fast-downgrade` (cause `parameter-rejected`, metrics class `fast_downgrade`, log label in ten locales); 2x confirmation-gated pricing rules; docs and structure owners.

## Live smoke (real OAuth token, repository adapter, 2026-09-23)

| Leg | Sent | Result | Tier outcome |
|---|---|---|---|
| claude-opus-5-5, registry-eligible, set | `speed: fast` + beta | 429 "Usage credits are required for fast mode.", recognized as a fast refusal | applied / assumed at send |
| same request after downgrade | no speed, no fast beta | 200 "OK" | downgraded / response-declined |
| claude-opus-4-6 with an operator capability override, set | `speed: fast` + beta | 200 "OK", `usage.speed: "standard"` | downgraded / response-declined (live echo) |

## Checks

- Original implementation (prior head `5e4cb7ea77`): the earlier PR Verification section recorded `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`, `bun run lint:gui`, `bun run skill:surface:check`, `git diff --check`, focused tests, and directory runs. Those results do not certify the repair head.
- Repair checkout based on `ea0fab74a3ddb7b485452faa24a2d15b1036080b`: `bun install --frozen-lockfile` passed (104 packages); `bun test tests/responses/responses-anthropic-fast-downgrade.test.ts` passed (8 pass, 0 fail); `bun run typecheck` passed; `git diff --check` passed. Earlier focused-test runs during the repair failed on an assertion against the wrong public error string and then on a test-injected spend-home owner leak; both test defects were corrected before the final pass.
- The repair was deliberately limited to the focused test and typecheck. The full suite, docs build, privacy scan, structure check, and other original focused tests were not rerun on this repair head. Hosted exact-head CI remains required before landing; cancelled test shards on the prior head are missing evidence, not a pass.

## Delegation

gpt-6-sol leaves: Helmholtz (Aside docs research), Nash (code map, reflection), Kant (independent audit, three rounds), Avicenna (log label + locales), Heisenberg (pricing), Nietzsche (docs), Cicero (new tests).

## Rendered request-log label

An isolated in-process proxy (throwaway OPENCODEX_HOME, local fake Anthropic upstream answering the fast send with the credits 429) served one request end to end: the fast send was refused, the standard resend answered, and the request detail shows the new recovery label. Capture: `evidence/logs-fast-downgrade.png`.
