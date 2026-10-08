# 020 — Pool runtime state and data plane (wp3)

## Pool runtime

- `src/oauth/anthropic-routing.ts`: module body becomes `createAnthropicRouting(instance)`; module-level
  `PROVIDER`, `upstreamHealth`, `sessionAffinity`, `manualPreference`, `manualSelectionGeneration`,
  `quorumCache` move into the instance closure. `anthropicRoutingFor(instance)` caches one facade per
  instance; existing exports are bound to A. Event subscriptions are registered once and dispatch to the
  facade of `event.provider` only when it exists. Config reads use `resolveAnthropicAccountPoolConfig`.
  Errors such as `OAuthLoginRequiredError` carry the real instance. If the file would pass 1999 lines,
  move the factory into `anthropic-routing-instance.ts`.
- `src/oauth/anthropic-model-routes.ts`: `resolveAnthropicModelRouteForInstance(instance, config, modelId)`
  reads the instance's routes; the old name stays as the A wrapper; `routeCandidates` stays pure.
- `src/oauth/anthropic-model-quota.ts`, `anthropic-rate-limit-policy.ts`: per-instance maps behind
  `anthropicModelQuotaFor(instance)` / `anthropicRatePolicyFor(instance)`; classifiers stay shared;
  legacy exports mean A; `clearAll...` helpers for shutdown/tests.
- `src/oauth/anthropic-account-refusal.ts`: response ownership keeps `snapshot.provider`; recovery
  requires the matching instance.
- `src/oauth/anthropic-account-threshold.ts`: `effectiveAnthropicAccountThresholdForInstance(instance, config, row)`;
  the old name stays as the A wrapper.
- `src/oauth/health.ts`: `projectStoredOAuthAccountHealth` reads cooldown evidence through the routing facade
  of the row's instance (today it does so only for `anthropic`).
- `src/oauth/pool-kernel.ts`: `anthropicPoolKey(instance)` (A keeps `"anthropic"`); reconcile builds one
  roster per instance. `src/oauth/generic-account-failover.ts` excludes both instances.
- `src/oauth/pool-settings-capability.ts`: both instances get the Anthropic capability; DTO reads the
  instance's config.
- `src/lib/state-store-registrations.ts`: sweeps traverse every existing instance bucket.
- `src/providers/quota/anthropic-cooldown-recovery.ts`: generations keyed by (instance, account).

## Data plane

- `src/protocols/settings.ts`: pooled native preference resolved for the selected instance;
  `protocolPolicyRevision` includes B's inputs.
- `src/server/messages-native-eligibility.ts`: OAuth native gate uses `configuredAnthropicInstance(config,
  route.providerName)` (ID predicate plus the D-09 row-shape guard); the wire `adapter` check is unchanged,
  so a custom `anthropic2` gateway row keeps its current non-instance behaviour.
- Every request-path instance derivation in this phase uses `configuredAnthropicInstance`, never the bare ID
  predicate.
- `src/server/messages-native-oauth.ts`, `messages-native.ts`: bindings carry an immutable instance used
  for currentness, credential/UUID reads, family leases, quota recording and refusal recovery.
- `src/server/claude-messages.ts`: the caller-forward candidate predicate excludes provider-qualified
  routes to an instance other than the bare A path; quorum reads use the settled instance.
- `src/server/responses/request-transport.ts`: every `route.providerName === "anthropic"` pool/OAuth
  gate becomes instance-aware, with the instance captured once; log bases use it.
- `adapter-dispatch.ts`, `adapter-continuation.ts`, `sidecar-execution.ts`, `core-combo.ts`,
  `src/routing/quota.ts`: recovery, snapshots, labels and cache keys use the captured instance.
- `src/router.ts` bare Claude inference: unchanged (A only).

## Tests

- `tests/adapters/anthropic/anthropic-instance-isolation.test.ts` — equal account and session IDs in A
  and B with distinct tokens: affinity, manual selection, cooldown, admission pause, family quota and
  round-robin state stay separate; B with no accounts fails closed while A has accounts.
- `tests/claude-integration/anthropic2-native-routing.test.ts` — native eligibility for B, qualified B
  route does not take caller-forward, bare claude still resolves to A.

## Execution plan revalidated at 56a6a7fd17

