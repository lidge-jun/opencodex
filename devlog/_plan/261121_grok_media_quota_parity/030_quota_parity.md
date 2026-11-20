# 030 — Codex and Grok quota/reset parity

Evidence: [001](./001_live_evidence.md#codex-quota). Commits:
`fix(codex): keep non-expiring reset credits and their detail fields`,
`fix(codex): calibrate Pro 100 and Pro 500 pool capacity`.

## Audit result

Live captures run through the existing parsers (Terra audit lane, read-only), cross-checked against
the parent OpenAI and xAI research reports:

| Surface | Verdict |
|---|---|
| `/wham/usage` Pro weekly-only payload | Correct: weekly 0 % with its reset, no short window, short/monthly marked absent. Matches the documented "Pro plans have no 5-hour window". |
| `/wham/usage` credits (string balance) | Correct |
| `rate_limit_reset_credits.available_count` | Correct, same field the official client reads. `applicable_available_count` stays unread: undocumented; the parent report saw 1 / 0 at 19 % used, consistent with the help-center rule that a reset applies only when an allowance has less than 80 % left, but that is inference |
| `/wham/rate-limit-reset-credits` rows | **Mismatch**: `safeResetCreditsDto` drops a credit whose `expires_at` is null, which the official client allows (`Option<String>`) |
| Plan types | `prolite`/`pro`/`promax` are Pro 100/200/500 (openai/codex `protocol/src/account.rs`, read via Aside). `src/providers/codex-capacity.ts` weights `prolite` 5 (the pre-2026-10-29 ratio) and has no `promax`, so a Pro 500 seat counts as one Plus seat |
| Grok `/v1/billing?format=credits` | Correct (percent, weekly end); same values as `grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig` (live grpc-web: period type 2 = WEEKLY, same start/end) |
| Grok legacy `/v1/billing` | Correct null for unified billing (zero monthly limit) |
| `GetRemainingResets` | Both `prod_mc_billing.ConsumerUiSvc` (used) and `grok_api_v2.GrokBuildBilling` answer status 0 with an empty message on this account; the populated shape could not be observed |

## Changes

### MODIFY `src/codex/auth-api/reset-credit-service.ts`

```ts
type ResetCreditRowDto = { granted_at: string; expires_at: string | null; reset_type?: string;
  status?: string; title?: string; description?: string };
function safeResetCreditsDto(input: unknown): { credits: ResetCreditRowDto[]; available_count?: number; total_earned_count?: number }
```
A row needs a string `granted_at`; `expires_at` is the string or `null` (absent → null); the four
display strings are copied when strings (200 chars max). `total_earned_count` is copied when finite.
Credit ids are not exposed. `createResetCreditWhamClient().inspect` keeps only rows with a string
`expires_at` for the auto-redeemer, whose schedule is expiry-based (its types stay `string`).

### MODIFY `src/providers/codex-capacity.ts`

```diff
-  prolite: 5,
+  // Pro 100 / Pro 500 doubled on 2026-10-29; 10x / 50x Plus (OpenAI staff, 2026-11-08). Display only.
+  prolite: 10,
+  promax: 50,
```
Update `structure/providers/openai-tiers.md` (capacity paragraph) and
`docs-site/src/content/docs/guides/providers.md` (+ locales carrying the same sentence) accordingly.

## Tests (failing first)

- New `tests/codex-integration/codex-reset-credit-dto.test.ts` (codex-auth-api.test.ts is at its
  ratchet cap), registered in layout + expected shard: route `GET /api/codex-auth/reset-credits` keeps
  a `{granted_at, expires_at: null}` row; detail strings and `total_earned_count` carried; ids and
  unknown fields dropped; the auto-redeem inspect client drops the null-expiry row.
- `tests/providers/provider-capacity.test.ts`: new cases (`promax` weighs 50 and is not an unknown plan;
  `prolite` weighs 10), and every existing expectation that uses `prolite` (lines 13-30, 77-81:
  aggregate weekly percent, total/consumed/remaining weight, recovery percent) recalculated with weight
  10; run the whole file plus `tests/codex-integration/codex-quota-window-conflict.test.ts`.

## Deliberately unchanged

- Consume by `credit_id`, and switching Grok coupon RPCs to `grok_api_v2.GrokBuildBilling`: both touch
  irreversible redemption that cannot be exercised live without spending a reset; the current paths are
  live-verified.
- `applicable_available_count`, `model_usage`, `rate_limit_reached_type`, `rate_limit_upsell` CTAs,
  Grok `productUsage`/`onDemand*`/`prepaidBalance`: no routing decision depends on them, semantics are
  undocumented or inferred. Treating 100 % weekly Grok usage as exhausted (instead of spilling into
  paid Additional Usage) stays the safer default.
