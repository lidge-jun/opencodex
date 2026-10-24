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
- Provider reports: `heldProviderQuotaReports`, the reports the Home last published. They become
  the provider's `pooled` windows; an aggregated Codex pool report is `estimated`, an in-band
  observed report is `header`, any other report is `measured`.
- Per-account OAuth quota (Anthropic instances, Kiro, Antigravity, xAI, Cursor, Kimi, Command Code,
  Devin, DSH, Meta): the last-good per-account cache. A current `QuotaFailureCode` becomes
  `failure`.
- Claude CLI: `peekClaudeUsageObservation` in `src/adapters/claude-cli/usage-admission.ts`, which
  reads the admission snapshot from memory or its file without resolving the sign-in. A parsed CLI
  limit refusal is a `custom` window `refusal` with `exhausted: true` and source `estimated`.

`tests/server/quota-pool-relay.test.ts` reads the route on the Home, over the link relay and over
the hub relay against a pool account with an expired token, and fails on any fetch, process spawn or
file write inside the read and on any change to the Home's files.

## Window mapping

Kinds come from the fields the existing parsers stored (`parseUpstreamQuotaHeaders`,
`parseUsageQuota`): the Codex short window is `burst_5h` up to 6 hours (`daily` up to 36 hours,
`custom` beyond) and carries `windowSeconds` only when upstream stated it; provider `fiveHour*` is
`burst_5h`; weekly and monthly map by name; Kiro plan credits and USD credits are `credits` windows
with `unit`. A window an upstream proved to be model-scoped (`scope: "model"`) carries
`scopeModel` and never makes the whole account `exhausted`; an exact-model diagnostic row without
that proof is dropped, because unscoped it would gate every model. `rejected` evidence becomes
`exhausted: true`.

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
