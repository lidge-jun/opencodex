# 040 — Batch D: changes-requested, contributor-owned

Four PRs from contributors we cannot push to.

- **#3144** fix(cli): let an explicit different --port start a sibling (@olddonkey)
- **#3138** fix(service): report the wait actually spent, not the budget (@ntdatt812)
- **#3121** fix(openai): exclude user-owned alias overlays from canonical seed validation
  (@Flowershangfromthebranches)
- **#3164** fix duplicate Codex restore warning after graceful stop (@x3M3x, draft)

## Method

For each: read the requested changes, then decide between three outcomes.

1. **Small and mechanical** — carry it. Cherry-pick onto `codex/<n>-carry`, apply the
   requested fixes ourselves, land it, close the original `landed-via-maintainer`.
2. **Needs the author's design judgment** — leave a specific comment naming what is
   outstanding and leave it open. This is a legitimate remaining item.
3. **Superseded or no longer applies** — close with the evidence.

Carrying is the default here, since the goal is drawdown and the user authorized it.

## Verification (C)

Landing SHA ancestry per carried PR; original closed with a crediting comment naming both
the carry PR and the merge SHA.

