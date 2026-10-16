# 050 — wp5: canonical Claude-id normalizer for the Cursor adapter

Depends on: 000 (independent of wp1-wp4; own PR against `dev`). Design produced by a sol/high
research lane on 2026-09-02 and folded here; the lane read the current tree and changed no files.

Loop-spec: spec-satisfaction; trigger = Fable 5.1 seeded three times because Cursor spells Claude
ids both Anthropic-style (`claude-fable-5-1`) and version-first (`claude-5.1-fable`); goal = one
capability base per Claude model, any live spelling resolves to it, wire ids are composed back in
the spelling the live roster exposed; non-goals = picker id churn for saved configs, non-Claude
families; verifier = the focused test list at the bottom + typecheck; stop = green + exact-head CI.

## File change map

### NEW `src/adapters/cursor/claude-id.ts`

```ts
export type CursorClaudeSpelling = "anthropic" | "version-first";

export interface NormalizedCursorClaudeId {
  /** The sole key used by CURSOR_CAPABILITIES and pricing metadata. */
  canonicalBaseId: string;
  /** Exact input stem, preserving `5-1` versus `5.1` for wire round-trips. */
  sourceBaseId: string;
  spelling: CursorClaudeSpelling;
  thinking: boolean;
  fast: boolean;
  level?: string;
}

const CLAUDE_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "extra-high"]);

/** Existing picker bases whose canonical key stays version-first (saved configs). */
const VERSION_FIRST_CANONICAL_BASES = new Set([
  "claude-4.5-haiku", "claude-4.5-opus", "claude-4.6-opus", "claude-4.5-sonnet", "claude-4.6-sonnet", "claude-4-sonnet",
]);

function parseClaudeBase(raw: string): { canonicalBaseId: string; sourceBaseId: string; spelling: CursorClaudeSpelling } | undefined {
  const anthropic = /^claude-(fable|haiku|opus|sonnet)-(\d+(?:[.-]\d+)*)$/.exec(raw);
  if (anthropic) {
    const family = anthropic[1]!;
    const version = anthropic[2]!.replaceAll(".", "-");
    const versionFirst = `claude-${version.replaceAll("-", ".")}-${family}`;
    return {
      canonicalBaseId: VERSION_FIRST_CANONICAL_BASES.has(versionFirst) ? versionFirst : `claude-${family}-${version}`,
      sourceBaseId: raw,
      spelling: "anthropic",
    };
  }
  const versionFirst = /^claude-(\d+(?:\.\d+)*)-(fable|haiku|opus|sonnet)$/.exec(raw);
  if (!versionFirst) return undefined;
  const sourceBaseId = `claude-${versionFirst[1]!}-${versionFirst[2]!}`;
  return {
    canonicalBaseId: VERSION_FIRST_CANONICAL_BASES.has(sourceBaseId) ? sourceBaseId : `claude-${versionFirst[2]!}-${versionFirst[1]!.replaceAll(".", "-")}`,
    sourceBaseId,
    spelling: "version-first",
  };
}

export function normalizeCursorClaudeId(raw: string): NormalizedCursorClaudeId | undefined {
  const id = raw.trim().toLowerCase();
  const patterns: ReadonlyArray<readonly [RegExp, (m: RegExpExecArray) => { base: string; thinking: boolean; fast: boolean; level?: string }]> = [
    [/^(.*)-thinking-([a-z-]+)-fast$/, m => ({ base: m[1]!, thinking: true, fast: true, level: m[2]! })],
    [/^(.*)-([a-z-]+)-thinking-fast$/, m => ({ base: m[1]!, thinking: true, fast: true, level: m[2]! })],
    [/^(.*)-thinking-([a-z-]+)$/, m => ({ base: m[1]!, thinking: true, fast: false, level: m[2]! })],
    [/^(.*)-([a-z-]+)-thinking$/, m => ({ base: m[1]!, thinking: true, fast: false, level: m[2]! })],
    [/^(.*)-([a-z-]+)-fast$/, m => ({ base: m[1]!, thinking: false, fast: true, level: m[2]! })],
    [/^(.*)-thinking-fast$/, m => ({ base: m[1]!, thinking: true, fast: true })],
    [/^(.*)-thinking$/, m => ({ base: m[1]!, thinking: true, fast: false })],
    [/^(.*)-fast$/, m => ({ base: m[1]!, thinking: false, fast: true })],
  ];
  for (const [pattern, dims] of patterns) {
    const match = pattern.exec(id);
    if (!match) continue;
    const parsed = dims(match);
    if (parsed.level && !CLAUDE_LEVELS.has(parsed.level)) continue;
    const base = parseClaudeBase(parsed.base);
    if (base) return { ...base, ...parsed, sourceBaseId: base.sourceBaseId };
  }
  const base = parseClaudeBase(id);
  return base ? { ...base, thinking: false, fast: false } : undefined;
}

export function composeCursorClaudeWireId(
  identity: Pick<NormalizedCursorClaudeId, "sourceBaseId" | "spelling">,
  options: { thinking: boolean; fast: boolean; effort?: string; bareThinking?: boolean },
): string {
  const { sourceBaseId: base, spelling } = identity;
  const fast = options.fast ? "-fast" : "";
  if (!options.thinking) return options.effort ? `${base}-${options.effort}${fast}` : `${base}${fast}`;
  if (options.bareThinking || !options.effort) return `${base}-thinking${fast}`;
  return spelling === "version-first" ? `${base}-${options.effort}-thinking${fast}` : `${base}-thinking-${options.effort}${fast}`;
}
```

