# Quota Pool Producer

`GET /api/quota-pool` serves the GOAT contract `ocx.quota-pool/1`: one provider-neutral view of
every account quota this Home already holds. GOAT owns the decoder
(`packages/contracts/src/quotaPool.ts` in goat-si/goat); OpenCodex is the producer, and
`tests/helpers/quota-pool-schema.ts` mirrors the contract strictly (strict objects, no `null`).

## Surfaces

- Home: `GET /api/quota-pool` on the management API, under the same management authorization as
  the neighbouring reads (`src/server/management/quota-pool-routes.ts`, loaded on demand by
  `src/server/management-api.ts`). Only GET is routed. Any query, including `refresh=1`, is ignored:
  the read has no active form.
- Remote Link Child: `/api/quota-pool` is in `LINK_MANAGEMENT_READ_PATHS`, so the Child's dashboard
  reaches it at `/api/machine/hub-relay/api/quota-pool`; the Home serves it through
  `/v1/link-management` with the link key. The shared refresh-key rule still refuses a link read
  that carries `refresh`, `reload`, `force` or `quota`.
- Hub client: the hub relay forwards `/api/machine/hub-relay/api/*` to the hub's management API
  with the caller's management credential, so the same path reaches the hub's read.

## Passive by construction

`readQuotaPool` (`src/quota-pool/assemble.ts`) runs the whole assembly inside `runPassiveRead`, for
every caller, and reads only caches other paths filled:

- Codex pool accounts: the passive `listCodexAuthAccountsSnapshot` (stored `StoredAccountQuota` per
  account and the cached main-account reading), with no WHAM probe, token refresh or native-main
  claim. Each account's window `source` is `header` when its newest quota-history sample came from
  response headers and `measured` otherwise (`latestCodexQuotaObservationSource`, a read that never
  prunes or clears history).
- Per-account OAuth quota (Anthropic instances, Kiro, Antigravity, xAI, Cursor, Kimi, Command Code,
  Devin, DSH, Meta): the last-good per-account cache. A current `QuotaFailureCode` becomes
  `failure`.
- Claude CLI: `peekClaudeUsageObservation` in `src/adapters/claude-cli/usage-admission.ts`, which
  reads the admission snapshot from memory or its file without resolving the sign-in. A parsed CLI
  limit refusal is a `custom` window `refusal` with `exhausted: true` and source `estimated`.
