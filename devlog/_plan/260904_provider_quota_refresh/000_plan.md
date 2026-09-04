# Provider quota refresh affordance + Meta usage visibility

Unit opened 2026-09-04. Two defects reported against the live Providers dashboard
on `http://localhost:10100/#providers`:

1. Only the Codex account pool has a "Refresh quotas" button. Every other provider
   — anthropic, xai, cursor, google-antigravity, meta-muse — offers the operator no
   way to force a fresh quota read from the dashboard.
2. Meta Muse shows no quota on the provider Usage tab even though the proxy has an
   observation for it.

## Evidence gathered at P (live proxy, port 10100, v2.42.0, pid 73184)

`GET /api/provider-quotas` returns six reports, and `meta-muse` is one of them:

```json
{
  "provider": "meta-muse",
  "label": "Meta Muse Code (CLI credential)",
  "source": "meta-muse:subscription-observation",
  "quota": { "updatedAt": 1788491894216, "fiveHourPercent": 1, "fiveHourResetAt": 1788509678000,
             "weeklyPercent": 1, "weeklyResetAt": 1788739200000 },
  "updatedAt": 1788491894216
}
```

`generatedAt` was 1788511281008, so the observation was 5.39 hours old.

## Root causes

**Defect 2 is a client-side freshness bound, not a missing measurement.**
`gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx` defines
`QUOTA_REPORT_MAX_AGE_MS = 30 * 60_000` and `freshQuotaReport()` returns `null`
for any report where `now - updatedAt >= QUOTA_REPORT_MAX_AGE_MS`. That filter runs
on the response as well as on the session cache, so the meta-muse row is discarded
before it ever reaches `ProviderDetails` — and `quotaReport` being `undefined` is
exactly what makes the Usage tab render `pws.quotaUnavailable` and the Overview
omit its rate-limit section.

The bound is correct for a PROBED provider: anthropic, xai, cursor and
google-antigravity each re-read on their own TTL, so a 30-minute-old row means the
probe is failing and showing it would be a lie. It is wrong for a PASSIVE provider.
`meta-muse` publishes no quota endpoint; `src/providers/quota.ts`
(`hasPassiveAccountQuota`, `fetchPassiveProviderQuota`) records usage only from
`response.subscription_usage` SSE frames on a real streaming turn. A five-hour-old
observation is not a stale reading of a live number — it is the only number that
exists, and deleting it leaves the operator with nothing.

The Accounts tab already got this right: `ProviderAuthPanel.tsx` passes
`observedAt` to `QuotaBars` for `meta-muse`, which renders `quota.observedAgo`.
That surface reads `/api/oauth/accounts?provider=meta-muse&quota=1`, which has no
age filter, which is why Meta usage is visible there and nowhere else. The fix is to
carry the same "this is an observation, not a probe" fact to the other surfaces
rather than to widen or delete the bound.

**Defect 1 is a missing affordance.** `Providers.tsx` owns
`invalidateProviderQuotas(force)`, which bumps `quotaRefresh.epoch` and sets
`force`, and the shell's effect then reads `/api/provider-quotas?refresh=1`. Every
existing caller is a MUTATION — account switch, login, logout, key add/switch/remove,
config save, provider add/remove. There is no operator-initiated path. The
`codexAuth.refreshQuota` / `refreshingQuota` / `quotaRefreshed` /
`quotaRefreshFailed` keys already exist in all nine locale files because
`CodexAccountPool` uses them, so the copy is reusable.

## Work phases

| Phase | Doc | Deliverable |
|-------|-----|-------------|
| wp0 | this unit | roadmap, docs only |
| wp1 | `010_wp1_passive_quota_visibility.md` | wire marker + client exemption so Meta renders |
| wp2 | `020_wp2_refresh_affordance.md` | refresh control on Accounts and Usage surfaces |
| wp3 | `030_wp3_live_verification_and_pr.md` | live screenshots, push, PR against `dev` |

## Constraints

- Repository-wide suite is prohibited by the requester. Focused `bun test <file>`,
  `bun x tsc --noEmit`, `bun run lint:gui` only.
- Push with `--no-verify`; branch `codex/260904-provider-quota-refresh`; target `dev`.
- A GUI-mentioning PR requires a screenshot in the description (`enforce-target`).
- The live proxy on port 10100 is the user's working service. Read it, restart it
  only when a rebuild must be picked up, never repoint or reconfigure it.
- `refresh=1` must never cause a passive provider to spend an inference turn.
