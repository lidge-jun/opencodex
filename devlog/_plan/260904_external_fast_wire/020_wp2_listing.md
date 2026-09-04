# 020 — wp2 / PR2: publish the row on external listings

Stacked on PR1. Scope IN: `src/server/index.ts` (`/v1/models` and the Claude Code discovery
call only), `src/claude/model-info.ts`, `tests/fast-row-listing.test.ts` (new). Scope OUT:
ingress parsing (wp3); the dashboard `/api/models` `namespaced` ids; Desktop 3P hashed
aliases are covered but never rewritten; the Cursor integration status panel.

## Which surfaces publish, and which deliberately do not

`/api/models` `namespaced` ids are `disabledModels` keys and the identities `ocx export`
and the OpenCode integration write into user config files (`src/cli/opencode.ts:368`,
`src/cli/export-command.ts:78`). A synthetic id landing in a persisted config outlives the
flag that produced it, so those surfaces keep emitting base ids only. That is a real
limitation, not an oversight, and wp4 documents it as one.

The surfaces that DO publish are the two a client uses to pick a model for a live request:
the raw OpenAI-style `/v1/models` list, and Claude Code discovery.

## Eligibility at listing time

Routed models have everything in scope already: `m.provider` names the provider and
`config.providers[m.provider]` is available at `src/server/index.ts:1605`. So the row mapper
calls `fastRowEligible(provider, m.id, m.provider)` — the same `fastPolicyForModel` the
catalog uses, pure and synchronous (`service-tier.ts:181`), adding no await to a branch that
must not gain one.

Natives need both halves of the evidence. Upstream asserts Fast per model, and the operator
can still withdraw it:

```ts
// src/server/index.ts. UPSTREAM_NATIVE_ENTRIES lives in src/codex/catalog/metadata.ts and
// is NOT re-exported by the catalog facade, so import it directly.
import { UPSTREAM_NATIVE_ENTRIES } from "../codex/catalog/metadata";

const nativeFastEligible = (metadataId: string): boolean => {
  const entry = UPSTREAM_NATIVE_ENTRIES.get(metadataId);
  const upstreamSaysFast = Array.isArray(entry?.additional_speed_tiers)
    && entry.additional_speed_tiers.includes("fast");
  if (!upstreamSaysFast) return false;
  // Upstream evidence alone never publishes: an operator capability override or the final
  // wire resolution can still make the route ineligible, and decideTier would then drop
  // the tier the row advertised.
  const provider = config.providers[OPENAI_CODEX_PROVIDER_ID];
  return provider !== undefined
    && fastRowEligible(provider, metadataId, OPENAI_CODEX_PROVIDER_ID);
};
```

Reading the same `additional_speed_tiers` the Codex picker's toggle is built from
(`src/codex/catalog/effort.ts:167` writes it; upstream asserts it) is what keeps the
external row and the in-app toggle from disagreeing about which natives have Fast.

## `/v1/models`

```diff
         const effortRowsEnabled = config.cursorEffortRows === true;
+        // Same opt-in discipline: with the flag off, no policy resolution and no extra rows.
+        const fastRowsEnabled = config.fastRows === true;
+        // One inventory serves both grammars; building it twice would double the work on a
+        // hot path for no benefit.
+        const syntheticKnownIds = effortRowsEnabled || fastRowsEnabled
+          ? knownEffortRowIds(config)
+          : undefined;
```

`effortRowKnownIds` becomes `syntheticKnownIds` at its two existing uses. The native mapper
then composes the two expansions:

```diff
         const expandedNativeModelRow = (id: string, metadataId = id) => {
           const reasoningEfforts = nativeReasoningEfforts(metadataId);
           return expandCursorEffortRow(nativeModelRow(id, metadataId), reasoningEfforts, config, {
-            knownIds: effortRowKnownIds,
+            knownIds: syntheticKnownIds,
             table: cursorEffortTable,
             supportsReasoning: reasoningEfforts.length > 0,
-          });
+          }).flatMap(row => expandFastRow(
+            row,
+            // Only the base row earns a fast sibling. An effort row already spent the
+            // grammar, and wp1's parser requires the stripped base to be a KNOWN model -
+            // "<base>--<effort>" is synthetic, so "<base>--<effort>--fast" would publish a
+            // row that no ingress can resolve.
+            row.id === id && nativeFastEligible(metadataId),
+            config,
+            syntheticKnownIds,
+          ));
         };
```

