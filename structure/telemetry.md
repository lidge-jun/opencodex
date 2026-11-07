# Telemetry

Anonymous, default-on daily usage telemetry owned by `src/telemetry/`, `src/types/telemetry.ts`,
`src/server/management/telemetry-routes.ts`, and `src/cli/telemetry.ts`.

## Wire contract and vocabularies

`src/telemetry/contract.ts` is an import-free module defining `TELEMETRY_SCHEMA_VERSION = 1`,
the closed rosters (`PROVIDER_KINDS`, `MODEL_FAMILIES`, `INSTALL_CHANNELS`, `RELEASE_CHANNELS`,
`OS_VALUES`, `ARCH_VALUES`, `REQUEST_OUTCOME_CLASSES`, `REQUEST_FAILURE_CAUSES`), and
`validateTelemetryPayloadV1`. Every level of the payload rejects unknown keys, non-roster strings,
out-of-window or non-calendar `day` values, semver build metadata, and more than 64 model rows.

## Consent and agent boundary

`src/types/telemetry.ts` defines `OcxTelemetryConfig` (`decision`, `decidedAt`, `noticeShownAt`),
validated in `src/config/schema/leaf-validators.ts`, `src/config/schema/config-schema.ts`,
`src/config/diagnostics.ts`, `src/config/load-degrade.ts`, and adopted into live server state
via `adoptPersistedTelemetry` in `src/config/live-reconcile.ts`.

`src/telemetry/consent.ts` (`resolveTelemetryStatus`) evaluates precedence in order:
`OCX_TELEMETRY` (`0`, `false`, `off`, `no`), `DO_NOT_TRACK` (`1`, `true`, `yes`),
`decision === "declined"`, `decision === "accepted"`, undecided with `noticeShownAt`
(`default-on`), and undecided without notice (`awaiting-notice`).

Only a human can transition an undecided install to active sending:

- `PUT /api/telemetry` and `POST /api/telemetry/notice` in `src/telemetry/routes.ts` (delegated
  from `src/server/management/telemetry-routes.ts` and lazily mounted in `src/server/management-api.ts`)
  require `hasHumanDashboardSession` from `src/server/management/consent-session.ts`.
- `ocx telemetry enable` in `src/cli/telemetry.ts` and `ocx config set telemetry` in
  `src/cli/config-command.ts` refuse agent-driven callers; `ocx telemetry disable` is always
  permitted.
- Interactive prompts run from `src/cli/star-prompt.ts`, `src/service/cli.ts`, and
  `src/cli/init.ts`; agent-driven, non-TTY, or service starts print a once-per-version notice
  and record neither `noticeShownAt` nor `decision`.

## Identity, aggregation, and scheduling

`src/telemetry/install-id.ts` manages `<OPENCODEX_HOME>/telemetry-id.json` (`0o600`, exclusive
no-follow creation) on the first send and deletes it when telemetry is declined. Only
`sha256(installId + ":" + day)` leaves the machine.

`src/telemetry/aggregate.ts` scans `usage.jsonl` through `src/usage/ledger-scanner.ts` for one
completed UTC day, mapping providers to `PROVIDER_KINDS`, models to `MODEL_FAMILIES`, outcomes
via `src/usage/request-outcome.ts`, and decomposing usage into five disjoint token buckets
(`inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, `reasoningTokens`) whose
sum matches `usageDisplayTotalTokens` in `src/usage/totals.ts`.

`src/telemetry/payload.ts` resolves the install channel and validates the built payload with
`validateTelemetryPayloadV1`. `src/telemetry/sender.ts` posts to the constant collector URL
with a 10-second `signalWithTimeout`. `src/telemetry/scheduler.ts` runs an unref'd background
timer started lazily from `src/server/background-lifecycle.ts`, re-reading config from disk on
each tick and sending at most one completed post-consent day per tick.
