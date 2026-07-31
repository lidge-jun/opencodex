# 020 — WP2: anthropic family (anthropic, anthropic-apikey, umans, xiaomi, cloudflare-ai-gateway)

Pre-analysis: Hume (sol explorer, 2026-07-10). Re-verify against tree at WP2's P.

## Model delta (research 001, corrected in A-round1)

All 7 seed ids KEPT (opus-4-7/opus-4-6/sonnet-4-6 are lifecycle-active per
research 001 — no removals). Only ctx map additions: claude-opus-4-8 1M,
claude-haiku-4-5 200K (both Tier-2 proven).

## Hardening targets (diff-level candidates; scope-check at P)

1. registry.ts (AMENDED after A-round1: reviewer correctly flagged that research
   001 lists opus-4-7/opus-4-6/sonnet-4-6 as LIFECYCLE-ACTIVE, not DROP —
   removal was over-reach; KEEP all 7 seed ids): only ADD missing ctx entries
   claude-opus-4-8: 1_000_000 (Tier-2 proven), claude-haiku-4-5: 200_000
   (Tier-2 proven). No id removals in WP2.
   Xiaomi CORRECTION (main-session Tier-2 re-check 2026-07-10): api.xiaomimimo.com
   RESOLVES (CNAME mimo-pri-alisgp.alb.xiaomi.com -> 47.237.8.234); the explorer's
   DNS-dead claim was the website domain, not the API host. Entry KEPT; model
   data FROZEN (mimo-v2.5-pro unproven but unfalsified — no change).
2. anthropic.ts:627 — key/oauth modes omit auth header when apiKey absent =>
   throw loud missing-credential error at buildRequest.
3. anthropic.ts usesNativeAnthropicEndpoint catch (malformed baseUrl -> false,
   silently disables auto-caching) => rethrow with clear message. AMENDED after
   A-round1: activation test REQUIRED and must enable caching (cacheRetention
   set) because short-circuit evaluation only reaches this helper when caching
   is on — test: adapter with cacheRetention "short" + malformed baseUrl =>
   buildRequest throws naming the baseUrl.
4. key-providers.ts:75 — validateApiKey probe fallback id `claude-sonnet-4-6`
   stale => use `claude-haiku-4-5` (cheapest current alias). "unknown" semantics
   for non-auth failures KEPT (documented best-effort; hard-failing on transient
   network here would block logins — not a silent fallback, returns explicit
   "unknown").
5. cloudflare-ai-gateway {account-id}/{gateway} placeholders => same treatment
   as WP1 azure (buildRequest throw + router user-baseUrl respect; WP1 router
   change already generalizes — verify only).
6. OUT (behavior-change too broad for this unit, user did not ask to break
   compat): image-guard textification, empty-content substitution, tail-guard
   "(continue)", tool-schema flattening, SSE malformed-frame drops. These are
   documented protocol-compat guards with test lock-ins; converting them to hard
   errors would break real Codex flows. Record as NOOP-with-rationale unless the
   A reviewer disagrees.

## Tests

ADD: missing-key throw (anthropic-apikey), placeholder throw (cloudflare),
registry ctx parity assertions (opus-4-8/haiku-4-5), malformed-baseUrl rethrow
activation test WITH cacheRetention "short" enabled. Existing anthropic-* suites
must stay green.
