# WP3 / PR2 — the Codex Fast toggle reaches Cursor's fast dimension

Stacked on PR1. Scope IN: `src/types/provider.ts`, `src/providers/{fastwire,registry}.ts`,
`src/adapters/cursor/{catalog,request-builder}.ts`, `src/adapters/cursor.ts`, tests.
Scope OUT: listing rewrites (WP4), other providers' wires, Cursor transport.

Accept criteria, each with its activation scenario:

| Path | Trigger | Observable effect |
|---|---|---|
| tier stamped | build a catalog for `cursor/claude-opus-5` | `service_tiers[0].id === "priority"` |
| no dead toggle | same for `cursor/kimi-k3` | no `service_tiers`, no `additional_speed_tiers` |
| thinking upgrade | request `cursor/claude-opus-5` + `service_tier:"priority"` | wire id ends `-fast` |
| grok params | request `cursor/grok-4.6` + Fast | `{id:"fast",value:"true"}` present, id stays `grok-4.6` |
| telemetry | same request | `tierLog.outcome.fastOutcome === "applied"` |

## Change map

| File | Action |
|---|---|
| `src/types/provider.ts` | MODIFY — `FastWire.kind` gains `"cursor-variant"` |
| `src/providers/fastwire.ts` | MODIFY — `FAST_WIRE_ADAPTERS` entry; **`fastWireDeclarationError:470` literal list** (audit B1) |
| `src/providers/registry.ts` | MODIFY — cursor `fastWire` + `modelSupportsServiceTier` (NO provider-level `supportsServiceTier`, audit B2) |
| `src/usage/log.ts` | MODIFY — **`normalizeAttemptTierOutcome` wireKind allowlist, both sites** (audit B8; otherwise the whole outcome row is discarded) |
| `src/adapters/cursor/catalog.ts` | MODIFY — `cursorFastCapableBases()`; `resolveCursorSelection` fast option |
| `src/adapters/cursor/request-builder.ts` | MODIFY — `normalizeCursorModelId` reads the tier decision; export `cursorRequestEmitsFastVariant` |
| `src/adapters/cursor.ts` | MODIFY — `tierLogForRunTurn` reports the resolved variant (must NOT rebuild, audit B7) |
| `src/usage/cost.ts` | NO CHANGE — but assert its behavior (audit B4) |
| `tests/fastwire-policy.test.ts` | MODIFY — the "A1 adds no explicit registry FastWire declaration" assertion (audit B9) |
| `tests/cursor-fast-tier.test.ts` | NEW — the five rows above |

## 1. A Cursor-owned wire kind

Reusing `"service-tier"` would claim Cursor emits a `service_tier` field. It does not; it
picks a different model variant. The kind is the honest name for that.

```diff
 export interface FastWire {
-  kind: "service-tier" | "anthropic-speed";
+  kind: "service-tier" | "anthropic-speed" | "cursor-variant";
```

```diff
 const FAST_WIRE_ADAPTERS: Readonly<Record<FastWire["kind"], ReadonlySet<string>>> = {
   "service-tier": SERVICE_TIER_ADAPTERS,
   // A1 deliberately has no adapter implementation for Anthropic speed.
   "anthropic-speed": new Set(),
+  // Cursor expresses Fast as a model-variant dimension, not a request field: the
+  // resolver swaps regular->fast / thinking->thinkingFast and the wire carries either a
+  // flattened -fast id or Grok's {id:"fast"} parameter.
+  "cursor-variant": new Set(["cursor"]),
 };
```

```diff
+/** Canonical Fast maps to the variant marker the Cursor resolver understands. */
+const DEFAULT_CURSOR_VARIANT_FAST_WIRE: FastWire = Object.freeze({
+  kind: "cursor-variant" as const,
+  canonicalToWire: Object.freeze({ priority: "fast" }),
+  foreignCallerTiers: "drop" as const,
+});
```

`foreignCallerTiers: "drop"` because Cursor has no concept of an arbitrary tier string;
only canonical Fast means anything.

`defaultFastWireForAdapter` stays OpenAI-only — Cursor's declaration comes from the
registry, so a provider whose adapter is cursor but whose entry is absent keeps today's
behavior:

```diff
 export function defaultFastWireForAdapter(adapter: string): FastWire | null {
   return SERVICE_TIER_ADAPTERS.has(adapter) ? DEFAULT_SERVICE_TIER_FAST_WIRE : null;
 }
```

