# 010 — wp1 / PR1: the fast-row grammar and its eligibility rule

Scope IN: `src/server/fast-row.ts` (new), `src/server/effort-row.ts` (export `isKnownId`),
`src/config.ts`, `src/types/config.ts`,
`tests/fast-row.test.ts` (new). Scope OUT: every listing and ingress call site — wp1 ships
the module and its tests with no caller, so the diff is reviewable on its own and the
runtime is byte-identical until wp2 wires it.

## Why a separate module rather than growing `effort-row.ts`

They share a separator and nothing else. `effort-row.ts` answers "which effort rung" and
consults an installed Cursor bundle table (`predictCursorEffort`, `detectCursorInstalls`).
A fast row answers "which service tier" and consults the FastWire policy. Folding the
second into the first would put Cursor install detection on the path of a feature that has
nothing to do with Cursor, and `cursorEffortRows` gates the whole file's work today.

What IS shared is the collision inventory, and that is already exported:
`knownEffortRowIds(config)` (`effort-row.ts:43`) collects configured, registry, live-cached
and custom model ids, routed slugs, provider/alias namespaces, `modelAliases` values, combo
ids, and routing-profile ids. wp1 imports it rather than rebuilding it. The name is
effort-flavoured for historical reasons; the set is not.

## The module

```ts
// src/server/fast-row.ts
import { fastPolicyForModel } from "../providers/service-tier";
import type { InboundWire } from "../providers/registry";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { knownEffortRowIds, type EffortRowKnownIds } from "./effort-row";

/**
 * Terminal marker for a synthetic Fast selector. `--` rather than `-` because terminal
 * `-fast` is a REAL id across this catalog (grok-4-fast, glm-5.3-fast, gpt-5-fast,
 * every Cursor fast variant), so a single hyphen cannot tell a product apart from a tier.
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
  // `eligible` alone. `unclassified` means capability is undefined, and decideTier makes
  // fastMode inert there (fastwire.ts:320) — publishing it would advertise a tier the
  // runtime then refuses to send.
  return fastPolicyForModel(provider, modelId, providerName, inbound).eligibility === "eligible";
}
```

Parsing mirrors `parseRequestEffortRowId`'s shape, including its cheap bail:

```ts
export interface ParsedFastRowId { baseId: string; }

export function parseFastRowId(
  id: string,
  config: Pick<OcxConfig, "fastRows">,
  knownIds?: EffortRowKnownIds,
): ParsedFastRowId | null {
  if (config.fastRows !== true) return null;
  if (!id.endsWith(FAST_ROW_SUFFIX)) return null;
  // An exact configured/public id always beats the synthetic grammar, the same precedence
  // effort rows use. An operator who really named a model `x--fast` keeps it.
  if (isKnownId(knownIds, id)) return null;
  const baseId = id.slice(0, -FAST_ROW_SUFFIX.length);
  return baseId.length > 0 ? { baseId } : null;
}

/** Parse one ingress selector against the current config. */
export function parseRequestFastRowId(id: string, config: OcxConfig): ParsedFastRowId | null {
  if (config.fastRows !== true) return null;
  // Ordinary ids do not carry the marker; bail before building the known-id inventory so
  // the flag costs nothing per request for models that are not fast rows.
  if (!id.endsWith(FAST_ROW_SUFFIX)) return null;
  return parseFastRowId(id, config, knownEffortRowIds(config));
}
```

`isKnownId` is currently module-private in `effort-row.ts:32`. wp1 exports it there (a
two-word diff) rather than duplicating the Set-or-predicate branch.

Publication helper, shaped like `expandCursorEffortRow` so wp2's call sites read the same:

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

The base row is always kept: a fast row is an addition, never a replacement. This is the
deliberate difference from `fastMode`, which replaces the listed Cursor id
(`src/server/index.ts:1603`). Replacement suits a global switch; a per-request selector
has to leave the default reachable.

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
+   * Opt-in synthetic Fast selectors. When true, external model listings add a
+   * `<base-id>--fast` row for every model whose resolved Fast policy is `eligible`,
+   * and selecting one routes the base model with the canonical `priority` service
+   * tier. Omitted/false preserves discovery output exactly.
+   */
+  fastRows?: boolean;
```

`.catch(false)` matters: a hand-edited config with `fastRows: "yes"` must degrade to off,
not reject every provider.

## Tests — `tests/fast-row.test.ts`

Fixtures follow `tests/cursor-fast-listing.test.ts:74`: build the provider from the
registry with `providerConfigSeed(getProviderRegistryEntry(...))` instead of hand-writing
a config, so the test cannot drift from real capability data.

1. **Default off.** `parseFastRowId("x--fast", {})` and `expandFastRow(row, true, {})`
   return null / `[row]`. The flag-off path is the one every existing install runs.
2. **Eligible publishes, unclassified does not.** Three fixture providers — one with
   `supportsServiceTier: true` on an `openai-responses` adapter (eligible), one with it
   `false` (capability-unsupported), one with it absent (unclassified) — and assert only
   the first expands. This drives the `eligibility === "eligible"` conditional directly
   rather than asserting a table contains a value, per `cursor-fast-tier.test.ts:31`.
3. **`wire-unavailable` does not publish.** `fastWire: null` with
   `supportsServiceTier: true` is the config-level conflict `config.ts:1193` already
   rejects, so use the registry case instead: an `anthropic` adapter, whose
   `anthropic-speed` wire has an empty adapter set (`fastwire.ts:15`).
4. **A known id beats the grammar.** With a provider declaring a literal `foo--fast`
   model, `parseFastRowId("foo--fast")` returns null and `expandFastRow` on `foo` emits
   no duplicate.
5. **Effort-row non-interference, both directions.** `parseEffortRowId("x--fast", ...)`
   returns null because `fast` is not a declared effort, and `parseFastRowId("x--high")`
   returns null because it lacks the marker. This is the assertion that lets the two
   grammars share `--`; without it the composition is an assumption.
6. **Bare marker rejected.** `parseFastRowId("--fast")` returns null — an empty base is
   not a model.
7. **Composite rejected both ways (audit B5).** `x--high--fast` and `x--fast--high` each
   parse to null under BOTH `parseFastRowId` and `parseEffortRowId`.

## One grammar per id (audit B5)

An id carrying BOTH markers resolves to neither grammar. wp1 owns the rule so it cannot
drift between the five call sites:

```ts
/**
 * True when a selector carries a fast marker AND a declared effort marker. Such an id is
 * rejected by both parsers rather than resolved by whichever runs first. Ordering-derived
 * behaviour was the audit's B5 finding: Responses parsed effort first and mutated the id,
 * so `x--fast--high` fired both dimensions while `x--high--fast` fired neither, and Chat
 * and Messages — which parse from the immutable requested id — disagreed with it.
 */
export function hasCompositeRowMarkers(id: string): boolean {
  if (!id.endsWith(FAST_ROW_SUFFIX)) return false;
  const stem = id.slice(0, -FAST_ROW_SUFFIX.length);
  const sep = stem.lastIndexOf("--");
  return sep > 0 && isDeclaredReasoningEffort(stem.slice(sep + 2));
}
```

`parseFastRowId` returns null on it, and wp3 checks it before the effort parser on every
ingress. Every ingress parses from the IMMUTABLE original selector, never from a value a
previous parser mutated.

## Verification

`bun test tests/fast-row.test.ts`, `bun test tests/config.test.ts`, `bun run typecheck`.
No repository-wide suite.
