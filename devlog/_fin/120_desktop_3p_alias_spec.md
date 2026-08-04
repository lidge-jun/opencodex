# Claude Desktop 3P short alias specification

## Decision

Use a three-character, letter-first base36 code derived from SHA-256 of the
canonical route key, and keep a small persisted reverse registry. Expose routed
models as:

```text
claude-{tier}-4-{code}
```

For example, `native/gpt-5.6-sol` is exposed as
`claude-opus-4-bji`. The discovery `display_name` remains honest, for example
`GPT-5.6-Sol (native)`.

This replaces the long `claude-ocx-{provider}--{model}` form only on the Claude
Desktop 3P / Claude Code discovery surface. The old form should remain accepted
inbound during migration because it may already be stored in Claude Code
settings.

Why this choice:

- A two-character base36 space has only 1,296 values and about a 61% chance of
  at least one collision at 50 models. It is not adequate.
- A three-character letter-first base36 space has 33,696 values and about a
  3.6% collision chance at 50 models. It still looks like a plausible Claude
  revision token and is small enough for the filter-sensitive surface.
- Hashing is stable under unrelated additions and removals. Alphabet and
  phonetic compression are either longer or unstable when model naming
  conventions change. Sorted index plus salt directly violates stability.
- A lookup table is required anyway: no 2-3 character code can reversibly
  contain an arbitrary `provider/id` string.

## Types and function signatures

```ts
export type ClaudeAliasTier = "opus" | "sonnet" | "haiku";

export interface ClaudeAliasRecord {
  route: string;       // canonical provider/model key, including native/...
  code: string;        // /^[a-z][0-9a-z]{2}$/
  tier: ClaudeAliasTier;
  aliases?: string[];  // retained aliases after an explicit tier migration
}

export interface ClaudeAliasRegistry {
  version: 1;
  records: Record<string, ClaudeAliasRecord>; // keyed by canonical route
}

export function deriveClaudeAliasCode(route: string): string;
export function resolveClaudeAliasTier(
  route: string,
  metadata: ModelCapabilityMetadata | undefined,
  config: OcxConfig,
): ClaudeAliasTier;
export function aliasForClaude3p(
  route: string,
  registry: ClaudeAliasRegistry,
): string | null;
export function resolveClaude3pAlias(
  alias: string,
  registry: ClaudeAliasRegistry,
): string | null;
```

`route` is always the internal canonical route key. Native OpenAI models use the
pseudo-provider form `native/{slug}` in the registry, even though decoding them
returns the bare slug expected by `routeModel`. Routed model IDs may themselves
contain `/`; split a route only at its first `/` when provider and model need to
be separated.

Do not trim, lowercase, Unicode-normalize, or otherwise rewrite a route before
hashing. Route construction must already have produced the exact canonical
provider and model IDs. Reject empty providers, empty model IDs, control
characters, and non-canonical duplicate spellings before alias generation.

## Code derivation algorithm

`deriveClaudeAliasCode(route)` is defined exactly as follows:

1. Encode the canonical `route` as UTF-8.
2. Compute SHA-256.
3. Interpret the complete 32-byte digest as one unsigned big-endian integer
   `h`.
4. Compute `n = h mod 33_696` (`26 * 36 * 36`).
5. The first character is ASCII `a + floor(n / 1_296)`.
6. Encode `n mod 1_296` as two lowercase base36 characters, left-padded with
   `0`.

The letter-first restriction makes codes such as `bji`, `k4u`, and `soa` look
more like model revisions than bare numeric suffixes. SHA-256 is available from
`node:crypto`, requires no dependency, and the full algorithm must have golden
tests so runtime or language changes cannot alter it.

`aliasForClaude3p` behavior:

1. If the route is `anthropic/{model}` and `{model}` starts with `claude-`,
   return `{model}` unchanged. Real Anthropic Claude IDs already satisfy both
   clients and must not be hidden behind an alias.
2. Otherwise find the pinned record for the route and return
   `claude-${record.tier}-4-${record.code}`.
3. Return `null` if the route is invalid, unregistered, or has an unresolved
   collision. Discovery omits such an entry and emits one actionable warning.

A Claude model reached through a non-Anthropic route, such as
`kiro/claude-opus-4.6`, is encoded. Passing it through would lose the provider
identity on inbound routing.

## Example encodings

These examples use the exact hash algorithm above. Tier values illustrate the
policy in the next section.

| Canonical route | Desktop / Code model ID | Inbound result |
| --- | --- | --- |
| `native/gpt-5.6-sol` | `claude-opus-4-bji` | `gpt-5.6-sol` |
| `native/gpt-5.6-terra` | `claude-sonnet-4-k4u` | `gpt-5.6-terra` |
| `native/gpt-5.6-luna` | `claude-haiku-4-f7l` | `gpt-5.6-luna` |
| `opencode-go/glm-5.2` | `claude-sonnet-4-kgz` | `opencode-go/glm-5.2` |
| `zai/glm-5.2` | `claude-sonnet-4-soa` | `zai/glm-5.2` |
| `openrouter/openai/gpt-5.6-sol` | `claude-opus-4-zuw` | `openrouter/openai/gpt-5.6-sol` |
| `kiro/claude-opus-4.6` | `claude-opus-4-zzn` | `kiro/claude-opus-4.6` |
| `anthropic/claude-opus-4-6` | `claude-opus-4-6` (pass-through) | `anthropic/claude-opus-4-6` via the normal Anthropic route |

The fixed `4` is a compatibility marker, not an encoded model generation. It
should remain fixed for registry version 1; changing it would invalidate saved
client selections.

