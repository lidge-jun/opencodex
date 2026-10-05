# Anthropic Account Pool

## Anthropic account pause

Anthropic OAuth shares `ProviderAccount.paused` in the protected auth store with generic
OAuth, not a second list in provider config. `setAccountPaused` serializes pause/resume
with credential and selection writes, advances the selection revision, and only publishes
invalidation after persistence. Removing an account removes its pause; reauthentication
preserves it. The store moves active selection to an unpaused, non-reauth row if available.
For Anthropic, automatic fallback preserves ring order, including source-less legacy rows,
and skips background local-CLI rows expiring within 60 seconds, including still-valid credentials.
`src/oauth/refresh-policy.ts` shares that skew between pause fallback, routing and token refresh.
Claude Code credential adoption follows the [bearer identity contract](#claude-credential-identity).
A legacy row selected by pause fallback or explicitly can use its own valid bearer for quota/model
discovery and refresh its stored token normally. Missing or invalid provenance normalizes to no
source, which never permits CLI-disk adoption. With no permitted fallback, active-account probes
stay closed until a usable account is selected or resumed.
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
`tests/oauth/local-token-detect.test.ts`, `tests/oauth/oauth-refresh.test.ts`,
`tests/adapters/anthropic/anthropic-model-routes.test.ts`, `tests/oauth/oauth-accounts-api.test.ts`,
`tests/cli/cli-account-pool-verbs.test.ts`, and `gui/tests/provider-quota-refresh-controls.test.tsx`.

## Claude credential identity

`src/oauth/anthropic-identity.ts` observes only authenticated `account.uuid` from the exact
bearer's fixed-origin profile response or the token exchange in `src/oauth/anthropic.ts`.
Its private versioned proof binds the UUID to SHA-256 of the access bearer. Store normalization
in `src/oauth/store.ts` drops malformed or stale proofs; account summaries omit the entire field.
Profile observations reject redirects and use a ten-second deadline and 64 KiB body limit.
Organization, email, generic account ID, disk location and active selection do not establish proof.

`src/oauth/anthropic-continuity.ts` permits usable changed local-CLI generations with a shared
nonempty token. A fully rotated pair instead requires matching authenticated account UUIDs.
The old bearer may use its stored bound proof or a fresh observation; independent old/new
observations run in parallel. Shared-refresh adoption cannot copy proof to a new access bearer.
A provider refresh also drops proof unless its new bearer carries fresh authenticated evidence;
conflicting authenticated UUIDs refuse persistence. Generic display metadata is not promoted to proof.

The refresh owner captures login ID, token generation and identity metadata before observation.
It rechecks them, pause/removal, CLI generation and selection revision after observation and inside
serialized persistence. Superseding writes win. An unresolved full rotation leaves the row and
pending intent intact, without replaying a possibly consumed refresh or setting reauthentication
solely from the identity failure. A proven different account may use its own stored refresh only
when no pending intent blocks it. Intent cleanup follows successful durable adoption.
An unsent token request proven by structured `getaddrinfo` `ENOTFOUND` for the token host,
with no outbound proxy configured in either the startup or current environment and a single
HTTP/1.1 attempt without keep-alive reuse or redirect following, releases its intent as
`pre-dispatch`; redirects and every other transport failure keep the intent.
`tests/oauth/oauth-refresh.test.ts` covers this boundary.
An already-expired identityless row whose old bearer no longer authenticates cannot establish
continuity to a fully rotated pair automatically; explicit import can create a separate slot.

Explicit local import observes the bearer when usable and enriches only a shared-token or
verified-UUID slot, retaining that slot's ID and selection. It preserves unrelated identityless
slots. If profile evidence is unavailable, import remains identityless with the same automatic
recovery limitation. These rules do not authenticate the local host owner who can edit the store.

Regression coverage: `tests/oauth/oauth-anthropic-identity.test.ts`, `tests/oauth/oauth-refresh.test.ts`.

## Model routes

For Anthropic OAuth, `src/oauth/anthropic-routing.ts` applies the first matching `anthropicAccountPool.routes` rule to every eligible pick. The declared account order is stable while its candidates remain eligible; active, manual, affinity, quota and strategy preferences only choose inside that set. A healthy session affinity outside a model route is ignored for that request and retained for later unrouted or differently routed models; the routed commit does not overwrite it. An explicit fallback widens an empty route to the ordinary pool, and fill-first then advances in ordinary pool order from the active account. A missing eligible route fails locally without that fallback. The rules are operator allowlists, not provider entitlement evidence. Request logs use `route:#<n>` for the 1-based rule position, not the operator name.

## Quota labels

Anthropic model-scoped quota labels in `src/providers/quota/vendor-probes-oauth.ts` publish
only canonical Fable, Opus, or Sonnet labels after removing terminal controls; unknown upstream display names are omitted.

## Account entitlement refusal recovery

`src/oauth/anthropic-account-refusal.ts` accepts an HTTP 403 only when a complete bounded
JSON `error` envelope has `permission_error` or `billing_error` and a whole-message
account subscription/Claude Code entitlement or Anthropic credit-balance refusal.
Generic permission, resource/model access, content policy, quoted diagnostics, conflicting
error codes and incomplete/malformed bodies remain terminal. The shared physical dispatch
in `src/server/responses/request-transport.ts` binds the refusal to the stored bearer it sent;
overridden headers, additional API keys and replaced credentials cannot cool that account.

`src/oauth/anthropic-routing.ts` records a process-local cooldown, clears account affinity,
and applies the existing strategy, pause/reauth exclusions, model route and selection commit.
Retry-After wins; an undated account 403 uses ten minutes, independently of quota resets.
A usage probe cannot clear this non-reset-derived cooldown. Plan renewal therefore requires
no permanent reauthentication flag, though a renewed account waits for cooldown expiry.
The main dispatch, pre-output empty-completion retry, web-search and image bridge use the
same bounded recovery and record the final refusal even when no retry sends remain.
A streamed terminal continuation after assistant output and search after live output or a
published search call cannot rotate on 403. Non-streaming buffered continuations may recover.
No eligible replacement preserves the upstream 403; generic 401 handling is unchanged.
Reactive recovery also works with proactive pooling disabled when multiple accounts are stored.

Regression coverage: `tests/adapters/anthropic/anthropic-quota-dispatch.test.ts`.

## Classified 429 admission

`src/oauth/anthropic-rate-limit-policy.ts` classifies trusted unified headers before
`src/oauth/anthropic-account-refusal.ts` changes health. Shared 5h/7d rejection or an
aggregate unified rejection without a family-specific rejection cools only the sending
credential's account, including the final budget refusal. An aggregate-only refusal uses
its unified reset or the sixty-second default; Retry-After retains precedence. Family-only
rejection does not assert shared exhaustion. A transient Retry-After pauses account admission
without clearing affinity; a request gets one same-account wait up to one second and at most
one eligible sibling detour. Timer rounding at the captured retry deadline permits that
retry, while a concurrent admission-pause extension still blocks it. Headerless/invalid-hint
refusals get at most one short same-account
retry and never cool the roster or invent a client Retry-After. Main, pre-output continuation
and sidecars share the request-local allowance and physical-send budget. Cancellation,
ambiguous-send markers, replaced credentials and committed streaming output forbid replay.
Default single-account users acquire no new retry or admission pause.

Regression coverage: `tests/adapters/anthropic/anthropic-429-policy.test.ts`.

## Family weekly admission

`src/providers/quota/anthropic-family-headers.ts` attributes 7d_oi only to fixture-confirmed
Fable 5 models. It preserves independent shared and model windows, including rejection-only
family evidence only on HTTP 429, without advancing the usage-probe clock. Other response
statuses retain soft utilization without creating a hard family refusal.
`src/oauth/anthropic-model-quota.ts` reads shared 5h/weekly and only the requested family's scoped weekly. Manual, affinity,
strategy, reactive selection and physical dispatch use that model. A family-only refusal
preserves unrelated sessions and account-wide health. Numeric thresholds stay soft: zero
and the all-drained fallback remain preferences, with no hard billing cap introduced.

Passive family evidence expires after thirty minutes or its known reset. An expired
exclusion admits one request-driven revalidation send at a time, released at response
headers or error, without a background probe. An owned 2xx retires the requested family
exclusion even without family headers, restoring concurrent sends. Family mutations use a
separate generation fence: a newer family observation preserves its own evidence while an
in-flight usage probe may still recover shared cooldown and publish shared utilization.
Credential replacement discards old passive ownership. Active non-enumerating probes preserve absent family windows; an authoritative
limits array retires absent families. Shared rejection and family rejection keep independent
resets, so Fable must wait for both relevant windows while Sonnet need only wait for shared quota.

Regression coverage: `tests/adapters/anthropic/anthropic-model-weekly-admission.test.ts`.

## Native Messages dispatch

`src/server/messages-native-oauth.ts` binds native Claude Messages through the same session,
model-route and generation-fenced account authority as Responses. It rechecks current model routes
across asynchronous preparation and before sending. Concurrent affine sessions retain their own
account while a manual selection revokes stale affinity authority.
`src/server/messages-native.ts` preserves caller message/cache structure while substituting the
committed credential and provider UUID. Physical sends acquire family admission before spend/send
accounting, release the lease on every exit and attribute quota only to the actual sending generation.
Bounded pre-output refusal recovery uses `src/oauth/anthropic-account-refusal.ts`; optional tried-account
exclusions apply only to alternate selection, preserving the permitted same-account throttle retry.
Rejected bodies are disposed before rebinding; output consumption never re-enters account recovery.
Account changes may start a cold cache. The proxy does not share caches across accounts.

## Native request preference

`anthropicAccountPool.nativeMessages` is an optional Anthropic-only boolean, defaulting to true.
`src/protocols/settings.ts` applies this default only to the settled `anthropic` provider with
the pool enabled and only to absent native rollout flags. Explicit false or malformed present
flags stay off; a false/malformed pool preference vetoes pooled native dispatch, and OAuth requires
managed native. Pool-off and other providers retain explicit settings. Policy revisions include
normalized input states as well as effective policy, so masked setting changes invalidate previews.
The config schema salvages malformed present native policy conservatively without discarding
unrelated providers. Validated writes reject malformed input.

`src/server/management/oauth-account-routes.ts` exposes the preference through unified and legacy
pool settings. Anthropic writes patch the latest persisted config through its mutation owner before
updating live state. A confirmed published write followed by bookkeeping failure adopts the saved
pool and returns a fixed warning; an unpublished failure keeps old state. Unknown outcomes require
reload and are not represented as a successful save. The GUI checkbox is a saved preference rather
than a promise that a route is eligible; explicit rollout opt-outs still apply.
