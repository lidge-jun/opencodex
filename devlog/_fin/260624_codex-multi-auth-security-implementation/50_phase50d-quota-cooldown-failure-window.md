# 50D - Phase 50D Plan: 429 Cooldown And Failure Window

Date: 2026-06-24

Status: planned, audit-revised.

## Objective

Continue Patch 5 by making quota/rate-limit outcomes operational:

- 429 responses put the selected pool account into a temporary cooldown using `Retry-After` or Codex reset headers.
- cooled accounts are skipped for new thread selection when another usable pool account exists.
- if every selected pool option is cooled, the proxy fails closed with a 429 instead of falling back to inbound/main auth.
- old transient failure streaks expire so a stale 5xx from minutes ago does not combine with a new failure forever.

External basis:

- RFC 6585 defines `429 Too Many Requests` and says responses may include `Retry-After`.
- RFC 9110 defines `Retry-After` as either delay-seconds or an HTTP date.

## Acceptance Criteria

- `recordCodexUpstreamOutcome(config, accountId, 429, { retryAfter })` stores `cooldownUntil`.
- Valid `Retry-After` delay-seconds and HTTP-date values are parsed; invalid/missing values fall back to a short default cooldown.
- Codex reset headers can be used as a cooldown fallback when `Retry-After` is absent.
- A cooled account is not selected for new threads or stale thread affinity when another usable account exists.
- Recording 429 clears affinity for that account.
- If the active selected pool account is cooled and no alternative exists, `resolveCodexAuthContext()` throws a cooldown error and `handleResponses()` returns a generic 429. It must not return `{ kind: "main" }`.
- Transient failure streaks expire after a bounded window before they can trigger threshold failover.
- Already-upgraded WebSocket turns re-check cooldown before reusing cached pool auth context.
- Existing caller 4xx, credential 401/403, 5xx/connect behavior from 50B remains unchanged.
- No account id, email, token, or alias is logged or returned in cooldown errors.

## File Plan

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/src/codex-routing.ts`

Expand upstream health:

```ts
type CodexUpstreamHealth = {
  consecutiveFailures: number;
  lastFailureStatus?: number;
  lastFailureAt?: number;
  cooldownUntil?: number;
};
```

Add constants:

```ts
const CODEX_DEFAULT_QUOTA_COOLDOWN_MS = 60_000;
const CODEX_MAX_QUOTA_COOLDOWN_MS = 24 * 60 * 60_000;
const CODEX_FAILURE_WINDOW_MS = 5 * 60_000;
```

Add metadata:

```ts
export type CodexUpstreamOutcomeMeta = {
  retryAfter?: string | null;
  resetAt?: unknown | unknown[];
  now?: number;
};
```

Add helpers:

- `parseRetryAfterMs(value, now)`:
  - positive integer/decimal seconds;
  - HTTP date via `Date.parse`;
  - clamp to max cooldown;
  - invalid/non-positive => `undefined`.
- `parseResetCooldownMs(resetAt, now)`:
  - supports epoch seconds or epoch milliseconds;
  - accepts an array and picks the earliest valid future reset;
  - clamps to max cooldown.
- `computeQuotaCooldownUntil(meta)`:
  - `Retry-After` first;
  - then reset header(s);
  - then default 60 seconds.
- `export function isCodexAccountInCooldown(accountId, now = Date.now())`.
- `export function getCodexAccountCooldownUntil(accountId, now = Date.now())`.

Change selection:

- `getEligiblePoolAccounts()` filters cooled accounts.
- mapped thread affinity revalidates both usability and cooldown.
- active account cooldown triggers `pickLowestUsageCodexAccount(config, active)`.
- if an alternative exists, set active to it.
- if no alternative exists, return the active id rather than `null`; `resolveCodexAuthContext()` will fail closed instead of falling back to main.

Change recording:

- `recordCodexUpstreamOutcome(config, accountId, outcome, meta?)`.
- `success` clears transient failure streaks but does not clear an unexpired cooldown, because concurrent in-flight requests can complete out of order after a 429. Expired cooldown data can be removed opportunistically.
- `caller` remains ignored.
- `credential` remains reauth+affinity purge.
- `quota` stores cooldown, clears affinity, and immediately switches active account to a non-cooled fallback when one exists.
- `transient` and `unknown` use `CODEX_FAILURE_WINDOW_MS`: if the current streak is stale, start at 1 rather than incrementing.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/src/codex-auth-context.ts`

Import `getCodexAccountCooldownUntil`.

Add:

```ts
export class CodexAccountCooldownError extends Error {
  accountId: string;
  cooldownUntil: number;
}
```

In `resolveCodexAuthContext()`:

- after `resolveCodexAccountForThread()`, if an account id exists and `getCodexAccountCooldownUntil(accountId)` returns a future timestamp, throw `CodexAccountCooldownError`.
- do this before token fetch, so a cooled account cannot execute through main or itself while no fallback exists.

Export a helper:

```ts
export function assertCodexAuthContextNotCooled(ctx: CodexAuthContext): void
```

