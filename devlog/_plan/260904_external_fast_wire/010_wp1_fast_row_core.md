# 010 — wp1 / PR1: the fast-row grammar and its eligibility rule

Scope IN: `src/server/fast-row.ts` (new), `src/server/effort-row.ts` (export `isKnownId`),
`src/config.ts`, `src/types/config.ts`, `tests/fast-row.test.ts` (new). Scope OUT: every
listing and ingress call site — wp1 ships the module and its tests with no caller, so the
diff is reviewable on its own and the runtime is byte-identical until wp2 wires it.

## Why a separate module rather than growing `effort-row.ts`

They share a separator and nothing else. `effort-row.ts` answers "which effort rung" and
consults an installed Cursor bundle table (`predictCursorEffort`, `detectCursorInstalls`).
A fast row answers "which service tier" and consults the FastWire policy. Folding the
second into the first would put Cursor install detection on the path of a feature unrelated
to Cursor, and `cursorEffortRows` gates that whole file's work today.

What IS shared is the collision inventory, and it is already built:
`knownEffortRowIds(config)` (`effort-row.ts:43`) collects configured, registry, live-cached
and custom model ids, routed slugs, provider/alias namespaces, `modelAliases` values, combo
ids, and routing-profile ids. wp1 imports it rather than rebuilding it. The name is
effort-flavoured for historical reasons; the set is not.

## The module

```ts
// src/server/fast-row.ts
import {
  accountBoundNativeOpenAiSlugsBySelector,
  shouldIncludeAccountBoundNativeOpenAi,
  shouldIncludeNativeOpenAi,
  UPSTREAM_NATIVE_ENTRIES,
} from "../codex/catalog/metadata";
import { fastPolicyForModel } from "../providers/service-tier";
import type { InboundWire } from "../providers/registry";
import type { OcxConfig } from "../types";
import {
  isKnownId,
  knownEffortRowIds,
  parseEffortRowId,
  parseRequestEffortRowId,
  loadDetectedCursorEffortTable,
  type EffortRowKnownIds,
  type ParsedEffortRowId,
} from "./effort-row";

/**
 * Terminal marker for a synthetic Fast selector. Double hyphen rather than single, because
 * terminal -fast is a REAL id across this catalog (grok-4-fast, glm-5.3-fast, gpt-5-fast,
 * every Cursor fast variant), so one hyphen cannot tell a product apart from a tier.
 * See 000_plan.md for the full collision table.
 */
const FAST_ROW_SUFFIX = "--fast";

export function fastRowId(baseId: string): string {
  return `${baseId}${FAST_ROW_SUFFIX}`;
}

/** Provider/model pair whose resolved Fast policy may be published as a row. */
export function fastRowEligible(
  provider: Parameters<typeof fastPolicyForModel>[0],
  modelId: string,
  providerName?: string,
  inbound: InboundWire = "responses",
): boolean {
  // "eligible" alone. "unclassified" means capability is undefined, and decideTier makes
  // fastMode inert there (fastwire.ts:320) - publishing it would advertise a tier the
  // runtime then refuses to send.
  return fastPolicyForModel(provider, modelId, providerName, inbound).eligibility === "eligible";
}
```

## Parsing: two questions, not one

Three drafts died here, and the reason is the design.

The first used a suffix-shape guard (`hasCompositeRowMarkers`). It was asymmetric — it
caught `x--high--fast` but not `x--fast--high` — and it suppressed `a--high--fast`, a row this
unit itself publishes when `a--high` is a real model.

The second required the stripped base to be in `knownEffortRowIds()`. That set answers
"which exact ids defeat the synthetic grammar"; it does NOT answer "which bases are
routable". Native slugs prove the gap: the `openai` registry entry declares no `models`
list (`registry.ts:1128`) and the default provider config declares none either
(`config.ts:3552`), because bare natives route through a family-pattern rule instead
(`isBareOpenAiFamilyModel`, `router.ts:529`). So `gpt-5.6-sol` — the flagship Fast model —
is absent from that set, and the second draft would have published `gpt-5.6-sol--fast` and
then refused to parse it. A row nothing can select is worse than no row.

The two questions stay separate:

| Question | Source | Used for |
|---|---|---|
| Which exact ids beat the grammar? | `knownEffortRowIds(config)` | refusing to strip a real `x--fast` |
| Which bases may carry a fast row? | `fastRowBases(config)` (new) | validating the strip |

`fastRowBases()` is a synchronous SUPERSET of what wp2 publishes, deliberately — not the
same enumeration. wp2's list depends on request-local async state: `fetchAllModels`, the
entitlement snapshot, and the gathered catalog (`index.ts:1350`, `:1404`, `:1421`). A
request-side parser has only `config` and cannot reproduce it.