No change there. `decideTier` needs none either: it is already generic over
`canonicalToWire`, so Fast on an eligible Cursor route returns `{kind:"set", value:"fast"}`.

**`applyServiceTierGate` must not write `service_tier` onto a Cursor body.** The gate runs
on `rawBody` for OpenAI-shaped requests; Cursor's adapter builds its own Connect request
and never reads `rawBody`, so a `{kind:"set"}` decision is invisible to it unless the
adapter reads `options.tierDecision` — which is exactly what §3 adds. Confirm during B
that the gate does not inject the field into a Cursor `rawBody` that later gets logged;
if it does, guard the injection on `fastWire.kind === "service-tier"`.

**Catalog stamp ordering is proven, not assumed (audit B3).** `sync.ts:335-349` runs
`applyReasoningLevels` -> `normalizeRoutedCatalogEntry` (strips tiers) ->
`applyCatalogMetadata` -> `applyCatalogModelMetadata` (re-stamps when
`model.supportsServiceTier === true`). The strip precedes the stamp, so a routed Cursor
row keeps its tier. wp3's check asserts on a BUILT catalog entry, not on
`applyCatalogModelMetadata` in isolation, so this ordering stays covered.

## 2. Only fast-capable bases advertise the toggle

```diff
+/** Bases whose capability declares a fast or thinking-fast variant. */
+export function cursorFastCapableBases(): string[] {
+  return Object.entries(CURSOR_CAPABILITIES)
+    .filter(([, c]) => c.variants.fast !== undefined || c.variants.thinkingFast !== undefined)
+    .map(([id]) => id);
+}
```

Today that is exactly `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`, `grok-4.5`,
`grok-4.6` (measured, 000_plan.md). Deriving it means a future capability edit keeps the
toggle honest without a second list to update.

```diff
     modelDisplayNames: cursorModelDisplayNames(),
+    // Fast is a variant dimension, so only bases that actually have one may advertise it —
+    // a tier on a base without a fast wire is the dead-toggle defect (NO_FAST_TIER_NATIVE_SLUGS).
+    fastWire: { kind: "cursor-variant", canonicalToWire: { priority: "fast" }, foreignCallerTiers: "drop" },
+    // NO provider-level supportsServiceTier: see audit B2 (002_audit_round1.md).
+    modelSupportsServiceTier: Object.fromEntries(cursorFastCapableBases().map(id => [id, true])),
+    fastTierDescription: "Cursor Fast variant",
```

**`supportsServiceTier` must stay ABSENT (audit B2, was a blocker).** `resolveFastPolicy`
computes `capability.provider === false ? false : exactCapability ?? capability.provider`,
so a provider-level `false` short-circuits BEFORE the per-model map and would kill the five
fast-capable bases too, leaving `modelSupportsServiceTier` as dead config. Leaving it
undefined yields: 5 bases `true` -> `eligible` -> tier stamped; 29 bases `undefined` ->
`unclassified` -> `serviceTierSupportFromPolicy` returns `false` because
`forwardCallerTier` is false on a non-service-tier adapter (`service-tier.ts:268-274`)
-> no toggle. Same outcome, without the short-circuit trap.

`registryModelServiceTierCapabilityApplies` is RESOLVED, not an open question (audit B5):
it reads `modelServiceTierCapabilityBaseUrlGuard` (`registry.ts:2935-2941`), which only the
OpenRouter entry sets (`registry.ts:1610`). Cursor sets none, so it returns `true`;
`authKind` is never consulted.

**The runtime validator must be widened in the same commit (audit B1, was a blocker).**
Without it the cursor entry is rejected at load:

```diff
-  if (value.kind !== "service-tier" && value.kind !== "anthropic-speed") {
-    return "fastWire.kind must be service-tier or anthropic-speed";
+  if (value.kind !== "service-tier" && value.kind !== "anthropic-speed" && value.kind !== "cursor-variant") {
+    return "fastWire.kind must be service-tier, anthropic-speed, or cursor-variant";
   }
```

`src/config.ts:495` types `kind` as a bare `z.string()` and delegates to
`fastWireDeclarationError` (`fastwire.ts:470`), so this single edit covers both the
registry and the on-disk config boundary.

## 3. The request path consumes the decision

```diff
-function normalizeCursorModelId(modelId: string, reasoning?: string): {
+function normalizeCursorModelId(modelId: string, reasoning?: string, fast?: boolean): {
```

