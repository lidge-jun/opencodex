# 020 — Preserve xAI weekly usage when expiry is unrenderable

The wire guard in #2950 fixes the render crash but exposes a second loss of data in xAI quota
parsing. On `dev@47b8d1643`, `parseXaiCreditsResponse` in `src/providers/quota.ts:1150-1164`
requires `normalizeResetAt(period.end)` to succeed before it even validates
`creditUsagePercent`. Once #2950's `6fcd39ac0` teaches `epochMillis` to reject a time beyond
ECMAScript's ±8,640,000,000,000,000 ms range, a weekly response such as
`{ creditUsagePercent: 57.4, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: 1e20 } }`
therefore becomes `null` even though its utilization is valid.

That `null` is not a harmless omission of the date. `fetchXaiWeeklyCredits` consumes the parser
at `src/providers/quota.ts:1166-1185`; losing the parsed result drops the preferred
`xai:grok-billing-credits` weekly meter. The caller then falls back to the legacy monthly billing
probe, or produces no xAI quota report when that fallback is unavailable. The phase must retain
the valid weekly percentage and omit only the reset timestamp that no formatter can render.

## Landing shape

#2950 is the landing vehicle. Its first commit, `6fcd39ac0`, is byte-identical to the sole
commit in #2951, so the two PRs are not independent changes and must not both land. Keep
`6fcd39ac0` in #2950 unchanged, keep its existing GUI and screenshot commits unchanged, and add
exactly one repair commit on top of `bcbc3ad5898bc56609ba1bfcb44ad553c4d80a84`. That repair
commit owns only `src/providers/quota.ts` and `tests/provider-quota.test.ts`.

The carried #2950 changes remain as authored:

- `src/providers/quota-wire.ts:31-38` expands `epochMillis`. The original `dev` body at lines
  31-33 accepts every positive finite number; `6fcd39ac0` resolves seconds versus milliseconds,
  then rejects an invalid `Date` time value. Its existing regression is
  `tests/command-code-quota.test.ts`, case
  `an out-of-range subscription period end is dropped, not carried into the report`, inserted
  after the test ending at the original line 365.
- `gui/src/provider-workspace/report.ts:38-95` changes the `quotaFromUnknown` path. The original
  `creditsExpiresAt` assignment at line 64 checks only finiteness; #2950 adds `dateTimestamp` and
  drops an unrepresentable persisted `creditsUsd.expiresAt` while preserving the balance fields.
  The assertion stays in
  `provider quota reports reject malformed required credits and drop malformed optional members`
  in `gui/tests/provider-capacity.test.ts`.
- `gui/src/components/provider-workspace/ProviderCapacityQuota.tsx:58-105` is the independent
  render boundary. On the snapshot, `formatRecoveryAt` at lines 59-62 and `formatPeriodEnd` at
  lines 68-70 call `Intl.DateTimeFormat` without checking the constructed `Date`; the render at
  lines 94-105 therefore lets either `expiresAt` or `nextRecoveryAt` abort the whole panel.
  #2950's `asDate`, nullable formatters, and conditional rows omit only the bad date line. The
  render regression is `credits with an unrepresentable expiry still render the balance` in
  `gui/tests/provider-capacity-credits.test.tsx`.
- `assets/pr2950-capacity-expiry.png` is the committed before/after evidence. Because #2950's
  title mentions `gui`, `enforce-target` requires a screenshot in the PR description. The
  description already embeds this asset; preserve that image reference when updating the PR.

## One repair commit

In `src/providers/quota.ts`, change only `parseXaiCreditsResponse` at the snapshot's lines
1150-1164. Keep the envelope and weekly-period checks at lines 1151-1155 unchanged. Compute
`resetAt = normalizeResetAt(period.end)`, but do not return `null` when it is `undefined`.
Independently derive `percent`: use `0` when `creditUsagePercent` is absent, preserving the
documented proto3 default, otherwise pass the supplied value through `normalizePercent` and
return `null` only when that percentage is invalid.

Return one object after those checks:

```ts
return {
  percent,
  ...(resetAt !== undefined ? { resetAt } : {}),
};
```

This keeps all existing contracts distinct. A non-weekly period is still rejected. A malformed
explicit percentage is still rejected. A missing percentage is still zero. A representable reset
is still returned. Only an unrepresentable reset changes from discarding the whole weekly sample
to returning its valid percentage without `resetAt`. `fetchXaiWeeklyCredits` already conditionally
adds `weeklyResetAt` at `src/providers/quota.ts:1182-1185`, so no caller change is needed.

In `tests/provider-quota.test.ts`, add the exact case
`parseXaiCreditsResponse preserves weekly percent when reset is unrenderable` immediately after
`parseXaiCreditsResponse maps weekly credits and rejects non-weekly periods` at lines 2378-2402
and before the integration case beginning at line 2404. Pass a weekly envelope with
`creditUsagePercent: 57.4` and `end: 1e20`, and assert strict equality with
`{ percent: 57.4 }`. The absent `resetAt` assertion matters: accepting the percentage while
leaking the invalid timestamp would merely move the original formatter crash downstream.

## Focused verification and disposition

Run only the files that exercise the carried wire/GUI guards and the repaired xAI parser:

```bash
bun test tests/provider-quota.test.ts tests/command-code-quota.test.ts
(cd gui && bun test tests/provider-capacity.test.ts tests/provider-capacity-credits.test.tsx)
```

Do not run `bun run test`, `bun test tests`, or the full GUI suite locally in this phase. The
train's exact-head cross-platform and Windows gates belong to wp6. Because the repair push changes
the PR head, complete #2950's review-readiness checklist again against that new head before the
merge; do not reuse the attestation attached to `bcbc3ad5898`.

Merge #2950 only after the focused files pass and its required screenshot remains in the
description. Once the merge is present on `dev`, close #2951 without merging it and leave the
terminal note `Superseded by #2950, merged as <superseding merge SHA>.` The SHA named there must
be the actual #2950 merge on `dev`, not `6fcd39ac0`, so the close-out points to the integration
event that made #2951 redundant.
