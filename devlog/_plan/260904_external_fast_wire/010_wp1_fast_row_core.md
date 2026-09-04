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
import { fastPolicyForModel } from "../providers/service-tier";
import type { InboundWire } from "../providers/registry";
import type { OcxConfig } from "../types";
import { isKnownId, knownEffortRowIds, type EffortRowKnownIds } from "./effort-row";

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

## Parsing, and why there is no composite guard

The first draft carried a `hasCompositeRowMarkers()` helper meant to reject ids bearing both
a fast and an effort marker. Audit round 2 killed it, and the reasoning is worth keeping
because it is the argument for the design that replaced it.

The helper was asymmetric: it tested `endsWith("--fast")` then looked one segment left, so
`x--high--fast` was caught while `x--fast--high` sailed past. Worse, it was blind to real
models: an eligible base legitimately named `a--high` publishes `a--high--fast`, and the
guard would have suppressed parsing of a row this very unit published.

The correct arbiter already exists. A fast row is valid **iff stripping the marker leaves a
base this proxy can actually route**, and `knownEffortRowIds()` answers exactly that. So
parsing validates the base instead of pattern-matching the composite:

```ts
export interface ParsedFastRowId { baseId: string; }

export function parseFastRowId(
  id: string,
  config: Pick<OcxConfig, "fastRows">,
  knownIds?: EffortRowKnownIds,
): ParsedFastRowId | null {
  if (config.fastRows !== true) return null;
  if (!id.endsWith(FAST_ROW_SUFFIX)) return null;
  // An exact configured/public id always beats the synthetic grammar - the same precedence
  // effort rows use. An operator who really named a model "x--fast" keeps it.
  if (isKnownId(knownIds, id)) return null;
  const baseId = id.slice(0, -FAST_ROW_SUFFIX.length);
  if (baseId.length === 0) return null;
  // The base must be a model we can route. This is what makes the grammar safe without a
  // composite guard: "a--high--fast" resolves because "a--high" is known, and
  // "x--fast--high" is never mistaken for a fast row because it does not end in the marker
  // - the effort parser sees base "x--fast", finds it unknown, and declines too.
  return isKnownId(knownIds, baseId) ? { baseId } : null;
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

Requiring a known base is a real tightening over the effort-row grammar, which accepts any
stem. It is affordable here because a fast row is only ever published for a model that
resolved a Fast policy, and a policy cannot resolve for a model the router does not know.

`isKnownId` is module-private in `effort-row.ts:32` today. wp1 exports it there rather
than duplicating the Set-or-predicate branch.

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
   `expandFastRow(row, true, {})` returns the row alone. This is the path every existing
   install runs.
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
6. **A base that itself ends in an effort marker still works.** A known model `a--high`
   yields a parsable `a--high--fast`. This is the audit-round-2 regression: the discarded
   composite guard failed it.
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

