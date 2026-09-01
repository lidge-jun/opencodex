# Audit round 1 — main-agent verification of the roadmap

Blockers found by running the plan's own claims against the tree at `d975feaa4`.
All folded into 010/020/030 in the same pass. An independent `xai/grok-4.6` reviewer lane
is running concurrently; its findings append as round 2.

## B1 (Critical) — `fastWireDeclarationError` hard-rejects the new kind

`src/providers/fastwire.ts:470`

```ts
if (value.kind !== "service-tier" && value.kind !== "anthropic-speed") {
  return "fastWire.kind must be service-tier or anthropic-speed";
}
```

020 §5 called `fastWireSchema` "an enum that must list the value" and treated the
validator as an unknown. It is neither an enum nor unknown: `src/config.ts:495` types
`kind` as a bare `z.string()` and delegates to this function, which rejects any third
kind. A cursor registry entry declaring `kind: "cursor-variant"` fails
`registryFastWireDeclarationError` at load, so the provider entry is invalid before any
request runs. **Fold:** the string literal list here is a required edit, called out
explicitly in the 020 change map.

## B2 (Critical) — `hasFastWireCapabilityConflict` is not the constraint 020 assumed

`src/providers/fastwire.ts:445-455`

```ts
if (source.fastWire !== null) return false;
```

The conflict only fires for `fastWire: null`. 020 §2 planned
`supportsServiceTier: false` + `modelSupportsServiceTier: {5 bases: true}` and worried
this would be rejected. It is not — but the real problem is the opposite one, and worse:

`src/providers/fastwire.ts:~350` (resolveFastPolicy)

```ts
const capability = authority.capability.provider === false
  ? false
  : exactCapability ?? authority.capability.provider;
```

`capability.provider === false` short-circuits **before** `exactCapability` is consulted.
So `supportsServiceTier: false` would force every Cursor model to
`capability-unsupported`, including the five with a fast variant, and the per-model
`true` entries would be dead config. **Fold:** omit `supportsServiceTier` entirely on the
cursor entry (leave it `undefined`) and let `modelSupportsServiceTier` decide per model.
A base with no entry then resolves `capability === undefined` → `eligibility:
"unclassified"` → `serviceTierSupportFromPolicy` returns `false` when
`forwardCallerTier` is false (`service-tier.ts:268-274`), which is exactly the desired
"no toggle" outcome.

## B3 (High) — the catalog stamp is ordered against us

`src/codex/catalog/sync.ts:335-349`

```
applyReasoningLevels(e, ...)
normalizeRoutedCatalogEntry(e, ...)   // deletes service_tiers / additional_speed_tiers
applyCatalogMetadata(e, ...)
applyCatalogModelMetadata(e, model)   // re-stamps when model.supportsServiceTier === true
```

020 asserted the ordering was fine but recorded no proof. It is fine — the strip runs
**before** the stamp — so a routed Cursor row can carry tiers. **Fold:** record the proven
order in 020 so a later reader does not re-derive it, and make the wp3 C-phase assert on a
built entry rather than on `applyCatalogModelMetadata` in isolation.

## B4 (High) — `usage/cost.ts` is a consumer 020 missed

`src/usage/cost.ts:418-425`

```ts
if (outcome.fastOutcome === "unknown"
    && outcome.wireKind === "service-tier"
    && typeof outcome.wireValue === "string") {
  return { requestedServiceTier: outcome.wireValue };
}
```

020 §5's consumer list named `FAST_WIRE_ADAPTERS`, `AttemptTierOutcome.wireKind`,
`canonicalFromWire`, `behavior.ts`, and `fastWireDeclarationError` — not this. It is a
string comparison, not an exhaustive switch, so `tsc` will **not** flag it: a
`"cursor-variant"` outcome silently takes the fall-through and reports no requested tier
for pricing. The branch above it (`canonical === "priority" && confirmation === "assumed"`,
line 414) does cover the Cursor case correctly, since 020 §4 sets
`confirmation: "assumed"`. **Fold:** 020 records this as verified-correct-by-accident and
adds a cost-attribution assertion so a future refactor cannot break it silently.

## B5 (Medium) — `registryModelServiceTierCapabilityApplies` is a base-URL guard, not auth