Previous D: the identity/config/credential foundation passed its hosted contract and baseline regressions, Typecheck and structure gates. Full runtime parity remains this phase and the helper/product-surface phase; full CI remains required before merge. No change of direction.

### Main dispositions

- Accept captured-instance facades, A compatibility wrappers, shared pure helpers
  and module-level subscriptions dispatched only to existing matching instances.
- Accept distinct ForInstance APIs for model routes, thresholds, response recovery,
  native bindings and quota-header recording. Existing signatures remain A.
- Accept scope expansion to account-cache and quota barrel: physical data-plane
  assertions cannot pass while header attribution remains canonical.
- Require configured admission at B selection and immediately before physical send,
  preserving existing A auth/disabled checks. Same instance through every await,
  body rebuild, recovery and continuation. Snapshot.provider must match the settled
  provider; errors must not cause sibling-pool fallback.
- A route named `anthropic2` with OAuth auth and failed configured admission must
  refuse locally before the generic OAuth resolver can run. An undefined instance
  is not permission to resolve the same B auth namespace through generic fallback.
  Custom key rows keep their existing key-auth path. Native-ineligible B OAuth
  follows the scoped Responses bridge, never generic orphan credential resolution.
- Claims/leases carry instance and generation. Removal/re-add must invalidate old
  claims; sweeps walk existing buckets without allocating dormant B state.
- Keep shared error classes/pure wire transformations outside factories. If factory
  extraction is necessary, put shared contract types and pure helpers in a leaf;
  avoid facade/implementation runtime cycles.

## Fixed interfaces

### Ownership refinement prerequisite

Before integrating runtime workers, add explicit B configuration provenance:
`OcxProviderConfig.anthropicOAuthInstance?: "anthropic2"`. B's pure row predicate
requires an own marker, Anthropic adapter and OAuth mode. Endpoint equality,
existing auth rows and registry membership do not imply ownership. A remains
legacy-compatible without a marker. Both registry instances retain baseUrl override
support; first-party native eligibility stays the existing shared policy.

Creation: `src/providers/derive.ts` seeds the marker only for explicit builtin B
creation; `src/oauth/index.ts` preserves it on owned updates and refuses every
existing unmarked collision before login/persist/publication. No auto-migration.
Serialization: provider config and editor round trips retain it. Deserialization:
`src/config/schema/leaf-validators.ts` validates the literal; raw diagnostics reject
misplaced or incompatible markers without taking over an unmarked custom row.
Consumers: pure/config-aware identity helpers, registry transport ownership,
OAuth publication/guardian, discovery/probe guards and all runtime admission.
Update exhaustive field maps in `src/providers/model-rename-fields.ts` and
`src/server/auth-cors.ts`; this field carries no model IDs or credentials.

Discovery captures the authorized target derived from the marked configuration
with the existing transport/model-discovery URL rules. Guard against that target,
not a hardcoded first-party origin or request.url used as its own authority.
Live probe checks must match ownership and the captured target after awaits.
Marked overrides preserve A/B bridge parity; unmarked custom key rows retain their
own key. Unmarked OAuth rows never obtain the builtin B credential.

Ownership worker (exclusive): `src/providers/anthropic-instance-id.ts`,
`src/providers/anthropic-instance.ts`, `src/types/provider.ts`,
`src/providers/registry.ts`, `src/providers/registry/types.ts` if needed,
`src/providers/registry/entries-core.ts`, `src/providers/derive.ts`,
`src/providers/model-rename-fields.ts`, `src/config/schema/leaf-validators.ts`,
`src/config/schema/anthropic-account-pool.ts`, `src/config/diagnostics.ts`,
`src/oauth/index.ts`, `src/oauth/store-anthropic-instance.ts`,
`src/oauth/model-discovery-auth.ts`, `src/codex/catalog/provider-models.ts`,
`src/codex/catalog/gather-capture.ts`, `src/server/auth-cors.ts`,
`src/server/management/provider-routes.ts`, `src/cli/provider.ts`.
It may extract sibling modules for existing caps. Update the six existing instance
foundation tests/fixtures for marked B and preserve all previous cases; add unmarked
canonical collisions, marked overrides, marker round-trip/removal and live target
replacement. State's new shared fixture seeds marked B directly.

The four runtime packets below retain disjoint files from this prerequisite.
Publish marker semantics first; all packets use the same fixed helper names.
This refinement requires fresh source security review and hosted evidence.

