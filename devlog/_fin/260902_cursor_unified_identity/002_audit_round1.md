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

## Round 3 — broad reviewer lane (`Carver`), 10 blockers

Returned after the round-2 lane. Six findings duplicate what round 1/2 already folded
(B1 kind allowlist, B2 supportsServiceTier short-circuit, B4/B8 cost+log consumers,
B5 base-URL guard, B9 fastwire-policy assertion, verifier honesty). Independent
confirmation of the same diagnosis from a lane that read the tree separately.

Four are NEW and two of those are real design defects:

### B11 (High, NEW) — the listed `-fast` id is the WRONG dimension for thinking-default bases

`cursorFastIdFor` returns `<base>-fast`, and `parseCursorVariantId("claude-opus-5-fast")`
yields `kind: "fast"` — the REGULAR-fast sibling, not `thinkingFast`. Measured:

```
umbrella claude-opus-5      + high -> claude-opus-5-thinking-high
listed   claude-opus-5-fast + max  -> claude-opus-5-high-fast      (regular-fast, clamped)
thinkingFast               + max  -> claude-opus-5-thinking-max-fast
```

So WP3's Codex toggle (`thinking -> thinkingFast`) and WP4's listed id would send DIFFERENT
wires for the same base and the same user intent. Worse, `claude-opus-5`'s regular variant is
quarantined, so the listed id routes into the dead family.

**Fold:** `cursorFastIdFor` composes from the base's `defaultVariant` — `thinking` yields
`<base>-thinking-fast`, `regular` yields `<base>-fast` — so the listed id parses back to the
same variant `upgradeToFast` picks. WP4 adds an equivalence test asserting the listed id and
the toggled umbrella id resolve to the same wire for every fast-capable base.

### B12 (High, NEW) — `options.fastMode` in 030 had no possible caller

`CreateCursorRequestOptions` carries only `forceFreshConversation`
(`request-builder.ts:369`) and `AdapterFactoryContext` has no `fastMode`
(`adapters/registry.ts:18`). The fallback I had already dropped for being unreachable was
also unimplementable. Confirms the round-1 B6 disposition. The reviewer additionally proved
chat-completions is not native-chat for Cursor (`isNativeChatRouteEligible` requires
`adapter === "openai-chat"`, `chat-native.ts:62`) and replays through `handleResponses`
(`chat-completions.ts:130,254`), so BOTH non-Codex inbound paths populate `tierDecision`.

### B13 (Medium, NEW) — Grok's two call sites must change atomically

`request-builder.ts:204` calls `cursorGrokFastSelection(id, reasoning)` with no third
argument. If only `resolveCursorSelection` learns the fast flag, a toggled Grok pick would
emit a flattened `grok-4.6-high-fast` instead of the required
`{id:"fast",value:"true"}` parameters — violating WP3's own accept row. Both helpers and
that call site are one atomic edit, and the Grok accept-row test belongs to WP3.

### B14 (Low, NEW) — no `040+` doc for residuals

030 names a residual (effort ladders advertised on a listed fast id) with no home. Park it
in `040_residuals.md` when WP4 lands rather than leaving it only in prose.

Reviewer's normalized line: `VERDICT: GO-WITH-FIXES (blockers=10)`.

## B11 confirmed by measurement (`.tmp/probe3.ts`, at 7adb1e66a)

The reviewer's claim was not theoretical. Bare `-fast` on a thinking-default base picks the
REGULAR-fast sibling and diverges from what the Codex toggle would send:

```
base              default   listed id                       kind          resolved wire (max)
claude-opus-4-7   thinking  claude-opus-4-7-fast            fast          claude-opus-4-7-max-fast
                            claude-opus-4-7-thinking-fast   thinkingFast  claude-opus-4-7-thinking-max-fast
                  umbrella  claude-opus-4-7                 thinking      claude-opus-4-7-thinking-max
claude-opus-5     thinking  claude-opus-5-fast              fast          claude-opus-5-high-fast   <- clamped AND quarantined family
                            claude-opus-5-thinking-fast     thinkingFast  claude-opus-5-thinking-max-fast
grok-4.5          regular   grok-4.5-fast                   fast          grok-4.5-high-fast
                            grok-4.5-thinking-fast          thinkingFast  grok-4.5                  <- degrades to a bare id
grok-4.6          regular   grok-4.6-fast                   fast          grok-4.6-xhigh-fast
                            grok-4.6-thinking-fast          thinkingFast  grok-4.6                  <- degrades to a bare id
```

Two consequences the fix must respect, both visible above:

1. For a thinking-default base, only `<base>-thinking-fast` round-trips to the variant the
   toggle picks. `claude-opus-5-fast` additionally clamps max->high and lands in the
   quarantined regular family.
2. For a regular-default base, `<base>-thinking-fast` is WRONG the other way: grok has no
   thinkingFast spec, so `resolveCursorSelection` falls back to `variants.regular` and emits
   a bare `grok-4.6` with no effort and no fast marker at all.

So the id must be composed per base from `defaultVariant`, exactly as `cursorFastIdFor` in
030 §1 now does — a single shared suffix would be wrong for one half of the table either way.
