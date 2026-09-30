# Anthropic Account Pool

## Anthropic account pause

Anthropic OAuth shares `ProviderAccount.paused` in the protected auth store with generic
OAuth, not a second list in provider config. `setAccountPaused` serializes pause/resume
with credential and selection writes, advances the selection revision, and only publishes
invalidation after persistence. Removing an account removes its pause; reauthentication
preserves it. The store moves active selection to an unpaused, non-reauth row if available.
Pause does not clear cooldowns, quota, or credentials and does not cancel an already-sent turn.

`src/oauth/anthropic-routing.ts` excludes paused rows from quota, round-robin, fill-first,
manual, affinity, model-route and reactive 429 candidates, including when proactive pooling
is off. All-paused requests return 403 with resume guidance. Quorum is invalidated on pause
and resume; a sent account paused before its 429 may still recover on its sole unpaused
successor. Credential resolution, refresh-lock acquisition, selection commit and physical
dispatch recheck live eligibility after asynchronous waits. Responses and native Messages
preserve typed 401 authentication, 403 pause and 429 cooldown refusals after pacing, including pool-off recovery;
they do not report local rejection as 502. Only cooled usable survivors of a strict route
produce its scoped 429 and Retry-After, not a login error. An already-dispatched refresh
retains a successful rotated credential without unpausing; a late failure cannot mark the
paused row for reauthentication. Token Guardian and Anthropic quota probes recheck live
pause, selection and bearer ownership after token resolution and before each usage send;
a newly paused account makes no auxiliary request. An account switch during a usage probe still seeds the probed account's quota cache but suppresses its stale provider report and reset observation. Pool-off keeps a healthy active account;
pause/prior-429 recovery uses `only-eligible`, and logs name the committed account.

> Decision record: [ADR-6013](../decisions/ADR-6013-anthropic-account-pause.md)

Regression coverage: `tests/adapters/anthropic/anthropic-account-pause.test.ts`,
`tests/adapters/anthropic/anthropic-model-routes.test.ts`, `tests/oauth/oauth-accounts-api.test.ts`,
`tests/cli/cli-account-pool-verbs.test.ts`, and `gui/tests/provider-quota-refresh-controls.test.tsx`.

## Model routes

For Anthropic OAuth, `src/oauth/anthropic-routing.ts` applies the first matching `anthropicAccountPool.routes` rule to every eligible pick. The declared account order is stable while its candidates remain eligible; active, manual, affinity, quota and strategy preferences only choose inside that set. A healthy session affinity outside a model route is ignored for that request and retained for later unrouted or differently routed models; the routed commit does not overwrite it. An explicit fallback widens an empty route to the ordinary pool, and fill-first then advances in ordinary pool order from the active account. A missing eligible route fails locally without that fallback. The rules are operator allowlists, not provider entitlement evidence. Request logs use `route:#<n>` for the 1-based rule position, not the operator name.

## Quota labels

Anthropic model-scoped quota labels in `src/providers/quota/vendor-probes-oauth.ts` publish
only canonical Fable, Opus, or Sonnet labels after removing terminal controls; unknown upstream display names are omitted.
