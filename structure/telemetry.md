# Telemetry

Anonymous, default-on daily usage telemetry owned by `src/telemetry/`, `src/types/telemetry.ts`,
`src/server/management/telemetry-routes.ts`, `src/cli/telemetry.ts`, and
`services/telemetry-collector/`, with public user documentation in `docs-site/src/content/docs/guides/telemetry.md`.

## Wire contract and vocabularies

`src/telemetry/contract.ts` is an import-free module defining `TELEMETRY_SCHEMA_VERSION = 1`,
the closed rosters (`PROVIDER_KINDS`, `MODEL_FAMILIES`, `INSTALL_CHANNELS`, `RELEASE_CHANNELS`,
`OS_VALUES`, `ARCH_VALUES`, `REQUEST_OUTCOME_CLASSES`, `REQUEST_FAILURE_CAUSES`), and
`validateTelemetryPayloadV1`. Every level of the payload rejects unknown keys, non-roster strings,
out-of-window or non-calendar `day` values, versions not matching
`^\d+\.\d+\.\d+(-preview\.\d{8}(\.\d+)?)?$` (including any semver build metadata), and more than
64 model rows. Because both the proxy and the collector validate against `src/telemetry/contract.ts`,
any closed-roster or wire-contract change requires a **collector-first** rollout (deploying the
collector before a client release emits the new value).

## Consent and agent boundary

`src/types/telemetry.ts` defines `OcxTelemetryConfig` (`decision`, `decidedAt`, `noticeShownAt`),
validated in `src/config/schema/leaf-validators.ts`, `src/config/schema/config-schema.ts`,
`src/config/diagnostics.ts`, `src/config/load-degrade.ts`, and adopted into live server state
via `adoptPersistedTelemetry` in `src/config/live-reconcile.ts`.

`src/telemetry/consent.ts` (`resolveTelemetryStatus`) evaluates precedence in order:
`OCX_TELEMETRY` (`0`, `false`, `off`, `no`), `DO_NOT_TRACK` (`1`, `true`, `yes`),
`decision === "declined"`, `decision === "accepted"`, undecided with `noticeShownAt`
(`default-on`), and undecided without notice (`awaiting-notice`).

Casual-path consent guards require human interaction before transitioning an undecided install to active sending:

- `PUT /api/telemetry` in `src/telemetry/routes.ts` (delegated from
  `src/server/management/telemetry-routes.ts` and lazily mounted in `src/server/management-api.ts`)
  requires `hasHumanDashboardSession` from `src/server/management/consent-session.ts` and records
  `decision`, `decidedAt`, and `noticeShownAt`. There is no separate notice-only endpoint; dismissing
  the GUI consent dialog via Escape, the backdrop, or close records nothing and leaves the install
  undecided for the next app start.
- `GET /api/telemetry` (`buildTelemetryStatusSnapshot` in `src/telemetry/routes.ts`) builds `preview`
  for the same completed UTC day the scheduler would send next (oldest eligible unsent day, with
  `previewEligible: true`), or previews the latest completed UTC day with `previewEligible: false`
  when no day is eligible to be sent.
- `ocx telemetry enable` in `src/cli/telemetry.ts` requires an interactive human terminal (`isatty`
  on both stdin and stdout, not `OCX_SERVICE`, and not `isAgentDriven()`), prints the full
  disclosure block, asks a `[Y/n]` confirmation prompt (default yes), and records `accepted`;
  otherwise it exits non-zero with `agent_consent_required` or `tty_required` pointing to the
  dashboard. `ocx telemetry disable` is always permitted. If `mutatePersistedConfig` returns
  `unavailable` or throws during `enable` or `disable`, the CLI exits non-zero with an actionable
  error, prints no success line, and does not delete `telemetry-id.json` unless the decline
  persisted.
- `ocx config set telemetry` and `ocx config unset telemetry` in `src/cli/config-command.ts` refuse
  all callers, and `ocx config import` ignores incoming `telemetry` keys for every caller and
  preserves the persisted `telemetry` block unchanged.
- Interactive prompts run from `src/cli/star-prompt.ts`, `src/service/cli.ts`, and `src/cli/init.ts`,
  printing the disclosure block (what is sent, what is never sent, public aggregates at
  `opencodex.me/dashboard`, `ocx telemetry status --json`, and opt-out controls) before the `[Y/n]`
  prompt; agent-driven, non-TTY, or service starts print a once-per-version notice and record
  neither `noticeShownAt` nor `decision`.