```diff
-  const grokFast = cursorGrokFastSelection(id, reasoning);
+  // Codex Fast is a variant switch here: an explicit -fast slug already parses as fast,
+  // and the toggle promotes an umbrella pick to its fast sibling when one exists.
+  const grokFast = cursorGrokFastSelection(id, reasoning, fast);
```

```diff
-  const resolved = resolveCursorSelection(id, reasoning);
+  const resolved = resolveCursorSelection(id, reasoning, undefined, { fast });
```

In `catalog.ts`, the upgrade is a kind mapping applied after parsing, before spec lookup:

```diff
+function upgradeToFast(baseId: string, kind: CursorVariantKind): CursorVariantKind {
+  const variants = CURSOR_CAPABILITIES[baseId]?.variants;
+  if (!variants) return kind;
+  if (kind === "thinking" || kind === "thinkingFast") {
+    return variants.thinkingFast ? "thinkingFast" : kind;
+  }
+  return variants.fast ? "fast" : kind;
+}
```

```diff
 export function resolveCursorSelection(
   pickedId: string,
   reasoning: string | undefined,
   liveMaxModeIds?: ReadonlySet<string>,
+  options: { fast?: boolean } = {},
 ): CursorResolvedSelection {
   const parsed = parseCursorVariantId(pickedId);
   if (!parsed.known) { ... }
   const capability = CURSOR_CAPABILITIES[parsed.baseId]!;
-  const spec = capability.variants[parsed.kind] ?? capability.variants.regular;
+  const kind = options.fast === true ? upgradeToFast(parsed.baseId, parsed.kind) : parsed.kind;
+  const spec = capability.variants[kind] ?? capability.variants.regular;
```

Every later use of `parsed.kind` in that function (`composeWireId`, the `wirePrefix` guard)
switches to `kind`. The prefix guard matters: `kind === "regular"` is what adds
`cursor-`, and a Grok pick upgraded to `fast` must not keep it — but Grok never reaches
`composeWireId` when fast, because `cursorGrokFastSelection` intercepts first.

**All three later reads must move to `kind`, not just the spec lookup (audit B10).** The
reviewer quoted the live body: `parsed.kind` is read at `catalog.ts:487` (spec), `:493`
(`composeWireId`), and `:494-495` (the `wirePrefix === "cursor-"` guard). Rebinding only
`spec` would make Opus Fast emit the thinking id with no `-fast`, and would keep the
`cursor-` prefix on any Grok pick that bypassed `cursorGrokFastSelection`. The complete
hunk:

```diff
   const capability = CURSOR_CAPABILITIES[parsed.baseId]!;
-  const spec = capability.variants[parsed.kind] ?? capability.variants.regular;
+  const kind = options.fast === true ? upgradeToFast(parsed.baseId, parsed.kind) : parsed.kind;
+  const spec = capability.variants[kind] ?? capability.variants.regular;
   if (!spec) { ... }
   const requested = parsed.level ?? reasoning;
   const effort = cursorVariantEffort(spec, requested);
-  const canonicalId = composeWireId(parsed.baseId, parsed.kind, effort);
-  const wireId = capability.wirePrefix && parsed.kind === "regular"
+  const canonicalId = composeWireId(parsed.baseId, kind, effort);
+  const wireId = capability.wirePrefix && kind === "regular"
     ? `${capability.wirePrefix}${canonicalId}`
     : canonicalId;
```

`cursorGrokFastSelection` gains the same promotion so an umbrella Grok pick takes the
parameterized path:

```diff
 export function cursorGrokFastSelection(
   pickedId: string,
   reasoning: string | undefined,
+  fast?: boolean,
 ): { wireBaseId: string; effort: string } | undefined {
   const parsed = parseCursorVariantId(pickedId);
-  if (!parsed.known || parsed.kind !== "fast") return undefined;
+  const kind = fast === true ? upgradeToFast(parsed.baseId, parsed.kind) : parsed.kind;
+  if (!parsed.known || kind !== "fast") return undefined;
```

`createCursorRequest` derives the flag from the tier decision:

```diff
-  const model = normalizeCursorModelId(parsed.modelId, parsed.options.reasoning);
+  // decideTier already applied fastMode / caller-tier precedence; a {kind:"set"} decision
+  // on this route means canonical Fast survived the policy gate.
+  const fastRequested = parsed.options.tierDecision?.kind === "set";
+  const model = normalizeCursorModelId(parsed.modelId, parsed.options.reasoning, fastRequested);
```

Reading `tierDecision` rather than `serviceTier` keeps one decision authority: config
`fastMode: false` produces `{kind:"drop"}` and correctly suppresses the upgrade even when
the caller asked.

