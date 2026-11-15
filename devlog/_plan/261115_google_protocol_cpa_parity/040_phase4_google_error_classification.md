# 040 — Phase 4: Google error classification (ErrorInfo, RetryInfo, TOS_VIOLATION)

Rows: AG-X1, AG-X2, AG-X3 (all P1). Class C3: the TOS part writes durable account state through the
existing fenced `markAccountNeedsReauthIfGeneration` path. Independent of #8742.

## Current behaviour (d842c1352e)

- `src/adapters/google-errors.ts`: classification reads only `error.message`/`error.status` prose
  (`GOOGLE_QUOTA_EXHAUSTED_NEEDLES`, `GOOGLE_TRANSIENT_RATE_LIMIT_PATTERNS`); the only structured reason
  read is `VALIDATION_REQUIRED` (`hasAntigravityValidationReason`). `extractGoogleRetryAfterSeconds`
  accepts only `^\d+(\.\d+)?s$`.
- `src/adapters/google-http.ts:139-172`: the body delay is used only on the quota-exhausted branch; the
  transient 429 backoff calls `retryBackoffDelayMs` with `res.headers` only, so a body-only
  `RetryInfo.retryDelay` gives the 250 ms → 2 s ladder.
- `src/adapters/antigravity-refusal.ts:50-57`: only the "verify your account" prose convicts an account.

CPA reference: `internal/runtime/executor/antigravity_executor_credits.go:219-288` (429 reasons),
`:358-439` (TOS), `internal/runtime/executor/helps/json_retry_helpers.go:35-80` (delays). Tests to
mirror: `antigravity_executor_credits_test.go:149` (`TestClassifyAntigravity429`), `:246`
(`TestParseRetryDelay_HumanReadableDuration`), `antigravity_executor_tos_test.go:40,171,219`.

## 4a — structured details (X1, X2)

NEW `src/adapters/google-error-details.ts` (a separate module so the parsing is testable on its own;
`google-errors.ts` is 179 lines with no baseline entry, under the 2,000-line threshold):

```ts
export interface GoogleErrorDetails { reason?: string; domain?: string; retryDelayMs?: number }
/** google.rpc details from {error:{details:[...]}} or [{error:{...}}]; bounded input, never throws. */
export function googleErrorDetails(payloadText: string): GoogleErrorDetails;
/** Google duration text: "30s", "0.5s", "1h2m3s", "1.5h", "500ms", "2m". Returns ms or undefined; rejects negatives, >30 days, garbage. */
export function parseGoogleDurationMs(raw: string): number | undefined;
```