## Identity, aggregation, and scheduling

`src/telemetry/install-id.ts` manages `<OPENCODEX_HOME>/telemetry-id.json` (`0o600`, exclusive
no-follow creation) on the first send and deletes it when telemetry is declined or when an
`OCX_TELEMETRY` / `DO_NOT_TRACK` opt-out is observed. Only `sha256(installId + ":" + day)` leaves
the machine.

`src/telemetry/aggregate.ts` scans `usage.jsonl` through `src/usage/ledger-scanner.ts` for one
completed UTC day, accumulating counters inside the streaming `onEntry` callback for the target day
only without retaining ledger rows in memory, mapping providers to `PROVIDER_KINDS`, models to
`MODEL_FAMILIES`, outcomes
via `src/usage/request-outcome.ts`, and decomposing usage into five disjoint token buckets
(`inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, `reasoningTokens`) whose
sum matches `usageDisplayTotalTokens` in `src/usage/totals.ts`.

`src/telemetry/payload.ts` resolves the install channel and validates the built payload with
`validateTelemetryPayloadV1`. `src/telemetry/sender.ts` posts to the constant collector URL
with a 10-second `signalWithTimeout`. `src/telemetry/scheduler.ts` runs an unref'd background
timer started lazily from `src/server/background-lifecycle.ts` with startup and periodic jitter.
Whenever `OCX_TELEMETRY` or `DO_NOT_TRACK` opt-out is observed (at startup in
`src/server/background-lifecycle.ts` even though the scheduler is not started, and on every tick),
`ineligibleThroughDay` (today's UTC day) and the `envOptOutActiveSince` marker are persisted in
`<OPENCODEX_HOME>/telemetry-state.json` (atomic no-follow write) and `telemetry-id.json` is deleted.
A proxy started under the opt-out reads the env once and runs no ticks, so the marker stands for the
whole period it ran: while it is set no day is eligible, and `endTelemetryEnvOptOut` closes the
period (ineligible through the closing day, marker cleared) on that proxy's clean stop or on the
first tick that runs without the opt-out. Each tick carries an `AbortSignal`
cancelled by shutdown or consent changes (`nudgeTelemetryScheduler`), sends at most one completed
UTC day strictly after the consent/disclosure UTC day (`day > formatUtcDay(decidedAt ?? noticeShownAt)`)
and strictly after `ineligibleThroughDay` (`day > ineligibleThroughDay`), re-reads persisted consent
and environment variables immediately before transmission, and honors HTTP `429` / `503`
`Retry-After` responses by persisting `retryAfterUntil` in `telemetry-state.json` and skipping ticks
until then.

## Collector and public documentation

`services/telemetry-collector/` is the Cloudflare Worker + D1 service (`services/telemetry-collector/src/index.ts`,
`services/telemetry-collector/src/ingest.ts`, `services/telemetry-collector/src/stats.ts`,
`services/telemetry-collector/src/prune.ts`, and `services/telemetry-collector/schema.sql`) that imports
`src/telemetry/contract.ts` directly, deduplicates reports on `(day, install_day_hash)` in a single
atomic conditional D1 batch, rate-limits `POST /v1/events` to 120 reports/hour per salted hourly IP
hash (`HTTP 429` with `Retry-After`, pruned after 2 hours) without storing raw IP addresses, and
serves cached aggregate rollups from `GET /v1/stats`. In `TelemetryStatsV1`, `totals.activeInstalls`
and breakdown `installs` counters represent install-days (sum of daily reporting installs),
`totals.avgDailyActiveInstalls` reports `install-days / days in range` (rounded to 1 decimal), and
every breakdown (`providers`, `models`, `versions`, `platforms`, `channels`, `errors`, and
`dailyByProvider` per day) folds rows with fewer than 10 install-days in the selected range into
`"other"` (dropping `"other"` if below 10, while keeping `totals`, `daily`, and `heatmap` unchanged).
Reports are unauthenticated and self-reported by opencodex installs.

`docs-site/src/content/docs/guides/telemetry.md` documents the payload schema, consent and agent boundaries, opt-out controls, payload preview, and collector retention.
