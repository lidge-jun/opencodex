# Model availability error classification

Carried from #4460 (AgenticLab-SH) as the tip of lane B in the contributor carry
train. This unit stays in `_plan` until the carry lands on `dev`; a `_fin` record
describes work already visible in public git history, which this is not yet.

## Problem

Account-gated native model selection inherited `CodexPoolAuthenticationError`, so every local
compatibility or capacity failure became HTTP 401 `invalid_api_key`. A healthy pool account that
did not support the selected model therefore looked like a broken credential.

## Change

- Added typed `unsupported` and `temporarily_unavailable` model-availability reasons.
- Mapped unsupported selections to 400 `invalid_request_error`.
- Mapped temporarily unavailable model-capable pools to 429 `rate_limit_error` with code
  `rate_limit_exceeded`.
- Reused the mapping on Responses, Images, Live, and Search surfaces.
- Preserved existing 401 behavior for actual pool credential failures.

## Verification

- Focused mapping tests cover 400, 429, and unchanged 401 behavior.
- The existing auth-context regression suite covers account-gated detours, exact selection,
  cooldowns, affinity, and reauthentication behavior.

## Catch-order audit

`CodexModelAvailabilityError` extends `CodexPoolAuthenticationError`, so any `catch` that
tests the parent first would fold the new 400 and 429 back into 401. Every such site was
audited during the carry:

- `src/server/responses/codex-auth-error.ts`, `images.ts`, `live.ts` and `search.ts` test the
  subclass before the parent. That order is the contract.
- `src/server/context-history.ts` folds the parent straight to 401 and was left unchanged. It
  resolves with `modelId: "context_history"`, and every `CodexModelAvailabilityError` throw
  site is gated on `ACCOUNT_GATED_NATIVE_OPENAI_MODELS` membership — directly, or through
  `modelEligibleAccountIds`, which is only populated for a gated model. The subclass therefore
  cannot reach that catch. `tests/codex-integration/codex-model-availability-error.test.ts`
  pins the membership that keeps this true.
- `src/server/responses/encrypted-payload.ts` and `collaboration.ts` import the parent but
  never branch on it.

Whether the context-history surface should adopt the same mapping outright is a maintainer
decision recorded on #4460, not a defect in this carry.