`sourceBaseId` is required: `claude-fable-5-1` and `claude-fable-5.1` are both "anthropic" spelling
but differ on the wire.

### MODIFY `src/adapters/cursor/catalog.ts`

1. Replace the three Fable 5.1 entries (lines ~123-155) with one `"claude-fable-5-1"` entry
   (displayName "Claude Fable 5.1", CONTEXT_1M, defaultVariant thinking, regular/thinking FULL, order T).
2. At the top of `parseCursorVariantId` (before the exact-identity lookup, line ~383):
```ts
  const claude = normalizeCursorClaudeId(id);
  if (claude && CURSOR_CAPABILITIES[claude.canonicalBaseId]) {
    const explicitVariant = claude.thinking || claude.fast || claude.level !== undefined;
    return {
      baseId: claude.canonicalBaseId,
      kind: explicitVariant
        ? claude.thinking ? (claude.fast ? "thinkingFast" : "thinking") : claude.fast ? "fast" : "regular"
        : defaultKindFor(claude.canonicalBaseId),
      ...(claude.level ? { level: claude.level } : {}),
      ultra: false,
      known: true,
    };
  }
```
   `REAL_1M_WIRE_IDS` (`claude-4-sonnet-1m`) must still be checked first; the normalizer does not
   recognise `-1m`, so ordering: REAL_1M check → normalizer → existing chain.
3. Beside `liveCursorMaxModeBases` (line ~606):
```ts
type CursorLiveClaudeWireIdentity = Pick<NormalizedCursorClaudeId, "sourceBaseId" | "spelling">;
let liveCursorClaudeWireIdentities: ReadonlyMap<string, CursorLiveClaudeWireIdentity> = new Map();

export function recordLiveCursorClaudeModels(liveIds: readonly string[]): void {
  const next = new Map<string, CursorLiveClaudeWireIdentity>();
  for (const rawId of liveIds) {
    const n = normalizeCursorClaudeId(rawId.startsWith("cursor-") ? rawId.slice(7) : rawId);
    if (!n || !CURSOR_CAPABILITIES[n.canonicalBaseId]) continue;
    if (!next.has(n.canonicalBaseId)) next.set(n.canonicalBaseId, { sourceBaseId: n.sourceBaseId, spelling: n.spelling });
  }
  liveCursorClaudeWireIdentities = next; // replaced, never merged: a renamed model must not keep a stale spelling
}
export function liveCursorClaudeWireIdentitiesForTests(): ReadonlyMap<string, CursorLiveClaudeWireIdentity> { return liveCursorClaudeWireIdentities; }
export function resetLiveCursorClaudeWireIdentitiesForTests(): void { liveCursorClaudeWireIdentities = new Map(); }
```
4. `composeWireId(baseId, kind, effort, claudeIdentity?)` (line ~545): when `claudeIdentity` is
   given, return `composeCursorClaudeWireId(claudeIdentity, { thinking, fast, effort, bareThinking: spec.order === "bare" })`;
   the non-Claude body is unchanged.
