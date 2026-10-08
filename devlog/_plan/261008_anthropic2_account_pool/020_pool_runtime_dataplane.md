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
