# Phase 140 (P1) - Kiro actionable error mapping

## Trigger

The parity review still flags Kiro failures as too generic. Stream exception
frames and non-2xx HTTP bodies currently become broad `upstream_error` text, so
users cannot distinguish auth expiry, rate limit, quota exhaustion, wrong
profile/region, malformed tool payloads, or unavailable models.

Multi-account routing/failover remains out of scope. This phase only improves
single-account error fidelity and secret-safe user-facing diagnostics.

## Current state

- `src/adapters/kiro-errors.ts` redacts Kiro stream exception text and local
  paths, but does not classify common Kiro exception families into actionable
  messages.
- `src/adapters/kiro-retry.ts` retries 429/5xx and aborts safely, but final
  non-2xx `Response` bodies are still raw provider bodies consumed later by
  `src/server.ts`.
- `src/bridge.ts` maps every adapter stream `error` event through
  `classifyError(502, "upstream_error", message)`, so stream-side Kiro errors
  need recognizable message text.
- `src/errors.ts` already maps context, quota, rate limit, auth, overload, and
  invalid-request categories for generic provider errors.

## Diff plan

### MODIFY `src/adapters/kiro-errors.ts`

Add an actionable Kiro error normalization layer while preserving current
redaction behavior:

- Keep `safeKiroErrorMessage(headers, payloadText)` as the stream-frame API.
- Add `safeKiroHttpErrorMessage(status, headers, payloadText)` for non-2xx HTTP
  responses.
- Parse JSON bodies for `__type`, `code`, `error`, `name`, `message`,
  `Message`, and `errorMessage`.
- Redact secrets and local paths before returning any message.
- Emit category-specific text that `classifyError()` can recognize:
  - throttling/rate-limit types -> `Kiro rate limit exceeded ...`
  - auth/access denied/expired token types -> `Kiro authentication failed ...`
  - quota exhaustion text -> `Kiro quota exhausted ...`
  - validation/profile/region/model/tool schema issues -> `Kiro invalid request ...`
  - overloaded/temporary server failures -> `Kiro server overloaded ...`
  - unknown -> `Kiro upstream error ...`

### MODIFY `src/adapters/kiro-retry.ts`

- Import `safeKiroHttpErrorMessage`.
- When returning the final non-OK response, read a clone/body safely and replace
  it with a sanitized actionable text response that preserves status and
  headers.
- Keep retry behavior unchanged for retryable 429/5xx before the final attempt.
- Keep abort semantics unchanged.

### MODIFY `src/errors.ts`

Extend generic classification keywords so stream-side Kiro messages map
correctly despite bridge status `502`:

- `throttlingexception`, `rate limited`, and `rate limit exceeded` ->
  `rate_limit_error/rate_limit_exceeded`.
- `authentication failed`, `access denied`, `expired token`,
  `unauthorizedexception`, `unrecognizedclientexception` ->
  `authentication_error/invalid_api_key`.
- `quota exhausted` and non-per-minute quota exhaustion wording ->
  `insufficient_quota/insufficient_quota`.
- `validationexception`, `invalid request`, `model unavailable`, `model not
  found`, `profile arn`, `region` -> `invalid_request_error`.

Ordering must preserve the existing transient-429 test: request-per-minute
quota wording remains `rate_limit_exceeded`, not `insufficient_quota`.

### MODIFY tests

- `tests/kiro-stream.test.ts`
  - Add stream exception cases proving Kiro throttling/auth/validation/model
    errors produce actionable redacted messages.
  - Bridge classification is covered by `tests/error-fidelity.test.ts`.
- `tests/kiro-retry.test.ts`
  - Add final non-OK response cases:
    - 403 auth body becomes sanitized Kiro authentication text.
    - 400 validation/model body becomes Kiro invalid request text.
    - final 429 still returns status 429 and sanitized rate-limit text.
- `tests/error-fidelity.test.ts`
  - Add `classifyError()` assertions for Kiro stream messages and keep existing
    transient-429 quota behavior.

## Verification

- `bun x tsc --noEmit`
- `bun test tests/kiro-stream.test.ts tests/kiro-retry.test.ts tests/error-fidelity.test.ts tests/adapter-error-inline.test.ts`
- `wc -l src/adapters/kiro-errors.ts src/adapters/kiro-retry.ts src/errors.ts tests/kiro-stream.test.ts tests/kiro-retry.test.ts tests/error-fidelity.test.ts`

## Commit

`fix(kiro): map upstream failures to actionable errors`

## Explicit non-goals

- No multi-account circuit breaker or failover.
- No live Kiro account smoke test; use deterministic wire fixtures.
- No new adapter event schema. This phase works with the existing
  `AdapterEvent.error` string and shared bridge classifier.

## Completion evidence

- Implemented in `a038784`:
  - `src/adapters/kiro-errors.ts` now keeps `safeKiroErrorMessage()` and adds
    `safeKiroHttpErrorMessage()` with Kiro-specific redacted category prefixes.
  - `src/adapters/kiro-retry.ts` now replaces final non-OK Kiro HTTP bodies
    with sanitized actionable text while preserving status, retry count, and
    abort behavior.
  - `src/errors.ts` now recognizes Kiro rate-limit, auth, quota, validation,
    model, and region messages before the generic `status >= 500` fallback.
  - Regression coverage was added in `tests/kiro-stream.test.ts`,
    `tests/kiro-retry.test.ts`, and `tests/error-fidelity.test.ts`.
- Local verification:
  - `bun x tsc --noEmit` passed.
  - `bun test tests/kiro-stream.test.ts tests/kiro-retry.test.ts tests/error-fidelity.test.ts tests/adapter-error-inline.test.ts`
    passed: 36 tests.
  - Line counts stayed under 500 for all touched files.
- Independent verifier:
  - Backend verifier reported DONE.
  - It reran `bun x tsc --noEmit` and the same four-file target suite, with
    36 pass / 0 fail, and confirmed touched file line counts under 500.
