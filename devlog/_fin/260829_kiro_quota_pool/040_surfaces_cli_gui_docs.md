# 040 — Phase 4: surfaces (CLI, GUI, docs)

Work class: C2. Depends on: `020`. Independent of `030`.

## GUI: nothing to build

This is the payoff for wiring into the existing seam. `ProviderAuthPanel` already renders
`QuotaBars` from `account.quota` and the unavailable message from
`account.quotaUnavailable` (`gui/src/components/provider-workspace/ProviderAuthPanel.tsx:517`);
`useProviderAccountPools` already requests `?quota=1`
(`gui/src/hooks/useProviderAccountPools.ts:96`); the route already populates both fields
from `fetchProviderAccountQuotas`
(`src/server/management/oauth-account-routes.ts:274`).

Once `supportsPerAccountQuota("kiro")` is true, Kiro accounts render. **Verification is
still required** — "it should just work" is not evidence. A GUI screenshot is mandatory in
the PR description anyway (the `enforce-target` gate rejects a `gui`-mentioning PR
without one).

The monthly window renders through the existing `monthlyPercent` row in
`QuotaBars` (`gui/src/components/QuotaBars.tsx:45`), so no new component and no new
label vocabulary.

## CLI

`ocx account list kiro --quota` already exists and formats a QUOTA column
(`src/cli/account.ts:104`). `quotaText` reads `fiveHourPercent`/`shortPercent` and
`weeklyPercent` — **neither of which Kiro populates**. Add a monthly arm:

```ts
if (typeof quota.monthlyPercent === "number") parts.push(\`mo \${quota.monthlyPercent}%\`);
```

Without this the column prints `-` for a perfectly healthy Kiro account, which reads as
"broken". This is a two-line change with a real user-visible failure behind it.

## The stale "single login slot" copy

`src/cli/account.ts:28` and `:215` describe Kiro as replacement-style with a single login
slot. That has been false since the multiauth add-account flow shipped
(`src/oauth/kiro.ts:335`, which snapshots the CLI SQLite DB, runs
`kiro-cli logout`/`login`, and appends by profile ARN with rollback on failure).

Fix the copy to describe what the code does: multiple accounts, added one at a time through
the CLI handoff, each with its own quota row. A user who reads "single login slot" will
never try to build a pool — the feature is invisible, which is functionally the same as
missing. This directly serves the user's "pool 기반 자동 탑재" ask.

## Docs

- `docs-site/src/content/docs/reference/adapters.md` — Kiro section: note quota reporting
  and the multi-account pool.
- `docs-site/src/content/docs/reference/cli/providers-accounts.md` — the `--quota`
  column now covers Kiro; document the monthly window and the `unavailable` state.

English source only. Translated locales are left alone rather than machine-translated;
the repo rule is that locales must not *contradict* English, and an untouched locale that
omits a new note does not contradict it.

## Accept criteria

| # | Scenario | Observable proof |
| --- | --- | --- |
| 1 | `quotaText` with only `monthlyPercent` | renders `mo 15%`, not `-` |
| 2 | `quotaText` with `quotaUnavailable` | renders `unavailable` (existing behaviour preserved) |
| 3 | Help text for kiro | no longer claims a single login slot |
| 4 | GUI accounts tab with 2 Kiro accounts | screenshot shows two quota bars |
| 5 | `bun run lint:gui` | passes (no GUI source change expected, so this is a guard) |

## Verifier

`bun test tests/account-cli.test.ts` (or the existing CLI account test file — confirm the
exact name before writing the plan into the attest) and a manual GUI screenshot.
`bun run skill:surface:check` if any CLI capability string changes.
