# 020 — wp2: Codex Spark hidden by default, behind a Codex Auth switch

## What the operator sees today

Every account card on the Codex Auth page carries a second bar labelled
`GPT-5.3-Codex-Spark Weekly`, and in the owner's live dashboard all four accounts show it at
0%. It is emitted unconditionally by the WHAM parser
([quota.ts:611](../../../src/codex/quota.ts)) whenever `additional_rate_limits` contains the
`codex_bengalfox` feature.

Owner decision: **Spark is not shown by default.** It is a niche model window, it is 0% for
most operators, and on a four-account pool it doubles the row count for information almost
nobody is acting on. The switch exists because "not by default" is not the same as "never".

## Design direction (cxc-dev-uiux-design)

Three placements were considered against the existing page:

| Option | Verdict |
|---|---|
| Per-account toggle on each card | Rejected — the setting is about a *window kind*, not an account. Four toggles that must agree is a state-sync bug waiting to happen. |
| Advanced settings drawer | Rejected — the drawer already exists at the page foot, but burying a display toggle there means the operator who wants Spark back cannot find why it vanished. |
| **Page-header control row, beside Pause exhausted / Refresh quotas** | **Chosen.** |

The header row is where the page already keeps its *view-and-pool-wide* actions. A Spark
toggle is exactly that: it changes what every card renders, and it belongs next to the other
control that operates on all cards at once.

Presentation follows the existing header controls rather than introducing a new visual
vocabulary: same pill height, same border treatment, label + switch. It reads
`Codex Spark quota` with an on/off switch, not a bare unlabelled toggle — an unlabelled
switch in a header is a guessing game.

Copy: `codexAuth.showSparkQuota` = "Codex Spark quota", with a title/tooltip explaining that
the window only applies to GPT-5.3-Codex-Spark and is hidden by default. Localized across all
nine locales; `Codex Spark` stays untranslated as a product name (same treatment the
intentional-English allowlist already gives product nouns).

## MODIFY / NEW map

### Server: the setting must persist

**`src/types/config.ts`** — extend the existing GUI-preferences area with:

```ts
/**
 * Show the GPT-5.3-Codex-Spark weekly window on Codex account cards. Default false: the
 * window applies to one model, reads 0% for most operators, and doubles the bar count on a
 * multi-account pool.
 */
showCodexSparkQuota?: boolean;
```

**`src/server/management/*-routes.ts`** — read/write through the existing settings surface that
the Codex Auth page already talks to. Follow the surrounding preservation discipline: an
unrelated save must not drop it (the `oauthAccountFailover` lesson from #2568d).

### Where the row is suppressed — server, THREE projections (implementation correction)

The Spark window is dropped from the **API projection**, not hidden with CSS: anything the
client does not render, it should not receive.

An early draft justified this by claiming `maxQuotaUtilisation` would reorder Codex account
cards. That was wrong — it sorts the **Providers overview**
([ProviderOverviewDashboard.tsx:66](../../../gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx)),
not the account cards. The audit corrected it to two projections. **Implementation found a
third.**

| Path | Reaches the data via |
|---|---|
| `/api/codex-auth/accounts` | `quotaForPlan` ([auth-api.ts:212](../../../src/codex/auth-api.ts)) |
| `/api/provider-quotas` (pooled) | `listCodexAuthAccountsSnapshot` → the same DTO |
| `/api/provider-quotas` (**direct mode**) | `fetchMainAccountInfoSnapshot` ([providers/quota.ts:1121](../../../src/providers/quota.ts)) — **never touches the Codex Auth DTO** |

The third path is how a `codexAccountMode: "direct"` install reports quota, and filtering at
`quotaForPlan` alone leaves it untouched. It surfaced because the existing
`tests/provider-quota.test.ts` Codex case **still passed** after the first attempt — a test
asserting Spark is present, passing when it was supposed to have been filtered. That is the
useful kind of test failure.

The filter therefore lives in `withSparkVisibility` (exported from `auth-api.ts`) and is
applied at BOTH `quotaForPlan` and `providerQuotaFromCodexQuota`, the latter being the one
point every Codex-sourced provider report funnels through.

**Label-exact is not a nicety.** `customWindows` is the generic carrier for Cursor
(`First-party models`, `API usage`), Anthropic (`Fable`/`Opus`/`Sonnet`), Antigravity
(`Gem`/`Cla`), Kimi (`Total subscription credits`) and a dozen dynamic provider labels. A
filter written as "drop custom windows" blanks every one of them.

**Never at parse or cache time.** Custom windows participate in quota-presence checks, snapshot
reconciliation and capacity aggregation, so removing Spark upstream of the projection would
change routing state rather than display.


### Client

**`gui/src/components/CodexAccountPool.tsx`** — header control + optimistic state, following
the existing `refreshQuotas` / `pauseExhausted` handler shape.

**i18n** — `codexAuth.showSparkQuota` + tooltip in all nine locale files. Note the parser
landmine fixed in #2640: these catalogs pack several entries per line, so a new key must be
added in the same shape or the parity test's regex sees only the first entry per line.

## TESTS

| Layer | Case | File |
|---|---|---|
| Server | default (setting absent) → no Spark window on `/api/codex-auth/accounts` | `tests/codex-auth-api.test.ts` |
| Server | setting true → Spark window present, unchanged | same |
| Server | setting survives an unrelated settings save | same |
| Server | **default → no Spark window on `/api/provider-quotas`** (audit B2 round 2) | `tests/provider-quota.test.ts` |
| Server | non-Spark custom windows are NEVER filtered — Cursor, Anthropic, Antigravity, Kimi | `tests/provider-quota.test.ts` |
| GUI | `buildQuotaRows` renders a Spark row when given one | `gui/tests/quota-bars-rows.test.ts` |
| GUI | locale parity holds after the new keys | existing parity suites |

The fourth row is the one that matters most. Cursor's `First-party models` / `API usage`
windows travel through the same `customWindows` array
([QuotaBars.tsx:86](../../../gui/src/components/QuotaBars.tsx)); a filter written as "drop
custom windows" instead of "drop the Spark label" would silently blank the Cursor provider
card. Pin it by label.

## Verification (C)

```bash
bun test tests/codex-auth-api.test.ts
cd gui && bun test          # 994+ pass, 0 fail
bun run typecheck           # exit 0
```

Plus a **rendered screenshot of both states** — Spark hidden (default) and Spark shown after
flipping the switch — captured against a dev build via agbrowse. The PR gate requires a GUI
screenshot, and a claim that a row is hidden is only credible when the absence is visible.

## Activation scenario

Default-off must be proven by ABSENCE with the data present: the WHAM payload still carries
`codex_bengalfox`, the parser still writes the custom window, and the DTO still omits it. A
test that simply omits Spark from the fixture proves nothing.

## Dependency

Runs after wp1: both phases touch the quota display contract, and hiding one row is easier to
review once the neighbouring 5h/weekly rows are correct.
**Owner of the shared projection.** Both surfaces already funnel through `quotaForPlan`
([auth-api.ts:212](../../../src/codex/auth-api.ts)) — the Codex Auth rows directly, and
`/api/provider-quotas` via `listCodexAuthAccountsSnapshot`
([providers/quota.ts:1129](../../../src/providers/quota.ts)). `quotaForPlan` is therefore the
single filtering point, and B is done only when BOTH test targets above are green.
