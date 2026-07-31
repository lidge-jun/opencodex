# Issue #52 — per-provider model allowlist (`selectedModels`) + catalog trim

Date: 2026-07-03
Owner: Boss (main session), heuristic PABCD.
Status: DONE — Phase 1 backend (commit 69c0708) + Phase 2 GUI (commit 13ef7f5).
Verify: `npx tsc --noEmit` green (server + gui); `bun test ./tests/` 1365 pass / 0 fail incl. 6 new
`selected-models` cases; `gui` production build green. Endpoint logic is a thin CRUD mirror of the
existing subagent-models/disabled-models endpoints (not live-smoke-tested; filter logic unit-tested).
NOTE: a concurrent agent was committing upstream-retry/SSE work to `dev` during this task — my two
commits sit on top of theirs (854da1e); no overlap in files.
Issue: guigeng — a custom API proxy exposing 2000+ models produces a 50MB+ catalog + unpaginated
Models page. Wants to pick only the few models needed per provider.

## Root cause (confirmed, see prior devlog assessment)

- `fetchProviderModels` (`src/codex-catalog.ts:788`) returns the FULL live `/models` list, no
  allowlist intersection, no count cap. Amplified by full-template clone per model
  (`deriveEntry` `:497`).
- Major providers are safe (bounded static registry lists; cursor intersects live∩static). The
  blow-up is any provider with a large live list and no allowlist: **custom proxies (guigeng)** and
  **built-in aggregators like OpenRouter** (`registry.ts:291`, live-fetches hundreds).

## Design

Add a per-provider `selectedModels?: string[]` allowlist. When non-empty, ONLY those model ids ship
to Codex's catalog and to `/v1/models` — live discovery still runs, we just narrow what is emitted.
Empty/absent = today's behavior (all). The admin GUI (`/api/models`) keeps seeing the FULL list so
the user can pick; the filter applies only at the CATALOG/client emission points.

### Phase 1 — backend (this pass)

1. `src/types.ts`: `OcxProviderConfig.selectedModels?: string[]`.
2. `src/codex-catalog.ts`: new exported `filterCatalogVisibleModels(models, config)` — one place that
   applies BOTH the `disabledModels` blocklist and the per-provider `selectedModels` allowlist.
   Replace the two existing disabled-only filters:
   - on-disk sync (`codex-catalog.ts:986`)
   - `/v1/models` handler (`src/server.ts:2093`) — covers both the Codex `client_version` catalog and
     the OpenAI list shape.
   `/api/models` (admin picker) stays UNFILTERED.
3. `src/server.ts`: `/api/selected-models` GET (per-provider current selection + full available list)
   and PUT (`{ provider, models }` → set/clear `selectedModels`, save, refresh catalog).
4. `tests/selected-models.test.ts`.

### Phase 2 — GUI (next pass)

`gui/src/pages/Models.tsx`: per-provider allowlist editor (search + paginate the model rows; check to
include; empty = all) wired to `/api/selected-models`; i18n strings (en/ko/zh).

## Verification

`npx tsc --noEmit` green; `bun test ./tests/` green; new selected-models test green.
