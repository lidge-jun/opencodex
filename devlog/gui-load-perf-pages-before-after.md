# GUI page-data TTI — before / after (PERF-2)

Date: 2026-07-28  
Branch: `perf/gui-page-data`

## Baseline (cold, local :10100)

Same proxy measurements as PERF-1:

| Endpoint | Cold latency |
|----------|----------------|
| `/api/usage?range=30d` | ~5.2s |
| `/api/codex-auth/accounts` | ~1.2s |
| `/api/models` | ~333ms |
| status / config / providers / settings | fast (sub-200ms typical) |

### Before (symptoms)

1. **Codex Auth** — Account/quota boxes waited for both `/accounts` (~1.2s) and `/active` to finish before `loadState` became ready. Soft revisits always started from an empty list.
2. **Usage** — Switching provider/surface tabs (all/codex/claude/grok) always re-hit `/api/usage` (~5.2s cold) even when that `(range, surface)` payload was already held in the session.
3. **Storage** — Revisits re-scanned from scratch with no last-good paint.
4. **API Keys** — Keys + `/v1/models` already fired in parallel, but cold remounts always showed empty/loading until both returned.
5. **Claude Code/Desktop** — Tab switch unmounted the inactive panel and remounted it (full refetch). Desktop status poll was already independent.
6. **Grok / Subagents** — Full-page loading gate on every visit; no last-good list seed.
7. **Logs + Debug** — Switching Logs↔Debug unmounted Debug (settings + log streams restarted). Debug log viewer reset whenever `fetchLogs` identity churned around flag toggles. Logs tab re-entry forced a non-silent refetch.

## Changes

### Shared

- `session-list-cache.ts` — sessionStorage read/write for **non-secret** list/summary shapes (usage summaries, storage report, key prefixes, model catalogs, debug flags, Claude/Grok/Subagents configs). No API secrets or auth tokens.

### Codex Auth

- In-memory last-good account snapshot (not sessionStorage — emails/ids).
- Progressive ready: paint boxes as soon as `/accounts` returns; soft-refresh when boxes already shown.
- Mode banner seeds from session cache of config-derived mode enums.

### Usage

- Module + session cache keyed by `apiBase:range:surface`.
- Surface/range switches with held data paint instantly and revalidate quietly; mismatched prior payload is dropped so the wrong filter never flashes.

### Storage

- Seed from last scan; soft-refresh without blanking the report.

### API Keys

- Seed active-key prefixes + endpoints and the external model catalog from session cache.
- Keep keys/models fetches independent on mount.

### Claude / Grok / Subagents

- Claude Code + Desktop both stay mounted (`hidden`) so tab switches reuse state and both can fetch in parallel on first visit.
- Session-seed + soft-refresh for Claude Code, Claude Desktop, Grok, and Subagents.

### Logs + Debug

- Keep Debug mounted under Logs; `active` pauses polls/log streaming while the Debug tab is hidden (no remount storm).
- Logs list seeds from session cache; re-entering the Logs tab uses silent refresh when rows are already held.
- Debug log viewer resets only when stream identity (`stream` + enabled) changes — not when unrelated debug switches toggle.

## Expected TTI improvement

| Surface | Expected |
|---------|----------|
| Codex Auth boxes | Visible after `/accounts` (~1.2s), not after `/active` join; revisits instant from memory |
| Usage provider tabs | Instant when `(range,surface)` already held; cold first visit still ~5.2s |
| Storage | Last scan paints immediately on revisit; soft refresh |
| API Keys | Keys + catalog paint from session seed; independent refresh |
| Claude tab switch | No remount refetch |
| Grok / Subagents | Instant re-entry from session seed |
| Logs ↔ Debug | No Debug remount; switch toggles no longer clear/refetch log streams |

## Remaining risks

- Session seeds can briefly show stale summaries until revalidate completes.
- Claude mounts both panels on first visit (extra parallel network) — intentional for tab-switch TTI.
- Debug stays mounted while on the Logs tab (polls paused via `active={false}`).
- No measured after numbers in this pass (code-path reasoning + existing GUI tests).
