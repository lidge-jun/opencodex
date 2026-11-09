# Telemetry

Anonymous, default-on daily usage telemetry owned by `src/telemetry/`, `src/types/telemetry.ts`,
`src/server/management/telemetry-routes.ts`, and `src/cli/telemetry.ts`.

## Wire contract and vocabularies

`src/telemetry/contract.ts` is an import-free module defining `TELEMETRY_SCHEMA_VERSION = 1`,
the closed rosters (`PROVIDER_KINDS`, `MODEL_FAMILIES`, `INSTALL_CHANNELS`, `RELEASE_CHANNELS`,
`OS_VALUES`, `ARCH_VALUES`, `REQUEST_OUTCOME_CLASSES`, `REQUEST_FAILURE_CAUSES`), and
`validateTelemetryPayloadV1`. Every level of the payload rejects unknown keys, non-roster strings,
out-of-window or non-calendar `day` values, versions not matching
`^\d+\.\d+\.\d+(-preview\.\d{8}(\.\d+)?)?$` (no build metadata), and more than 64 model rows.
Any roster or wire-contract addition must be deployed to the collector before a client release
emits the new values (collector-first rollout).

## Consent and agent boundary

`src/types/telemetry.ts` defines `OcxTelemetryConfig` (`decision`, `decidedAt`, `noticeShownAt`),
validated in `src/config/schema/leaf-validators.ts`, `src/config/schema/config-schema.ts`,
`src/config/diagnostics.ts`, `src/config/load-degrade.ts`, and adopted into live server state
via `adoptPersistedTelemetry` in `src/config/live-reconcile.ts`.

`src/telemetry/consent.ts` (`resolveTelemetryStatus`) evaluates precedence in order:
`OCX_TELEMETRY` (`0`, `false`, `off`, `no`), `DO_NOT_TRACK` (`1`, `true`, `yes`),
`decision === "declined"`, `decision === "accepted"`, undecided with `noticeShownAt`
(`default-on`), and undecided without notice (`awaiting-notice`). It reads only the config's
`telemetry` block: a whole config is never treated as a block, so a top-level `noticeShownAt` or
`decision` (which `ocx config set` can write) is not consent.

Only a human can transition an undecided install to active sending:

- `PUT /api/telemetry` in `src/telemetry/routes.ts` (delegated
  from `src/server/management/telemetry-routes.ts` and lazily mounted in `src/server/management-api.ts`)
  requires `hasHumanDashboardSession` from `src/server/management/consent-session.ts`.
  `GET /api/telemetry` previews the oldest eligible unsent day (or the latest completed day with
  `previewEligible: false` when no day is eligible). It reads consent from `config.json` on disk,
  like the scheduler, and reuses a day's aggregate for `TELEMETRY_PREVIEW_CACHE_MS` because the
  dashboard polls it.
- `ocx telemetry enable` in `src/cli/telemetry.ts` requires an interactive human terminal
  (`isatty` stdin and stdout, not `OCX_SERVICE`, not agent-driven), prints the disclosure block,
  and asks for confirmation before recording `accepted`; otherwise it exits non-zero with
  `agent_consent_required` or `tty_required`. `ocx telemetry disable` is always permitted.
  `ocx config set`/`unset` in `src/cli/config-command.ts` refuse `telemetry`, and `ocx config import`
  preserves the persisted `telemetry` block unchanged for every caller.
- Interactive prompts run from `src/cli/star-prompt.ts`, `src/service/cli.ts`, and
  `src/cli/init.ts`; agent-driven, non-TTY, or service starts print a once-per-version notice
  and record neither `noticeShownAt` nor `decision`.
- `src/telemetry/disclosure.ts` is the one source for the disclosure text: the CLI prompt prints
  it and the Windows installer dialog is generated from it (`structure/desktop-shell.md`,
  "Windows installer telemetry choice").
- A decision made before `config.json` exists (`ocx telemetry disable`, the dashboard popup on a
  fresh install, the Windows installer opt-out) is held as `pendingDecision` in
  `telemetry-state.json` instead of creating the config, so `ocx init` still runs setup.
  `withPendingTelemetryDecision` applies it wherever consent is resolved (scheduler, status route,
  CLI prompt) until a decision is written into the config, which clears it.