It throws `CodexAccountCooldownError` when `ctx.kind === "pool"` and the account still has a future cooldown. HTTP paths that resolve a fresh auth context will be covered by `resolveCodexAuthContext()`; WebSocket per-message reuse will call this helper before `handleResponses()` receives cached `ws.data.authContext`.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/src/server.ts`

Import `CodexAccountCooldownError`.

Catch it anywhere `resolveCodexAuthContext()` is called:

- HTTP `handleResponses()` catch returns `429 rate_limit_error` with generic message.
- WebSocket upgrade catch returns the same generic 429 response.

Also protect already-upgraded WebSocket messages:

- before building the per-message request inside the `message` handler, call `assertCodexAuthContextNotCooled(ws.data.authContext)`;
- if it throws, send a safe WebSocket error frame with status `429` and no account id/email/token;
- do not call `handleResponses()` for that frame.

In passthrough response recording:

- collect `retry-after`;
- collect `x-codex-primary-reset-at`, `x-codex-secondary-reset-at`, `x-codex-tertiary-reset-at`;
- pass them as metadata to `recordCodexUpstreamOutcome()`.

Sidecar callbacks intentionally keep status-only recording for now because they do not expose reset headers at the server call site.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/tests/codex-routing.test.ts`

Add/adjust tests:

- 429 with `Retry-After: 120` stores `cooldownUntil`.
- 429 with reset header stores cooldown from reset when no `Retry-After` exists.
- 429 on active account switches new threads to another usable account and clears old thread affinity.
- expired cooldown is ignored by `isCodexAccountInCooldown()`.
- stale transient streak expires after `CODEX_FAILURE_WINDOW_MS` via `now` metadata.
- existing 5xx threshold behavior still works inside one window.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/tests/codex-auth-context.test.ts`

Add cleanup for upstream health in hooks.

Add test:

- active pool account has valid credentials and inbound main auth exists;
- record a 429 cooldown for the active pool with no alternative pool;
- `resolveCodexAuthContext()` rejects with `CodexAccountCooldownError`, not `{ kind: "main" }`.
- `assertCodexAuthContextNotCooled()` rejects a cached pool context while cooled and accepts it after expiry.

### OPTIONAL MODIFY `/Users/jun/Developer/new/700_projects/opencodex/tests/server-auth.test.ts`

Only if a server-level 429 response test is cheap. Routing and auth-context tests are sufficient for this slice.

## Verification Plan

Focused:

```bash
bun test tests/codex-routing.test.ts tests/codex-auth-context.test.ts
```

Full:

```bash
bun run typecheck
bun test tests
cd gui && bun run build
git diff --check
git status --short
```

Independent verification:

- read-only verifier checks cooldown math, no main fallback on cooled single-account pool, stale failure-window reset, and no PII/token leakage.

## Plan Audit Fixes

- WebSocket per-message cached `authContext` now gets an explicit cooldown guard instead of relying only on upgrade-time `resolveCodexAuthContext()`.
- 2xx success no longer clears an unexpired cooldown; it only clears transient failure streak data and preserves quota cooldown until expiry.

## Out Of Scope For This Slice

- Terminal SSE/WebSocket `response.failed` / `response.incomplete` post-stream outcome recording.
- UI display of cooldown state.
- Persisting cooldown across process restart.

## Build Evidence

Status: implemented in B.

Implementation files:

- `/Users/jun/Developer/new/700_projects/opencodex/src/codex-routing.ts`
  - Added quota cooldown health state, `Retry-After` parsing, Codex reset-header cooldown fallback, 24h clamp, 60s default, and 5-minute transient failure window.
  - Filtered cooled pool accounts out of new-thread and stale-affinity selection when another usable pool account exists.
  - Preserved fail-closed behavior by returning the configured cooled active pool account when no alternative exists, so auth context resolution can reject it instead of returning main.
  - Made 429 clear account affinity and switch the global active pool to a non-cooled fallback when available.
  - Made 2xx success clear transient failure streaks while preserving unexpired 429 cooldown.
- `/Users/jun/Developer/new/700_projects/opencodex/src/codex-auth-context.ts`
  - Added `CodexAccountCooldownError`.
  - Added cooldown checks before token fetch in `resolveCodexAuthContext()`.
  - Added `assertCodexAuthContextNotCooled()` for already-upgraded WebSocket turns that reuse a cached pool auth context.
- `/Users/jun/Developer/new/700_projects/opencodex/src/server.ts`
  - Returns generic 429 `rate_limit_error` for cooldown errors on HTTP and WebSocket upgrade.
  - Passes `Retry-After` and Codex reset headers into `recordCodexUpstreamOutcome()` for passthrough responses.
  - Re-checks cached WebSocket pool auth context before each `response.create` turn and sends a generic 429 error frame when cooled.
- `/Users/jun/Developer/new/700_projects/opencodex/tests/codex-routing.test.ts`
  - Added coverage for delay-seconds and HTTP-date `Retry-After`, reset-header fallback, affinity clearing, active fallback, success preserving cooldown, and stale transient failure window reset.
- `/Users/jun/Developer/new/700_projects/opencodex/tests/codex-auth-context.test.ts`
  - Added coverage for cooled single-pool fail-closed behavior with inbound main auth present.
  - Added coverage for cached pool auth context rejection while cooled and acceptance after expiry.

Verification evidence:

- `bun test tests/codex-routing.test.ts tests/codex-auth-context.test.ts` -> 37 pass, 0 fail.
- `bun run typecheck` -> pass (`bun x tsc --noEmit`).

Privacy evidence:

- Returned cooldown errors use only the generic message `Selected Codex account is cooling down`.
- No account id, email, token, or local alias is returned or logged by the cooldown path.
