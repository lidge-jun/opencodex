# OpenCodex Telemetry Collector

Cloudflare Worker + D1 service backing `https://telemetry.opencodex.me`.

Deployment is a maintainer step. Nothing in local development or CI deploys this Worker or mutates Cloudflare resources.

## Endpoints

- `POST /v1/events` — validates `TelemetryPayloadV1` from `src/telemetry/contract.ts`, enforces a 16 KiB streaming body cap and per-report aggregate ceilings, requires `RATE_LIMIT_SALT` (returns HTTP `503` if unset), atomically rate-limits to 120 reports/hour per salted hourly IP hash (sized for shared-IP / CGNAT capacity; returns HTTP `429` with `Retry-After`), and deduplicates on `(day, install_day_hash)` while rolling up daily totals, model/provider buckets (with contributing report count `installs`), and error counts (with contributing report count `installs`) atomically in a single conditional D1 batch. Reports are unauthenticated and self-reported; rate limits and per-report bounds limit, but do not prevent, forged submissions.
- `GET /v1/stats?range=7d|30d|90d|365d` — queries D1 in a single batch and returns `TelemetryStatsV1` cached by canonical range for 300 seconds (`caches.default` plus an in-isolate TTL cache) with `Cache-Control: public, max-age=300` and CORS for `https://opencodex.me` and `http://localhost:4321`. `totals.activeInstalls` and breakdown `installs` represent install-days (sum of daily reporting installs across the range), and `totals.avgDailyActiveInstalls` is `activeInstalls / rangeDays` rounded to 1 decimal.
- Scheduled cron (`15 * * * *`) — prunes `daily_installs` older than 400 days and `rate_limits` buckets older than 2 hours.

## Small-cohort protection and residual risks

Every breakdown returned by `GET /v1/stats` (`providers`, `models`, `versions`, `platforms`, `channels`, `errors`, and `dailyByProvider` per day) folds rows with fewer than 10 install-days in the selected range (or on that day for `dailyByProvider`) into `"other"`, and drops `"other"` if `"other"` itself has fewer than 10 install-days. Range-wide `totals`, `daily`, `heatmap`, and `outcomes` remain unfiltered.

Residual subtraction risk: folding small cohorts into `"other"` (and dropping `"other"` below 10 install-days) prevents direct display of small cohorts in breakdown tables, but when only a single small cohort is suppressed while `totals` and `daily` remain unfiltered, its counts can still be approximated by subtracting the published breakdown rows from the published totals.

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

3. Configure the mandatory rate-limit salt secret (`POST /v1/events` fails closed with `503` when `RATE_LIMIT_SALT` is missing):

```bash
bunx wrangler secret put RATE_LIMIT_SALT
```

4. Deploy the Worker:

```bash
bunx wrangler deploy
```
