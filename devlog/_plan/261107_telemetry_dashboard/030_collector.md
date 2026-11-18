# 030 — Telemetry collector (Cloudflare Worker + D1)

Stack layer 4. Imports the wire contract `src/telemetry/contract.ts` from 010 directly.

## Layout (dependency-free)

| File | Role |
| --- | --- |
| `services/telemetry-collector/wrangler.toml` | Worker name, route `telemetry.opencodex.me/*`, D1 binding `DB` with placeholder id `00000000-0000-0000-0000-000000000000`, cron trigger for pruning. Real ids are set by a maintainer at deploy time. |
| `services/telemetry-collector/schema.sql` | D1 tables (below). |
| `services/telemetry-collector/tsconfig.json` | Extends root settings with `rootDir: "../.."`, `noEmit: true`, `declaration: false` (as in `scripts/test-layout/tsconfig.verify.json`) so importing `../../src/telemetry/contract.ts` does not hit TS6059. |
| `services/telemetry-collector/src/types.ts` | Minimal local `D1Database`/`D1PreparedStatement`/`ExecutionContext` interfaces, `CollectorEnv`, `TelemetryStatsV1`. |
| `services/telemetry-collector/src/ingest.ts` | `POST /v1/events`. |
| `services/telemetry-collector/src/stats.ts` | `GET /v1/stats?range=7d|30d|90d|365d`. |
| `services/telemetry-collector/src/prune.ts` | Scheduled pruning. |
| `services/telemetry-collector/src/index.ts` | `fetch`/`scheduled` handlers, CORS, 404/405. |
| `services/telemetry-collector/README.md` | Deploy: `bunx wrangler d1 create`, `d1 execute --file schema.sql`, secrets (`RATE_LIMIT_SALT`), `wrangler deploy`. |

No root `package.json`/`bun.lock` change. The root typecheck only covers `src/`; this layer adds a
test that typechecks the collector project with the repository's own TypeScript toolchain (command
chosen and proven in B, since `node_modules/.bin/tsc` is absent and `bun check` is the root checker).

## Storage

- `daily_installs(day, install_day_hash, version, release_channel, os, arch, install_channel,
  new_install, active_minutes, PRIMARY KEY(day, install_day_hash))` — pruned after 400 days.
- `daily_totals(day, reports, new_installs, active_minutes, completed, failed, incomplete, aborted,
  input, cache_read, cache_write, output, reasoning)`.
- `daily_models(day, provider_kind, model_family, installs, requests, input, cache_read, cache_write, output,
  reasoning)` (`installs` defaults to 0 for migration safety).
- `daily_errors(day, cause, installs, count)` (`installs` defaults to 0 for migration safety).
- `rate_limits(bucket_hour, ip_hash, hits)` — pruned after 2 h.

**Dedup:** ingest executes conditional rollup statements (`WHERE NOT EXISTS (SELECT 1 FROM daily_installs WHERE day = ? AND install_day_hash = ?)`) followed by `INSERT OR IGNORE INTO daily_installs` as the final statement of a single atomic D1 `batch`. A re-sent day — new `batchId` or not — changes nothing, and a failed batch rolls back completely so retries succeed. Raw install ids and IPs are never stored; `RATE_LIMIT_SALT` is mandatory (503 when missing) and `ip_hash = sha256(RATE_LIMIT_SALT + "\0" + hour + "\0" + ip)`.

## Validation and limits

`validateTelemetryPayloadV1` from the contract (closed keys at every level, closed rosters for
provider kind, model family, channels, os, arch, failure causes; calendar-checked `day` in
[today − 7, today + 1]; strict version regex ≤ 32 chars; bounded per-row and per-report integers clamped to `Number.MAX_SAFE_INTEGER`; ≤ 64 model rows). Streaming body ≤ 16 KiB (413), JSON only (400), atomic 120 reports/hour per IP hash (429 with `Retry-After`), 503 if `RATE_LIMIT_SALT` is unset. Any roster or contract change must be deployed to the collector before a client release emits it.

## Stats API (`TelemetryStatsV1`, consumed by 050)

```ts
type TelemetryStatsV1 = {
  schemaVersion: 1; generatedAt: string; range: "7d" | "30d" | "90d" | "365d";
  totals: { activeInstalls: number; avgDailyActiveInstalls: number; newInstalls: number; activeMinutes: number; requests: number;
            tokens: { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number } };
  daily: Array<{ day: string; activeInstalls: number; newInstalls: number; activeMinutes: number;
                 requests: number; failed: number; tokens: number }>;
  dailyByProvider: Array<{ day: string; providerKind: string; requests: number; tokens: number }>;
  heatmap: Array<{ day: string; activeInstalls: number }>;   // always the last 365 days
  providers: Array<{ providerKind: string; requests: number; tokens: number }>;
  models: Array<{ modelFamily: string; requests: number; tokens: number }>;
  versions: Array<{ version: string; installs: number; newInstalls: number }>;
  platforms: Array<{ os: string; arch: string; installs: number }>;
  channels: Array<{ installChannel: string; installs: number; newInstalls: number }>;
  outcomes: { completed: number; failed: number; incomplete: number; aborted: number };
  errors: Array<{ cause: string; count: number }>;
};
```

Served with `Cache-Control: public, max-age=300` and CORS for `https://opencodex.me` and
`http://localhost:4321`.

## Verification

- `tests/usage/usage-telemetry-collector-worker.test.ts`: `bun:sqlite` in-memory D1 shim loading
  `schema.sql` via `repoPath`; ingest accepts a payload built by the 010 builder, rejects unknown keys
  and roster values, dedups re-sent days, rate-limits with 429, sets CORS, returns every stats field
  for each range with a full 365-day heatmap, never stores a raw id or IP; pruning.
- `tests/usage/usage-telemetry-collector-typecheck.test.ts`: the collector project typechecks.
- Registered in `scripts/test-layout/layout-usage.json` and `tests/fixtures/test-layout-expected.json`;
  add `ci:full` if the import graph misses them.
- `bun run typecheck`, `bun run privacy:scan` (placeholder ids only), file-size and layout guards.

