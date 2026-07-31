# 110.53 — F3: Overload Mapping and Retry-After Message Fidelity

## Objective

Make translated backoff faithful to what the **stable** Codex parser actually does. This
supersedes the 110 RCA note that "`rate_limit_exceeded` is not recognized" — that was based on
the stale `/tmp/opencodex-codex-src` snapshot. The stable checkout
(`/Users/jun/Developer/codex/codex-cli/codex-rs/codex-api/src/sse/responses.rs`) recognizes
`rate_limit_exceeded` and extracts the delay from the **message text**.

Three faithful-backoff items, plus one cleanup:

- **F3a — map overload to a recognized code.** `errors.ts:31-33` maps every `status >= 500` to
  `upstream_server_error`, which Codex does **not** special-case. A 503 / "overloaded" upstream
  should map to `server_is_overloaded`, which Codex recognizes (`is_server_overloaded_error`,
  `responses.rs:533-535`) and backs off on with retry-after (`responses.rs:332-335`).
- **F3b — preserve the retry-after delay text.** Codex's `try_parse_retry_after`
  (`responses.rs:487-509`) reads the delay from the **error message** (e.g. `"Please try again
  in 11.054s."`, fixture `responses.rs:844`). `classifyError` already passes `message` through
  verbatim, so an upstream phrase survives — the requirement is a **contract**: never normalize
  or truncate a rate-limit message in a way that strips `"try again in Ns/ms"`, and never
  fabricate a fake delay when the upstream gave none.
- **F3c — keep transient 429 "quota" retryable.** GPT Pro: a generic 429 "quota exceeded" is
  often a temporary request/token bucket, not fatal paid-credit exhaustion. `errors.ts:18-24`
  matches bare `"quota exceeded"` → `insufficient_quota` (a Codex-recognized **fatal** quota
  error, `is_quota_exceeded_error`, `responses.rs:517`). Tighten the match so a bare 429 bucket
  falls through to the retryable `rate_limit_exceeded` branch.
- **F3d (optional cleanup) — drop the dead `last_error`.** The bridge emits both `error` and
  `last_error` on `response.failed` (`bridge.ts:331,344`); the parser reads only `error`
  (`responses.rs` classification reads `response.error`). `last_error` is harmless dead weight.

## Evidence

```text
/Users/jun/Developer/codex/codex-cli/codex-rs/codex-api/src/sse/responses.rs:318      is_context_window_error(&error)        (classification entry)
/Users/jun/Developer/codex/codex-cli/codex-rs/codex-api/src/sse/responses.rs:332-335  is_server_overloaded_error → delay = try_parse_retry_after(&error)
/Users/jun/Developer/codex/codex-cli/codex-rs/codex-api/src/sse/responses.rs:487-509  try_parse_retry_after gates on code == "rate_limit_exceeded", parses "try again in Ns"
/Users/jun/Developer/codex/codex-cli/codex-rs/codex-api/src/sse/responses.rs:517      is_quota_exceeded_error (fatal quota)
/Users/jun/Developer/codex/codex-cli/codex-rs/codex-api/src/sse/responses.rs:533-535  is_server_overloaded_error → "server_is_overloaded" | "slow_down"
/Users/jun/Developer/codex/codex-cli/codex-rs/codex-api/src/sse/responses.rs:844      test fixture: rate_limit_exceeded message "Please try again in 11.054s."
```

opencodex classifier:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/errors.ts:18-37
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:330-331, 343-344  (F3d optional)
```

## Files

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/src/errors.ts
```

F3c — drop the over-broad `"quota exceeded"` so transient 429 buckets stay retryable
(current 18-24):

```diff
   if (
     text.includes("insufficient_quota") ||
-    text.includes("quota exceeded") ||
     text.includes("exceeded your current quota")
   ) {
     return { message, type: "insufficient_quota", code: "insufficient_quota" };
   }
```

F3a — add an overload branch mapping to a Codex-recognized code. Insert it **between line 30**
(the auth branch's closing `}`, `errors.ts:28-30`) **and line 31** (the `if (status >= 500)`
check) — so 401/403 auth is matched first, then overload, then the generic 5xx fallback:

```diff
   if (status === 401 || status === 403 || type === "authentication_error") {
     return { message, type: "authentication_error", code: "invalid_api_key" };
   }
+  if (
+    status === 503 ||
+    text.includes("overloaded") ||
+    text.includes("server is busy") ||
+    text.includes("temporarily unavailable")
+  ) {
+    // Codex recognizes "server_is_overloaded" and applies retry-after backoff
+    // (responses.rs:332-335,533-535); generic "upstream_server_error" is not recognized.
+    return { message, type: "server_error", code: "server_is_overloaded" };
+  }
   if (status >= 500) {
     return { message, type: "server_error", code: "upstream_server_error" };
   }
```

> **Contract (F3b) — no code change, enforce in review:** the `message` argument flows into the
> emitted envelope verbatim. Callers must pass the **upstream** error text (which carries
> `"try again in Ns"`) and must not synthesize a rate-limit error with a fabricated delay. When
> no upstream delay text exists, emit the message without one — Codex falls back to its default
> backoff, which is correct.

### MODIFY (optional — F3d)

```text
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts
```

```diff
               emit("response.failed", {
                 response: {
                   ...responseSnapshot("failed", finishedItems),
                   error: responseError(502, "upstream_error", event.message),
-                  last_error: responseError(502, "upstream_error", event.message),
                 },
               });
```

(and the symmetric drop in the `catch` block at `bridge.ts:343-344`). Defer if any consumer
other than the Codex parser reads `last_error`; the parser does not.

## Verification

Extend `tests/error-fidelity.test.ts`:

```bash
bun test tests/error-fidelity.test.ts
bun test tests
bun x tsc --noEmit
git diff --check
```

Assert:

- `classifyError(503, "upstream_error", "The server is overloaded")` → `code: "server_is_overloaded"`.
- `classifyError(429, "upstream_error", "You have exceeded your quota for requests per min. Please try again in 5s")`
  → `code: "rate_limit_exceeded"` (retryable) **and** message still contains `"try again in 5s"`.
- `classifyError(402, "upstream_error", "You exceeded your current quota")` → `code: "insufficient_quota"` (still fatal).

Expected:

```text
overload → server_is_overloaded; transient 429 quota → rate_limit_exceeded (delay text preserved);
real exhaustion → insufficient_quota; full suite passes; typecheck clean
```

## Commit

```text
[agent] fix: map overload to server_is_overloaded and keep transient 429 retryable
```