A superset is the right shape anyway. Being too permissive here costs nothing: the router
still rejects a base it cannot serve, and the exact-id guard above still protects real
models. Being too strict is what breaks the feature — that was the round-3 defect, where a
published row could not be parsed. So the parser answers "could this plausibly be a base we
publish for?" and lets routing make the final call.

```ts
/**
 * Bases that may carry a fast row. A superset of the published set: entitlement filtering
 * is deliberately NOT applied, because it needs an async snapshot the request path does not
 * have, and an unavailable selector is already rejected downstream by routing.
 */
export function fastRowBases(config: OcxConfig): Set<string> {
  const bases = new Set<string>(knownEffortRowIds(config));
  // Bare natives carry no declared models list and route by family pattern, so the known-id
  // set omits them entirely (router.ts:529). They are also the models Fast matters most for.
  //
  // Deliberately the STATIC upstream table, not visibleNativeSlugs(): that one filters by
  // disabled/shadowed state and reaches readCurrentCatalogOrCache() (metadata.ts:430, :807),
  // so it would both read the catalog on every parsed selector and SHRINK as runtime state
  // changes. A base disappearing mid-session would strand a client still holding the id it
  // was published. A base is meant to be RECOGNIZED here and then judged by routing.
  if (shouldIncludeNativeOpenAi(config)) {
    for (const slug of UPSTREAM_NATIVE_ENTRIES.keys()) bases.add(slug);
  }
  if (shouldIncludeAccountBoundNativeOpenAi(config)) {
    // Pass an EMPTY observed-entry list on purpose. The default argument reads the Codex
    // models cache and catalog from disk (metadata.ts:765), which would put a file read on
    // every parsed selector. The empty form still seeds every selector with
    // NATIVE_OPENAI_MODELS (:773), and an observed native this unit could publish for must
    // already be in UPSTREAM_NATIVE_ENTRIES anyway, so nothing publishable is lost.
    for (const [selector, slugs] of accountBoundNativeOpenAiSlugsBySelector(config, [])) {
      for (const slug of slugs) bases.add(`${selector}/${slug}`);
    }
  }
  return bases;
}
```

Every source here is synchronous and, with the static native table and the explicit empty
observed-entry list, none touches the filesystem (`metadata.ts:450`, `:763`). The set is
also STABLE for a given config: it cannot shrink because a catalog refresh changed
visibility. wp2 asserts the containment direction that matters — every base it publishes a
row for is in this set (test 10). The reverse does not hold, by design.

```ts
export interface ParsedFastRowId { baseId: string; }

export function parseFastRowId(
  id: string,
  config: Pick<OcxConfig, "fastRows">,
  // Both optional so a unit test can call the parser with neither inventory and get the
  // flag-off / shape-only behaviour without constructing a config.
  knownIds?: EffortRowKnownIds,
  routableBases?: EffortRowKnownIds,
): ParsedFastRowId | null {
  if (config.fastRows !== true) return null;
  if (!id.endsWith(FAST_ROW_SUFFIX)) return null;
  // An exact configured/public id always beats the synthetic grammar - the same precedence
  // effort rows use. An operator who really named a model "x--fast" keeps it.
  if (isKnownId(knownIds, id)) return null;
  const baseId = id.slice(0, -FAST_ROW_SUFFIX.length);
  if (baseId.length === 0) return null;
  // The base must be one this proxy actually publishes a fast row FOR. Not the known-id
  // set: that omits bare natives, which route by family pattern rather than a declared
  // models list, and they are the models Fast matters most for.
  return isKnownId(routableBases, baseId) ? { baseId } : null;
}
```

## Reverse-order composites

`x--fast--high` does not end in the marker, so the fast parser never sees it. An earlier draft
claimed the effort parser would then decline it too. That was wrong: `parseEffortRowId`
validates the terminal effort and the Cursor ladder but never checks that the base is real
(`effort-row.ts:78-95`), so it returns base `x--fast` with effort `high`.

That is pre-existing effort-row behaviour and this unit does not change it. What this unit
must not do is let a FAST marker be consumed as part of an effort row's base. One guard,
applied where the grammars meet:

```ts
/**
 * True when an effort-row base still carries a fast marker, i.e. the selector nested the
 * two grammars. Composition is not supported (020 R1), so such an id resolves to neither
 * rather than silently to whichever parser ran first.
 *
 * Guarded by the known-id check so a real model named "foo--fast" keeps its legitimate
 * "foo--fast--high" effort row.
 */
export function effortBaseCarriesFastMarker(
  baseId: string,
  knownIds: EffortRowKnownIds | undefined,
): boolean {
  return baseId.endsWith(FAST_ROW_SUFFIX) && !isKnownId(knownIds, baseId);
}
```

