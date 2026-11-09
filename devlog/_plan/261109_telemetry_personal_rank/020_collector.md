# 020 — Collector: profiles and leaderboard (wp3)

Extends `services/telemetry-collector/`; the anonymous ingest/stats code and its tables are untouched.

## MODIFY `schema.sql` (append)

```sql
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,                    -- random UUID, never shown
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,       -- sha256(secret) hex
  created_day TEXT NOT NULL,
  last_submit_day TEXT,
  hidden INTEGER NOT NULL DEFAULT 0       -- maintainer moderation flag (wrangler d1 execute)
);
CREATE TABLE IF NOT EXISTS profile_days (
  profile_id TEXT NOT NULL, day TEXT NOT NULL,
  requests INTEGER NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL, tokens INTEGER NOT NULL,
  PRIMARY KEY (profile_id, day)
);
CREATE INDEX IF NOT EXISTS profile_days_day ON profile_days (day);
CREATE TABLE IF NOT EXISTS profile_day_families (
  profile_id TEXT NOT NULL, day TEXT NOT NULL, family TEXT NOT NULL,
  requests INTEGER NOT NULL, tokens INTEGER NOT NULL,
  PRIMARY KEY (profile_id, day, family)
);
CREATE TABLE IF NOT EXISTS profile_rate_limits (
  bucket_hour TEXT NOT NULL, scope TEXT NOT NULL, key_hash TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_hour, scope, key_hash)
);
```

## NEW `src/profiles.ts` (write paths) and `src/leaderboard.ts` (read paths)

| Method | Path | Auth | Limit (per hour) | Behaviour |
| --- | --- | --- | --- | --- |
| POST | `/v1/profiles` | none | 5 per client key (`create`) | `validateProfileCreateV1`; body ≤ 2 KiB; 409 `handle taken` (unique constraint); 201 `{ ok, profile: {handle, displayName, avatar, createdDay}, secret }`. Secret = `ocxp_` + base64url(32 random bytes); only its hash is stored. |
| POST | `/v1/profiles/me/days` | bearer | 48 per profile (`submit`) | `validateProfileDayV1`; `day > created_day` (no backfill, 400); first write wins per (profile, day), the same pattern as ingest (`ingest.ts` dedup): one atomic `batch` of `INSERT INTO profile_day_families … SELECT … WHERE NOT EXISTS (SELECT 1 FROM profile_days WHERE profile_id = ?1 AND day = ?2)` rows, then `INSERT OR IGNORE INTO profile_days …` last; `deduplicated = meta.changes === 0` of the last statement; `UPDATE profiles SET last_submit_day = max(…)`. |
| GET | `/v1/profiles/me` | bearer | 120 per profile (`me`) | `{ ok, profile, hidden, periods: {day,week,month: {rank, of, tokens, requests}}, families: [{family, tokens, requests}] }` (families over month). Rank contract below. |
| DELETE | `/v1/profiles/me` | bearer | 10 per client key (`delete`) | Deletes families, days, then the profile in one batch → `{ ok, deleted: true }`; unknown secret → 401. |
| GET | `/v1/leaderboard?period=day|week|month&metric=tokens|requests&limit=1..100` | none | 600 per client key (`read`) | Rank contract below; `{ schemaVersion: 1, period, metric, from, to, generatedAt, total, entries: [{rank, handle, displayName, avatar, tokens, requests}] }`. Amended in wp7: no in-process cache (a hide applies on the next read), `cache-control: public, max-age=60`. |
| GET | `/v1/profiles/by-handle/<handle>` | none | shares `read` | Exactly `{ ok, profile: {handle, displayName, avatar}, periods, families }`; never `created_day`, `last_submit_day`, `hidden` or ids; 404 for unknown or hidden. |

**Rank contract.** Ranked set for (period, metric) = non-hidden profiles whose metric sum over the window is > 0.
`rank` = SQL `RANK() OVER (ORDER BY metric DESC)` (ties share a rank, the next rank skips); display order within a
tie is `handle ASC`. `of` = size of the ranked set. A profile outside the ranked set (no positive metric, or hidden)
gets `rank: null` and `of` unchanged (`0` when nobody is ranked). The GUI, docs-site and CLI all read these
fields and never compute ranks themselves.

**No indexing.** Every profile and leaderboard response carries `x-robots-tag: noindex`; the docs-site
personal-rank view is client-rendered from a query parameter, so no per-profile page exists for crawlers.

Bearer parsing: `authorization: Bearer <secret>`, `PROFILE_SECRET_RE`, else 401 without touching D1.
Period window: anchor = latest completed UTC day; `from = anchor − (days − 1)`.
Rate limits reuse `rateLimitClientKey` but never the anonymous ingest hash value: client keys are hashed as
`computeHourlyIpHash(salt, "profile:" + scope + "\0" + clientKey, hour)` and stored only in `profile_rate_limits`, so no
stored value equals an `ip_hash` in `rate_limits` and the two tables cannot be joined; profile-scoped limits hash
the profile id with the same salt. 429 with `Retry-After` like ingest. Missing `RATE_LIMIT_SALT` → 503.

## MODIFY `src/index.ts`

Route the paths above (405 with `allow` for wrong methods, preflight for GETs only; CORS stays
`opencodex.me` + localhost; write endpoints are called by the proxy, not by browsers, so no
`authorization` in `access-control-allow-headers`).

## MODIFY `src/prune.ts`

Also delete: `profile_rate_limits` older than 2 h; `profile_days`/`profile_day_families` older than 400 days;
profiles that never submitted and were created more than 14 days ago (handle squatting) together with nothing else;
profiles whose `last_submit_day` is older than 400 days with their rows.

## Abuse controls (summary)

Reserved handles, display-name charset with no links, closed avatar palette, create limit per client key,
per-profile submit limit, per-day plausibility caps and consistency checks, first-write-wins per day, no backfill,
squatting prune, maintainer `hidden` flag honoured by every public read. Documented in the collector README with
the `wrangler d1 execute` command for hiding a profile.

## Tests (failing first)

NEW `tests/usage/usage-telemetry-profile-collector.test.ts` using `createInMemoryD1`: create/duplicate/reserved/
invalid; secret format and only hash stored; submit validation, no backfill, dedup, caps; me/periods/ranks/ties;
hidden excluded from leaderboard and by-handle; delete removes every row; rate limits per scope with Retry-After;
prune rules; leaderboard rows contain only the allowed keys. Extend the collector typecheck test's file list if it
enumerates files.


## Stale check (wp3 P, 2026-11-09)

- `readBoundedBody` in `ingest.ts` is private and its error text names 16 KiB; profiles get their own small bounded
  reader (2 KiB create, 8 KiB day) instead of editing the stack-owned ingest module.
- Caching: an isolate cache keyed by canonical query (5 min) plus `cache-control: public, max-age=300` on public reads;
  the Workers edge-cache API is left out (the stack lane is changing its error handling in `stats.ts`).
  Bearer responses are `no-store`.
- Handle uniqueness uses `INSERT OR IGNORE` + `meta.changes` (no reliance on constraint exceptions, which differ
  between `bun:sqlite` and D1).
- Write endpoints get no CORS preflight (OPTIONS → 405), so a browser page cannot send the bearer header cross-origin.
- `tests/usage/usage-telemetry-collector-worker.test.ts` dumps a fixed list of anonymous tables; the new profile test
  dumps the profile tables the same way and checks they never contain an IP, a raw secret or an anonymous identifier.