5. `resolveCursorSelection`: `const claudeIdentity = liveCursorClaudeWireIdentities.get(parsed.baseId) ?? (requestedClaude ? { sourceBaseId, spelling } : undefined)`
   where `requestedClaude = normalizeCursorClaudeId(pickedId)`. Precedence: live roster spelling →
   the spelling the saved config used → capability base.

### MODIFY `src/codex/catalog/provider-fetch.ts` (line ~1424)

`recordLiveCursorClaudeModels(liveResult.models);` immediately inside `if (liveResult.ok)`, before
`filterCursorConfiguredModelsByLiveDiscovery`. Not cleared on failure (stale-cache parity).

### MODIFY `src/adapters/cursor/effort-map.ts`

- Keep only `claude-fable-5-1` and `claude-fable-5-1-thinking`; delete the `5.1`/`5.1-fable` rows
  and their thinking rows (lines ~28-30, ~63-65) and the matching `CURSOR_THINKING_FAMILIES` rows.
- Add `cursorEffortLookupId(modelId)`: normalise via `normalizeCursorClaudeId`, return
  `canonicalBaseId + (thinking ? "-thinking" : "") + (fast ? "-fast" : "")`, else the input. Use it in
  `cursorEffortSuffix`, `cursorModelEffortLadder`, `cursorModelHasEffortTiers`, `cursorWireModelIdWithEffort`.
- `cursorWireModelIdWithEffort` composes Claude ids through `composeCursorClaudeWireId` with the
  input's own spelling, so a version-first saved alias keeps effort-then-thinking order.

### MODIFY `src/adapters/cursor/discovery.ts`

No structural change: once `parseCursorVariantId` canonicalises, the base comparison in
`isCursorModelAvailableForAccount` (line ~86) matches across spellings. `CURSOR_STATIC_MODELS`
now derives one Fable 5.1 row.

### MODIFY `src/usage/expected-prices.ts`

Keep only the `cursor / claude-fable-5-1` overlay row (delete lines 108-109). In
`findExpectedPriceOverlay`, after the exact lookup misses and only when `provider === "cursor"`,
retry with `normalizeCursorClaudeId(modelId)?.canonicalBaseId`.

## Tests

NEW `tests/cursor-claude-id.test.ts`: normalizes the three Fable 5.1 spellings to one base; extracts
thinking/fast/effort from both marker orders; preserves `sourceBaseId` for dotted round-trips; does
not absorb `claude-4-sonnet-1m` or unknown products; composes both orders correctly.

MODIFY `tests/cursor-catalog.test.ts`: all three spellings parse to `baseId: "claude-fable-5-1"`;
legacy aliases stay routable with no live roster; live roster spelling overrides; dotted spelling
preserved exactly; Fable 5.1 contributes one umbrella row.
MODIFY `tests/cursor-effort-suffix.test.ts`: keep the three wire cases (renamed group), add the
shared-ladder case, keep ERROR_BAD_MODEL_NAME order cases.
MODIFY `tests/cursor-discovery.test.ts`: one canonical-row assertion replaces the three-seed loop;
cross-spelling live ids admit the row; sibling Claude versions do not cross-activate.
MODIFY `tests/cursor-umbrella-rows.test.ts`: count comment; aliases are not rows; live spelling map
resets atomically.
MODIFY `tests/usage-cost.test.ts`: three-spelling resolution loop stays; overlay membership has only
`cursor/claude-fable-5-1`; overlay count 61 → 59.

Verifier: `bun test tests/cursor-claude-id.test.ts tests/cursor-catalog.test.ts tests/cursor-effort-suffix.test.ts tests/cursor-discovery.test.ts tests/cursor-umbrella-rows.test.ts tests/usage-cost.test.ts`
then `bun run typecheck` and `bun run test:changed`.

## Risks / open decisions (carried into this cycle's P)

- The module-global spelling map follows the Max-Mode precedent; if one process ever routes two
  Cursor accounts with different rosters it must be keyed by provider. Not the case today
  (one `cursor` provider entry); record as accepted.
- When a roster exposes both spellings, first-seen wins (roster order). Acceptable: both are
  callable by construction.
- Pricing fallback is bounded to `provider === "cursor"` and recognised Claude ids; other providers
  keep exact-only lookup.
