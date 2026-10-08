# Anthropic Account Pool

## Instance identity and credential registration

`src/providers/anthropic-instance-id.ts` owns the fixed `anthropic` and `anthropic2`
identifiers. The registry declares both as Anthropic OAuth family members; they share
one adapter and model metadata. `src/providers/anthropic-instance.ts` distinguishes
instance identity from configured admission. Pool 2 requires an enabled Anthropic
OAuth row with its own `anthropicOAuthInstance: "anthropic2"` marker. Explicit
builtin creation supplies the marker; load, enrichment and reconciliation never
adopt an existing unmarked row, even at the canonical endpoint. Both pools retain
the existing endpoint override behavior. The marker records configuration intent,
not a cryptographic or OS boundary.

`src/types/anthropic-account-pool.ts` defines the shared configuration shape.
`src/oauth/anthropic-pool-config.ts` reads the primary pool from the top-level
`anthropicAccountPool` and Pool 2 from its provider row, without inheriting the
primary pool's settings. Malformed native preference remains false on tolerant load;
strict write diagnostics reject unsupported field locations.

`src/oauth/anthropic-oauth-definitions.ts` shares the OAuth engine while Pool 2
disables local Claude CLI import and continuity. `src/oauth/store-anthropic-instance.ts`
checks cross-instance token fingerprints and bearer-bound UUID proofs inside the
existing auth-store write lock. Display identities do not establish a duplicate.
Refresh intent paths and credential-owner checks retain the actual instance.
Pool 2 config publication rechecks the latest provider row under the config mutation
lock; a collision preserves the custom row and reports any already-written orphan
credential. No default-provider change accompanies that publication.

Regression coverage: `tests/providers/provider-anthropic-instance.test.ts`,
`tests/config/config-anthropic-instance-pool.test.ts`,
`tests/oauth/oauth-anthropic-instance-registration.test.ts`, and
`tests/oauth/oauth-anthropic-instance-refresh.test.ts`.

## Discovery credential ownership

`src/oauth/model-discovery-auth.ts` checks the configured Pool 2 row before a
catalog resolver observes or refreshes its OAuth credential. Observed gathers use
their captured provider snapshot. `src/oauth/index.ts` applies the same policy
when building the final models request; Pool 2 OAuth authorization is scoped to
the target authorized by its marked configuration. Connection probes capture the
provider row and recheck live ownership and target before sending. A custom key provider named `anthropic2`
continues to use its own configured key, including legacy rows with no auth mode.
Coverage: `tests/oauth/anthropic2-discovery-ownership.test.ts`.

## Instance-scoped runtime

Pool 2 is reached only by an explicit `anthropic2/<model>` selector, its alias, or
`defaultProvider: "anthropic2"`. `activeProviderEntries` in `src/router.ts` leaves the marked
builtin row out of bare-model fallback (configured default model, model lists, model
aliases), so a bare `claude-*` never resolves to Pool 2 whatever the row order or the
primary row's state; an unmarked custom `anthropic2` row keeps ordinary fallback. A
Pool 2 selector leaves `anthropic2` only through an operator blocked-model redirect.

`anthropicRoutingFor(instance)` in `src/oauth/anthropic-routing.ts` binds account
selection, affinity, quorum, manual preference, cooldown and rotation to one
instance. Legacy named exports mean the primary pool. Model routes widen only
within that instance's roster. Pure protocol/model transformations remain shared.
Pause, policy and selection notifications affect only the matching existing state.

`src/oauth/anthropic-model-quota.ts`, `src/oauth/anthropic-rate-limit-policy.ts`
and `src/providers/quota/anthropic-cooldown-recovery.ts` expose corresponding
instance-bound owners. Family leases, admission pauses and probe generations
include the instance and account. Clear/removal fences prevent an older claim from
becoming current after the same account ID is re-added.
`src/lib/state-store-registrations.ts` sweeps and reconciles existing instance
buckets without starting dormant pools.