## Tier assignment

Tier is capability metadata, not part of the hash. Resolve it once when a
record is first created, then pin it in the registry so metadata updates do not
silently rename an alias saved by a client.

Precedence, highest first:

1. **Per-model config override:** `claudeCode.aliasTiers[route]`. This is the
   authoritative escape hatch for operators and custom providers.
2. **Declared provider/model capability:** a curated `claudeAliasTier` on model
   metadata. Built-in routes should use this rather than heuristics. Providers
   with a documented capability class may supply a provider default, overridden
   by model metadata.
3. **Name heuristic fallback:** exact hyphen/dot/underscore-delimited tokens
   `opus`, `pro`, `max`, `ultra`, `frontier`, or `sol` imply `opus`; tokens
   `haiku`, `mini`, `nano`, `lite`, `flash`, or `luna` imply `haiku`; all other
   models use `sonnet`. If both groups match, choose `sonnet` and warn because
   the name is ambiguous.

Reasoning-effort ladders, context-window size, and vision support must not alone
determine tier; they are not reliable proxies for overall capability. The
heuristic is only a discovery fallback. The generated display name always shows
the real model and provider, so the tier is not presented as vendor identity.

An intentional tier change is a migration: add the newly tiered alias to the
record and retain the prior full alias in `record.aliases` for inbound decoding.
Only the new alias is advertised. Do not recycle old aliases.

## Registry and collision handling

Keep built-in records in a checked-in versioned manifest so every installation
uses the same assignments. Merge custom/live-model records into a runtime file
under the opencodex config directory, written atomically. The runtime registry
is portable configuration and should survive upgrades; removals become
tombstones rather than freeing an alias for reuse.

At registry build time, construct both `route -> record` and `full alias ->
route` indexes and reject duplicates. Codes should be globally unique across
all tiers, even though differing tiers would technically make full aliases
different. Global uniqueness prevents a later tier migration from exposing a
latent collision.

If two routes derive the same primary code:

1. Never renumber or re-tier an existing record.
2. Built-in collisions receive an explicit checked-in code override reviewed
   with the manifest change.
3. A new custom/live route is not advertised until it has a unique explicit
   `claudeCode.aliasCodes[route]` override matching
   `/^[a-z][0-9a-z]{2}$/`; persist that override in the runtime registry.
4. Reject an override already owned by any active record or tombstone.

This explicit handling is deliberate. Automatically selecting “the next free
hash” would make a model's result depend on discovery order or on which other
models happen to be installed, violating determinism. With only 33,696 possible
codes, universal collision-free encoding is mathematically impossible; the
registry is the contract that resolves the rare exception without moving old
aliases.

## Inbound decoding

Build the reverse index at startup from active records, tombstones, and each
record's legacy `aliases`. For a Messages API request model:

1. Try exact lookup of the complete incoming ID in the reverse index. Do not
   parse tier or code independently and do not accept near matches.
2. For `native/...`, return the model portion after the first `/` as a bare
   native slug. For every other record, return the canonical route unchanged.
3. If no short alias matches, run the existing `resolveAlias` decoder for the
   legacy `claude-ocx-...` format.
4. Then retain the current `claudeCode.modelMap` exact and date-suffix-stripped
   fallbacks.
5. Otherwise pass the model through unchanged, preserving real Claude IDs.

Exact full-ID lookup prevents a request such as `claude-haiku-4-bji` from being
accepted when the registered alias is `claude-opus-4-bji`. It also makes tier
migrations and tombstones explicit instead of relying on lossy suffix parsing.

## Edge cases and operational rules

- **Removed/disabled model:** stop advertising it. Keep its reverse record so a
  saved selection decodes deterministically; normal routing then returns the
  existing unavailable/disabled-model error. Never assign its alias to another
  route.
- **Provider changes:** provider is part of the hash and route identity, so the
  same model ID through two providers intentionally receives different codes.
- **Nested model IDs:** `openrouter/openai/gpt-5.6-sol` is valid; provider is
  `openrouter`, model ID is `openai/gpt-5.6-sol`, split on the first slash only.
- **Case:** route IDs are case-sensitive. `MiniMax-M3` and `minimax-m3` are
  distinct unless the owning provider canonicalizes them before this layer.
- **Malformed input:** reject whitespace-only components, control characters,
  invalid code overrides, duplicate full aliases, and registry versions newer
  than the implementation understands.
- **Concurrent writes:** update the runtime registry with lock + temporary file
  + atomic rename. Re-read and revalidate under the lock before committing.
- **Corrupt/missing registry:** built-ins can be rebuilt from the checked-in
  manifest. Do not regenerate custom collision overrides silently; warn and
  omit affected aliases until the portable registry/config is restored.
- **Client compatibility:** return the same short IDs from both the Desktop 3P
  and Claude Code Anthropic-flavored `/v1/models` response. Keep truthful
  `display_name` values and do not use short aliases on OpenAI/Codex catalogs.

## Required verification

- Golden vectors for every example above, including UTF-8 hashing semantics.
- Round trips for native, routed, nested-model-ID, and non-Anthropic Claude
  routes.
- Anthropic pass-through tests.
- Corpus test asserting unique codes and full aliases for every built-in route.
- Addition/removal test proving existing records and aliases are byte-identical.
- Collision fixture proving the newcomer is omitted until an explicit unique
  override is supplied and that the incumbent never changes.
- Tier migration test proving only the new alias is advertised while both old
  and new aliases decode.
- Legacy `claude-ocx-...` and `modelMap` precedence regression tests.
