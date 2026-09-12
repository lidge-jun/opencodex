# 260912 — Routed reasoning ladders come from models.dev

## Decision

For a routed provider whose destination models.dev publishes, the Codex catalog and the outbound
wire value prefer the published reasoning ladder over a hand-written one, and a rung the upstream
actually refused is dropped from every later ladder (registry config included).

Layers:

1. src/providers/reasoning-metadata.ts snapshots models.dev (reasoning + reasoning_options, the
   effort / toggle / budget_tokens option types) into ~/.opencodex/reasoning-metadata-cache.json
   (24h TTL, stale-but-readable offline, atomic write). The v2 snapshot stores ladders for the
   gated destinations (OpenCode Zen + Zen Go, 133 models / ~20 KB) and the published `api` URL of
   every provider models.dev lists, so the gate can be checked against real data.
2. configuredReasoningEfforts() consults that snapshot only when nothing was configured for the
   model, so every hand-written contract stays authoritative; mapReasoningEffort() clamps through
   the same function, which is what keeps the catalog and the wire in agreement.
3. reasoning-support-cache.json records (provider, model, effort) refusals; the filter at the
   configuredReasoningEfforts() exit removes those rungs whether the ladder came from the snapshot
   or from the registry.

## Why the hand-written table was not enough

OpenCode Zen Go answers GET https://opencode.ai/zen/go/v1/models with ids only (id, object, created,
owned_by — 37 models, verified 2026-09-12), so opencodex had to guess:

- muse-spark-1.3-contributor was advertised up to ultra while the gateway refuses max with
  400 {"param":"reasoning.effort","type":"invalid_request_error","message":"Error from provider
  (Console Go): Upstream request failed: [invalid_request_error] reasoning_effort max requires an
  active Muse Code subscription for model muse-spark-1.3-contributor."} ; xhigh answers 200.
  models.dev publishes [minimal, low, medium, high, xhigh] for that model — the refusals were the
  synthetic tiers, not the model.
- deepseek-v4.1-flash needs [low, high, max] before it advertises any control at all; models.dev
  publishes exactly that.

Verified after the change: the catalog lists [low, medium, high, xhigh] for muse-spark and
[low, high, max] for deepseek-v4.1-flash, max on muse-spark is sent as xhigh, and a refusal replays
once at the next lower published rung (usage.jsonl recovery kind reasoning-effort-downgrade)
instead of failing the turn.

## Source resolution (2026-09-12 review follow-up)

models.dev publishes each provider's own `api` URL (`opencode-go` -> `https://opencode.ai/zen/go/v1`,
`opencode` -> `https://opencode.ai/zen/v1`), so the destination is resolvable from data rather than from a
guess. Resolution stays gated: BASE_URL_TO_METADATA_PROVIDER is the authoritative list (both URLs are
compared normalised, so a trailing slash or a `/v1` suffix never decides), and reasoningMetadataMapping()
reports for each gated destination whether the snapshot confirms it against the published URL.

Measured the same day: **36 of the registry's 83 destinations** match a models.dev provider, and 13 of a live
27-provider config do; 11 of those 13 already carry hand-written ladders (the metadata fallback is never
consulted) and the other 2 (`openrouter`, 4 models) would change catalog ladders. Resolving by URL alone
would therefore move ladders for providers this change has no evidence for, so widening the gate is a
separate decision with those numbers in hand -- the snapshot already carries the data it needs.

## Learned refusals are credential-scoped in practice

A refusal is recorded per `(provider, model, effort)`. Every destination that can reach this path is
`authKind: key`, i.e. one credential per provider entry, so that key already has the credential dimension;
the catalog is account-independent by construction (built once per process, not per request). Three
properties bound the rest: only the refused rung is dropped, the fact expires after 30 days, and the clamp
is visible as requestedEffort versus effectiveEffort in usage.jsonl. A credential-scoped key becomes
necessary only if opencodex ever pools several credentials behind one metadata-mapped provider entry.

## Known follow-ups

- Destination to models.dev provider id stays a gated table (two OpenCode destinations today).
  Widening it to every URL match is measured above and is a maintainer call, not a mechanical edit. A
  shared registry-side helper would replace the table itself, but importing providers/registry from this
  module widened an unrelated supported_reasoning_levels literal type during development, so the naive
  import was reverted.
- The snapshot refresh is triggered on first read with TTL and in-flight guards rather than from the
  startup path, so a long-lived proxy refreshes at most daily.
