# 080 — wp8: reinforce the Codex prompt cache and report it honestly

## Why this is here

Holding a binding (wp2) protects a cache that already exists. It does nothing if
the cache was never warm, and nothing if the operator cannot tell whether it was.
Both are true on the Codex path today, and the second one is why #4546 took a
token-burn incident to notice instead of a dashboard.

Anthropic-shaped clients go out of their way to force caching: explicit
`cache_control` breakpoints, a session-latched beta header and TTL so a toggle
cannot invalidate 20-70k tokens mid-conversation, and a retry policy that keeps a
short `Retry-After` on the **same** model precisely to avoid losing the prefix.
Upstream Codex does the equivalent with a session-scoped `prompt_cache_key` and a
turn-sticky `x-codex-turn-state` token that retries replay. OpenCodex forwards
what it is given and adds little of its own.

## Cache reinforcement

**Stable cohort identity.** A conversation should present one stable cache key for
its lifetime. Where the inbound request already carries `prompt_cache_key`, it is
preserved unchanged — it is the client's cohort and rewriting it is how a prefix
gets split. Where it is absent but a stable conversation identity exists, derive
one deterministically from that identity rather than leaving the destination to
guess, and keep the derivation stable across turns, retries and detours.

**Wire contracts are per destination, not per model name.** The canonical ChatGPT
Codex backend rejects `prompt_cache_options`, which is why the adapter already
strips it; the public API, Azure deployments and custom Responses gateways each
document their own support. A cache parameter is sent only where that destination
documents it. "Same model name" is not evidence of the same wire contract.

**Prefix stability is part of the cache.** Reordering tool definitions, rewriting
instructions, or toggling a header between turns invalidates a prefix just as
surely as changing accounts. Anything that varies per turn belongs after the
stable prefix, not inside it.

## Honest reporting

Missing cache information must stay **unknown**. Today the bridged Responses, Chat
and Anthropic paths always emit `cached_tokens: 0` and Kiro always writes 0, so a
provider that reports nothing is indistinguishable from a provider that reports a
total miss. `OcxUsage` already omits rather than zero-fills and `cacheHitRate` is
already `null` when unobserved — the defect is upstream of that, in the synthesized
zeros, and it is what makes the cache indicator look broken.

What the operator needs to see for a Codex model: cache reads, cache writes, and
ordinary input as three separate numbers, with unknown rendered as unknown; and
per provider, since the arithmetic differs — OpenAI folds cache reads and writes
into the input total while Anthropic reports them as separate fields, so a single
subtraction rule is wrong for one of them.

## Boundaries

The proxy does not manage a provider's KV cache and must not claim to. It controls
placement, pinning, parameter fidelity and prefix stability. Observed cache ratios
are evidence, not a guarantee, and a request whose result was lost after sending is
not refunded to zero.
