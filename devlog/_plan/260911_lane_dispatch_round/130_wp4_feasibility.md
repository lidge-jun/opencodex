# wp4 — seven-lane feasibility audit

Seven read-only `xai/grok-4.6` subagents, one per lane, dispatched in one round with fresh context.
Each was asked a single question: can this lane's stack be implemented entirely inside its owned
paths, and if not, which exact path is missing? Four came back `fits`, three came back `gaps`.

Three of seven lanes would have started, hit an unowned file, and stopped. That is the cost this
phase removed.

## Verdicts

| Lane | Verdict | Substance |
|---|---|---|
| L1 | fits | #4172 lands at `opencode-go-transport.ts:32` with every fanout call site owned; #4176 at `responses-undeclared-tool-guard.ts:324` and `types/tools.ts:69`. |
| L2 | gaps | The quota half fits `quota.ts:2909`, but seeding `glm-5.3-flash` at `registry.ts:2651` fails `tests/providers/provider-registry-parity.test.ts:464` and `:508`, which lock the roster and assert Flash is absent. |
| L3 | gaps | #4126 fits `warmup.ts:31` and `:290`. #4212 was pointed at the wrong surface. #4211 was pointed at the wrong function. |
| L4 | gaps | #4202, #4169, and #4207 fit. #4204 cannot bind the clamp to the Desktop runtime from `effort.ts` alone. |
| L5 | gaps | #4197 fits `integrations/config-io.ts:259`. #4214 needs the export-client contract, which L5 does not own. |
| L6 | fits | #4191 at `codex-ws-exchange.ts:214`; #4190 by wrapping the `emit` callback inside `adapters/qoder/adapter.ts:58-67`. |
| L7 | fits | #4215 at `guides/providers.md:70`; #4200 at `guides/remote-hub.md:77`. |

## Dispositions

**L2 — #4201.** Grant `tests/providers/provider-registry-parity.test.ts`. A lane that changes a
registry roster owns the oracle that asserts the roster; otherwise the change cannot land at all.

**L3 — #4212.** The packet granted `oauth-account-routes.ts`, which is the wrong route: it serves the
generic `/api/oauth/accounts`, and `oauth/index.ts:331` excludes ChatGPT from it. Codex pool accounts
are served by `poolAccountDto` in `src/codex/auth-api.ts:377` under `/api/codex-auth/accounts`, so
that file is granted instead. The reporter's 503 is inlined at `responses/core.ts:2336` and
`compact.ts:383`, which L1 owns, and the model-list drop is published from `catalog/sync.ts:1777`.
**Decision: #4212 is narrowed to per-account refresh-failure attribution on the Codex account
surface.** The 503 wording and the catalog-drop attribution are recorded as follow-ups, and the pull
request says `Refs #4212` rather than `Closes`.

**L3 — #4211.** Auto-selection filters in `getEligiblePoolAccounts` at `codex/routing.ts:1248`, not in
`isCodexAccountUsable`, which is why pause does not appear in the latter either. Grant
`src/codex/routing.ts` and `src/types/config.ts`, since the field needs a type next to
`pausedCodexAccountIds` and the schema alone does not provide one. **Decision: the filter applies to
automatic selection only; explicit namespace selection at `auth-context.ts:922` keeps working,** which
is what the issue asks for.

**L4 — #4204. Removed from the round.** Binding the clamp to the Desktop runtime requires
`codex/runtime.ts:573`, `catalog/bundled.ts:239`, and `catalog/sync.ts:1945`: the catalog probes one
selected runtime and no caller passes a consumer identity. Deciding that a catalog should be resolved
per consumer is a design decision, which is exactly what this round's decision-free filter excludes.
L4's stack becomes #4202 → #4169 → #4207.

**L5 — #4214.** `IntegrationClientId` is an alias of `ExportClientId` from
`clients/config-export/contracts.ts:84`, and the writer needs `EXPORT_CLIENTS` from
`clients/config-export.ts:1112`. Grant both. The dashboard tab additionally needs a locale key, which
this round forbids. **Decision: ship the CLI and registry path; the dashboard tab is a follow-up, and
the pull request says `Refs #4214`.** Note that open draft #3833 also edits the export-client surface;
L5 reports the overlap rather than merging the two lines of work.

## What this does not change

No lane gained a path another lane owns. `src/clients/` (plural) is unrelated to L4's `src/client/`
(singular). The four `fits` lanes are untouched.

