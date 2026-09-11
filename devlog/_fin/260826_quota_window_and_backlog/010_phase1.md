# 010 — wp1: the header quota parser learns the duration rule

## The defect in one line

`parseUpstreamQuotaHeaders` branches on "explicitly monthly, or else weekly". There is no
third branch, so a 5-hour primary window is recorded as the weekly reading.

## MODIFY map

### `src/codex/quota.ts`

**1. Add a minutes-domain short-window predicate next to the existing monthly one**

The seconds-domain predicate already exists (`isExplicitShortWindow`, line ~205) and the
minutes-domain monthly predicate already exists (`isExplicitMonthlyWindowMinutes`, line ~221).
The missing piece is the minutes-domain SHORT predicate. Both share one numeric parse, so
factor that out rather than writing the coercion twice.

```ts
/** Minutes-domain twin of isExplicitShortWindow: the header wire reports minutes, not seconds. */
function windowMinutes(value: unknown): number | undefined {
  const minutes = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : undefined;
  return typeof minutes === "number" && Number.isFinite(minutes) ? minutes : undefined;
}

function isExplicitShortWindowMinutes(value: unknown): boolean {
  const minutes = windowMinutes(value);
  return minutes !== undefined && minutes > 0 && minutes < WEEKLY_WINDOW_MIN_MINUTES;
}
```

`WEEKLY_WINDOW_MIN_MINUTES` is NEW and mirrors the existing monthly constant:

```ts
const WEEKLY_WINDOW_MIN_SECONDS = 24 * 60 * 60;                  // exists, line ~96
const MONTHLY_WINDOW_MIN_MINUTES = MONTHLY_WINDOW_MIN_SECONDS / 60;  // exists, line ~97
const WEEKLY_WINDOW_MIN_MINUTES = WEEKLY_WINDOW_MIN_SECONDS / 60;    // NEW — 1440
```

Deriving it from the seconds constant is deliberate: the two parsers must not be able to drift
to different thresholds, which is exactly the class of bug this phase is fixing.

**2. Give the parser its third branch**

Before (line ~344):

```ts
const primaryIsMonthly = primaryRaw !== null && isExplicitMonthlyWindowMinutes(primaryWindowMinutes);

if (primaryIsMonthly) {
  ...
} else {
  const weeklyPercent = primaryPercent ?? secondaryPercent;
  ...
}
```

After:

```ts
const primaryIsMonthly = primaryRaw !== null && isExplicitMonthlyWindowMinutes(primaryWindowMinutes);
// Codex restored the 5-hour window for Plus and Team (Pro stays weekly-only). A primary window
// that DECLARES a sub-day duration is a burst window, and folding it into weeklyPercent both
// discards the real weekly reading and leaves the account looking exhausted after the burst
// window resets. Duration decides, exactly as the WHAM parser already does.
const primaryIsShort = primaryRaw !== null && isExplicitShortWindowMinutes(primaryWindowMinutes);

if (primaryIsMonthly) {
  // ... unchanged ...
} else if (primaryIsShort) {
  if (primaryPercent !== undefined) {
    quota.shortPercent = primaryPercent;
    if (primaryResetAt !== undefined) quota.shortResetAt = primaryResetAt;
    const minutes = windowMinutes(primaryWindowMinutes);
    if (minutes !== undefined) quota.shortWindowSeconds = Math.round(minutes * 60);
  }
  // The burst window vacates the primary slot, so the weekly reading is the secondary — which
  // is where it actually was all along.
  if (secondaryPercent !== undefined) {
    quota.weeklyPercent = secondaryPercent;
    if (secondaryResetAt !== undefined) quota.weeklyResetAt = secondaryResetAt;
  }
} else {
  // ... unchanged: primary-or-secondary weekly ...
}
```

**3. Do NOT touch** the tertiary handling below it, `isCodexQuotaExhausted`,
`computeCodexUsageScore`, or the WHAM parser. They already read `shortPercent` correctly
([quota.ts:117](../../../src/codex/quota.ts), [routing.ts:339](../../../src/codex/routing.ts));
this phase only makes the header path produce the field they are already waiting for.

**4. Update the stale premise comment** at
[core.ts:3777](../../../src/server/responses/core.ts): "primary was the 5h window; it now
carries weekly data for GPT plans" is false again. Replace with a note that the slot is
duration-classified and the plan does not decide.

### \`src/routing/quota.ts\` — the fold that stops this fix becoming a regression (audit B1)

