# 020 — wp2 / PR2: publish the row on external listings


## Amendments from audit round 1

### A1 — native eligibility is policy-derived, not metadata-derived (B2)

`nativeFastEligible()` as first written read only upstream `additional_speed_tiers`, which
ignores an operator's `supportsServiceTier: false` and the final wire resolution. Both
conditions are now required:

```ts
// Direct import: UPSTREAM_NATIVE_ENTRIES lives in src/codex/catalog/metadata.ts and is NOT
// re-exported by the catalog facade (audit note 5).
import { UPSTREAM_NATIVE_ENTRIES } from "../codex/catalog/metadata";

const nativeFastEligible = (metadataId: string): boolean => {
  const entry = UPSTREAM_NATIVE_ENTRIES.get(metadataId);
  const upstreamSaysFast = Array.isArray(entry?.additional_speed_tiers)
    && entry.additional_speed_tiers.includes("fast");
  if (!upstreamSaysFast) return false;
  // Upstream evidence alone never publishes: an operator capability override or a wire
  // resolution can still make the route ineligible, and decideTier would drop the tier.
  const provider = config.providers[OPENAI_CODEX_PROVIDER_ID];
  return provider !== undefined
    && fastRowEligible(provider, metadataId, OPENAI_CODEX_PROVIDER_ID);
};
```

### A2 — both Claude discovery loops, not just the routed one (B3)

`buildAnthropicModelInfos` builds natives at `model-info.ts:143` and routed models at
`:155`. The original draft patched only the routed loop, which would have left
`gpt-5.6-sol` — the flagship Fast model — without a row on Claude discovery, contradicting
this unit's goal. The native loop gains the same additive block, sharing one predicate:

```diff
   for (const slug of nativeSlugs) {
     const id = idStyle === "readable" ? claudeCodeNativeAlias(slug) : aliasForRoute("native", slug);
     ...
     out.push(info);
     push1mVariant(info, nativeWindow, nativeMaxInput);
+    if (fastRows?.("native", slug) === true) pushFastVariant(info);
   }
```

`pushFastVariant` is a local helper alongside `push1mVariant`, used by both loops, so the
two surfaces cannot drift. It applies to both id styles: an ADDED row strands no saved
selection, which is why the `fastMode` rewrite's Desktop 3P exclusion does not apply here.

### A3 — Cursor management status field dropped (B7)

The proposed `fastRow` field referenced an eligibility value the mapper cannot derive: it
retains only the public id, not a `{provider, modelId}` pair
(`cursor-integration-routes.ts:69`). It is a Cursor-integration status panel, not a
client-facing selector, so it leaves this unit entirely.
`src/server/management/cursor-integration-routes.ts` is removed from scope, and the
"Management route" section above is superseded.

### A4 — additional tests

7. A native model WITH upstream `additional_speed_tiers` but an operator
   `supportsServiceTier: false` gets NO row. This is the A1 guard, and it fails against
   the pre-audit design.
8. Claude discovery publishes a fast row for a native slug in BOTH id styles.

Stacked on PR1. Scope IN: `src/server/index.ts` (`/v1/models` and Claude Code discovery
branches only), `src/claude/model-info.ts`, `src/server/management/cursor-integration-routes.ts`,
`tests/fast-row-listing.test.ts` (new). Scope OUT: ingress parsing (wp3), the dashboard
`namespaced` ids (they are `disabledModels` keys), Desktop 3P hashed aliases.

## Where the eligibility comes from at listing time

The routed branch already has everything needed: `m.provider` names the provider and
`config.providers[m.provider]` is in scope at `src/server/index.ts:1605`. So the row mapper
can call `fastRowEligible(provider, m.id, m.provider)` directly — the same
`fastPolicyForModel` the catalog uses, which is pure and synchronous
(`service-tier.ts:181`), so it adds no await to a branch that must not gain one.

Natives are the case that needs a decision. A native slug like `gpt-5.6-sol` has no
`config.providers` entry of its own; its Fast support is asserted upstream, and
`UPSTREAM_NATIVE_ENTRIES` carries `additional_speed_tiers: ["fast"]` for exactly the
models that have it (`src/codex/data/upstream-models.json`). wp2 reads that snapshot
rather than inventing a second source:

```ts
// src/server/index.ts, near nativeModelRow (1532)
const nativeFastEligible = (metadataId: string): boolean => {
  const entry = UPSTREAM_NATIVE_ENTRIES.get(metadataId);
  return Array.isArray(entry?.additional_speed_tiers)
    && entry.additional_speed_tiers.includes("fast");
};
```