The routed branch takes the same shape with policy-derived eligibility:

```diff
           return expandCursorEffortRow(row, m.reasoningEfforts, config, {
-            knownIds: effortRowKnownIds,
+            knownIds: syntheticKnownIds,
             table: cursorEffortTable,
             supportsReasoning: (m.reasoningEfforts ?? []).length > 0,
-          });
+          }).flatMap(expanded => expandFastRow(
+            expanded,
+            expanded.id === row.id
+              && provider !== undefined
+              && fastRowEligible(provider, m.id, m.provider),
+            config,
+            syntheticKnownIds,
+          ));
```

`m.id` (not `publicId`) is the identity the policy resolves against, while the id that
receives the suffix is the public one — a routed slug, or an operator alias when one
exists. An alias is an explicit operator decision and keeps its own `--fast` sibling rather
than being bypassed.

## Claude Code discovery

`buildAnthropicModelInfos` builds natives at `model-info.ts:143` and routed models at
`:155`. **Both loops publish**, or the flagship Fast model — native `gpt-5.6-sol` — would
be missing from the surface this unit exists to serve.

The signature gains a predicate rather than a config object, because `model-info.ts` is a
translation module and must not start resolving provider policy itself:

```diff
 export function buildAnthropicModelInfos(
   ...
   fastMode?: boolean,
+  fastRows?: (provider: string, modelId: string) => boolean,
 ): AnthropicModelInfo[] {
```

`buildAnthropicModelInfos` treats the predicate's PRESENCE as the gate — both loops call
`fastRows?.(...)` — so the caller must pass `undefined` when the flag is off. The predicate
itself answers eligibility, not enablement; conflating the two would publish rows on a
default install.

The caller at `src/server/index.ts:1454` binds it to `config` and routes the `native`
pseudo-provider explicitly, since `config.providers.native` does not exist:

```ts
config.fastRows === true
  ? (provider: string, modelId: string) => provider === "native"
    ? nativeFastEligible(modelId)
    : (config.providers[provider] !== undefined
      && fastRowEligible(config.providers[provider], modelId, provider))
  : undefined,
```

`nativeFastEligible` must be declared BEFORE this call. The raw OpenAI mapper that also
uses it sits further down the handler, so a `const` defined there would leave this call in
its temporal dead zone.

One helper serves both loops, alongside the existing `push1mVariant`:

One `discoveryId` helper computes the id for a row, and BOTH the loops and the collision
set use it, so the two can never disagree about what a real id looks like:

```ts
// The existing per-loop id expressions, extracted so there is ONE definition. Note the
// asymmetry, which is real and must be preserved: the readable style uses the LISTED id
// (so a fastMode-rewritten Cursor id is reflected), while the Desktop 3P style hashes the
// RAW m.id (model-info.ts:164-165), because a hash rewrite would strand a saved selection.
const nativeDiscoveryId = (slug: string): string => idStyle === "readable"
  ? claudeCodeNativeAlias(slug)
  : aliasForRoute("native", slug);

// The existing `fastModelId ?? m.id` expression at model-info.ts:159-162, lifted so the
// collision set and the routed loop compute one value. The fastMode Cursor rewrite must be
// reflected here, or a rewritten row would look synthetic to the collision check.
const listedModelIdFor = (m: CatalogModel): string =>
  fastMode === true && m.provider === "cursor" && idStyle === "readable"
    ? cursorFastIdFor(m.id) ?? m.id
    : m.id;

const routedDiscoveryId = (m: CatalogModel, listedModelId: string): string =>
  idStyle === "readable"
    ? claudeCodeAlias(m.provider, listedModelId)
    : aliasForRoute(m.provider, m.id);

// Every real id BOTH loops will emit, computed before either runs. `seen` alone is not
// enough: it grows as the loops run, so whether a synthetic id collided with a real one
// would depend on iteration order. With both `foo` and a real `foo--fast` in the roster,
// the synthetic id for `foo` IS the real model's id, and whichever ran first would win.
const realDiscoveryIds = new Set<string>([
  ...nativeSlugs.map(nativeDiscoveryId),
  ...routedModels.map(m => routedDiscoveryId(m, listedModelIdFor(m))),
]);

const pushFastVariant = (base: AnthropicModelInfo) => {
  const fastId = `${base.id}--fast`;
  // A real model always wins its own id, whatever the iteration order.
  if (realDiscoveryIds.has(fastId) || seen.has(fastId)) return;
  seen.add(fastId);
  out.push({ ...base, id: fastId, display_name: `${base.display_name} · Fast` });
};
```

