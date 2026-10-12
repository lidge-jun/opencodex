# Batch 7 — plan

Previous D (wp2): roadmap locked in `010_roadmap.md`; direction: batch 7 carries #5916 with a fixed per-request ceiling
and decides #5497 and a narrowed #5539 here.

## P decisions on the open rows

- #5497 — leave. It adds a public provider field (`responseTierAuthoritative`) with docs in three locales and new cost
  and usage-log handling (the canonical ChatGPT exception is kept); that is a product/config review, not a merge-train carry.
- #5539 (Responses half) — leave. For an unconfigured `openai-responses` provider (API-key OpenAI included) it would fold
  `minimal` to `low`, which changes requests for OpenAI models that accept `minimal`. The strict-gateway 400 is
  fixable today by declaring the provider's `reasoningEfforts` ladder.

## Carry

- #5916 (@codingbooo, closes #5880): squash onto `codex/bug-train-7` from `dev` `76b26a0881`, author + `Co-authored-by`.

## Integration fix (security review blocker)

The generic OAuth send allowance is `accounts × TRANSIENT_RETRY_MAX_ATTEMPTS` and the hop limit is `accounts - 1`, both
from an uncapped roster snapshot. Add `GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST = 6` in
`src/oauth/generic-account-failover.ts` and apply it in two places:

1. `src/server/responses/request-transport.ts`: `budgetAccounts = Math.min(genericRosterSize, MAX)`;
   `genericFailoverLimit = Math.max(GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST, budgetAccounts - 1)`;
   `expandInferenceOAuthSendBudget(options.sendBudget, budgetAccounts)`.
2. `src/server/inference/context.ts` `expandInferenceOAuthSendBudget`: clamp `accounts` to the same constant, so any
   future caller cannot raise the ceiling either.

Result: the default ingress OAuth ceiling is 6 × 3 = 18 physical sends per request however many accounts are enrolled,
versus 4 before #5916. Explicitly supplied caller budgets are left unchanged.
The PR's 4- and 5-account cases keep their expectations.

Regression: in `tests/server/server-google-antigravity-oauth-429-budget.test.ts` (or a sibling if the file-size cap binds),
eight accounts with transient 429 everywhere: exactly 18 sends across exactly the first 6 accounts, then terminal 429.
Must fail without the clamp (24 sends / 8 accounts).

Docs/structure: update the #5916 text in `structure/transports/responses-failover.md`, `responses-spend.md` and
`docs-site/.../providers.md` to state the ceiling.

## Check

tsc, structure:check, privacy:scan, the #5916 test files plus `tests/oauth/generic-oauth-failover.test.ts`,
`tests/oauth/oauth-account-attribution.test.ts`, layout and file-size guards. Independent security re-review of the final
diff. Exact-head hosted CI, then `--admin --match-head-commit`; close #5916 with the batch note.
