# 010 — Anthropic pool quota exhaustion: terminal usage limit (#6991) and fresh-read recovery (#6989)

Base: origin/dev dc45bb2ca9. Branch: codex/6989-6991-anthropic-pool-quota-261012.

## Evidence on dev

- #6991. Local pool refusals become a retryable 429 `rate_limit_error` / `rate_limit_exceeded` at four sites:
  `src/server/responses/request-transport.ts:786-793` (pool-enabled initial selection, `all-cooled`),
  `src/server/responses/adapter-dispatch.ts:528-530` and `:788-790` (`AnthropicAccountCooldownError` after pacing / on the recovery leg),
  `src/server/responses/passthrough-dispatch.ts:951-953`. `formatErrorResponse` (`src/bridge/errors.ts:19`) classifies every 429 as
  `rate_limit_exceeded` (`src/lib/errors.ts:448-458`) and has no slot for `resets_at`. The first exhausted request returns the upstream
  429 as `Provider error 429: ...` with `rate_limit_exceeded` (`adapter-dispatch.ts:1679-1722`) after `rotateAnthropicAccountOnRefusal`
  finds no replacement (`src/oauth/anthropic-routing.ts:1062-1073`).
- Codex (openai/codex 6c372fbe, `codex-api/src/api_bridge.rs:181-218`) treats HTTP 429 with `error.type == "usage_limit_reached"` as
  non-retryable `UsageLimitReached` and reads `resets_at` as integer epoch seconds; a wrapped WebSocket `error` frame reuses the same
  classifier (`responses_websocket.rs:591-662`). OpenCodex's WS bridge keeps the nested error object (`src/server/ws-bridge.ts:369-403`).
  Without `plan_type` Codex prints its generic usage-limit copy; a ChatGPT plan type would print ChatGPT upgrade copy, so none is sent.
- #6989. `captureAnthropicCooldownRecovery` and `settleAnthropicCooldownRecovery` (`anthropic-routing.ts:379-412`) only claim
  `cooldownSource === "reset-derived"`. A shared-quota 429 that carries Retry-After records source `retry-after` (`:1131-1141`), so a fresh
  usage read showing headroom never lifts it. #6953 already records `refusedQuotaWindows` for every 429 regardless of deadline source and
  its reset-grant admission documents this gap (`src/providers/anthropic-reset-admission.ts:4-8`).

## Classification rule (#6991)

`recordAnthropicAccountRefusal` only records a 429 health entry for a `shared-quota` classification; transient throttles become admission
pauses and family-only rejections become family evidence. For each account the pool would otherwise consider (same filter as
`getAnthropicPoolRetryAfterSeconds`, including route/fallback expansion), collect its blocks:

| Block | Until | Quota? |
|---|---|---|
| live health entry, refusalStatus 429 | cooldownUntil | yes (shared-quota by construction, any deadline source) |
| live health entry, refusalStatus 403 | cooldownUntil | no (entitlement) |
| admission pause (transient Retry-After) | pause until | no |
| family exclusion, not revalidating | family retry time | yes |
| family exclusion, revalidation in flight (busy) | now + 1 s | no |

The account is quota-held when its latest block is a quota block (ties favor transient). The pool answers `usage_limit_reached` only when
no route candidate is eligible and every blocked account is quota-held. `resets_at` (epoch seconds) is computed apart from the
admission order: per account, the latest upstream window reset over all its quota holds (unknown if any rejected window lacks a
reset header or a family has no reset), then the earliest across accounts, omitted when any held account is unknown. Retry-After
stays the admission deadline. Anything else keeps today's `rate_limit_error` / `rate_limit_exceeded` with Retry-After.

## Recovery rule (#6989)

A cooldown is claimable by a fresh usage read when it is live, `refusalStatus === 429`, and either source is `reset-derived` (unchanged) or
the refusal named at least one rejected window (`refusedQuotaWindows`). Settlement requires the same generation, `quota.updatedAt >=
claimedAt` (unchanged stale-read fence) and `percent < 100` for every window in `rejectedQuotaWindows` if present, else
`refusedQuotaWindows`. 403 refusals and windowless non-reset-derived 429s are never claimed; a reset-derived aggregate refusal stays
claimable as before but is always retained. Claimed probes already force a fresh dispatch
(`requiresFreshDispatch`), so a cached or joined older read cannot settle.