## 4. Telemetry stops lying

```diff
-  if (adapter.runTurn && !adapter.tierLogForRunTurn) { ...(..., null, null) }
```

The generic fallback in `adapters/registry.ts` stays for other adapters. Cursor sets its
own in `src/adapters/cursor.ts`:

```diff
+    // Cursor emits Fast as a variant, so the wire fact is the resolved variant, not a field.
+    adapter.tierLogForRunTurn = parsed => {
+      const request = createCursorRequest(parsed);
+      const emittedFast = request.modelId.endsWith("-fast")
+        || (request.requestedModelParameters ?? []).some(p => p.id === "fast" && p.value === "true");
+      return createAdapterTierMetadata(
+        parsed.options.tierObservation,
+        parsed.options.tierDecision,
+        emittedFast ? "cursor-variant" : null,
+        emittedFast ? "fast" : null,
+      );
+    };
```

**Rebuilding the request is NOT allowed (audit B7, blocker).** `createCursorRequest` is not
a pure function: `resolveCursorConversationId` (`request-builder.ts:320-335`) calls
`generatedCursorConversationId()` on three of its four branches, so a second call mints a
DIFFERENT conversation id, and `resolveCursorCheckpoint` (`request-builder.ts:479`)
consults checkpoint state. A telemetry-only rebuild would fabricate a conversation that was
never sent and could disturb checkpoint bookkeeping.

So the wire fact must come from the request the adapter already built. The Cursor adapter
holds it at `src/adapters/cursor.ts:148` (`let request = createCursorRequest(_parsed)`);
`tierLogForRunTurn` reads that value instead of building its own:

```diff
+    // Cursor emits Fast as a variant, so the wire fact is the variant that was actually
+    // sent. createCursorRequest is NOT pure (it mints conversation ids), so this reads the
+    // request the run already built rather than rebuilding one.
+    const emittedFast = (sent: CursorRunRequest) => sent.modelId.endsWith("-fast")
+      || (sent.requestedModelParameters ?? []).some(p => p.id === "fast" && p.value === "true");
```

`tierLogForRunTurn` runs BEFORE `runTurn`, not after (reviewer finding 3, verified):

```ts
// src/server/responses/core.ts:3477-3479
let runTurnAdapter = adapter;
if (adapter.runTurn) {
  recordAdapterTierMetadata(logCtx, adapter.tierLogForRunTurn?.(parsed));
}
```

That kills both candidate designs. A write-back flag set inside `runTurn` is read before it
is written. A rebuild inside `tierLogForRunTurn` runs before `_cursorIdentityScope`
(`cursor.ts:134-146`) and `_cursorConversationId` (`cursor.ts:160`) exist, so it mints a
second `crypto.randomUUID()` conversation and hashes a `local` scope instead of the token
scope. Neither reports the request that was actually sent.

What IS pure and available at that moment is the variant resolution itself — it reads only
`parsed.modelId`, `parsed.options.reasoning`, and `parsed.options.tierDecision`. So the
telemetry recomputes the VARIANT, not the request:

```diff
+    // Fast is a variant here, so the wire fact is which variant the resolver will pick.
+    // tierLogForRunTurn runs BEFORE runTurn (core.ts:3479), and createCursorRequest is not
+    // pure (it mints conversation ids), so this must not rebuild the request. Variant
+    // resolution is pure and reads the same three inputs the builder will read.
+    adapter.tierLogForRunTurn = parsed => {
+      const fast = cursorRequestEmitsFastVariant(parsed);
+      return createAdapterTierMetadata(
+        parsed.options.tierObservation,
+        parsed.options.tierDecision,
+        fast ? "cursor-variant" : null,
+        fast ? "fast" : null,
+      );
+    };
```

`cursorRequestEmitsFastVariant(parsed)` is a new exported helper in `request-builder.ts`
that shares `normalizeCursorModelId`'s exact inputs and returns whether the resolved wire
carries the fast dimension. Sharing the function is what keeps telemetry and the wire from
drifting; a B-phase test asserts they agree for every fast-capable base.


Cursor's response carries no tier echo, so `confirmation` stays `"assumed"` — the
`responseTierAuthoritative: false` path. Do not claim `"confirmed"`.

## 5. Field chain

`FastWire.kind` gains a value; every stage:

