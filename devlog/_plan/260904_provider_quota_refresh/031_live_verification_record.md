# Live verification record — 2026-09-04

Both defects were reproduced and then confirmed fixed against a running proxy serving the
built GUI. Screenshots in `assets/`.

## Isolation

The user's own proxy runs on port 10100 from
`/Users/jun/Developer/new/700_projects/opencodex` under launchd — a different checkout
from this worktree, so restarting it would NOT have loaded this change, and repointing it
is out of bounds. Verification therefore ran on a scratch instance:

- `OPENCODEX_HOME` = a `mktemp -d` directory holding only `config.json` (three providers),
  `auth.json`, and `provider-account-quota-cache.json` copied from the real home.
- port 10399, started with `bun run src/cli/index.ts start --port 10399` from this worktree.
- Port 10100 was confirmed untouched afterwards: same pid 73184, uptime still climbing.
- The scratch home was moved to Trash when finished.

## Wire evidence

`GET /api/provider-quotas` on the scratch instance returned the meta-muse row carrying
the new marker:

```json
{
  "provider": "meta-muse",
  "source": "meta-muse:subscription-observation",
  "quota": { "updatedAt": 1788491894216, "fiveHourPercent": 1, "weeklyPercent": 1 },
  "updatedAt": 1788491894216,
  "observed": true
}
```

`generatedAt` was 1788513424412 — the observation was ~6 hours old, far past the
30-minute bound that used to delete it.

## UI evidence (aside CLI repl, signed-in profile, under a `perl alarm` deadline)

| Surface | Before | After |
|---|---|---|
| Providers overview, RATE LIMITS | Muse Code absent | `Muse Code · Checked 5h ago · Observed 5h ago · 1% used` |
| Muse Code → Overview | no rate-limit section | `Observed 5h ago`, both windows |
| Muse Code → Usage | `pws.quotaUnavailable` | both windows, source line, `Quota updated 5h ago` |

The refresh control was exercised, not merely rendered:

- Usage tab: clicking `Refresh quotas` produced `status: "Quotas refreshed"` and the age
  line re-derived from `5h ago` to `6h ago` — the read really happened.
- Accounts tab (anthropic, three pooled accounts): the control appears beside
  `Add account` and reported `Quotas refreshed` after a real forced read.

## Assets

| File | Content |
|---|---|
| `010_meta_usage_quota.png` | Muse Code → Usage with both windows and the refresh control |
| `020_usage_refresh_result.png` | the same tab after a click, showing the success status |
| `030_accounts_refresh_button.png` | Accounts tab control for a pooled OAuth provider |
| `040_accounts_refresh_result.png` | Accounts tab after a click |

## CI (PR #3448, head 232afdd97)

Attempt 1 ended `cancelled`, which `gh pr checks` renders as `fail` for two rows. That
was not a test failure and is worth stating precisely, because "a red check" and "a broken
change" are different claims: every substantive job succeeded — all four `test` shards,
`gates`, `macos`, all three `keyring` jobs, `npm-global` on ubuntu and macos,
`storage policy`, `api usage`, `react-doctor`, `enforce-target`. The single
`npm-global windows-latest` job was cancelled with ZERO failing steps
(`steps: []` under a `cancelled` conclusion), and the aggregate `ci` gate then failed
for the one reason it exists to check: "Assert every needed job succeeded or was skipped".

Attempt 2 completed with `conclusion: success`, and the PR now shows 10 passing checks
with nothing pending or failing.
