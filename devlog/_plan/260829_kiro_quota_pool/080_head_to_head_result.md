# 080 — Head to head with kiro-lb, from the landed tree

Written after implementation, against the branch `codex/kiro-quota-pool` at `829767c0f`.
Every opencodex claim cites our code; every kiro-lb claim cites its file:line in the
AGPL-3.0 reference clone (commit `474df2b`). Behaviour was studied; no code was copied.

## Where we now lead

| Axis | kiro-lb | opencodex |
| --- | --- | --- |
| Breakdown selection | `AGENTIC_REQUEST`, else **index 0** (`kiro/usage.py:74-78`) | explicit priority list; an unrecognised list reports unknown (`src/providers/kiro-usage.ts` `RESOURCE_PRIORITY`) |
| Free-trial pool | fetched then dropped (`kiro/usage.py:97-111`) | reported as its own window |
| Exhaustion vs. percentage | `quota_depleted` derived from headroom <= 0 (`kiro/account_manager.py:173-190`) | overage-aware: a limit-passing account with overage enabled is **not** exhausted |
| Region handling | derived, unvalidated (`kiro/usage.py:20-36`) | every hostname candidate passes an allowlist; a crafted ARN cannot reach the URL |
| Idle cost | background poll, and `interval=0` still polls every 60s (`main.py:342-359`) | pull-on-demand behind a TTL; an idle proxy makes **zero** usage calls |
| Probe isolation | sequential, new 20s client per account (`kiro/dashboard.py:806-821`) | parallel with per-account failure isolation and an in-flight join |
| Refresh-pass robustness | a concurrent deletion can `KeyError` and abort the pass (`kiro/dashboard.py:806-815`) | generation guard + reconcile; a superseded probe commits nothing |
| Exhaustion quarantine | 6h floor, **32-day** cap (`kiro/config.py:457-479`) | reset-aligned, clamped 5 min – 24 h |
| Stale verdicts | persisted until overwritten | degrade to unknown past the TTL or the reset instant — "try again", never "stay parked" |
| Identity safety | per-account auth manager | bearer + profile ARN + region from ONE account snapshot, with a regression test (#2841 lineage) |
| Scope | Kiro only | Kiro is one provider on a shared seam that already served Anthropic |

## Where kiro-lb still leads

Stating this plainly, because a comparison that only lists our wins is worthless.

1. **Pre-request selection.** kiro-lb picks an account *before* dispatch with a weighted
   race (`kiro/account_manager.py:1183-1208`). Ours ranks only on the 429 recovery path
   (`src/oauth/generic-account-failover.ts`), so the first request of a turn can still
   land on a spent account. Deferred by design (doc `060`), not solved.
2. **Persistence across restart.** Its quota rows live in SQLite and seed routing at
   startup (`kiro/store.py:206-289`). Our caches are process-local, so a restart forgets
   every measurement until the next probe.
3. **Operations dashboard.** Request-rate charts, per-model token panels, Prometheus
   export (`kiro/metrics.py`). We render quota bars and a CLI column.
4. **Account onboarding.** Device login for Builder ID, Google and GitHub straight from
   the dashboard (`kiro/device_login.py`). Ours hands off to the Kiro CLI one account at
   a time.

Item 1 is the one that matters most for the user's "pool 기반 자동 탑재" ask, and it is
the first follow-up work-phase.

## Honest summary

On *correctness of the quota reading* and *safety of the pool machinery* we are ahead:
resource selection, overage semantics, trial balances, region validation, credential/route
pairing, and stale-state handling are each demonstrably stricter, with tests. On *routing
sophistication* kiro-lb is still ahead on the pre-dispatch axis, and on *operational
surface* it is ahead outright.

"Better than kiro-lb" is therefore true for the two things this unit set out to do —
display Kiro quota, and make the pool quota-aware — and not yet true as a blanket claim
about the whole gateway.
