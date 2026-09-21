# 060 — wp6: group credentials by observed domain, not by string identity

## Today

A credential pool is a list. Two API keys are assumed to be two independent pools
of capacity, and two accounts on one provider are assumed not to share a cache.
Both assumptions are wrong in opposite directions, and each one costs money in a
different way.

OpenAI documents that prompt caches are not shared across organizations or
processing regions, and that changing keys within one organization does not
guarantee a hit; rate limits are defined per organization and project, with model
groups sharing a limit — so failing over from key A to key B inside the same limit
buys no capacity while still paying a cold prefix. Anthropic isolates prompt cache
per workspace even inside one organization, and excludes cache-read tokens from
input TPM while counting cache writes and ordinary input — so identical token
counts consume quota differently per provider. Azure documents its own cache-key
guidance and per-deployment breakpoint differences for the same model family.
Gemini's current interactions surface supports implicit caching but not explicit
cache objects, and explicit caches are project- and region-scoped resources rather
than portable strings.

## The rule

Three identities, tracked separately: the authentication identity, the cache
compatibility domain, and the quota-sharing domain. They are a conservative
classification the proxy maintains, never a claim to know where a provider stores
its cache. Undocumented providers stay `unknown`, and `unknown` is never silently
read as "no cache" or as "shared across accounts".

Cache compatibility and conversational portability are also different questions. A
request carrying `previous_response_id`, file ids, or a provider-side conversation
id cannot be replayed onto another account at all; the adapter must confirm
portability and return a clear error rather than replaying onto the wrong
credential. Comparable gateways implement exactly this as a separate pre-call
check, which is evidence the distinction is load-bearing in production rather than
theoretical.

## Consequence for placement

New sessions are placed by cache-reuse likelihood and free capacity within a quota
domain. Keys that share a documented limit count once toward available capacity.
Existing sessions are not re-placed by any of this — wp2 already settled that.
