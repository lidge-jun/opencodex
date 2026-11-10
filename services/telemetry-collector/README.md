# OpenCodex Telemetry Collector

Cloudflare Worker + D1 service backing `https://telemetry.opencodex.me`.

Deployment is a maintainer step. Nothing in local development or CI deploys this Worker or mutates Cloudflare resources.

## Endpoints

- `POST /v1/events` — validates `TelemetryPayloadV1` from `src/telemetry/contract.ts`, enforces a 16 KiB streaming body cap and per-report aggregate ceilings, requires `RATE_LIMIT_SALT` (returns HTTP `503` if unset), atomically rate-limits to 120 reports/hour per salted hourly hash of the client key (sized for shared-IP / CGNAT capacity; returns HTTP `429` with `Retry-After`), and deduplicates on `(day, install_day_hash)` while rolling up daily totals, model/provider buckets (with contributing report count `installs`), per-day distinct install counts for each provider and each model family (`daily_provider_installs`, `daily_family_installs`), and error counts (with contributing report count `installs`) atomically in a single conditional D1 batch. Reports are unauthenticated and self-reported; rate limits and per-report bounds limit, but do not prevent, forged submissions.
- `GET /v1/stats?range=7d|30d|90d|365d` — queries D1 in a single batch and returns `TelemetryStatsV1` cached by canonical range for 300 seconds (`caches.default` plus an in-isolate TTL cache) with `Cache-Control: public, max-age=300` and CORS for `https://opencodex.me` and `http://localhost:4321`. `totals.activeInstalls` and breakdown `installs` represent install-days (sum of daily reporting installs across the range), and `totals.avgDailyActiveInstalls` is `activeInstalls / rangeDays` rounded to 1 decimal.
- Scheduled cron (`15 * * * *`) — prunes `daily_installs` older than 400 days and every `rate_limits` hourly bucket whose hour began at least 2 hours before the run. The bucket for hour H is deleted by the H+2:15 run, so a salted hash is kept for at most 2 hours 15 minutes after the earliest hit it counts (longer only if a scheduled run is missed).

## Opt-in public profiles (leaderboard)

Separate tables (`profiles`, `profile_days`, `profile_day_families`, `profile_rate_limits`) that never join the
anonymous ones: no install hash, version or platform is stored, and rate-limit keys are hashed as
`profile:<scope>\0<key>` so no value equals an anonymous `ip_hash`. The wire contract is
`src/telemetry/profile/contract.ts` (collector-first rollout applies to it too).

- `POST /v1/profiles` — `{schemaVersion, handle, displayName, avatar}` (2 KiB), 5 per client key per hour; returns
  the profile, its `createdDay` (the client never sends that day or earlier) and a one-time secret (`ocxp_` + 32
  random bytes, base64url). Only `sha256(secret)` is stored. A taken handle is `409`.
- `POST /v1/profiles/me/days` (bearer) — one completed UTC day within the last 7, strictly after the creation day,
  with consistent totals and closed model families (8 KiB), 48 per profile per hour. The first submission for a day
  wins (`{deduplicated}`).
- `GET /v1/profiles/me` (bearer) — ranks for day, week and month, month family totals and the `hidden` flag; `no-store`.
- `DELETE /v1/profiles/me` (bearer) — deletes the profile and every row submitted for it in one batch; an unknown
  secret is `401`.
- `GET /v1/leaderboard?period=day|week|month&metric=tokens|requests&limit=1..100` and
  `GET /v1/profiles/by-handle/<handle>` — public, 3000 per client key per hour, `cache-control: public, max-age=60` (no
  in-process cache, so a hidden profile disappears on the next read at the Worker and within 60 seconds in shared caches),
  `x-robots-tag: noindex`. Entries carry only rank, handle, display name, avatar, tokens and requests. Ranking is
  `RANK()` over profiles with a positive total in the window ending on the latest completed UTC day; hidden profiles
  are excluded everywhere.
- Bearer and write routes are never CORS-preflighted, so a browser page cannot send a profile secret cross-origin.
- Pruning: profile rate-limit buckets after 2 hours, day rows after 400 days, profiles that never submitted after 14
  days, and profiles whose last submission is older than 400 days together with their rows.

To hide a profile from every public view (moderation), a maintainer runs:

```bash
bunx wrangler d1 execute opencodex-telemetry --remote --command "UPDATE profiles SET hidden = 1 WHERE handle = '<handle>'"
```

## Small-cohort protection and residual risks

