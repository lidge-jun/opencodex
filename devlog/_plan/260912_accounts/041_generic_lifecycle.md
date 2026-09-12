# Bind admitted generic accounts and classify recoverable failures

Cycle lifecycle depends on generic-family. C4 credential/retry. Existing owners: `generic-account-failover.ts`, `oauth/store.ts`, `server/responses/core.ts:4054/4149/5537`, `oauth/anthropic-routing.ts:759` provides a commit-after-resolution precedent.

MODIFY generic-account-failover.ts: bounded process-local conversation affinity keyed by provider/session identity, with explicit idle TTL and entry cap; no conversation id means no affinity. Look up only live non-reauth accounts, release on expiry/removal/credential-generation change or classified failure, bind admitted account after guarded snapshot application rather than proposal. Extend note-success/selection context to carry actual account generation. Preserve explicit account selectors and manual active selection semantics; never persist conversation bodies.

MODIFY existing generic recovery branches in core.ts: retain one same-request retry budget and existing no-output replay boundary. Handle only post-refresh account authentication rejection and provider-classified quota/account 403; ordinary permission/region/policy 403 stays terminal. Classifier uses existing provider error/code owners, not arbitrary text heuristics. Auth failure marks only rejected credential generation unhealthy, quota failure records family cooldown. Retry snapshot token/project/routing metadata must all describe the chosen account.

```ts
// The exact evidence-discriminated GenericOAuthFailure union is specified below.
```

No stored broad rotateOn flag is introduced until its every consumer is grounded; defaults express only classified safe recovery. Field chain: adapter response classifier → internal failure object → existing recovery dispatch (not persisted credentials) → health/affinity invalidation and request attempt recovery marker. Add a bounded explicit recovery-kind union only if required, update log normalizer/GUI label/serialization together.

Tests: multi-turn affinity holds; removal/reauth/expiry releases; proposed stale credential never binds; post-refresh 401 rotates one account; quota-classified 403 rotates; unrelated 403 does not; no rotation after downstream output; budget exhaustion terminates; initial and continuation paths match. New test files join both layout registries. Credential threat model and draft details stay in `.tmp/`; public unit contains safe design only. All source ownership docs updated. Local tests NOT RUN; hosted final cumulative tip plus independent security review required.

Reflection REF-01 overrides the earlier broad failure type and family-affinity key. Affinity is provider+session, not family: a model change retains account if eligible for that family, otherwise releases it. Cap 2048 entries, idle TTL 30 minutes, prune on write and deletion/generation change. Context now is passed from one request clock. The only classified failure union is:
```ts
type GenericOAuthFailure =
 | {kind:"terminal"}
 | {kind:"auth"; status:401; evidence:"post-refresh-401"; generation:string}
 | {kind:"auth"; status:403; evidence:"provider-account-credential"; generation:string}
 | {kind:"quota"; status:403|429; scope:"account"|"gemini"|"claude"; retryAfter?:string};
```
First 401 uses existing refresh. Refresh transport error never marks unhealthy. Provider-account 403 requires existing closed code classification; when absent it is terminal. One request-wide recovery budget and unconditional client-output committed marker prohibits new dispatch after any output, including continuation and sidecar. Preserve sidecar quota-only callback unless its existing error contract can carry authenticated post-refresh evidence; record terminal auth limitation rather than invent evidence. Snapshot generation type is revalidated against OAuthAccessSnapshot before implementation.