- Provider reports: `heldProviderQuotaReports`, the reports the Home last published. They are the
  `pooled` windows only where account rows do not serve the configured provider: a provider with
  no account rows (an API-key provider's credits, for example) or a per-account provider configured
  with an API key (see [Pooled windows](#pooled-windows)). An in-band observed report is `header`,
  any other report is `measured`.

`tests/server/quota-pool-relay.test.ts` reads the route on the Home, over the link relay and over
the hub relay against a pool account with an expired token and an empty provider-report cache. It
fails on any fetch, process spawn or file write inside the read, on any change to the Home's files,
and unless the Codex `pooled` windows are still computed from the account rows.

## Pooled windows

A provider whose requests are served by account rows (the Codex pool, Claude CLI, and a
per-account OAuth provider configured with `authMode: "oauth"`) gets its `pooled` windows from
those rows in `src/quota-pool/pooled.ts`, a pure function over the mapped account windows. The
pool therefore does not depend on an active `/api/provider-quotas` read or the reset poller having
warmed the report cache, and a held report never stands in for the rows it was computed from. A
per-account provider configured with an API key still lists any stored OAuth rows, but its pool is
the key's held report, the same split the quota dispatcher makes.

Per window id, over the accounts automatic routing may pick, the pooled `usedPercent` is
Σ(weight × usedPercent) / Σ(weight). Codex weights are the plan calibration in
`src/providers/codex-capacity.ts` (`codexCapacityWeight`), the same configured-weight estimate
`aggregateCodexPoolCapacity` gives the dashboard. Per-account OAuth providers have no calibrated
plan table, so each routable account counts once. Excluded from the pool: paused and reauth
accounts, and Codex accounts with a `selectionExcludedReason` (plan-excluded, or a duplicate of the
main login). A reading older than `CODEX_CAPACITY_MAX_QUOTA_AGE_MS` (30 minutes), a window whose
reset has passed, and a window an account has no reading for never contribute, so unknown is never
averaged in as 0%; when nothing contributes, the window is absent. Credits windows pool by percent
only (`used` and `limit` are not summed).

Every pooled window is `estimated`. Its `observedAt` is the oldest contributing observation, its
`resetsAt` the earliest contributing reset, and `windowSeconds` and `unit` appear only when every
contributor agrees. Its `exhausted` speaks for that window alone: true when every eligible account
has that window exhausted.

Whether the pool can run at all is a separate `custom` window, present only while it cannot:
`availability` ("Pool availability") when every eligible account holds an unscoped exhausted
window, and `availability:<scope>` (with that `scopeModel`) when every eligible account is blocked
for one model scope, by the scoped window or an unscoped one, and neither `availability` nor the
scoped window itself already says so. It carries `exhausted: true` and no percentage; its
`resetsAt` is the earliest moment some account recovers (an account recovers when the last of its
blocking windows resets; omitted when no recovery time is known) and its `observedAt` the oldest
blocking observation. So two accounts blocked on different windows, or a Claude CLI refusal with no
usage reading, make the pool unavailable until the first block lifts, without stamping that timing
on the percentage windows. An eligible account with no fresh evidence is not known to be blocked and
keeps the pool open, because routing would still try it. GOAT's placement reads `exhausted: true`
as 100% used. Priority tiers, pins, affinity and credits policy are not reflected in the estimate.

## Window mapping

Kinds come from the fields the existing parsers stored (`parseUpstreamQuotaHeaders`,
`parseUsageQuota`): the Codex short window is `burst_5h` up to 6 hours (`daily` up to 36 hours,
`custom` beyond) and carries `windowSeconds` only when upstream stated it; provider `fiveHour*` is
`burst_5h`; weekly and monthly map by name; Kiro plan credits and USD credits are `credits` windows
with `unit`. A window an upstream proved to be model-scoped (`scope: "model"`) carries
`scopeModel: "family:<name>"` (lowercase, `family:opus`), the form GOAT's placement matches against
every versioned model of that Claude family, and never makes the whole account `exhausted`; an
exact-model diagnostic row without that proof is dropped, because unscoped it would gate every
model. `rejected` evidence becomes `exhausted: true`.

Absent is unknown: a window with no reading is omitted, never reported as 0%, and a window whose
reset has passed is omitted too. Optional fields are left out instead of set to `null`. Account
`state` is `reauth`, then `paused`, then `exhausted` (any unscoped exhausted window), then
`unknown` (no windows), else `available`. `pooled.nextResetAt` is the earliest unscoped reset among
the pooled windows.

## Identity

`src/quota-pool/identity.ts` keeps `<OPENCODEX_HOME>/quota-pool-identity.json` (owner-only):
`homeId` (`home_` + 32 hex, the Home's stable instance id, not a hostname) and a 256-bit secret.
The server creates it in `acquireServerBackgroundLifecycle` before it serves; the read only reads it
and answers 503 `quota_pool_identity_unavailable` instead of creating it. Creation is exclusive and
never follows a link: the secret is written and flushed to a private temp file and hard-linked into
place (an in-place exclusive create where hard links are unavailable), so two servers starting on
one fresh home adopt the same identity. A loser that finds a file at the path, including one that
appears between its own absence check and existence check, re-reads it for up to 500 ms and adopts
it once it is valid; an empty or partial file is never returned or memoized. A symlink, or a file
that stays malformed past that bound, is refused and left untouched rather than overwritten.

`homeId` is also the Home instance id other peers see: `GET /healthz` publishes it as `instanceId`
and `GET /v1/models` names it in `x-opencodex-served-by` (`src/remote/served-by.ts`, see
[Runtime](runtime.md)). It is random and carries nothing derivable from the machine; the secret is
never published.

`accountRef` is `acct_` + base64url of the first 128 bits of HMAC-SHA256(secret,
`ocx.quota-pool/1` NUL provider NUL accountId). It is stable across restarts, distinct per provider,
and never contains an email, a raw account id or a token; without the secret a recipient cannot
confirm a guessed identity against it. Deleting the file rotates `homeId` and every reference
together when the proxy next starts; a running proxy keeps the identity it already read (and keeps
publishing that `homeId` as its instance id). `label` is the account's existing log label (`main`, `p<hex6>`, `o<hex6>`), never an
email or alias. `producer.role` is `runtimeRole` (`standalone` when unset) and `producer.version`
is the package version. `driver` and `pooled.headroom` are not produced yet.
