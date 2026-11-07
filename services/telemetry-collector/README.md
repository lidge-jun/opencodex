# OpenCodex Telemetry Collector

Cloudflare Worker + D1 service backing `https://telemetry.opencodex.me`.

Deployment is a maintainer step. Nothing in local development or CI deploys this Worker or mutates Cloudflare resources.

## Endpoints

- `POST /v1/events` — validates `TelemetryPayloadV1` from `src/telemetry/contract.ts`, enforces a 16 KiB streaming body cap and per-report aggregate ceilings, requires `RATE_LIMIT_SALT` (returns HTTP `503` if unset), atomically rate-limits to 30 reports/hour per salted hourly IP hash, and deduplicates on `(day, install_day_hash)` while rolling up daily totals, model/provider buckets, and error counts atomically in a single conditional D1 batch.
- `GET /v1/stats?range=7d|30d|90d|365d` — queries D1 in a single batch and returns `TelemetryStatsV1` cached by canonical range for 300 seconds (`caches.default` plus an in-isolate TTL cache) with `Cache-Control: public, max-age=300` and CORS for `https://opencodex.me` and `http://localhost:4321`.
- Scheduled cron (`15 * * * *`) — prunes `daily_installs` older than 400 days and `rate_limits` buckets older than 2 hours.

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

3. Configure the mandatory rate-limit salt secret (`POST /v1/events` fails closed with `503` when `RATE_LIMIT_SALT` is missing):

```bash
bunx wrangler secret put RATE_LIMIT_SALT
```

4. Deploy the Worker:

```bash
bunx wrangler deploy
```
