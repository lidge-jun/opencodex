# 010 — Finish the Zed Hosted provider carry (#5912)

Unit: carry andrew05060414's experimental Zed Hosted AI provider (#5912) onto `dev` as a
maintainer PR. Maintainer decision (2026-10-01): adopt as use-at-your-own-risk (UAYOR).

## State at entry

Branch `codex/zed-hosted-ai-carry`, 5 commits ahead of `origin/dev`, 0 behind, already pushed
at `03e9dce881`. Carried: native RSA callback login (`src/oauth/zed.ts`), account-scoped
short-lived LLM token exchange with expiry refresh (`src/providers/zed.ts`), live roster, the
`/completions` envelope adapter for Anthropic / Google / OpenAI Responses / xAI Chat
(`src/adapters/zed.ts`), UAYOR wording in the dashboard ToS-risk set (`gui/src/oauth-tos-risk.ts`)
and in `docs-site` guides/providers, reference/adapters, reference/configuration/providers.

## Remaining diff (this cycle)

1. `src/providers/zed.ts` — `scrubZedCredentials()` removes the account access token and the
   user id from upstream error text before it becomes an `Error` message, on the two calls that
   send the account credential (account lookup, LLM token exchange). `responseJson` takes the
   credentials. The `/completions` path carries only the short-lived LLM token and keeps the
   generic `redactSecretString`.
2. `tests/providers/zed-hosted-provider.test.ts` — regression: a 401 body echoing both values
   yields a message that names the step and contains neither value. Trailing newline restored.
3. Commit with `Co-authored-by` for andrew05060414; push (no force).
4. Open the maintainer PR to `dev` with every template section, `Co-authored-by`, the UAYOR
   framing, an explicit security-review request (OAuth / credential path per MAINTAINERS.md),
   and real-account UAT stated as not verified.

## Verification

Local test and typecheck runs are banned for this lane (maintainer instruction). Evidence is
the exact-head hosted CI of the PR; queued, skipped, or cancelled checks are not passes.
Failures are read with `gh run view --log-failed`, fixed, and pushed again.

## Closeout

When exact-head CI is green, close #5912 with a link to the new PR and thanks. Do not merge.

## Reflection

The remaining risk is reviewer-side, not mechanical: Zed's service terms. That is why the PR
asks for security review and states UAYOR instead of claiming support. No change to core
request paths (`src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`).

## Audit round 1 (FAIL) — folded into this plan

Reviewer (gpt-6.1-sol, read-only) found three P1 blockers; all are accepted.

5. **Rejection boundaries.** `fetchZedAuthenticatedUser` and `fetchZedLlmToken` can reject from
   `fetchFn` or from the body read inside `responseJson` with a message that echoes the account
   credential, bypassing `scrubZedCredentials`. Add `scrubZedRejection(error, credentials)`, which
   decides only on content: if the error's message (or `String(error)` for a non-Error) contains
   neither the account token nor the user id, rethrow the original by identity, so a clean abort
   keeps its identity. If it contains either, throw a replacement that never carries the value: a
   `DOMException` with the same `name` and the scrubbed message when the original is a
   `DOMException` (so `AbortError`/`TimeoutError` cancellation semantics survive), otherwise an
   `Error` with the scrubbed message and the same `name`; numeric `status` is copied over and
   the original is dropped as `cause` (its message would leak). The `await fetchFn(...)` and
   `await responseJson(...)` calls of both functions sit inside the `try` whose `catch` applies
   it, and so does the `/completions` fetch inside `zedLlmFetch`. Regression cases: fetch
   rejection echoing both values; body-read rejection (a stream that errors mid-read) echoing them;
   numeric `status` preserved; a credential-bearing `AbortError` comes back as an `AbortError`
   without the values; a clean `AbortError` is rethrown by identity.
6. **File-size ratchet.** `src/server/management/provider-routes.ts` is 1998 lines on `dev` with no
   baseline cap; the carried 22-line Zed probe takes it to 2020, past the 2000 NEW_OVERSIZED
   threshold. Move the probe into `src/server/management/zed-provider-probe.ts`
   (`probeZedProvider(prov, apiKey, accountId)`) and call it with a single dynamic-import line, so
   the file ends at 1999 lines and Zed code stays off the module graph until a Zed probe runs.
7. **Preset counts.** The registry grows from 100 to 101 presets (Zed is OAuth; key-based stays 83).
   Update the anchored sentence in all eight provider guides (total 101, OAuth 14), all eight
   quickstarts (101), and `structure/ops/docs-and-release.md` (101 total, 14 OAuth), as checked by
   `tests/ci-workflows/docs-provider-preset-counts.test.ts`. Union risk: another open lane (Mirasim)
   also adds a preset; whichever lands second must recount, and the PR says so.
