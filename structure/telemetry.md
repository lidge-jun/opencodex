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
(`default-on`), and undecided without notice (`awaiting-notice`). It reads only the config's
`telemetry` block: a whole config is never treated as a block, so a top-level `noticeShownAt` or
`decision` (which `ocx config set` can write) is not consent.

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
  when no day is eligible to be sent. It reads consent from `config.json` on disk, like the scheduler,
  and reuses a day's aggregate for `TELEMETRY_PREVIEW_CACHE_MS` because the dashboard polls it.
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
aggregation and sender stay behind the dynamic import. Each tick carries an `AbortSignal`
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
atomic conditional D1 batch, rate-limits `POST /v1/events` to 120 reports/hour per salted hourly hash
of the client key (`HTTP 429` with `Retry-After`; a bucket is deleted by the hourly prune at most 2 hours
15 minutes after its hour begins) without storing raw IP addresses, and serves cached aggregate rollups
from `GET /v1/stats`. The client key comes only from `cf-connecting-ip`: IPv4 per address,
IPv4-mapped IPv6 as that IPv4 address, and any other IPv6 address collapsed to its /64 prefix;
`x-forwarded-for` is ignored and a request without `cf-connecting-ip` shares one fixed bucket. In
`TelemetryStatsV1`, `totals.activeInstalls` and breakdown `installs` counters represent install-days
(sum of daily reporting installs), and `totals.avgDailyActiveInstalls` reports
`install-days / days in range` (rounded to 1 decimal). Every breakdown (`providers`, `models`, `versions`,
`platforms`, `channels`, `errors`, `dailyByProvider`) publishes a value only for `(day, key)` pairs reported by
at least 10 distinct installs on that day, applied before days are summed into the range, so one install
cannot pass it alone by reporting on many days or through many provider/model-family rows. The distinct
counts come from `daily_installs`, `daily_errors.installs`, `daily_provider_installs`, and
`daily_family_installs`. Single-valued dimensions (version, platform, install channel) fold a day's
sub-threshold rows into that day's `"other"`, published only if it reaches 10; multi-valued dimensions
(providers, model families, error causes) drop sub-threshold rows. `totals`, `daily`, and `heatmap` stay
unfiltered, so suppressed values can still be approximated by subtraction.
Reports are unauthenticated and self-reported by opencodex installs.

`docs-site/src/content/docs/guides/telemetry.md` documents the payload schema, consent and agent boundaries, opt-out controls, payload preview, and collector retention.
## Public profiles (opt-in leaderboard)

Owned by `src/telemetry/profile/`, `src/cli/telemetry-profile.ts`, the profile modules of
`services/telemetry-collector/` (`profiles.ts`, `leaderboard.ts`, `profile-http.ts`), `gui/src/components/telemetry-profile-card.tsx`
with `gui/src/telemetry-profile-api.ts`, and `docs-site/src/components/TelemetryLeaderboard.astro` with
`docs-site/src/components/telemetry-dashboard/leaderboard.ts`. Design: `devlog/_plan/261109_telemetry_personal_rank/`.

- **Contract.** `src/telemetry/profile/contract.ts` imports only the anonymous contract's rosters. A profile day is
  `{schemaVersion, day, requests, tokens{5 buckets}, families[{family, requests, tokens}]}` with exact keys, consistent
  sums, closed `MODEL_FAMILIES`, a completed UTC day at most 7 days old and daily caps. The collector validates with the
  same functions, so changes need a collector-first rollout.
- **Separate consent.** Connecting is its own decision, never implied by the telemetry decision or notice:
  `POST /api/telemetry/profile` requires `hasHumanDashboardSession` and `acknowledgePublic: true`;
  `ocx telemetry profile connect` refuses `isAgentDriven()` (`agent_consent_required`) and non-TTY or `OCX_SERVICE`
  (`tty_required`) and asks `[y/N]`. Connecting requires anonymous telemetry to be effective; it never writes
  `config.json`, `telemetry-state.json` or `telemetry-id.json`. Disconnecting (`DELETE /api/telemetry/profile`,
  `ocx telemetry profile disconnect`) is always permitted and never touches the telemetry decision.
- **No linkage.** No file under `src/telemetry/profile/` imports `install-id`, `payload` or `sender` or names the install
  id, install-day hash or batch id (`tests/usage/usage-telemetry-profile-sync.test.ts` scans for it). Profile calls go
  to `/v1/profiles*` with a bearer secret on their own timer.
- **State.** `<OPENCODEX_HOME>/telemetry-profile.json` (atomic no-follow write, `0600`, recorded for uninstall) holds the
  handle, display name, avatar, secret, connect day, sent days and `pendingDelete`/`revoked`. An unreadable file
  sends nothing. No API response, CLI output or GUI view carries the secret (`toPublicProfileState`).
- **Sync.** `src/telemetry/profile/sync.ts` sends at most one day per tick, chosen by
  `resolveNextEligibleTelemetryDay` with the profile's own sent days and the connect day folded into
  `ineligibleThroughDay`, so every anonymous eligibility rule applies plus no day on or before the connect day.
  The floor is the later of the client's connect day and the collector's `createdDay`; a day the collector refuses
  with a 4xx other than 401/429 is set aside (`refused` in `sentDays`) so the oldest-first order never stalls.
  Every write after a network call goes through `updateTelemetryProfileState`, which re-reads the file and skips the
  write if the secret changed, the file is gone or a disconnect is pending. A disconnect of an unreadable file
  removes it locally (`local_removed`). Sending requires anonymous telemetry to be effective.
  `src/server/background-lifecycle.ts` starts the loop only
  when the profile file exists, independently of the env opt-out gate, so a pending deletion is retried while
  telemetry is off; `GET /api/telemetry/profile` starts it after a CLI connect. A `401` marks the profile revoked.
- **Collector.** Profile endpoints, limits, ranking (`RANK()` among non-hidden profiles with a positive total; `rank:
  null` outside that set; `of` is the set size), `x-robots-tag: noindex`, no preflight for bearer routes, and pruning are
  described in `services/telemetry-collector/README.md`.
- **Surfaces.** The Home card shows while telemetry is effective or a profile exists, hides when the route is refused
  (Remote Link Child), and renders user strings as text. The docs-site leaderboard validates a handle before
  building any request and writes names with `textContent` only (`tests/ci-workflows/docs-telemetry-leaderboard.test.ts`).
