# 002 — kiro-lb: what it does, and where it is beatable

Reference clone read read-only at `/tmp/kirolb.*/repo` (commit `474df2b` / `b2ec34d`,
2026-08-26). AGPL-3.0. **Behaviour studied, no code reused.**

kiro-lb is a competent, purpose-built gateway. It is single-provider by design, and that
focus buys it a real dashboard and a working weighted router. An honest comparison has to
start by saying what it does well, because those are the bars we must clear.

## What it does well

| Capability | Where |
| --- | --- |
| Reads real upstream usage per account | `kiro/usage.py:43-70` |
| Quota-weighted routing (exponential race, weight = remaining fraction) | `kiro/account_manager.py:1183-1208` |
| Distinct exclusion states with distinct timers | `kiro/account_manager.py:109-170` |
| Monthly-quota quarantine aligned to `nextDateReset` (6h floor, 32d cap) | `kiro/config.py:457-479` |
| Suspension (403) and credential-death (refresh 400/401) as separate states | `kiro/kiro_errors.py:30-51` |
| Persisted quota rows survive restart and seed routing | `kiro/store.py:206-289` |
| Cross-process refresh lease | `kiro/store.py:172-197` |

## Where it is beatable — with citations

These are the gaps the reviewers verified in its source, not marketing points.

1. **Weighted routing is model-blind.** `_select_account()` builds candidates from
   `list(self._accounts)` and never consults its own `model` argument or
   `_model_to_accounts` (`kiro/account_manager.py:1259-1276`). An account whose plan
   cannot serve the requested model is discovered by *failing a request*.
2. **Headroom is stale for up to the full poll interval.** Successful requests do not
   decrement local headroom (`kiro/account_manager.py:1369-1432`); only a poll updates it
   (default 900s, `kiro/config.py:533`). A hot account keeps its high weight for ~15
   minutes while it burns through its balance.
3. **`USAGE_REFRESH_INTERVAL_SECONDS=0` does not disable polling.** The comment says it
   does; the loop enforces `max(interval, 60)` and startup always polls
   (`main.py:342-359`). Zero means *every minute*.
4. **Bulk polling is sequential with a fresh 20s client per account.** `refresh_all_account_usage()`
   awaits one at a time (`kiro/dashboard.py:806-821`) and `usage.py:64-70` constructs a new
   `AsyncClient` per call. An N-account pool of dead accounts costs ~N × 20s per pass.
5. **A concurrent account deletion can abort an entire refresh pass.** The loop re-indexes
   `manager._accounts[account_id]` after an await, outside the lock
   (`kiro/dashboard.py:806-815`) — a `KeyError` there ends the pass, so later accounts
   never refresh.
6. **Breakdown selection falls back to index 0.** If no `AGENTIC_REQUEST` entry exists,
   the first entry becomes the routing signal (`kiro/usage.py:74-78`). An upstream
   addition silently reweights the pool on an unrelated resource.
7. **`freeTrialInfo` is dropped**, understating usable balance for trial accounts
   (`kiro/usage.py:97-111`).
8. **No absolute reset timestamp in the UI**, only a coarse relative duration, and only
   for excluded accounts (`frontend/src/features/dashboard/quota-display.ts:18-33`).
   `unit` and `overageRate` are fetched then discarded (`kiro/dashboard.py:613-627`).
9. **Pool loading is not automatic discovery.** No standard cache path (`~/.aws/sso/cache`,
   `~/.local/share/kiro-cli`) is scanned unless already registered as a source; scanning
   happens at startup/handoff only, with no watcher (`kiro/account_manager.py:407-505`).
   The README tells users to add accounts through dashboard device login.
10. **Suspension/auth-death prose contradicts the code**: both expire automatically after
    24h (`kiro/config.py:481-494`) although comments claim only support or re-login clears
    them.
11. **Refresh-lease waiting has no deadline** — contenders poll every 50ms forever
    (`kiro/auth.py:965-980`).
12. **Device-login flows are process memory only** (`kiro/device_login.py:97-113`); a
    restart mid-approval invalidates the login.
13. **Dashboard copy is inaccurate**: it says "only the refresh token is stored" while
    `internal_credentials()` persists access token, refresh token, expiry, region and
    client secret (`kiro/device_login.py:341-366`).

## What "better" must mean for us

Beating it is not "we also show a number". Our structural advantages have to be real, and
stated no wider than what we ship:

- **Quota-aware recovery ordering.** On a 429 we rotate toward the account with the most
  known headroom instead of walking the roster blind. This is *recovery* ordering, not
  pre-dispatch selection — see the scope note below.
- **Parallel, deadline-bounded probing** with per-account failure isolation.
- **Explicit unknown state** everywhere — never present a failed probe as "0% used".
- **No new background timer**: pull-on-demand plus TTL, so an idle proxy is silent.
- **Correct pool semantics we already own**: request-local rotation that never mutates the
  operator's `activeAccountId`, and per-account routing metadata that travels with its
  own bearer.

## Scope honesty (amended after audit round 1)

Two advantages were claimed here and have been withdrawn, because the design could not
back them:

- **Pre-request, model-aware selection.** Our rotation hook runs only inside the 429
  branch (`src/server/responses/core.ts:5574`), so nothing in this unit chooses an
  account *before* the first request, and no model is passed to the ranker. kiro-lb's
  weighted router genuinely is pre-request (though it is model-blind). Deferred to a
  follow-up work-phase; not claimed here.
- **Live decrement between polls.** `ProviderQuota` stores percent, not absolute
  used/limit, and Kiro meters fractional credits — one turn is not one credit. Any local
  decrement would be invented data. kiro-lb's 15-minute staleness gap is real; we do not
  currently close it, we only poll on demand with a shorter TTL.