Responses and native Messages retain the configured instance and authorized
target through preparation, retries and continuations. Named Pool 2 OAuth routes
that fail configured admission refuse before generic OAuth resolution.
Physical response attribution checks the sent provider, bearer and credential
generation; native also checks its UUID. The header writer's numeric config
generation is separate from the credential-generation string and preserves the
existing live-roster exception. Explicit combos retain their declared targets;
direct Pool 2 account recovery never selects the primary pool.

`src/oauth/anthropic-send-ownership.ts` captures the account incarnation and
login identity before the physical fetch. Header publication and refusal binding
retain that same owner after the await; response arrival cannot adopt a newly
registered row with identical credentials. Ordinary cooldown observations do not
invalidate the send incarnation. Numeric config generation remains a separate
roster fence.

`src/server/responses/request-prepare.ts` preserves explicit Pool 2 intent before
default routing can discard an unavailable qualifier. Exact configured provider
keys precede aliases; unrelated uppercase custom keys retain their own meaning.
Messages ingress and protocol preview share the corresponding selector rule.
`src/router.ts` also reserves unavailable literal Pool 2 selectors before the
default-provider path. Its dedicated refusal maps to authentication errors in Chat
and Responses ingress, including native Chat, which may bypass the Responses
preparation pipeline. The router uses the import-free identity leaf.

## Pool-bound helpers

Vision and web search choose their backend family first, by the existing rules:
web search defaults to OpenAI and vision keeps its automatic order.
Only an Anthropic family result consults a pool. `resolveAnthropicHelperInstance` in
`src/sidecar/auth.ts` takes the explicit `anthropicInstance` of `webSearchSidecar`,
`visionSidecar` or the matching `claudeCode` override, then the parent request's
builtin instance, resolved through `inheritedAnthropicInstance`: a present custom unmarked
`anthropic2` row is never inherited as Pool 2, while a parent pool whose row was removed or
disabled mid-request is still inherited, so its helper refuses instead of discovering
another pool. A target is available when it is
configured and holds any account that is neither paused nor awaiting reauth; which
account sends is decided at snapshot time. An explicit or inherited target that is
unavailable raises `AnthropicHelperUnavailableError` (`anthropic_helper_unavailable`).
The planners (`planWebSearch`, `planVisionSidecar`, the passthrough bridge) convert
that refusal into "no helper plan" through `withAnthropicHelperRefusal`, so the main
request proceeds exactly as it does when no helper is configured, and nothing
discovers another pool. With neither target, legacy discovery keeps its order and
never adds Pool 2. `resolveAnthropicSidecarAuth` is an exact instance lookup with no
fallback.

`src/sidecar/anthropic-binding.ts` gives builtin helpers the selected instance's
model-route admission, account selection and credential snapshot through
`resolveAnthropicHelperSnapshot`. Like the legacy helper token path, it reads the
pool's selection without promoting the active account, so a helper never moves the
active pointer or spends a one-dispatch manual preference. `fetchAnthropicHelper`
rechecks the configured row, captured target, live account and bearer before each
physical send, so a removed, paused or replaced account refuses rather than sending.
Callers and the send fence build the Messages URL with the same
`anthropicHelperMessagesUrl`, so a trailing slash on `baseUrl` cannot split them.
Generated image descriptions are cached per resolved pool, model and reasoning;
settings that do not change the description (`enabled`, `timeoutMs`) leave the
cache intact. Custom helper providers keep
their own credential path. `src/vision/plan.ts`, `src/vision/anthropic-describe.ts`
and `src/web-search/` consume this binding; account-refusal recovery in
`src/web-search/loop.ts` and `src/images/loop.ts` stays within the sending instance.
Compatibility Lab live probes (`src/lib/lab-live-route-production.ts`) fetch an `anthropic2`
bearer only for the marked builtin row; an unmarked or orphaned row refuses before any credential
lookup.