| Stage | Location |
|---|---|
| creation | `registry.ts` cursor entry; `config.ts` `fastWireSchema` accepts the literal |
| serialization | `cloneFastWire` — kind-agnostic spread, no change |
| deserialization | `fastWireSchema` enum must list `"cursor-variant"` or config load rejects it |
| consumers | `FAST_WIRE_ADAPTERS` (exhaustive Record — a missing key is a type error), `AttemptTierOutcome.wireKind`, `canonicalFromWire`, `behavior.ts` fingerprint, `fastWireDeclarationError` |

`FAST_WIRE_ADAPTERS` being a `Record<FastWire["kind"], ...>` means the compiler finds THAT
consumer. It does NOT find string-comparison consumers, and there is one (audit B4):

```ts
// src/usage/cost.ts:418-425
if (outcome.fastOutcome === "unknown" && outcome.wireKind === "service-tier" && ...) {
  return { requestedServiceTier: outcome.wireValue };
}
```

A `"cursor-variant"` outcome falls through that branch. That is CORRECT for us, because an
applied Cursor Fast sets `canonical: "priority"` with `confirmation: "assumed"` and is
caught one branch earlier (`cost.ts:414`). Correct by accident is not proven, so wp3
asserts cost attribution explicitly instead of leaving it to a future refactor.

`fastWireDeclarationError` has NO adapter allowlist — it validates shape only
(`fastwire.ts:458-490`) — and `hasFastWireCapabilityConflict` fires only when
`fastWire === null` (`fastwire.ts:450`), which does not apply here.

**`src/usage/log.ts` discards the whole outcome (audit B8, blocker — reviewer round 2).**
`normalizeAttemptTierOutcome` allowlists `wireKind` at two sites:

```ts
// src/usage/log.ts:322-325 — validation
if ("wireKind" in outcome && outcome.wireKind !== null
    && outcome.wireKind !== "service-tier"
    && outcome.wireKind !== "anthropic-speed") return null;   // drops the ENTIRE row
// src/usage/log.ts:340 — projection repeats the same three-way test
```

A `"cursor-variant"` outcome returns `null`, so the persisted attempt loses its tier row and
the GUI Logs view shows nothing after a restart. Worse than the `cost.ts` fall-through:
silent total loss, invisible to `tsc` because both are string comparisons. Both sites must
accept the new kind in the same commit.

**`tests/fastwire-policy.test.ts:647` goes red by design (audit B9).**

```ts
test("A1 adds no explicit registry FastWire declaration", () => {
  expect(PROVIDER_REGISTRY.every(entry => entry.fastWire === undefined)).toBeTrue();
});
```

It encodes "A1 shipped no registry fastWire", which this work-phase deliberately ends.
Rewrite it to assert the new invariant — cursor is the only entry carrying a declaration and
its kind is `cursor-variant` — rather than deleting the coverage.

## 6. Bypass record (PLAN-BYPASS-NAMED-01)

- Tier: E2 (type-level exhaustiveness + tests).
- Executing surface: `tsc` for the kind Record; `bun test` for behavior. Note `tsc` does
  NOT cover string-comparison consumers such as `usage/cost.ts:422` (audit B4).
- Known bypass: an operator can set `providers.cursor.supportsServiceTier: true`, which
  advertises Fast on all 34 bases; 29 would then resolve with no fast variant and silently
  send the ordinary wire id.
- Residual risk: a dead toggle on operator-misconfigured installs.
- Wording: this is an early warning, not enforcement. Final enforcement layer: none.

The upgrade is a no-op when the variant is absent (`upgradeToFast` returns the input kind),
so the misconfiguration degrades to today's behavior rather than an error.

## 7. Existing tests that constrain this change

`tests/codex-catalog.test.ts:2923-2947` asserts routed entries carry NO
`service_tiers`/`additional_speed_tiers`, and `:2959-2973` asserts a routed row DOES get
them when the model declares `supportsServiceTier: true`. Both stay valid: the first uses
providers that declare no capability, the second is the shape Cursor now joins. Check during
B whether either fixture uses `provider: "cursor"`; if so, update it to assert the new
per-base behavior rather than the blanket absence.

**Both Grok call sites change atomically (audit B13).** `request-builder.ts:204` calls
`cursorGrokFastSelection(id, reasoning)` with no third argument today. If only
`resolveCursorSelection` learns the flag, a toggled Grok pick emits a flattened
`grok-4.6-high-fast` instead of the required `{id:"fast",value:"true"}` parameters —
violating this phase's own accept row. The helper signature, `normalizeCursorModelId`, and
that call site are one edit, and the Grok accept-row test belongs to wp3, not wp4.
