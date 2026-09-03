# wp2 — the dashboard states how old the observation is

Own PR, base `dev`, after wp1 lands. Branch: `codex/muse-quota-observation-age`.

## Why this is a work-phase and not a line in wp1

Every other quota bar in this dashboard answers *what is true now*: Anthropic's is at
most `ACCOUNT_QUOTA_TTL_MS` (10 minutes) old, and a stale probe is marked
`quotaUnavailable` (`oauth-account-routes.ts:298`). A Muse bar answers *what was true at
the last streaming turn*, which can be hours old — bounded only by the six-hour disk
horizon (`account-quota-disk.ts:28`), and unbounded in memory because the account-quota
TTL sweep is not registered as a `sweepExpired` callback (`001` §G).

Rendering the two identically is the one way this feature can actively mislead. So the
age is the honesty condition, not decoration.

## Scope boundary

`QuotaBars` is shared by the Codex account pool, the provider overview, the combo
workspace, and every OAuth account row. **The change must be additive and opt-in**: a
component that starts rendering a timestamp for every caller would put an age on
Anthropic's bars, where it is noise.

## MODIFY `gui/src/components/QuotaBars.tsx`

One optional prop, rendered only when passed:

```ts
  /**
   * Render "observed <age> ago" beside the bars. Set ONLY for a passively observed
   * quota (meta-muse), where the value can be arbitrarily old. A probed provider
   * refreshes on its own TTL and must not carry this.
   */
  observedAt?: number;
```

Rendered above the rows in both layouts, from the existing `quota.updatedAt`:

```tsx
{observedAt !== undefined && (
  <p className="quota-observed muted">{t("quota.observedAgo").replace("{age}", formatObservedAge(observedAt, t, locale))}</p>
)}
```

`formatObservedAge` is a new exported helper in the same file (co-located with
`buildQuotaRows`, which is already exported for the same reason). Buckets, chosen so the
string never implies more precision than an observation has:

| Elapsed | Output |
|---|---|
| < 60s | `quota.observedJustNow` |
| < 60m | `${n}m` |
| < 24h | `${n}h` |
| otherwise | `${n}d` |

A negative elapsed (clock skew between the write and the browser) renders as just-now
rather than a negative number.

## MODIFY `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`

At the `QuotaBars` call (`:522`), pass the prop **only** for the passive provider:

```tsx
<QuotaBars
  quota={account.quota ?? null}
  plan={null}
  threshold={80}
  t={t}
  layout="stacked"
  pending={account.quota == null}
  {...(item.name === "meta-muse" && account.quota ? { observedAt: account.quota.updatedAt } : {})}
/>
```

The provider id is compared here rather than a capability being plumbed through the
account payload: the GUI has no other consumer for such a flag, and one string in one
render site is easier to audit than a new field on every account row. If a second passive
provider appears, this becomes a server-sent boolean — recorded as the migration, not
done speculatively.

**The absent case needs no change.** `ProviderAuthPanel.tsx:517` already renders the
quota block only when `account.quota != null || account.quotaUnavailable ||
reserveQuotaSlots`, and `QuotaBars` returns `null` when `buildQuotaRows` is empty and
`pending` is false (`QuotaBars.tsx:193`). An account with no observation renders nothing,
which is already correct — c5's "not a zero bar" half is asserted, not implemented.

## MODIFY the locale files

Three keys in `gui/src/i18n/en.ts`, near the existing `quota.*` block:

```ts
  "quota.observedAgo": "Observed {age} ago",
  "quota.observedJustNow": "Observed just now",
  "quota.observedHint": "Meta reports usage only during a streaming response, so this is the last value seen — not a live reading.",
```

`quota.observedHint` is the `title` on the age line. Without it the user has no way to
know why this one provider's number lags.

Every other locale file (`ko`, `ja`, `zh`, `zh-TW`, `fr`, `de`, `ru`, `tr`) gets the
same three keys. Translate `ko` and leave the rest on the English string if no confident
translation exists — a missing key breaks the typed `TFn` lookup, which is the failure
mode to avoid.

## Tests

`gui/tests/quota-observed-age.test.tsx`:

- `formatObservedAge` bucket boundaries: 59s, 60s, 59m, 60m, 23h, 24h, and a negative
- `QuotaBars` without `observedAt` renders no age line (the regression that protects
  every other caller)
- with `observedAt` renders it in both `compact` and `stacked` layouts
- a `meta-muse` account row with a quota shows the age; an account without a quota
  renders no bars and no age

## Verification

```bash
bun test gui/tests/quota-observed-age.test.tsx gui/tests/oauth-tos-warning-gate.test.tsx
bun x tsc --noEmit
bun run lint:gui
cd gui && bun run build
```

Plus render grounding (C-RENDER-GROUNDING-01): this phase changes a rendered surface, so
C loads `http://localhost:10100/#providers` against a proxy carrying a real observation,
screenshots the Muse account row, and reads the screenshot back. A built-but-unviewed
bundle is not evidence.

## Terminal outcome

`DONE` when the Muse account row shows both windows with a truthful age, the same
component renders no age for Anthropic, and an account with no observation renders
nothing at all.