Every method on anthropicRoutingFor(instance), anthropicModelQuotaFor(instance),
anthropicRatePolicyFor(instance), anthropicCooldownRecoveryFor(instance) retains
its current argument order and return contract, as enumerated by the architect.
The instance is required by the factory and immutable on returned facades.
Legacy named exports bind only to A.

New required-instance entrypoints:

- resolveAnthropicModelRouteForInstance(instance, config, modelId)
- effectiveAnthropicAccountThresholdForInstance(instance, config, row?)
- rotateAnthropicAccountOnResponseForInstance(instance, response, options)
- getAnthropicSidecarAccessTokenForInstance(instance, model, config)
- resolveNativeOAuthBindingForInstance(instance, config, options?)
- recordAnthropicAccountQuotaFromHeadersForInstance(instance, accountId, headers,
  writerGeneration, status?, model?)

The header recorder signature is locked to the argument order above: headers is
`Headers`; writerGeneration is the numeric config/roster publication generation.
It is distinct from the credential-generation string in the sent snapshot.
Preserve `mayCommitAccountQuotaKey`'s live-key exception for an older config
generation. Physical response consumers synchronously check sent provider, bearer
and credential generation after awaits and before recording; native also preserves
UUID ownership. Old recorder remains an A wrapper.

## Disjoint workers

State: oauth/anthropic-routing* implementation, anthropic-model-routes,
anthropic-account-threshold, pool-kernel, generic-account-failover, health,
pool-settings-capability; lib/state-store-registrations;
routing/quota, routing/compatibility/assemble and
server/management/routing-profile-routes.ts (including both dry-run consumers and
their parseCandidateEvidence config plumbing).
Tests: anthropic-instance-isolation, anthropic-instance-pool-parity,
oauth-anthropic-instance-health; owns reusable tests/helpers/anthropic-instance-fixture.ts.

Quota: oauth/anthropic-model-quota, anthropic-rate-limit-policy,
anthropic-account-refusal, providers/quota/account-cache,
providers/quota/anthropic-cooldown-recovery, providers/quota.ts export only.
Tests: adapters/anthropic/anthropic-instance-quota.test.ts (separate file), with
equal IDs, independent family claims/admission pauses and physical header attribution.
This splits the architect's large State packet along the existing quota-owner boundary.

Responses: server/responses/request-transport, adapter-dispatch,
adapter-continuation, sidecar-execution, core-combo and context types required in
those files. Ask main before modifying another owner.
Tests: anthropic-instance-recovery, anthropic2-fast-parity,
responses/anthropic2-responses-parity.

Native: server/messages-native*.ts, server/claude-messages.ts,
protocols/settings.ts and protocols/plan-snapshot.ts. The snapshot's
messagesPassthroughPossible predicate must exclude qualified B selectors just as
ingress does; preview stays credential-free.
Tests: claude-integration/anthropic2-native-routing.

Main: task docs, structure owners, both test inventories and git/CI. Fixture is
assigned to State (amend architect's parent ownership) so contract implementations
and fixtures arrive together; consumers may write tests against documented fixture
or inline minimal setup until State publishes it, then consolidate.

## Dependency and verification

State and Quota publish their real facade APIs together before integration.
Responses and Native use the fixed method-name contract; no placeholder production
functions. Quota publishes explicit all-bucket reconciliation hooks; State owns
sweeper registration and the routing claim's readonly instance field. Removal and
clear advance incarnation fences before pruning; retain monotonic counters or
tombstones so an old zero-generation claim cannot become current after re-add.
Workers cannot change branches, commit, push, run local tests/build/typecheck/lint,
start services, spawn children or mutate goal/FSM.
All use gpt-6.1-sol. No source file exceeds its baseline or 1999 lines.

H-01/02/03 require isolated homes, equal stored IDs/session IDs but distinct tokens
and verified UUIDs, a send ledger, deterministic await barriers, and an intentional
misbinding negative control caught by the ledger. New cases cover pool-off recovery,
strict/fallback routes, pause/cooldown/family behavior, native and translated paths,
prefix stripping, caller credential exclusion, and no post-output replay.
Actual execution is hosted CI at the phase commit; no local test execution.
Full merge readiness and all applicable jobs remain wp5 criteria.