This is the same evidence the Codex picker's own toggle is built from
(`src/codex/catalog/effort.ts:167` writes that field; upstream asserts it), so the external
row and the in-app toggle cannot disagree about which natives have Fast.

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
-          return expandCursorEffortRow(nativeModelRow(id, metadataId), reasoningEfforts, config, {
-            knownIds: effortRowKnownIds,
-            table: cursorEffortTable,
-            supportsReasoning: reasoningEfforts.length > 0,
-          });
+          return expandCursorEffortRow(nativeModelRow(id, metadataId), reasoningEfforts, config, {
+            knownIds: syntheticKnownIds,
+            table: cursorEffortTable,
+            supportsReasoning: reasoningEfforts.length > 0,
+          }).flatMap(row => expandFastRow(
+            row,
+            // Only the base row earns a fast sibling: `x--high--fast` would be a second
+            // grammar stacked on the first, and nothing parses it.
+            row.id === id && nativeFastEligible(metadataId),
+            config,
+            syntheticKnownIds,
+          ));
         };
```

The `row.id === id` guard is load-bearing. Without it every `<base>--<effort>` row would
also sprout `--fast`, and wp3's parser splits on one marker, so those ids would resolve to
a base of `<base>--<effort>` — a model that does not exist. Composition of the two
dimensions is deliberately not supported in this unit; it is recorded as a residual.

The routed branch takes the same shape, with policy-derived eligibility:

```diff
-          return expandCursorEffortRow(row, m.reasoningEfforts, config, {
-            knownIds: effortRowKnownIds,
-            table: cursorEffortTable,
-            supportsReasoning: (m.reasoningEfforts ?? []).length > 0,
-          });
+          return expandCursorEffortRow(row, m.reasoningEfforts, config, {
+            knownIds: syntheticKnownIds,
+            table: cursorEffortTable,
+            supportsReasoning: (m.reasoningEfforts ?? []).length > 0,
+          }).flatMap(expanded => expandFastRow(
+            expanded,
+            expanded.id === row.id
+              && provider !== undefined
+              && fastRowEligible(provider, m.id, m.provider),
+            config,
+            syntheticKnownIds,
+          ));
```

`m.id` (not `publicId`) is the model identity the policy is resolved against, while the
row id that gets the suffix is the public one — a routed slug, or an operator alias when
one exists. An alias is an explicit operator decision, and it keeps its own `--fast`
sibling rather than being bypassed.

## Claude Code discovery

`buildAnthropicModelInfos` already takes `fastMode` (`src/claude/model-info.ts:113`) and
already knows how to publish a dimension as an extra row rather than a replacement:
`push1mVariant`. The fast row follows `push1mVariant`, not the `fastMode` rewrite.

```diff
 export function buildAnthropicModelInfos(
   ...
   fastMode?: boolean,
+  fastRows?: (provider: string, modelId: string) => boolean,
 ): AnthropicModelInfo[] {
```

A predicate rather than a config object: `model-info.ts` is a translation module and must
not start resolving provider policy itself. The caller in `src/server/index.ts:1454`
supplies it, already bound to `config`.

```diff
     const info = modelInfo(id, `${listedModelId} (${m.provider})`, ladder, imageInput, routedMaxInput ?? m.contextWindow);
     out.push(info);
+    // An additive sibling, deliberately unlike the fastMode rewrite above: fastMode is a
+    // global switch with no per-request choice, so it replaces; a selector must leave the
+    // default pickable next to it.
+    if (fastRows?.(m.provider, m.id) === true) {
+      const fastId = `${id}--fast`;
+      if (!seen.has(fastId)) {
+        seen.add(fastId);
+        out.push({ ...info, id: fastId, display_name: `${listedModelId} (${m.provider}, Fast)` });
+      }
+    }
```

Both id styles are covered here, unlike `fastMode`. The reason `fastMode` excludes Desktop
3P is that it *rewrites* the hashed id and would strand a saved selection
(`model-info.ts:157`); an added row strands nothing, because the original id keeps
existing.

## Management route

`cursor-integration-routes.ts:90` reports what the Cursor integration published. It gains
a sibling field rather than mixing grammars into `effortRows`:

```diff
       effortRows: expandCursorEffortRow({ id }, reasoningEfforts, config, {...}).slice(1).map(row => row.id),
+      fastRow: fastRowsEnabled && eligible ? fastRowId(id) : undefined,
```

## Tests — `tests/fast-row-listing.test.ts`

1. Flag off: a listing containing an eligible model has no `--fast` id anywhere. Run this
   against both the `/v1/models` shape and `buildAnthropicModelInfos`.
2. Flag on: the eligible model gains exactly one `--fast` row AND keeps its base row.
3. Flag on, ineligible/unclassified model: no `--fast` row.
4. Effort rows and fast rows both on: `<base>--high` exists, `<base>--fast` exists,
   `<base>--high--fast` does NOT. This is the guard for the `row.id === id` condition.
5. Claude Code discovery: the fast id appears alongside the base id and the row count is
   base + 1.
6. A native without `additional_speed_tiers` gets no row, one with it does.

## Verification

`bun test tests/fast-row-listing.test.ts tests/fast-row.test.ts`, plus the existing
`tests/cursor-fast-listing.test.ts` to prove the neighbouring grammar is unchanged.
`bun run typecheck`. No full suite.

## Residual

R1 — effort and fast do not compose (`<base>--high--fast` is not published). Fixing it
means a combined codec and a two-marker parser; deferred until someone asks for a specific
effort at Fast, since the base row's default effort already reaches Fast.
