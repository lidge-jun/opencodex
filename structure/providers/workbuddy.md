# WorkBuddy AI Subscription

`workbuddy-ai` uses the international WorkBuddy subscription at `https://www.workbuddy.ai`.
It is separate from the API-key CodeBuddy CLI providers and does not configure the WorkBuddy client.

## Authentication and credential ownership

`src/oauth/workbuddy.ts` implements browser authorization: request state, show the returned
HTTPS login page, poll the token, then resolve the authoritative account identity. The complete
flow has a five-minute deadline and supports cancellation; individual requests and decoded
responses are bounded. Only WorkBuddy AI and CodeBuddy AI HTTPS login origins are accepted.
API requests use fixed WorkBuddy AI destinations and refuse redirects. Upstream response text,
tokens and profile fields are absent from error messages.

The shared OAuth store retains access/refresh tokens and private `workbuddy` metadata
(`uid`, domain, optional enterprise id and refresh expiry). Personal and enterprise identities
have distinct account slots. No desktop credential file is read or changed. Shared refresh locks
serialize renewal and persist rotation; the default refresh policy is lazy-only. Request snapshots
carry metadata from the same credential as the bearer, including the one-shot 401 refresh and
generic account-rotation paths. Management account summaries do not expose that metadata.

## Transport and models

`src/providers/workbuddy.ts` pins inference to `/v2/chat/completions` on the international origin;
config validation and wire selection keep the account provider on its dedicated adapter.
`src/adapters/workbuddy.ts` inherits the OpenAI Chat event contract. It always requests upstream
SSE and consumes the same parser for buffered callers. It supplies WorkBuddy's account, team,
client and conversation headers, preserves user-turn identity across tool-result continuations,
and uses process-salted digests rather than prompt text in IDs. It reuses Chat tool-name aliasing
and restores names on responses; `src/adapters/workbuddy-schema.ts` normalizes tool schemas.
Client-channel and restricted-account refusals remain refusals; prompts are not rewritten to
evade those checks. Inference uses the shared executor, cancellation and send budgets.

`src/providers/workbuddy-models.ts` extracts only the `cli` agent roster from `/v3/config`,
including input/output limits, image capability and reasoning efforts. WorkBuddy AI GLM rows
remain text-only because that gateway filters image input. Catalog requests carry captured
account metadata; fresh/stale cache and failure cooldowns are bound to the credential and tenant.
Unavailable discovery degrades to the same-account cache, then the minimal `default-model` seed.

`src/providers/quota/workbuddy.ts` reads the authenticated resource summary through the bounded,
fixed-origin API helper. It sums `Packages` once and treats `CreditGroups` as a breakdown;
explicit remaining/frozen amounts take precedence over arithmetic estimates. Team accounts use
the enterprise meter when the personal summary has no capacity. Optional paid/free package
queries use summary-owned codes, bounded pagination and the same total deadline; a failure
omits expiry without losing the balance. Expiry uses the earliest future non-daily package
and excludes packages absent from the summary.

The private account/tenant metadata participates in quota cache identity. The normal account
probe/cache path supplies refresh, paused-account exclusion, stale-reading and 401 invalidation
semantics. Unknown or malformed summaries never become zero. Explicit zero balances remain visible.
`workbuddyCredits` is a display-only field in the quota DTO, separate from USD balances and
quota windows, so credit exhaustion does not disable free models or influence account ranking.
`src/providers/workbuddy-credit-balance.ts` validates the numeric-only public projection for the
GUI. The shared provider quota panel shows the remaining credits, usage, group balances and
optional expiry; the existing refresh and stale-state controls apply to it.

## Verification

`tests/oauth/workbuddy-login.test.ts` covers login, identity, cancellation, refresh, response
bounds and store normalization. `tests/adapters/workbuddy-adapter.test.ts` covers destination
pinning, account headers, tool schemas/names, streaming and turn continuity.
`tests/providers/workbuddy-provider.test.ts` exercises catalog account isolation,
buffered and streamed Responses requests, and persisted one-shot 401 renewal with synthetic
accounts. `tests/providers/workbuddy-quota.test.ts` covers balance parsing, expiry, failures,
account isolation, refresh and the display-only routing boundary.
`gui/tests/workbuddy-credits.test.tsx` covers the account/provider panels and malformed payloads.
These fixtures do not establish live account entitlement or vendor channel acceptance.

Protocol reference: [Magpie WorkBuddy plugin](https://github.com/magpie-community/plugins/tree/e7f65641df820dfd715c0d2241f99f2092e4efb1/packages/workbuddy).
