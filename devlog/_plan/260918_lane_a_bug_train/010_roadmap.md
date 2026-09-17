# Lane A bug train — roadmap

Base: `origin/dev` at `2f025814f3`, package 2.59.0.

Three reported bugs are in scope. They share no source files, so each lands as an
independent pull request against `dev` rather than a serial stack.

| Issue | Area | Files | PR |
| --- | --- | --- | --- |
| #4906 | Codex account/model entitlement routing | `src/codex/model-entitlements.ts`, `src/server/responses/core-codex-account.ts`, `src/server/responses/passthrough-dispatch.ts` | 020 |
| #4893 | Responses passthrough transient-retry policy | `src/providers/key-failover.ts`, `src/server/responses/passthrough-dispatch.ts` | 030 |
| #4903 | Combo failover classification of a `response_format` refusal | `src/combos/failover.ts` | 040 |

#4893 and #4906 both touch `passthrough-dispatch.ts`, in disjoint regions: #4906 edits the
pool-retry block near the end of the recovery loop, #4893 edits the four
`fetchWithTransientRetry` option literals. Whichever lands second rebases onto the first.

## Why each report needed re-judging at the current head

Every report names 2.57.0 or 2.58.0. The findings below are re-derived from the `dev` tip, and
two of the three reports are accurate about the symptom while wrong about the cause.

### #4906 — the roster preference is real but almost never has evidence

`#4797` (`f35fbe8ef6`) added two ordering rules, and both are present at the tip:
`withoutModelDeniedAccounts` narrows the eligible list and `preferModelEntitledAccount`
corrects an active cursor. Both read `selectionOptions.deniedModelAccountIds`, which comes
from `cachedDeniedCodexAccountIdsForModel`.

That reader is cache-only by contract, and the cache it reads expires in five minutes
(`MODEL_ROSTER_TTL_MS = 5 * 60_000`). Entries past `expiresAt` are skipped, so the reader
returns `undefined`. Nothing on the flagship request path refills it: `resolveCodexModelEntitlements`
is awaited only for `ACCOUNT_GATED_NATIVE_OPENAI_MODELS`, which since the 2026-09-04 owner
decision holds `gpt-daybreak-blue-latest` alone. The remaining writers are proxy startup,
catalog sync, convergence, and the catalog endpoint.

So for a flagship request more than five minutes after the last sync, `deniedModelAccountIds`
is `undefined`, both ordering rules are the identity function, and the pool selects on quota
alone — which is exactly the Free account the reporter sees. The report's own guess ("the
refresh did not produce usable denial evidence, or it is not being consumed") is right about
the outcome and reaches the wrong half: the evidence is produced, and then it expires.

The second half is that the upstream refusal teaches the pool nothing. A 400 whose body is
exactly `The '<model>' model is not supported when using Codex with a ChatGPT account.` is an
authenticated, account-specific, model-specific denial — strictly better evidence than an
absent roster row. It is currently used once, to trigger one alternate-account retry, and then
discarded. The next request repeats the same selection and takes the same 400.

A third defect sits in the detector itself. `isAllowListedCodexAccountModel400` builds its
expected string from `route.modelId`, but `applyCodexAccountGatedWireNormalization` rewrites
the wire model for `gpt-daybreak-blue-latest` to `gpt-5.6-sol` before dispatch. Upstream
therefore names `gpt-5.6-sol` in the refusal while the comparison expects the Daybreak slug,
the match fails, and the one model that is still account-gated gets neither the
alternate-account retry nor the eight-rung same-account ladder built for it.

Fix: record the confirmed 400 as durable per-account denial evidence, union it into
`cachedDeniedCodexAccountIdsForModel` beneath roster-positive evidence, and compare the
refusal against the normalized wire model as well as the route model.

Bounds this keeps. It stays an ordering preference: `withoutModelDeniedAccounts` still
restores denied members when filtering would empty the list, `preferModelEntitledAccount`
still returns the active account unchanged when no entitled alternative exists, no model is
hidden from any catalog, and nothing is refused before dispatch. The 2026-09-04 decision that
the flagships fail open is untouched. Availability is decided by the authenticated roster and
by upstream error evidence — never by a plan name and never by remaining quota.

### #4893 — the passthrough lane cannot read the policy it is configured with

The three source facts in the report hold at the tip. `transientRetryPolicyFor` rejects every
adapter but `openai-chat`; `createResponsesPassthroughAdapter` sets `passthrough: true` and
`core.ts` returns into `executePassthroughResponse` on that flag, before the three call sites
that would read the policy are constructed; and `passthrough-dispatch.ts` does not import the
function at all, passing the constant `TRANSIENT_RETRY_MAX_ATTEMPTS` at four call sites —
the initial send plus the OAuth-401, rate-limit-429, and rebuild recovery legs.

PR #4800 widens the adapter gate only. That is necessary and not sufficient: the lane never
calls the gated function, so with #4800 alone the reproduction is unchanged at three sends.
This PR carries #4800's gate change with a `Co-authored-by` trailer and wires the lane.

The two boundaries the constant currently insulates:

- **Budget accounting.** `remainingTransientSendBudget(cap)` resolves to
  `RequestExecutionBudget.remainingBaseSends(cap)`, so the provider value is a per-leg
  ceiling intersected with what the logical request has left, not an independent allowance.
  Every leg must read the same resolved cap, including `sendBudgetExhausted()`, which today
  asks the question at the constant and would otherwise declare a request with configured
  headroom exhausted.
- **The non-replayable boundary.** `isNonReplayableResponse` is checked inside
  `fetchWithTransientRetry` and at each recovery branch, and is unaffected by `attempts`.
  Raising the configured value must not become a way to obtain a resend that marker forbids;
  the regression asserts that explicitly.

Closure criterion: total physical sends equal the configured value intersected with the
request budget — `attempts: 1` sends once, `attempts: 5` sends at most five, no policy sends
three.

### #4903 — a capability refusal classified as a request-shape refusal

The combo chain stops because `comboFailureDecision` reaches
`["origin_rejected", "context_length_exceeded", "invalid_request_error"].includes(error.code)`
and returns `stop`. `isRequestLocalTargetIncompatibility` runs first and could return `hop`,
but its envelope admits three shapes only: `Unsupported parameter: user`, an
`unsupported_value` on `reasoning.effort`, and a model-scoped image-input rejection. A
`response_format` refusal matches none of them, and the gateway's `invalid_parameter_error`
is not in the accepted code set either, so the function returns at its first guard.

Neither rejected option is taken. Hopping on every 400 would replay a genuinely malformed
request against every remaining target. Dropping `response_format` would change the output
contract the caller asked for, silently, on a path whose whole purpose is a structured title.

Fix: extend the bounded envelope to the exact shape of a `response_format` capability
refusal — HTTP 400, intact provider JSON, `type: "invalid_request_error"`, a code in the
accepted set widened by `invalid_parameter_error`, and a message that names
`response_format` as unavailable or unsupported. A target that cannot honour the contract is
a target-local capability gap; the next target keeps the same request and either honours it or
is skipped in turn. Traversal stays finite because each candidate is tried once.

## Operating constraints for this lane

- No local verification of any kind. Correctness is argued from source and proven by hosted CI
  at the exact head.
- Push with `git push --no-verify`; the pre-push hook runs the local suite.
- The lane does not merge, does not push to `dev`, does not rebase unasked, and does not close
  issues or pull requests. Each item ends with an open PR and exact-head CI evidence.
- No flake management: no widened timeouts, no added retries, no platform skips.
- New test files need byte-identical entries in `scripts/test-layout/layout.json` and
  `tests/fixtures/test-layout-expected.json`.