wp3 applies it at each ingress: when the effort parser returns a base for which this holds,
the selector is treated as unrecognized. Both marker orders then behave identically on all
five surfaces.

## Request-time entry point

One wrapper parses BOTH grammars, so no call site can apply the nested-marker rule
differently from another. wp3 uses only this:

```ts
export interface ParsedSyntheticRow {
  fastRow: ParsedFastRowId | null;
  effortRow: ParsedEffortRowId | null;
}

/**
 * Resolve one ingress selector against both synthetic grammars. Callers pass the id the
 * client sent and never a value another parser mutated.
 */
export function parseSyntheticRowId(
  id: string,
  config: OcxConfig,
  // Claude surfaces decode the alias before the marker is unambiguous, so they pass the
  // decoded form for Fast while effort parsing keeps seeing the id the client sent. A THUNK,
  // not a string: arguments are evaluated before the call, so an eager decode would run its
  // alias lookups even on the fastRows-off path this function exists to leave untouched.
  fastSelector?: () => string,
): ParsedSyntheticRow {
  // Fast off: delegate verbatim. Not merely equivalent - the SAME function shipped today,
  // so an install that never enables this feature cannot observe any change at all, in
  // behaviour or in cost. Building knownIds or touching the Cursor table here would be a
  // regression on the existing cursorEffortRows path.
  if (config.fastRows !== true) {
    return { fastRow: null, effortRow: parseRequestEffortRowId(id, config) };
  }
  // Evaluated only past the fastRows gate above.
  const selector = fastSelector?.() ?? id;
  // Ordinary ids carry no marker at all; bail before building any inventory.
  if (id.lastIndexOf("--") <= 0 && selector.lastIndexOf("--") <= 0) {
    return { fastRow: null, effortRow: null };
  }
  const knownIds = knownEffortRowIds(config);
  const fastRow = selector.endsWith(FAST_ROW_SUFFIX)
    ? parseFastRowId(selector, config, knownIds, fastRowBases(config))
    : null;
  if (fastRow) return { fastRow, effortRow: null };
  // Cursor install detection stays behind its own flag, exactly as parseRequestEffortRowId
  // gates it today.
  const effortRow = config.cursorEffortRows === true
    ? parseEffortRowId(id, config, { knownIds, table: loadDetectedCursorEffortTable() })
    : null;
  // Composition is not supported (020 R1) and the effort parser cannot see the problem: it
  // validates the terminal effort but never that the base is real (effort-row.ts:78-95), so
  // "x--fast--high" would otherwise resolve to the nonexistent base "x--fast". This rule
  // applies only with fastRows ON, so it can never change a shipped-config outcome.
  return effortRow && effortBaseCarriesFastMarker(effortRow.baseId, knownIds)
    ? { fastRow: null, effortRow: null }
    : { fastRow: null, effortRow };
}
```

`parseRequestFastRowId` is not introduced; the wrapper subsumes it. Existing effort-row
call sites migrate to the wrapper in wp3 so both grammars are resolved in one place.

**The migration must not regress `cursorEffortRows`.** With `fastRows` off the wrapper
reduces to today's behaviour, and the differences are deliberate and bounded:

With `fastRows` off the wrapper **delegates to `parseRequestEffortRowId` itself**, so the
shipped path is not reimplemented and cannot drift. An earlier draft reconstructed the
logic inline and regressed two cases the audit caught: it built the known-id inventory and
loaded the Cursor bundle table for any id containing `--` (work the shipped early-return
skips), and it applied the nested-marker rule unconditionally, so a `cursorEffortRows` user
with `fastRows` off would have lost the `x--fast--high` effort row they get today.

With `fastRows` on, the nested-marker rule is new behaviour for a new opt-in feature, which
is the only place it is allowed to apply. Test 12 pins the delegation.

Two callers have no effort-row history to preserve — `count_tokens` and `compact` never
parsed one — so they must not acquire the delegated call either. Both use a Fast-only
entry point that returns before any inventory work when the flag is off:

```ts
/** Fast-only resolution for surfaces that never parsed an effort row. */
export function parseFastOnlyRowId(
  config: OcxConfig,
  selector: () => string,
): ParsedFastRowId | null {
  if (config.fastRows !== true) return null;
  return parseSyntheticRowId("", config, selector).fastRow;
}
```

`isKnownId` is module-private in `effort-row.ts:32` today. wp1 exports it there rather than
duplicating the Set-or-predicate branch.
## Publication helper

```ts
export function expandFastRow<T extends { id: string }>(
  row: T,
  eligible: boolean,
  config: Pick<OcxConfig, "fastRows">,
  knownIds?: EffortRowKnownIds,
): T[] {
  if (config.fastRows !== true || !eligible) return [row];
  const id = fastRowId(row.id);
  return isKnownId(knownIds, id) ? [row] : [row, { ...row, id }];
}
```

