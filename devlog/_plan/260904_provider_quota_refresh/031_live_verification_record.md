# Live verification record — 2026-09-04

Both defects were reproduced and then confirmed fixed against a running proxy serving the
built GUI. The observations below preserve that historical verification.

## Isolation

Verification ran against an isolated scratch instance. The existing proxy used a
separate checkout and was left untouched; its process identity and increasing
uptime were confirmed afterward. The scratch home was moved to Trash when
verification finished.

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
- Accounts tab (pooled OAuth provider): the control appears beside
  `Add account` and reported `Quotas refreshed` after a real forced read.

## Capture retention

The Accounts and Usage captures were subsequently removed from the current tree.
Both came from a real operator profile; retaining either surface is unnecessary
for the behavioral evidence above. This applies the same retention rule to both
surfaces without claiming that the Usage captures were independently cleared of
personal information. Git history is unchanged.

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