\`codexAccountQuotaEvidence\` (line ~37) computes routing headroom from \`weeklyPercent\` and
\`monthlyPercent\` only. That omission is invisible TODAY because the broken parser writes the
5h value into \`weeklyPercent\` — routing sees the burst by accident. Measured live:

\`\`\`
headroom BEFORE the parser fix : 0.03   (reads 97% used — accidentally correct)
headroom AFTER  the parser fix : 0.88   (reads 12% used — WRONG, burst is at 97%)
\`\`\`

Fixing the parser alone would route traffic into a 429. Add \`shortPercent\` to the percent set
and \`shortResetAt\` to the reset set:

\`\`\`ts
const percents = [
  ...(monthly ? [] : [quota.weeklyPercent]),
  quota.monthlyPercent,
  // The burst window is upstream-enforced independently of the governing window, so an account
  // at 97% here has 3% headroom regardless of its weekly figure. computeCodexUsageScore already
  // folds it in (codex/routing.ts:339); this module must not disagree.
  quota.shortPercent,
].filter(...)
\`\`\`

Same treatment for \`resets\` with \`quota.shortResetAt\`, so a burst-limited account reports the
burst reset rather than a distant weekly one.

### Nothing else changes — beyond the two files above

- `setAccountQuotaFromParsed` already merges `short*` fields (line ~318, `snapshotHasShort`).
- `updateAccountQuota` already preserves them (line ~413).
- The DTO already returns `shortPercent` ([auth-api.ts:212](../../../src/codex/auth-api.ts)).
- The GUI already aliases it to `fiveHourPercent` and renders the bar
  ([codex-quota-utils.ts:27](../../../gui/src/codex-quota-utils.ts),
  [QuotaBars.tsx:45](../../../gui/src/components/QuotaBars.tsx)).

Storage and display were already correct: one parser was filling the wrong pipe, and one
routing consumer was reading that wrong pipe. **This phase changes two runtime files** —
`src/codex/quota.ts` and `src/routing/quota.ts` — and they must land together. Shipping the
parser alone converts a display bug into a routing bug (audit B1).

## TESTS

### `tests/rate-limit-reset-credits.test.ts` (extend — it owns the header-parser cases)

| Case | Input | Expected |
|---|---|---|
| Plus/Team 5h primary + weekly secondary | primary 97% / 300 min, secondary 12% / 10080 min | `{shortPercent:97, shortWindowSeconds:18000, weeklyPercent:12}` |
| 5h exhausted does not poison weekly | primary 100% / 300 min, secondary 8% / 10080 min | `weeklyPercent === 8`, `shortPercent === 100` |
| Pro weekly-only unchanged | primary 80% / 10080 min | `{weeklyPercent:80}`, no `shortPercent` |
| Monthly primary unchanged | primary 100% / 43800 min | existing expectation holds verbatim |
| Reset instant travels with its window | primary 300 min + reset | `shortResetAt` set, `weeklyResetAt` NOT set from the primary |
| Absent window-minutes header | primary 80%, no minutes header | weekly (unchanged legacy behaviour) |
| 24h boundary, below | primary 60% / 1439 min | `shortPercent` — strict `<` (audit B5) |
| 24h boundary, at | primary 60% / 1440 min | `weeklyPercent` — exactly a day is NOT short |
| Routing headroom holds | `{shortPercent:97, weeklyPercent:12}` | `codexAccountQuotaEvidence` headroom <= 0.05, not 0.88 |

The last row is load-bearing: an upstream that omits the duration header must keep behaving
exactly as it does today. Duration-classification is opt-in on the presence of a declared
duration, never a guess.

### `tests/codex-quota-parser-parity.test.ts` (NEW)

The property assertion, and the one that would have caught this defect the first time:

```ts
// Given the SAME upstream reading expressed both ways, the two parsers must agree on which
// window each number belongs to. Any future change that teaches one parser a rule the other
// does not know fails here.
for (const c of [
  { minutes: 300,   seconds: 18000,  primary: 97,  secondary: 12 },   // Plus/Team 5h
  { minutes: 10080, seconds: 604800, primary: 80,  secondary: undefined }, // Pro weekly
  { minutes: 43800, seconds: 2628000, primary: 100, secondary: 22 },  // monthly plan
]) { ... expect header-derived window assignment to equal WHAM-derived ... }
```

Compare the WINDOW ASSIGNMENT (which field each percent lands in), not raw object equality —
the WHAM parser also emits `monthlyIsPrimaryWindow` and Spark custom windows that the header
wire does not carry.

### Falsification (mandatory before trusting either)

Revert the `primaryIsShort` branch and confirm both new suites go red. A parity test that
passes against the broken parser is worthless.

## Verification (C)

```bash
bun test tests/rate-limit-reset-credits.test.ts tests/codex-quota-parser-parity.test.ts \
         tests/ws-endpoint.test.ts tests/codex-routing.test.ts
bun x tsc --noEmit          # exit 0
bun run test                # 0 fail — quota.ts is shared runtime
```

## Activation scenario (C-ACTIVATION-GROUNDING-01)

The new branch is a conditional, so C must prove it ARMS rather than merely compiles:
feeding `x-codex-primary-window-minutes: 300` must move the 97 from `weeklyPercent` to
`shortPercent` **and** let 12 reach `weeklyPercent`. Observing only "shortPercent is set"
would pass even if the secondary were still being dropped.

## Out of scope for wp1

The Spark row and the GUI switch are wp2. Capacity weights (`plus:1`) are untouched: a new
window is not evidence that the pooled display ratio is wrong, and that ratio is display-only
([codex-capacity.ts:166](../../../src/providers/codex-capacity.ts)).
