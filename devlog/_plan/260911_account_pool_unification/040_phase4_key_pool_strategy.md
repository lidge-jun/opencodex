# Phase 4 — API keys gain proactive selection

Base: dev directly. This layer is NOT in the chain: key-failover shares no module
with the OAuth kernel, and an API key is a different identity from an OAuth
account set. The A-phase audit reparented it here.

## Thesis

API-key pools get a proactive strategy before the first attempt, while keeping
the existing reactive 429 and 401 rotation as the fallback.

## Current behaviour (verified on dd9a2906b)

src/providers/key-failover.ts is reactive only. hasKeyPoolFailover (:98-101)
requires authMode not oauth or forward and apiKeyPool length at least 2.
Selection is a circular index walk in rotateKeyAfterFailure (:220-233) starting
from the failed entry, skipping cooled keys. Cooldown state is a local map
(:19-53) keyed by provider and key id. Wrappers: rotateKeyOn429 (:269-278),
rotateKeyOn401 (:288-296), rotateProviderTransportOn429 (:322-338).

src/providers/api-keys.ts listProviderApiKeys (:62-80) returns the pool and an
activeId with no strategy. src/types/provider.ts:384-389 defines apiKeyPool as
id, key, label and addedAt only.

The pre-dispatch hook points are in src/server/responses/core.ts: :4188-4190
(refreshDispatchAdapter calling resolveCurrentProviderApiKeyTransport) and
:4437-4444 (resolveProviderTransport after OAuth resolution). The OAuth side has
preferredInitialAccount at :4335-4340 with the comment that it prefers a known
headroom account before the first attempt; API keys have no analogue.

## Change surface

MODIFY src/types/provider.ts - add an optional per-provider key-pool strategy
field. Do not reuse the OAuth account-pool field names; these are different
identities and phase 5 owns the operator surface.

MODIFY src/providers/key-failover.ts - add a proactive selector invoked from the
pre-dispatch sites, supporting round-robin and a rate-limit-aware order. Keep
:220-233 exactly as the 429 and 401 fallback.

MODIFY src/server/responses/core.ts at :4188 and :4437 to consult the selector
before the first attempt. The mid-retry resolveProviderTransport calls at :4119,
:5399, :5503 and :7346 stay recovery paths and are not touched.

## Policy difference from OAuth pools, stated deliberately

Key rotation is a rate-limit scheduling problem: keys usually share an account or
organization, so moving key costs little cache. Subscription accounts lose their
prompt cache on every move. That is why phase 3 puts affinity ahead of quota for
accounts and this phase does not for keys.

## Security

key-failover already logs failedId and candidateId. The new selector must not
inherit that shape, and must log no key identity. privacy:scan stays green.

## Tests

A configured round-robin strategy changes the first-attempt key; the reactive 429
and 401 walk still works when the strategy is unset; a cooled key is skipped by
both paths; a single-key pool is a no-op.

## Out of scope

No operator-visible surface. Phase 5 owns the management route and GUI; adding
fields there from this layer would collide with it.