- The dashboard popup (`gui/src/components/telemetry-consent-card.tsx`) opens only for an undecided
  install with no env override, after the star onboarding has closed, and never on a Remote Link
  Child. Only Continue writes (`PUT /api/telemetry`); Escape and the backdrop record nothing.
  Focus is moved to the heading after `showModal()` (which would otherwise focus the first
  focusable element), so a stray Enter cannot accept. A saved decision whose reply cannot be parsed
  is re-read with `GET`, and if that also fails the save still counts (`gui/src/telemetry-api.ts`).
  A session restored from a remembered device is refused (`agent_consent_required`), and the popup
  says how to choose instead. On a Remote Link Child the Proxy details row only says telemetry is
  managed on the Home: `/api/telemetry` is not a link-readable path.
- Telemetry consent in `config.json` is owned by the file: `carryPersistedTelemetry`
  (`src/config/telemetry-carry.ts`) makes both whole-config saves (`saveConfig` and
  `saveConfigPreservingClaudeCode`) write the validated on-disk block instead of the caller's
  snapshot, so a decision written by another process is never dropped or rolled back, and a
  malformed hand edit is dropped as a load would drop it. Without a readable `config.json` a save
  never introduces a decision: before the file exists the decision is held in
  `telemetry-state.json`, where another process may have replaced it, and a file that cannot be read
  may hold a decline the snapshot never saw. Only a snapshot decline survives; any other block is
  dropped, and the held decision or the notice applies. The same rule covers
  `initializePersistedConfigIfMissing`, which creates `config.json` from the running config, and the
  consent route never copies a decision it only held as pending into the running config.

## Identity, aggregation, and scheduling

`src/telemetry/install-id.ts` manages `<OPENCODEX_HOME>/telemetry-id.json` (`0o600`, exclusive
no-follow creation) on the first send and deletes it when telemetry is declined or when an
`OCX_TELEMETRY`/`DO_NOT_TRACK` environment opt-out is observed. Only
`sha256(installId + ":" + day)` leaves the machine.

`src/telemetry/aggregate.ts` scans `usage.jsonl` through `src/usage/ledger-scanner.ts` for one
completed UTC day, accumulating counters directly inside `onEntry` without retaining ledger rows in
memory, mapping providers to `PROVIDER_KINDS`, models to `MODEL_FAMILIES`, outcomes via
`src/usage/request-outcome.ts`, and decomposing usage into five disjoint token buckets
(`inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, `reasoningTokens`) whose sum
matches `usageDisplayTotalTokens` in `src/usage/totals.ts`.

`src/telemetry/payload.ts` resolves the install channel and validates the built payload with
`validateTelemetryPayloadV1`. `src/telemetry/sender.ts` posts to the constant collector URL
with a 10-second `signalWithTimeout` and parses `Retry-After` on HTTP 429/503 responses.
`src/telemetry/scheduler.ts` runs an unref'd background timer with startup and interval jitter
started from `src/server/background-lifecycle.ts`. Whenever an `OCX_TELEMETRY` or `DO_NOT_TRACK`
opt-out is observed (at startup in `src/server/background-lifecycle.ts` or on a tick),
`recordTelemetryEnvOptOut` persists `ineligibleThroughDay` (today's UTC day) and the
`envOptOutActiveSince` marker in `telemetry-state.json` and deletes `telemetry-id.json`; a proxy
started under the opt-out records its pid in `envOptOutOwners` instead. Such a proxy reads the env
once and runs no ticks, so the marker or owner stands for the whole period: while either is set no
day is eligible. `endTelemetryEnvOptOut` closes the period (ineligible through the closing day) on
that proxy's clean stop, which always covers its stop day, or on the first tick without the opt-out,
which ends it only once no recorded owner pid is still alive and otherwise extends it to today. A
`telemetry-state.json` that exists but cannot be read (symlink, oversized, malformed, or with an
opt-out field or held decision that is present but invalid) stops sending
(`state-unreadable`) rather than being read as empty: the tick checks it before choosing a day and
again just before sending, the bookkeeping writes after a send or a `Retry-After` leave such a file
alone, other writers (including every recorded decision, so sending does not stay paused) rebuild
it as ineligible through the UTC day six hours from now, and the status snapshot reports
`stateUnreadable`. A rebuild forgets `envOptOutOwners`, so an opted-out proxy records itself again
every 6 hours (`TELEMETRY_ENV_OPT_OUT_REFRESH_MS`), within that window. A held decline whose
timestamp is damaged still applies. The state code lives in
`src/telemetry/state.ts`, which `background-lifecycle.ts` imports statically; the scheduler, its
aggregation and sender stay behind the dynamic import. Each tick sends at most one completed UTC
day strictly after the UTC day of `decidedAt ?? noticeShownAt` and strictly after
`ineligibleThroughDay`, honors `retryAfterUntil` backoffs, re-reads persisted consent and env
immediately before transmission, and carries an `AbortSignal` cancelled on stop or consent changes.
