# 261025 Command Code MODEL_NOT_IN_PLAN refusal (#7684)

Command Code answers a model the account's plan excludes with HTTP 403
`{"success":false,"error":{"code":"FORBIDDEN","status":403,"message":"MODEL_NOT_IN_PLAN: <detail>"}}`.
OpenCodex forwards that 403, and Codex treats any 403 as a retryable `UnexpectedStatus`: a scratch
probe against Codex CLI 0.163.0 counted 6 sends (`Reconnecting... 1/5` to `5/5`) for the 403 and
exactly 1 send for an HTTP 400 (`.tmp/m5/codex-retry-probe.ts`, not committed). Inside a combo the
same 403 cools the whole Command Code provider row (`comboFailureCooldownScope` returns
`provider` for 401/402/403), so every other Command Code model in that combo is skipped. This unit
makes the refusal a single, non-retryable, model-scoped answer.

## Loop spec

- Archetype: satisfy-spec, one work-phase (wp1). Trigger: lane M5 brief for issue #7684.
- Goal: one upstream send per turn for a plan-excluded model, a clear client error naming the
  model and the plan, combos hop to the next target and cool only the refused target.
- Non-goals: catalog/discovery removal of plan-excluded models (unverifiable without an
  authenticated account), sibling-account rotation on a plan refusal, a per-account denial cache
  (generic OAuth has none; `src/codex/observed-model-denials.ts` is Codex-pool only and none is
  added), the Command Code API-key `openai-chat` preset, the shared error formatter allowlist,
  docs-site (guides/providers.md is owned by lane M4), the known failure at
  `tests/claude-integration/claude-desktop-remote-hub.test.ts:249`.
- Verifier: `bun test tests/providers/command-code-plan-denial.test.ts` red before / green after;
  credit refusal suites stay green; typecheck, test:changed, privacy:scan, structure:check exit 0;
  Codex probe through the real proxy route counts 1 send.
- Stop: PR open on dev with independent review PASS at the exact head and CI state reported.
- Memory artifact: this file plus the goalplan under `.codexclaw/goalplans/`.
- Terminal outcomes: DONE as above; BLOCKED if push/PR/review surfaces fail repeatedly; UNSAFE if
  the fix needs credential handling changes; NEEDS_HUMAN if review demands excluded scope.
- Escalation: a reviewer asking for catalog removal or account rotation goes to the origin.
- Resource bounds: none stated; host limits apply.

## Diff-level plan

1. `src/adapters/command-code.ts`: generalize the credit normalizer into
   `normalizeCommandCodeRefusal(response, oauth, signal, modelId)`. Status 400 keeps the existing
   OAuth-only credit rewrite byte-for-byte. Status 403, for every auth mode, reads at most 8 KiB
   (fatal UTF-8, display-safe) and matches only `success === false`, `error.code === "FORBIDDEN"`
   and a message starting with `MODEL_NOT_IN_PLAN`. It returns HTTP 400 with
   `{"error":{"type":"invalid_request_error","code":"model_not_in_plan","message":...}}`, headers
   `x-opencodex-upstream-status: 403` and `x-opencodex-refusal: model-not-in-plan`. The message
   names the canonical model, quotes the upstream detail (control characters stripped, redacted,
   capped at 200 characters) and says retrying will not succeed. Any other 403, a malformed or
   oversized body, or malformed UTF-8 is returned untouched. The reasoning-effort retry send uses the
   same normalizer. No account, key or provider cooldown is recorded; nothing is logged.
2. `src/combos/failover.ts`: add `model_not_in_plan` to the structured model-scoped hop list in
   `comboFailureDecision` (beside `model_not_found` / `unsupported_model`).
   `comboFailureCooldownScope` then falls through to `target` for the 400, so only the refused
   provider/model target cools.
3. `tests/providers/command-code-plan-denial.test.ts` (registered in
   `scripts/test-layout/layout-adapters.json` and on an existing line of
   `tests/fixtures/test-layout-expected.json`): OAuth two-account dispatch (one send, 400, active
   account unchanged, the same account then serves another model), key row (one send, 400), an
   unrelated FORBIDDEN 403 stays 403, combo `[plan-refused model, sibling model]` on the same
   provider completes on the sibling, and the failover predicates for the code.
4. `structure/providers-and-adapters.md`: extend the existing command-code row in place (net zero
   lines; the doc is at 600/600).

## Risks

- A 400 is a status change for this one refusal; clients that branched on 403 for it now see
  `invalid_request_error`. The upstream status is kept in `x-opencodex-upstream-status`.
- The client body keeps the dispatch wrapper (`Provider error 400: {...}`); the formatter
  allowlist does not forward `model_not_in_plan` as the top-level code. The code stays readable
  inside the message and on the combo path.

## Audit r1 amendment (GOAT task m5-plan-audit-r1, codex/gpt-6.1-sol high: GO-WITH-FIXES)

1. Accepted (P2 policy fallback): `policy-fallback.ts` hops on the final envelope's `error.code`,
   which `adapter-dispatch.ts` never forwards. The constant `MODEL_NOT_IN_PLAN_CODE` lives in
   `src/lib/errors.ts`; `formatErrorResponse` keeps it when a caller passes it (same rule as
   `undeclared_tool_call`). `adapter-dispatch.ts` passes it only when both the adapter's
   `x-opencodex-refusal: model-not-in-plan` header and the body code agree. The diagnostic headers
   stay on the adapter response only; the plan no longer claims them on the client response.
2. Accepted (P2 misleading detail): the message is fixed wording built from the request's
   canonical model id (accepted only if it matches a conservative id pattern). Upstream detail is
   never quoted, so effort-repair, opaque-recovery and subagent quota classifiers cannot fire on it.
   The adapter also skips its effort-repair branch for a normalized plan refusal.
3. Accepted (P1 logging): no upstream text reaches the client body or the combo warning. A test
   puts synthetic account/key canaries plus effort and quota phrases in the upstream detail and
   asserts their absence from the client body and captured console output.
4. Accepted (P2 matrix): adapter-level negatives for malformed JSON, invalid UTF-8, oversized body,
   wrong `success`/`code`, a `MODEL_NOT_IN_PLAN_OTHER` prefix lookalike, abort propagation,
   key/forward/OAuth modes, normalization after a genuine effort-repair send; dispatch tests on the
   Responses, Chat and Messages inbound paths; combo hop plus a second request that skips only the
   cooled target; a policy-route hop.
5. Noted: attribution moves from `credential-rejected` to `payload-rejected` by the status table;
   documented in the PR, not pinned by a test that would restate the table.