`src/config/schema/anthropic-account-pool.ts` accepts `anthropicInstance` only as
`anthropic` or `anthropic2`, only with an Anthropic backend, and rejects a
provider-qualified helper model naming the other instance. Claude Code overrides are
validated after inheriting the global helper fields; an inherited pool is checked only
while the merged backend is Anthropic. In
`src/server/management/config-routes.ts` and `agent-settings-routes.ts` a missing field
preserves, `null` deletes and an instance sets; an unset choice is never written as
`anthropic`. The option DTOs in `web-search-sidecar-options.ts` and
`vision-sidecar-options.ts` report the selected, parent, mixed and available pools.

## Pool-bound quota and reset grants

`src/providers/quota/anthropic-account-quota.ts` probes per-account usage for either
instance. It refuses an unconfigured instance, resolves token renewal before keying its
flight on the credential actually dispatched, and publishes only while the instance's
quota epoch, configured row, account incarnation and login identity are unchanged.
`captureProviderAccountQuotaEpoch(instance)` and the cache keys in
`src/providers/quota/account-cache.ts` are per instance, so clearing Pool 2 quota never
invalidates the primary pool.

`src/providers/anthropic-reset-grant-ledger.ts` names the journal by instance:
`anthropic-reset-grant-ledger.json` keeps the primary pool's existing bytes and records,
and Pool 2 uses `anthropic2-reset-grant-ledger.json`.
`src/server/management/anthropic-reset-grant-routes.ts` reads `provider` from the GET
query and the consume body, treats omission as the primary pool, echoes the provider and
returns `invalid_provider` for an unconfigured instance. Account, grant and operation IDs,
unknown-outcome retry ownership and session consent stay bound to that instance.

## Pool-bound management surfaces

`src/server/management/anthropic-pool-settings.ts` owns Anthropic pool persistence.
`writeAnthropicPoolSettings` writes exactly one location (top-level for the primary pool,
the provider row for Pool 2) and never recreates a deleted Pool 2 row.
`persistAnthropicPoolPatch` takes a required instance for the durable mutation, the
uncertain-save comparison and live publication; an unknown outcome returns 409
`config_save_state_unknown`. `src/server/management/oauth-account-routes.ts` serves
`/api/oauth/accounts/pool` and `/api/pool/settings` for both instances with DTO kind
`anthropic` and the actual provider. An unconfigured Pool 2 is refused: 409 from
`/api/oauth/accounts/pool` and 400 from `/api/pool/settings`, which has no pool kind for it.

`src/cli/account.ts` and its siblings accept `anthropic2` for pool, auto-switch, routes
and account selection; `ocx account anthropic-reset-grants` keeps its syntax and adds
`--provider anthropic|anthropic2`. `src/codex/catalog/provider-models.ts` discovers Pool 2
like the primary pool. `src/providers/label.ts` and `src/usage/cost.ts` keep Pool 2's own
label and grouping while pricing it from the shared Anthropic family metadata.
`gui/src/provider-icons.ts` maps `anthropic2` to the green Claude mark, mirrored by
`desktop/src-tauri/src/provider_icons.rs`; GUI query keys and mutation state carry the
provider.

Regression coverage: `tests/vision/vision-anthropic-instance-sidecar.test.ts`,
`tests/web-search/web-search-anthropic-instance.test.ts`,
`tests/providers/provider-anthropic-instance-quota.test.ts`,
`tests/server/anthropic2-management.test.ts`,
`tests/server/management-sidecar-anthropic-instance.test.ts`,
`tests/cli/cli-anthropic2-account.test.ts`, `tests/codex-integration/anthropic2-catalog.test.ts`,
`tests/usage/anthropic2-usage-attribution.test.ts`, `gui/tests/anthropic2-provider-mark.test.ts`
and `gui/tests/anthropic-instance-helper-controls.test.tsx`.

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

`anthropicAccountPool.nativeMessages` is an optional per-instance boolean, defaulting to true.
`src/protocols/settings.ts` applies this default to the settled builtin Anthropic instance with
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
