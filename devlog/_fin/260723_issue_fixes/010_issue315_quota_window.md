# 010 — WP1: #315 quota window classification (`limit_window_seconds`)

## Design

Classification must be duration-driven when WHAM supplies `limit_window_seconds`,
with exact backward compatibility when it is absent:

- primary with duration >= 28d (2,419,200s) → monthly.
- primary with duration < 28d or absent → weekly (today's behavior).
- secondary remains the weekly fallback when primary is missing or primary is monthly.
- tertiary remains the monthly source; an explicit monthly primary WITH a usable
  percent takes precedence over tertiary (primary is the account's live window).
  Monthly percent and reset are ALWAYS taken from the SAME window — no cross-window
  pairing (audit finding 2).
- `go|free` thirty-day-only special case unchanged.

## MODIFY src/codex/quota.ts

1. Extract a shared, NULLABLE window type — the reporter's live payload carries
   `secondary_window: null` / `tertiary_window: null`, which the current inline
   object shape rejects at typecheck (audit finding 1):

```ts
// before (10-17)
  rate_limit?: {
    primary_window?: { used_percent?: number; reset_at?: number };
    secondary_window?: { used_percent?: number; reset_at?: number };
    tertiary_window?: { used_percent?: number; reset_at?: number };
  };
// after
export type WhamWindow = {
  used_percent?: number;
  reset_at?: number;
  limit_window_seconds?: number;
};
// ...
  rate_limit?: {
    primary_window?: WhamWindow | null;
    secondary_window?: WhamWindow | null;
    tertiary_window?: WhamWindow | null;
  };
```

   `?.` access already tolerates `null`, so `parseUsageQuota` body reads are unaffected.

2. Add near `normalizeUsagePercent`:

```ts
/** >=28d windows are monthly (weekly is 604800s; WHAM monthly is 2628000s). */
const MONTHLY_WINDOW_MIN_SECONDS = 28 * 24 * 60 * 60;

function isMonthlyWindowSeconds(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= MONTHLY_WINDOW_MIN_SECONDS;
}
```

3. In `parseUsageQuota`, branch on a monthly primary before the weekly mapping,
   keeping percent+reset coupled to one source window (audit finding 2):

```ts
  const primaryIsMonthly = isMonthlyWindowSeconds(data.rate_limit.primary_window?.limit_window_seconds);
  const monthlyFromPrimary = primaryIsMonthly && primaryPercent !== undefined;
  // weekly source: primary unless primary is monthly; then secondary
  const weeklyPercent = primaryIsMonthly ? secondaryPercent : (primaryPercent ?? secondaryPercent);
  const weeklyResetAt = primaryIsMonthly
    ? secondaryResetAt
    : (primaryPercent !== undefined ? primaryResetAt : secondaryResetAt);
  // monthly source: a monthly primary with a usable percent wins over tertiary;
  // both fields come from the SAME window (no cross-window percent/reset pairing)
  const monthlyPercent = monthlyFromPrimary ? primaryPercent : tertiaryPercent;
  const monthlyResetAt = monthlyFromPrimary ? primaryResetAt : tertiaryResetAt;
```

(realized by renaming today's `monthlyPercent`/`monthlyResetAt` locals to
`tertiaryPercent`/`tertiaryResetAt`.) The `thirtyDayOnly` (go|free) branch is then
explicitly changed to consume `tertiaryPercent`/`tertiaryResetAt` — NOT the new
effective monthly locals — so its behavior stays byte-identical to today (re-audit
finding 1). The effective `monthlyPercent`/`monthlyResetAt` locals are used only in
the non-go/free branch. The rest of the function is unchanged.

## Tests — MODIFY tests/rate-limit-reset-credits.test.ts (owns the Go/Free contract
and typed WHAM fixtures — audit finding 3; codex-routing.test.ts keeps its existing
parse cases untouched)

| Case | Payload | Expect |
|------|---------|--------|
| weekly 7d primary | primary `{60, r, 604800}` | weeklyPercent=60 |
| monthly primary (reporter repro) | primary `{6, 1787336442, 2628000}`, secondary/tertiary null | monthlyPercent=6, monthlyResetAt set, **no weeklyPercent** |
| monthly primary + weekly secondary | primary `{39, r1, 2628000}`, secondary `{20, r2}` | monthly=39, weekly=20 |
| monthly primary + tertiary both present | primary `{39, r1, 2628000}`, tertiary `{50, r3}` | monthly=39/r1 (primary precedence, same-source coupling) |
| monthly primary WITHOUT percent + tertiary | primary `{undefined, r1, 2628000}`, tertiary `{50, r3}` | monthly=50/r3 (tertiary source, r1 NOT paired) |
| go plan + monthly primary | plan_type "go", primary `{30, r1, 2628000}`, tertiary `{50, r3}` | thirty-day-only branch semantics preserved: define expected output explicitly in-test (current branch reads tertiary only → monthly=50/r3; assert exactly that to lock the invariant) |
| free plan, tertiary only | plan_type "free", tertiary `{50, r3}` | monthly=50/r3 (existing contract, unchanged) |
| legacy tertiary | primary `{10, r1}`, tertiary `{50, r3}` | weekly=10, monthly=50 |
| missing duration compat | primary `{10, r1}` only | weekly=10 (unchanged) |

Pre-fix expectation: reporter-repro case FAILS on af973e54 (weeklyPercent=6 emitted).

Note (audit finding 3, decision): inside the `go|free` branch we deliberately do NOT
add monthly-primary handling in this fix — the branch keeps reading tertiary as today.
Rationale: no live go/free payload with a monthly primary has been observed; locking
current behavior with an explicit test is the safe, evidence-bounded change. If a
go/free monthly-primary payload appears in the wild, that is a follow-up unit.

## Out of scope

GUI QuotaBars already renders monthly when `monthlyPercent` exists (triage evidence);
no GUI change.
