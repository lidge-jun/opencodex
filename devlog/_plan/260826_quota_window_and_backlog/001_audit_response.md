# 001 — audit response: the roadmap was locally right and globally incomplete

An independent read-only auditor returned **FAIL** with five blocking findings. I verified each
against the tree. **All five hold.** One of them is the kind that turns a fix into a regression,
so it is worth stating plainly rather than burying in a table.

## B1 — the parser fix alone would have BROKEN routing. ACCEPTED, and it is the important one.

`src/routing/quota.ts:37` computes routing-profile headroom from `weeklyPercent` and
`monthlyPercent` — and **not** `shortPercent`. That omission is invisible today precisely
because the header parser is broken: the 5h value is being written into `weeklyPercent`, so
routing accidentally sees it.

Measured on the live module:

```
headroom BEFORE the wp1 fix : 0.03   (reads 97% used — accidentally correct)
headroom AFTER  the wp1 fix : 0.88   (reads 12% used — WRONG, burst is at 97%)
```

Fixing the parser without fixing `routing/quota.ts` would take a 5-hour-exhausted account from
"3% headroom" to "88% headroom" and route traffic straight into a 429. The bug is currently
cancelling itself out, and the roadmap's "only the parser changes" claim would have removed one
half of the cancellation.

Note the asymmetry that made this easy to miss: `computeCodexUsageScore` in
`src/codex/routing.ts:339` **does** fold in `shortPercent`, and that is the file I read.
`src/routing/quota.ts` is a different module with a similar name and a different rule.

**Fold:** wp1 gains `src/routing/quota.ts` — add `shortPercent` to the percent set and
`shortResetAt` to the reset set — plus a regression asserting headroom stays low when only the
burst window is exhausted.

## B2 — wp2's server-filter rationale named the wrong surface. ACCEPTED with a correction.

I justified server-side filtering by claiming `maxQuotaUtilisation` would reorder Codex account
cards. The auditor checked: `maxQuotaUtilisation` sorts the **Providers overview**
(`ProviderOverviewDashboard.tsx:66`), not the Codex Auth cards. My stated reason was wrong.

The conclusion survives on a better reason. Spark reaches the GUI through **two** independent
projections — `/api/codex-auth/accounts` and `/api/provider-quotas` (the latter via
`listCodexAuthAccountsSnapshot`, `providers/quota.ts:1129`). Filtering one leaves the other
showing the row the operator switched off.

**Fold:** wp2 filters at a shared projection covering both surfaces, and tests both. The
label-exact requirement stands and is now better supported: `customWindows` carries Cursor's
`First-party models`/`API usage`, Anthropic's `Fable`/`Opus`/`Sonnet`, Antigravity's
`Gem`/`Cla`, Kimi's `Total subscription credits` and a dozen dynamic provider labels. A
"drop custom windows" filter would blank all of them.

## B3 — wp4's own dedupe criterion would have failed. ACCEPTED.

`applyProxyEnv` builds `seen` from **lowercased** entries (`config.ts:3122`) but my proposed
loop pushed configured entries without normalizing, so a configured `LOCALHOST` would be
followed by `localhost`. The plan's own accept-criteria row would have failed the plan's own
code.

Also accepted: #1215 asks for `string[]`; I specified a comma-separated `string` without
recording the deviation. **Decision, now recorded:** accept `string | string[]` and normalize.
The string form matches `NO_PROXY` syntax the operator already knows and matches the sibling
`proxy` field; the array form is what the issue asked for and is unambiguous about separators.
Supporting both costs one `Array.isArray` branch.

## B4 — wp5 was written against a UI that does not exist. ACCEPTED.

I claimed the GUI "drops `expiresAt`". It drops the **entire `creditsUsd` object**
(`report.ts:42`), and `AccountQuota` has no credits contract at all. There is no credits
figure to render a date beneath, and `gui/tests/provider-report.test.ts` — which I cited as the
test location — does not exist.

**Fold:** wp5 projects the whole typed `creditsUsd` shape and creates the presentation, which
makes it the largest of the three quick wins rather than the smallest. Label corrected to
**"Billing period ends"**: the source is `subscription.currentPeriodEnd`, and "Renews" asserts
a continuation the field does not promise.

## B5 — acceptance evidence gaps. ACCEPTED.

- The wp1 "property" test was three fixed examples. Add the **24-hour boundary**: 1439 minutes
  is short, 1440 is not — strict `<` in both predicates, verified at `quota.ts:211`.
- wp3's negative table used short names; upstream ids are `deepseek/deepseek-v4-flash`,
  `deepseek/deepseek-v4-pro`, `zai-org/GLM-5.2`, `zai-org/GLM-5.3`, `xai/grok-4.6`. A
  shortened name asserts absence of something that was never present — vacuously green.
- Goalplan criteria carry no `expectedEvidence` and no work-phase mapping. Fill both.

## B6 (finding 7) — phase ordering. PARTIALLY REBUTTED.

The auditor is right that wp1→wp2 is not a data dependency and that wp3-wp5 are independent.
I accept the correction and have removed the dependency claim from wp1→wp2.

Where I do not fully agree: PHASE-SPLIT-01 forbids ordering by **effort or payoff speed**, not
ordering independent slices at all. wp3-wp5 have no edges between them, so *some* order must be
chosen; ascending blast radius (static data → config plumbing → GUI surface) is a risk ordering,
not a quick-win-first ordering. B4 makes this concrete: wp5 turned out to be the largest of the
three, and it stays last — an effort ordering would now move it first.

## Net effect

Five folds, one partial rebuttal. The scope grows in two places that matter: wp1 gains a second
file without which it would regress routing, and wp5 roughly doubles. The roadmap docs are
amended in place; this document records why.

VERDICT accepted: **near-pass with five folded blockers**. Proceeding to B.