`reason` comes from the `@type …google.rpc.ErrorInfo` entry; `reasonUntyped` separately records a string
`reason` on a detail with no `@type` (CCA sometimes omits it), usable for retry classification only and
never for the durable TOS mark; `retryDelayMs` from `RetryInfo.retryDelay`, then
`ErrorInfo.metadata.quotaResetDelay`, then the message pattern `reset after <duration>` (CPA's fallback).

MODIFY `src/adapters/google-errors.ts`:

```diff
 export function isQuotaExhaustedBody(payloadText: string): boolean {
+  const { reason } = googleErrorDetails(payloadText);
+  if (reason === "QUOTA_EXHAUSTED" || reason === "INSUFFICIENT_G1_CREDITS_BALANCE") return true;
+  if (reason === "RATE_LIMIT_EXCEEDED") return false;
   const { message, status } = googleErrorDetail(payloadText);
@@ export function extractGoogleRetryAfterSeconds(payloadText: string): string | undefined {
-  …regex /^\s*(\d+(?:\.\d+)?)\s*s\s*$/i over details…
+  const ms = googleErrorDetails(payloadText).retryDelayMs;
+  return ms !== undefined && ms > 0 ? String(Math.ceil(ms / 1000)) : undefined;
 }
@@ function classifyGoogle(label, status, enumStatus, text, reason?)
+  if (reason === "QUOTA_EXHAUSTED" || reason === "INSUFFICIENT_G1_CREDITS_BALANCE") return `${label} quota exhausted`;
+  if (reason === "RATE_LIMIT_EXCEEDED") return `${label} rate limit exceeded`;
```

`safeGoogleHttpErrorMessage` passes `googleErrorDetails(payloadText).reason` into `classifyGoogle`.
Prose stays as the fallback for bodies without details (D6). Scope: `QUOTA_EXHAUSTED` and
`INSUFFICIENT_G1_CREDITS_BALANCE` convict quota exhaustion on every Google label; the
`RATE_LIMIT_EXCEEDED` → transient override applies to `label === "Antigravity"` only, matching CPA, which
reads ErrorInfo only on Antigravity (C-V-46). On AI Studio and Vertex the daily-quota prose needles still
win over `RATE_LIMIT_EXCEEDED`. `isQuotaExhaustedBody` gains a `label` parameter for that.

MODIFY `src/adapters/google-http.ts` (transient 429 path):

```diff
+      let delayHeaders: Headers = res.headers;
+      if (res.status === 429 && !res.headers.has("retry-after")) {
+        const bodyRetryAfter = extractGoogleRetryAfterSeconds(peek);   // peek moves out of the quota branch
+        if (bodyRetryAfter) { delayHeaders = new Headers(res.headers); delayHeaders.set("retry-after", bodyRetryAfter); }
+      }
       const delayMs = retryBackoffDelayMs(attempt, {
         baseDelayMs: GOOGLE_RETRY_BASE_MS,
         maxDelayMs: GOOGLE_RETRY_MAX_MS,
-        headers: res.headers,
+        headers: delayHeaders,
         retryAfterIsLowerBound: true,
       });
       if (delayMs > RETRY_AFTER_CEILING_MS) {
-        return … normalizeFinalGoogleError(label, res, …);
+        return … withBodyRetryAfter(normalizeFinalGoogleError(label, res, …), peek);   // client sees the stated wait
       }
```

`withBodyRetryAfter` sets `retry-after` from the body when the header is absent, mirroring the quota
branch. Stale check: how existing Retry-After tests in `tests/adapters/google/` observe the computed
delay without sleeping (an injected sleep or the `beforeDispatch` hook); the new tests use the same seam.

## 4b — TOS_VIOLATION (X3)

- `google-errors.ts`: `export const ANTIGRAVITY_TOS_VIOLATION_PREFIX = "Antigravity account suspended (TOS_VIOLATION)"`;
  `safeGoogleHttpErrorMessage` uses it for `label === "Antigravity" && status === 403 && reason === "TOS_VIOLATION"`.
  The appeal URL in `ErrorInfo.metadata` is never copied into the message (only the sanitized
  `error.message` is).
- `antigravity-refusal.ts`: `AntigravityRefusalKind = "verify_account" | "tos_violation" | "other"`;
  `classifyAntigravityRefusal` returns `tos_violation` only when the bounded body parses to
  `error.code === 403`, `status === "PERMISSION_DENIED"` and a detail with
  `@type: "type.googleapis.com/google.rpc.ErrorInfo"` and `reason: "TOS_VIOLATION"`, as CPA requires
  (`antigravity_executor_credits.go:376-391`). Prose or an untyped reason never convicts.
- `src/server/responses/adapter-dispatch.ts:1666` loop: pass `refusal.kind` as the reason to
  `markAccountNeedsReauthIfGeneration` (today a literal `"verify_account"`).
- One closed type in `src/oauth/types.ts`: `export const NEEDS_REAUTH_REASONS = ["verify_account",
  "tos_violation"] as const; export type NeedsReauthReason = typeof NEEDS_REAUTH_REASONS[number];
  export function isNeedsReauthReason(v: unknown): v is NeedsReauthReason`. Every literal
  `"verify_account"` check on this field becomes a membership check, at each site found by
  `rg -n 'verify_account' src` on d842c1352e:
  - `src/oauth/types.ts:118` (field type), `src/oauth/store.ts:699-700` (load), `:1610` (serialize),
    `:1656-1665` (`markAccountNeedsReauth`), `:1673` (`mergeAccountCredential`: a silent refresh keeps
    `needsReauth` only for a held reason — this is what preserves quarantine across refresh, the
    contract in `structure/transports/inventory.md:80`), `:1676` (`markAccountNeedsReauthIfGeneration`, the
    function dispatch calls);
  - `src/oauth/index.ts:1795,1836` (file at 1,980 lines: edits stay net zero by swapping literals for the
    helper), `src/cli/account-api.ts:45,473,519`, `src/cli/account-auth.ts:130`;
  - `src/oauth/health.ts:26,117,140` (`OAuthReauthReason` gains `tos_violation`, label "Account suspended");
  - `src/cli/account.ts:126` label `needs-reauth(tos)`;
  - `src/server/responses/adapter-dispatch.ts:1676` passes `refusal.kind` (1,970 lines: net zero).
- Downgrade limit, stated plainly: a build older than this change drops an unknown reason on load
  (`store.ts:699`), and its next silent refresh then clears `needsReauth` (`store.ts:1673`), so after a
  downgrade a suspended account can rejoin that older build's pool until it is refused again. The
  release note says so; no migration can prevent it from the newer side.
- In-stream: `src/adapters/google.ts:1402-1413` already ends the turn on `chunk.error`; when
  `chunk.error.status === "PERMISSION_DENIED"` and the details carry `TOS_VIOLATION`, the error message
  uses the TOS prefix. Account marking stays HTTP-only (dispatch has no fenced snapshot mid-stream).

## Tests (first, failing)

- EXTEND `tests/adapters/google/google-errors.test.ts`: `parseGoogleDurationMs` table (`30s`, `0.5s`,
  `1h2m3s`, `500ms`, `2m`, `-1s`, `abc`, `999999h`); `extractGoogleRetryAfterSeconds` for `1h2m3s`
  quotaResetDelay → `"3723"`; `isQuotaExhaustedBody` true for `QUOTA_EXHAUSTED` with transient prose on
  every label; for `RATE_LIMIT_EXCEEDED` with "daily limit reached" prose: false on Antigravity, true on
  AI Studio and Vertex; classification strings for each reason;
  TOS body → TOS prefix, no appeal URL in the message.
- EXTEND the Google retry tests: 429 with body-only `retryDelay: "3s"` waits ≥ 3000 ms before the second
  send (observed through the test seam, no real sleep); a body delay over the ceiling returns the 429 with
  `retry-after` set.
- EXTEND `tests/adapters/google/antigravity-refusal.test.ts` and the dispatch test that covers
  `verify_account` marking: a TOS 403 marks `tos_violation` and rotates; prose "terms of service" or an
  untyped `reason` does not convict.
- NEW store test: after a `tos_violation` mark, `mergeAccountCredential` with a refreshed credential keeps
  `needsReauth: true` and the reason; serialization round-trips it; `ocx account list` shows
  `needs-reauth(tos)`.

## Docs

`structure/providers-and-adapters.md` (Google error classification), `structure/transports/inventory.md`
(quarantine across refresh now covers `tos_violation`), `structure/providers/generic-account-pool.md`, and
the docs-site pages listed in 070.

