# GUI hot-path TTI — before / after (PERF-1)

Date: 2026-07-28  
Branch: `perf/gui-hot-path`

## Baseline (cold, local :10100)

Captured earlier on the same proxy:

| Endpoint | Cold latency |
|----------|----------------|
| `/api/usage?range=30d` | ~5.2s |
| `/api/codex-auth/accounts` | ~1.2s |
| `/api/models` | ~333ms |
| status / config / providers / settings | fast (sub-200ms typical) |

### Before (symptoms)

1. **Dashboard** — Shadow Call Intercept, web-search sidecar, and vision selects stayed disabled until `fetchDashboardCore` finished. That poll bundled `healthz` + providers + settings + sidecar + shadow **and then** sequentially awaited v2 / injection / effort-caps. Slow peers (or a long core round-trip) blocked toggles even when their own settings endpoints were already ready. Tokens-30d was already a separate poll (~5.2s) but did not need to gate controls; status widgets were fine to stream later.
2. **Models** — Shadow call settings were fetched only *after* the heavy models/caps/providers/selection `Promise.all`. The whole page early-returned on `loading`, so the shadow switch was invisible until the catalog finished.
3. **Providers** — Config-based ready/need-setup bins were correct on first paint, but `applyActiveAccountReauth` demoted rows into need-setup when live account discovery (~1.2s) returned, flashing a rail re-order. Add Provider waited on cold `/api/provider-presets` (+ usage rank) at modal open. Overview summary from config was fine; rate-limits / recently-used waited on usage (~5.2s) / quotas with no busy affordance.

## Changes

### Dashboard

- Split `fetchDashboardControls` (settings + sidecar-settings + shadow-call-settings) from `fetchDashboardCore` (health + providers + v2 + injection + effort-caps, all parallel).
- Separate `dashboard-controls` client-resource poll so control enablement commits as soon as own endpoints return.
- SessionStorage last-known controls for optimistic re-entry (stale-while-revalidate).
- `aria-busy` on slow status/usage stats and sidecar/shadow panels only (not the whole page).

### Models

- Mount-time parallel fetch for shadow-call + v2 (independent of models catalog).
- Shadow controls render during catalog `loading` so the switch is usable early.

### Providers

- `applyActiveAccountReauth` **tags** reauth without moving ready → need-setup (stable rail order from config).
- Attention list / overview reauth counts updated for tagged ready rows.
- Prefetch `add-provider-presets` + `add-provider-usage` on Providers page mount (shared client-resource keys with the modal).
- Parallelize oauth provider list with Codex accounts/active probes.
- Overview rate-limits / recently-used show `aria-busy` while usage/quotas load; catalog keeps label order until usage rank is present.

## Expected TTI improvement

| Surface | Expected |
|---------|----------|
| Dashboard sidecar / shadow toggles | Interactive after settings endpoints (~tens–low hundreds ms), not after full core poll; repeat visits instant from session cache |
| Dashboard tokens / version / uptime | Still stream late (~5.2s usage OK); no longer block controls |
| Models shadow switch | Usable as soon as `/api/shadow-call-settings` returns (~fast), while models list may still spin |
| Providers rail | Ready/need-setup order stable from first config paint; no ~1.2s reauth demotion flash |
| Add Provider catalog | Cache warm after page visit; open modal without cold presets wait |
| Providers overview | Summary immediate from config; usage/quota sections busy until probes finish |

## Remaining risks

- Session cache can briefly show stale sidecar/shadow until the controls poll confirms.
- Reauth providers stay in the Ready group (with warning status) instead of moving to Need setup — intentional for flash avoidance.
- Usage-ranked catalog order still applies once usage arrives if presets painted first without a warm usage cache.
- No measured after numbers in this pass (code-path reasoning + contracts tests only).

## Measured locally (2026-07-28, proxy `:10100`)

Client-pattern timings (same machine/proxy). These approximate TTI gates, not full browser paint.

| Pattern | ms |
|---------|-----|
| BEFORE Dashboard: core peers then controls (serial) | 5655 |
| AFTER Dashboard: controls only (serial) | 1323 |
| AFTER Dashboard: controls only (parallel) | 625 |
| BEFORE Models: catalog then shadow | 1439 |
| AFTER Models: shadow only | 16 |
| Usage cold | 725 |
| Usage warm (same query) | 9 |
| Usage other surface | 458 |
| Codex `/accounts` alone | 1020 |

**Read:** PERF-1 wins are mostly “don’t wait for the slow path before enabling controls” (5.6s → ~tens–low hundreds ms for shadow/sidecar). PERF-2 wins are mostly “don’t refetch held page data” (usage revisit ~9ms network; UI session seed is even cheaper). Full browser TTI not instrumented in this pass.
