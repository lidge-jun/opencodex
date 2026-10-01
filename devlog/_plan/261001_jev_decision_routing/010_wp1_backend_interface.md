# 010 wp1: decision backend seam and System One backend

Revalidate against the tree at the start of wp1; line numbers below are from `80efc0e373`.

## Files

### MODIFY `src/combos/jev.ts`

- Export `type JevDecisionBackend = "typesafe" | "systemone" | "model"`.
- `JevDecision` gains `backend: JevDecisionBackend`.
- Extract the shared envelope into exported helpers (stay in this file to keep imports flat):
  - `jevDecisionTimeoutMs(value?: number): number` — bounds check now inline in `resolveJevDecision`.
  - `jevDecisionPreflight(options): { failed?: gate; state?: Record<string, unknown> }` — empty candidates → `no_choices`; `candidatesFitRequestBounds` → `invalid`; `buildJevState` + `hasJevDecisionState` → `no_state`.
  - `jevRouteChoiceKeys(candidates): string[]` exporting the allowlist (wrapper over `candidateOptions`), and `jevRouteOption(candidates, key)` returning `{targetKey, effort}`.
- Rename the System One transport body to `resolveJevSystemOneDecision(options, endpoint)`; behavior identical. Byte-for-byte TypeSafe request (`model`, `state`, `questions`) keeps the existing body-equality test green.
- `resolveJevDecision(options)` becomes the dispatcher: `options.decisionModel` → model backend (wp2; until then not reachable), else System One. Every returned decision carries `backend`: `decisionProvider` absent or `jev` → `typesafe`, otherwise `systemone`.
- `ResolveJevDecisionOptions` gains `decisionModel?: string` and `invokeModel?: JevModelInvoke` (type declared in wp2's module; in wp1 declare the type here and re-export).

### MODIFY `src/usage/jev-stats.ts`

- `PersistedJevDecisionV1.backend?: JevDecisionBackend`.
- `normalizePersistedJevDecision`: copy `backend` only when it is one of the three values; anything else is dropped without rejecting the row.
- `JevStatsResponse` gains `backends: Array<{ backend: JevDecisionBackend | "unknown"; decisions: number; applied: number; averageLatencyMs: number | null }>` (fixed order typesafe, systemone, model, unknown; zero rows omitted).
- `StreamingJevStatsAccumulator`: per-backend counters in `add`, deep copy in `clone`, projection in `summarize`.

### MODIFY `src/server/responses/core-combo.ts` (JEV block ~517-575)

- Persist `backend: decision.backend` in `logCtx.jevDecision` and in the debug line. Exception path: backend derived via exported `jevDecisionBackendFor(combo)`.

### MODIFY `src/combos/index.ts`

- Re-export the new helpers/types.

### NEW `src/server/management/decision-discovery.ts` (from #6185, pure)

- `DECISION_MODEL_HINT`, `isDecisionModelCandidate(row, query)`, `systemOneEndpoint(baseUrl)`, `uniqueDiscoveryCandidates(rows, query)` carried as written in #6185 `5ffb4c1ba9`.

## Tests

- MODIFY `tests/routing/jev-decision.test.ts`: assert `backend` on apply and fail-open decisions for TypeSafe and a self-hosted row; add #6275's custom endpoint regression adapted to row id `custom-decider` over HTTPS (custom URL, model, own bearer, no TypeSafe env key).
- NEW `tests/routing/jev-decision-destination.test.ts` (cases from #6185): `TYPESAFE_API_KEY`/`JEV_API_KEY` set in env never appear in headers sent to a self-hosted row; a self-hosted row whose apiKey references those env names is unusable (`missing_key`, no send); a `jev` row with a foreign baseUrl still posts to TypeSafe.
- NEW `tests/server/decision-discovery.test.ts` (from #6185): hint, query override, endpoint derivation, dedupe.
- MODIFY `tests/usage/jev-stats*.test.ts` (locate): old row without backend parses; invalid backend dropped; backend buckets after clone+add.
- Register new test files in `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`.

## Accept

- `bun test tests/routing/jev-decision.test.ts tests/routing/jev-decision-destination.test.ts tests/routing/jev-decision-provider-combo.test.ts tests/server/server-jev-combo-e2e.test.ts tests/server/decision-discovery.test.ts` + usage jev-stats tests pass.
- TypeSafe body-equality test unchanged and green (activation: TypeSafe env key set, default combo).
- `bun run typecheck` 0.