## Changes (as implemented)

1. `src/oauth/anthropic-routing.ts`: `AnthropicAccountCooldownError` gains `usageLimit: { resetsAt: number | null } | null` and
   `retryableMessage`; its message names the usage limit and, when known, the ISO reset. 429 health entries record `quotaResetAt`
   via `rejectedWindowsResetAt` (only when every rejected window carries a reset). `anthropicAccountHold` returns the admission winner
   plus the account's quota reset computed over all quota holds. `anthropicPoolCooldownError(now, decision, model)` builds the refusal;
   `getAnthropicPoolRetryAfterSeconds` delegates to it; `resolveAnthropicDispatchAccountId` throws it.
   `anthropicPoolUsageLimitAfterRefusal` returns it only for a usage limit. Recovery claim/settle widened as above.
2. `src/oauth/anthropic-model-quota.ts`: `anthropicFamilyHoldState` (revalidating flag and family window reset).
3. `src/bridge/errors.ts`: `formatUsageLimitReachedResponse(message, resetsAtMs | null, retryAfterSeconds)`.
4. `src/server/responses/core-errors.ts`: `anthropicPoolCooldownResponse(refusal, { comboAttempt, logCtx })` — usage limit for direct
   requests (sets `logCtx.errorCode`), the old `rate_limit_error` body and wording for combo children.
5. Sites: `request-transport.ts` pool-enabled `all-cooled` refusal; both `AnthropicAccountCooldownError` catches in
   `adapter-dispatch.ts`; the passthrough catch; the final non-combo upstream 429 in `adapter-dispatch.ts`; the first-iteration 429 of a
   routed web-search loop in `sidecar-execution.ts`.
6. Native Messages keeps Anthropic `rate_limit_error`; its message carries the usage-limit wording.
7. Docs: `src/providers/anthropic-reset-admission.ts` comment, `structure/providers/anthropic-account-pool.md` (new section),
   `structure/transports/responses-failover.md`, docs-site `reference/configuration/providers.md`.

## Boundaries (unchanged identity)

Image bridge terminal, opt-in empty-completion continuation, Chat Completions translation, combo final-error identity
(`core-combo-failure.ts`), Codex-account cooldown path (`src/codex/auth-context.ts`), dashboard reason label for retry-after quota
cooldowns (`src/oauth/health.ts:224`). #6962 shares `adapter-dispatch.ts`, `request-transport.ts` and `messages-native.ts` but not the
edited statements; rerun billing tests on the union once it lands.

## Tests

- `tests/adapters/anthropic/anthropic-pool-usage-limit.test.ts` (12): quota-held pool answers `usage_limit_reached` with `resets_at`
  (pool on and off); unequal Retry-After/reset; unknown reset omits `resets_at`; partial reset headers; reset independent of admission
  winner; transient throttle and 403 keep `rate_limit_exceeded`; last upstream refusal answers the usage limit; throttled sibling keeps
  the provider rate limit; family quota vs revalidation; routed web-search loop; combo child body byte-identical; no account material
  in bodies or warn logs.
- `tests/adapters/anthropic/anthropic-quota-cooldown-recovery.test.ts` (11): Retry-After quota cooldown lifted by a fresh read (both
  instances); partial window retained; stale and superseded claims; default-source recovery; 403 and windowless never claimed;
  aggregate reset-derived retained; read started before a refusal cannot lift it; instance isolation; tie with a transient pause.
- Updated: `anthropic-cooldown-recovery.test.ts` (named-window Retry-After/default now clear; windowless/403 do not),
  `anthropic-model-routes.test.ts` (helper-named spent window answers `usage_limit_reached`).

## Verification

`bun run typecheck`, `bun test --isolate` over `tests/adapters/anthropic/`, `tests/oauth/`, layout/lab/core-module/reset-grant files,
`bun run test:changed`, `bun run structure:check`, `bun run privacy:scan`, `git diff --check`.

## Independent audit (GPT-6.1-Sol, builder Claude)

- r1 FAIL: reset vs admission deadline, combo prose, race tests, surfaces, docs — folded except image/continuation/Chat (boundary).
- r2 FAIL: partial reset headers, reset vs admission winner, routed web-search terminal, stale test expectation, plan text — all folded.
- r3 NEAR-PASS: no runtime defect; low finding on this document's stale text, fixed here.