The base row is always kept: a fast row is an addition, never a replacement. That is the
deliberate difference from `fastMode`, which replaces the listed Cursor id
(`src/server/index.ts:1603`). Replacement suits a global switch; a per-request selector has
to leave the default reachable.

## Config flag

Following the `cursorEffortRows` precedent exactly (`src/config.ts:1052`).

```diff
 // src/config.ts
   cursorEffortRows: z.boolean().optional().catch(false),
+  // Malformed hand edits disable this opt-in projection without rejecting providers.
+  fastRows: z.boolean().optional().catch(false),
```

```diff
 // src/types/config.ts
+  /**
+   * Opt-in synthetic Fast selectors. When true, the raw OpenAI-style /v1/models list and
+   * Claude Code discovery add a "<base-id>--fast" row for every model whose resolved Fast
+   * policy is eligible, and selecting one routes the base model with the canonical
+   * "priority" service tier. Omitted/false preserves discovery output exactly.
+   */
+  fastRows?: boolean;
```

`.catch(false)` matters: a hand-edited config with `fastRows: "yes"` must degrade to off,
not reject every provider.

## Tests — `tests/fast-row.test.ts`

Fixtures follow `tests/cursor-fast-listing.test.ts:74`: build the provider from the registry
with `providerConfigSeed(getProviderRegistryEntry(...))` rather than hand-writing a config,
so the test cannot drift from real capability data.

1. **Default off.** `parseFastRowId("x--fast", {})` returns null and
   `expandFastRow(row, true, {})` returns the row alone — both inventories are optional, so
   this needs no config. This is the path every existing install runs.
2. **Eligible publishes, unclassified does not.** Three fixture providers —
   `supportsServiceTier: true` on an `openai-responses` adapter (eligible), `false`
   (capability-unsupported), and absent (unclassified) — and only the first expands. This
   drives the `eligibility === "eligible"` conditional rather than asserting a table
   contains a value, per `cursor-fast-tier.test.ts:31`.
3. **`wire-unavailable` does not publish.** `fastWire: null` with `supportsServiceTier: true`
   is the config-level conflict `config.ts:1193` already rejects, so use the registry case:
   an `anthropic` adapter, whose `anthropic-speed` wire has an empty adapter set
   (`fastwire.ts:15`).
4. **A known id beats the grammar.** With a provider declaring a literal `foo--fast` model,
   `parseFastRowId("foo--fast")` returns null and `expandFastRow` on `foo` emits no
   duplicate.
5. **An unknown base is refused.** `parseFastRowId("nonexistent--fast")` returns null even
   with the flag on.
6. **A base that itself ends in an effort marker still works.** A routable `a--high`
   yields a parsable `a--high--fast`. This is the audit-round-2 regression: the discarded
   composite guard failed it.
9. **A bare native round-trips.** `gpt-5.6-sol--fast` parses back to `gpt-5.6-sol` on a
   DEFAULT config, with no `models` list configured. This is the audit-round-3 regression:
   the known-id-based draft failed it, because bare natives route by family pattern and
   appear in no declared models list. Assert the account-qualified form too.
10. **Publication and parsing share one source.** For a fixture config, every id
    `fastRowBases(config)` reports is parsable, and every fast row wp2 would publish has
    its base in that set. This is the anti-drift invariant; it fails if either side grows
    a case the other lacks.
11. **Nested markers resolve to neither grammar.** `effortBaseCarriesFastMarker("x--fast")`
    is true for an unknown base and false when `x--fast` is a real known model, so
    `foo--fast--high` still works for a real `foo--fast`.
12. **The wrapper preserves effort-row behaviour with `fastRows` off.** For a table of
    existing selectors — flag off, no separator, ordinary `<base>--<effort>` — the
    wrapper's `effortRow` equals `parseRequestEffortRowId`'s result exactly. This is the
    anti-regression guard for the shipped `cursorEffortRows` feature.
7. **Effort-row non-interference, both directions.** `parseEffortRowId("x--fast", ...)`
   returns null because `fast` is not a declared effort
   (`isDeclaredReasoningEffort("fast") === false`, `src/reasoning-effort.ts:39`), and
   `parseFastRowId("x--high")` returns null for want of the marker. This is the assertion
   that lets the two grammars share the separator; without it the composition is an
   assumption.
8. **Bare marker rejected.** `parseFastRowId("--fast")` returns null — an empty base is not
   a model.

## Verification

`bun test tests/fast-row.test.ts`, `bun test tests/config.test.ts`, `bun run typecheck`.
No repository-wide suite.