Both loops call these helpers for their own row ids too, so the collision set and the
published output cannot drift. `claudeCodeAlias` and `claudeCodeNativeAlias` are already
imported at `model-info.ts:19`, `aliasForRoute` is a parameter of `buildAnthropicModelInfos`
(`:111`), and `cursorFastIdFor` is already imported for the existing fastMode rewrite.

```diff
   for (const slug of nativeSlugs) {
     ...
     out.push(info);
     push1mVariant(info, nativeWindow, nativeMaxInput);
+    if (fastRows?.("native", slug) === true) pushFastVariant(info);
   }
```

```diff
     const info = modelInfo(id, ..., routedMaxInput ?? m.contextWindow);
     out.push(info);
+    // An additive sibling, deliberately unlike the fastMode rewrite above: fastMode is a
+    // global switch with no per-request choice, so it replaces; a selector must leave the
+    // default pickable beside it.
+    if (fastRows?.(m.provider, m.id) === true) pushFastVariant(info);
```

Both id styles are covered, unlike `fastMode`. `fastMode` excludes Desktop 3P because it
*rewrites* a hashed id and would strand a saved selection (`model-info.ts:157`); an added
row strands nothing, because the original id keeps existing.

## Import changes, per file

| File | Add |
|---|---|
| `src/server/index.ts` | `expandFastRow`, `fastRowEligible` from `./fast-row`; `UPSTREAM_NATIVE_ENTRIES` from `../codex/catalog/metadata` (the catalog facade does not re-export it) |
| `src/claude/model-info.ts` | none — `claudeCodeAlias`/`claudeCodeNativeAlias` (`:19`), `cursorFastIdFor`, and the `aliasForRoute` parameter (`:111`) are all already in scope |

## Tests — `tests/fast-row-listing.test.ts`

1. Flag off: a listing containing an eligible model has no `--fast` id, on both the
   `/v1/models` shape and `buildAnthropicModelInfos`.
2. Flag on: the eligible model gains exactly one `--fast` row AND keeps its base row.
3. Flag on, ineligible or unclassified model: no `--fast` row.
4. Effort rows and fast rows both on: `<base>--high` exists, `<base>--fast` exists,
   `<base>--high--fast` does NOT. Guards the `row.id === id` condition.
5. Claude discovery, ROUTED model: the fast row appears beside the base id in both id
   styles, and the row count is base + 1.
6. Claude discovery, NATIVE slug: same. This is the audit-round-2 regression — the
   routed-only draft failed it.
7. A native WITHOUT upstream `additional_speed_tiers` gets no row; one WITH it does.
8. A native WITH upstream evidence but operator `supportsServiceTier: false` gets NO row.
   The metadata-only draft failed this one.
9. **Order-independent collision.** A roster containing both `foo` and a real `foo--fast`
   publishes the REAL model's row under that id, asserted with the roster in BOTH orders.
   The `seen`-only draft passed one order and failed the other.
10. **Publication is inside the parser's superset.** Every base this listing publishes a
    fast row for is in `fastRowBases(config)`. This is the anti-drift invariant that makes
    a published row guaranteed-parsable; it is the round-3 regression.

## Verification

`bun test tests/fast-row-listing.test.ts tests/fast-row.test.ts tests/cursor-fast-listing.test.ts`
(the last proves the neighbouring grammar is unchanged), `bun run typecheck`. No full suite.

## Residual

R1 — effort and fast do not compose (`<base>--high--fast` is not published). Fixing it needs
a combined codec and a two-marker parser; deferred until someone asks for a specific effort
at Fast, since the base row's default effort already reaches Fast.