`src/providers/registry.ts:2935-2941` — it reads
`modelServiceTierCapabilityBaseUrlGuard`, which only the OpenRouter entry sets
(`registry.ts:1610`). 020 §2's "verify it does not gate OAuth providers" concern is
resolved: Cursor sets no guard, so the predicate returns `true`. **Fold:** replace the
open question with the answer.

## B6 (Medium) — anthropic-inbound already gets a tier decision

`src/server/claude-messages.ts:37,772` replays through `handleResponses`, which is the
same path that runs `decideTier` at `responses/core.ts:2095`. 030 §5 left this as "confirm
during B" and planned a `tierDecision === undefined` fallback. The fallback is therefore
**unreachable on that path** — a branch nobody can show firing
(C-ACTIVATION-GROUNDING-01). **Fold:** 030 drops the speculative fallback and instead
requires an activation test proving the anthropic-inbound route reaches the Cursor
resolver with `tierDecision.kind === "set"`.

## Non-blockers confirmed

- No import cycle: `catalog.ts` and `effort-map.ts` have **zero** imports of
  `discovery.ts` (`rg '^import'` returns nothing for catalog.ts's header block; discovery
  imports from effort-map and catalog, one direction only).
- Row arithmetic: measured `SEED_COUNT 54`, and `CURSOR_ROUTER_MODEL_IDS` is derived
  (`discovery.ts:113`) as auto + 3 levels = 4. 4 + 34 + 13 + 3 = 54 holds.
- `claude-4.5-haiku` was in 010's product list and is genuinely absent from
  `CURSOR_CAPABILITIES`; no seed id is dropped by the new composition.

## Round 2 — independent reviewer (xai/grok-4.6, lane `Aquinas`)

Narrow packet: five targeted questions about the WP3 design. Two findings were blockers my
round-1 pass missed; one corrected a design I had already written into 020.

### B7-REVISED (Critical) — `tierLogForRunTurn` runs BEFORE `runTurn`

`src/server/responses/core.ts:3477-3479`

```ts
let runTurnAdapter = adapter;
if (adapter.runTurn) {
  recordAdapterTierMetadata(logCtx, adapter.tierLogForRunTurn?.(parsed));
}
```

I had written a write-back design (`runTurn` stamps a flag, `tierLogForRunTurn` reads it).
That is read-before-write and would always report `null`. A rebuild there is equally wrong:
it runs before `_cursorIdentityScope` (`cursor.ts:134-146`) and `_cursorConversationId`
(`cursor.ts:160`) exist, so it mints a second `crypto.randomUUID()` conversation and hashes
a `local` scope. **Fold:** 020 §4 recomputes the pure VARIANT through a shared
`cursorRequestEmitsFastVariant(parsed)` helper; the write-back block was deleted.

### B8 (Critical) — `src/usage/log.ts` discards the whole outcome

`normalizeAttemptTierOutcome` allowlists `wireKind` at `:322-325` and again at `:340`,
returning `null` for any third kind, so a persisted attempt loses its tier row and the GUI
Logs view shows nothing after restart. Invisible to `tsc` (string comparison).
**Fold:** both sites added to the 020 change map.

### B9 (High) — an existing test asserts the opposite invariant

`tests/fastwire-policy.test.ts:647` asserts
`PROVIDER_REGISTRY.every(entry => entry.fastWire === undefined)`. WP3 ends that by design.
**Fold:** rewrite it to the new invariant rather than delete the coverage.

### B10 (Medium) — my `resolveCursorSelection` hunk was incomplete

`parsed.kind` is read at `catalog.ts:487`, `:493`, and `:494-495`; my diff rebound only the
spec, which would emit a thinking id with no `-fast` and keep `cursor-` on an upgraded Grok
pick. **Fold:** 020 §3 shows the full three-site hunk.

### Confirmed non-issues

- The `parsed` object core mutates at `:2095` is the same one Cursor reads at
  `cursor.ts:119,148` — no clone (dispatch traced at `core.ts:5330`).
- No `tests/cursor-*.test.ts` asserts absence of `service_tiers`, so stamping tiers on
  Cursor rows breaks nothing there.
- `core.ts:2636`'s `kind === "service-tier"` test governs only foreign OpenAI caller tiers;
  Cursor Fast takes the canonical early-return at `:2635`.

Reviewer's normalized line: `VERDICT: GO-WITH-FIXES (blockers=2)`. Both folded above.

The broad round-1 lane (`Carver`) is still running; anything it returns that is not already
folded appends as round 3.