Every breakdown returned by `GET /v1/stats` (`providers`, `models`, `versions`, `platforms`, `channels`, `errors`, and `dailyByProvider`) publishes a value only for `(day, key)` pairs reported by at least 10 **distinct installs on that day**, and applies that threshold before summing days into the range. One install therefore cannot pass it alone, whether it reports on many days of a range or spreads its usage over many provider or model-family rows. The distinct per-day counts come from `daily_installs` (one row per install-day), `daily_errors.installs` (each report adds at most 1 per cause), and `daily_provider_installs` / `daily_family_installs` (each report adds at most 1 per provider and per model family, however many `daily_models` rows it carries).

- Single-valued dimensions (`versions`, `platforms`, `channels`): an install-day has exactly one value, so a day's rows below the threshold fold into that day's `"other"`, which is published only if it reaches 10 on that day.
- Multi-valued dimensions (`providers`, `models`, `errors`, `dailyByProvider`): rows below the threshold are dropped, never folded, because a bucket made of several of them could be one install counted several times. A native `"other"` provider, family, or cause is an ordinary key and needs 10 distinct installs on the day like any other.

Range-wide `totals`, `daily`, `heatmap`, and `outcomes` remain unfiltered.

Residual subtraction risk: the threshold keeps a single install's numbers out of the breakdown rows, but `totals` and `daily` stay unfiltered, so when few rows are suppressed their combined counts can still be approximated by subtracting the published breakdown rows from the published totals.

Residual forged-cohort risk: reports are unauthenticated, so the threshold counts reports, not people. Someone who sends 9 forged reports for a rare provider, model family, version or error cause on the same day as one real install lifts that key to 10 distinct installs, and can then subtract their own known share to recover the real install's figures for that key. The real install stays anonymous (only its per-day hash is stored), and the per-client-key rate limit raises the cost, but no count threshold on unauthenticated input can prevent this.

## Rate-limit key

The hourly rate limit is keyed on a salted hash of the client key, never the raw address. The key comes only from `cf-connecting-ip`, which Cloudflare sets: an IPv4 address is used per address (an IPv4-mapped IPv6 address such as `::ffff:203.0.113.5` counts as that IPv4 address), and an IPv6 address is reduced to its /64 prefix, because one subscriber usually holds a whole /64. `x-forwarded-for` and other client-supplied headers are ignored; a request without a valid `cf-connecting-ip` shares one fixed bucket with every other such request. A subscriber holding a larger IPv6 prefix (for example a /48) still has one bucket per /64.

## Rollout order (collector-first)

The Worker imports `src/telemetry/contract.ts` directly and rejects unknown keys or non-roster values with HTTP `400`. **Any roster or wire-contract change in `src/telemetry/contract.ts` must be deployed to the collector Worker before a client release emits the new values**, so that updated clients are never rejected by an older collector deployment.

## Maintainer deployment steps

Run from `services/telemetry-collector/`:

1. Create the D1 database and update `database_id` in `wrangler.toml` (kept as `00000000-0000-0000-0000-000000000000` in the repository):

```bash
bunx wrangler d1 create opencodex-telemetry
```

2. Apply the schema:

```bash
bunx wrangler d1 execute opencodex-telemetry --remote --file schema.sql
```

For an existing D1 deployment created before `daily_models.installs` and `daily_errors.installs` were added, run the additive column migration (both columns use `DEFAULT 0` so existing rows remain valid):

```bash
bunx wrangler d1 execute opencodex-telemetry --remote --command "ALTER TABLE daily_models ADD COLUMN installs INTEGER NOT NULL DEFAULT 0; ALTER TABLE daily_errors ADD COLUMN installs INTEGER NOT NULL DEFAULT 0;"
```

For an existing D1 deployment created before `daily_provider_installs` and `daily_family_installs` were added, apply `schema.sql` again (every statement is `CREATE TABLE IF NOT EXISTS`). Days ingested before that have no distinct provider or model-family counts, so their provider and model breakdowns stay unpublished.

3. Configure the mandatory rate-limit salt secret (`POST /v1/events` fails closed with `503` when `RATE_LIMIT_SALT` is missing):

```bash
bunx wrangler secret put RATE_LIMIT_SALT
```

4. Deploy the Worker:

```bash
bunx wrangler deploy
```

Run every step logged in to the Cloudflare account that owns the `opencodex.me` zone: a Custom Domain
attaches only to a zone in the Worker's own account. The deploy creates the `telemetry.opencodex.me`
DNS record and certificate. Then check it:

```bash
curl -s "https://telemetry.opencodex.me/v1/leaderboard?period=day&metric=tokens&limit=1"
```
