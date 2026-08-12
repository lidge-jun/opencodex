# CL-04 implementation record — Lab CLI and management read surfaces

## Programme position

- **Phase:** CL-04 (read-surface only)
- **Starting `upstream/dev` SHA:** `68c71a4e9cdf882d812f09fd94783a28749db629` (merge #1352)
- **Branch:** `feat/cl-04-lab-read-surfaces`
- **PR:** [#1378](https://github.com/lidge-jun/opencodex/pull/1378) → `lidge-jun/opencodex:dev`
- **CL-05:** not started

## Scope delivered

### Shared query layer (`src/lab/query/`)

- Read-only SQLite open via `openLabReadConnection()`; never creates DB or rebuilds projection
- Schema/spec validation (`LAB_SQLITE_SCHEMA_VERSION`, `LAB_PROJECTION_SPEC_VERSION`)
- Explicit `lab_projection_unavailable` / `lab_projection_incompatible` errors
- Parameterized SQL, deterministic keyset cursors, bounded pagination (default 50, max 100)
- Privacy-safe DTO mapping (`dto-map.ts`) — no raw `payload_json` or artifact bytes
- Catalogue from packaged CL-01/CL-03 authorities (`catalog.ts`)

### Management API (`src/server/management/lab-routes.ts`)

- `GET /api/lab/status`
- `GET /api/lab/verdicts`
- `GET /api/lab/subjects`, `GET /api/lab/subjects/:subjectId`
- `GET /api/lab/observations`
- `GET /api/lab/events`, `GET /api/lab/events/:eventId`
- `GET /api/lab/artifacts`, `GET /api/lab/artifacts/:digest`
- `GET /api/lab/catalog`

### CLI (`src/cli/lab.ts`)

- `ocx lab status|verdicts|subjects|subject|observations|events|event|artifacts|artifact|catalog`
- `--json` machine output; skips Codex shim autorestore; no daemon/network

## Validation (local)

- `bun x tsc --noEmit` — passed
- `bun test tests/lab-read-surfaces.test.ts` — 17/17 passed
- `bun test tests/lab-conformance-harness.test.ts` — 17/17 passed
- `bun test tests/lab-evidence-ledger.test.ts` — 37/41 passed; 4 pre-existing Windows SQLite `EPERM`/file-lock flakes in `wipeSqlite` during repeated `rebuildLabProjection` (same failures on base `68c71a4` without CL-04)
- `bun test tests/lab-live-probe.test.ts` — 19/19 passed
- `bun test tests/lab-live-sandbox.test.ts` — 17/17 passed
- `bun run privacy:scan` — passed

## Acceptance blockers

- PR #1378 requires final CI after review remediation
- Independent acceptance review not performed
- Reviewer findings must be reconciled before CL-04 acceptance

## Out of scope (confirmed)

- CL-05 GUI, CL-06 routing profile fields, CL-07 fabric, CL-08 probes/public publish
- Automatic projection rebuilds, probe execution, raw artifact download APIs
