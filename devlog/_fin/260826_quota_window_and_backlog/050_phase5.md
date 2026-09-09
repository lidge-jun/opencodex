# 050 — wp5: #1060 subscription billing-period date

## The gap, restated after audit B4

The original draft said the GUI "drops `expiresAt`". It is worse than that: the GUI drops the
**entire `creditsUsd` object** ([report.ts:42](../../../gui/src/provider-workspace/report.ts)),
and `AccountQuota` has no credits contract at all
([codex-quota-utils.ts:1](../../../gui/src/codex-quota-utils.ts)).

So there is no existing credits figure to hang a date beneath. This phase creates the credits
presentation and then dates it — which makes it the LARGEST of the three quick wins, not the
smallest. It stays last in the phase order for exactly that reason.

## What the backend already has

CommandCode's probe resolves `expiresAt` from `subscription.currentPeriodEnd`
([quota.ts:1824](../../../src/providers/quota.ts)) and attaches it to `creditsUsd`
(line ~1849). The type declares the full shape
([quota.ts:83](../../../src/providers/quota.ts)):

```ts
export interface ProviderQuotaCreditsUsd {
  used: number; limit: number; remaining: number; percent: number;
  expiresAt?: number; unlimited?: boolean;
}
```

## The condition worth reading carefully

```ts
...(expiresAt !== undefined && purchased <= 0 ? { expiresAt } : {})
```

`expiresAt` is emitted **only when no credits were separately purchased**. With a purchase,
the subscription period end no longer describes when the displayed balance resets, so the field
is withheld rather than shown misleadingly. The GUI must therefore treat absence as normal and
render nothing — not "unknown", not an em-dash placeholder.

## Label: "Billing period ends", not "Renews" (audit B4)

The source field is `currentPeriodEnd`. "Renews" asserts a continuation the field does not
promise — a cancelled subscription has a period end and no renewal. The existing quota bars say
"resets"; using that word here would imply the credit balance and the usage windows share a
clock, which they do not.

## MODIFY map

### `gui/src/provider-workspace/report.ts`

Project the whole typed `creditsUsd` object, not one field. `quotaFromUnknown` narrows
unknown wire data field by field; `creditsUsd` gets the same treatment with the existing
`finite()` guard on each numeric member and `expiresAt` optional.

### `gui/src/codex-quota-utils.ts`

`AccountQuota` gains the optional credits member so the projection has somewhere to land.

### `gui/src/components/provider-workspace/ProviderCapacityQuota.tsx`

New credits presentation: the balance figure, plus the billing-period line when `expiresAt`
is present. Locale-aware date formatting via the `bcp47` helper the quota surface already
uses ([QuotaBars.tsx](../../../gui/src/components/QuotaBars.tsx)).

### i18n

`quota.creditsBalance` and `quota.creditsPeriodEnds` = "Billing period ends {date}" in all
nine locales. Catalogs pack several entries per line — match the surrounding shape.

## TESTS

| Layer | Case | File |
|---|---|---|
| GUI | full `creditsUsd` survives the projection | `gui/tests/provider-workspace-state.test.ts` |
| GUI | malformed members are dropped, not propagated as NaN | same |
| GUI | absent `expiresAt` renders no period line | component test |
| GUI | present `expiresAt` renders a localized date | component test |
| GUI | locale parity after the new keys | existing parity suites |

Audit B4 flagged that the originally named `gui/tests/provider-report.test.ts` does not
exist, and that a projection test cannot prove rendered absence. The projection cases go in the
existing `provider-workspace-state.test.ts`; the two render cases need a real component
test.

## Verification (C)

```bash
cd gui && bun test
bun x tsc --noEmit
```

Plus a rendered screenshot of the Providers workspace showing the credits line with its billing
period — the PR gate requires one for GUI changes.

Closes #1060.

