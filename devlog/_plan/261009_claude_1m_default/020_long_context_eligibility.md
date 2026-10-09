# 020 wp2: long windows are 1M on every Claude surface

## Why

Claude Code (2.1.288) accounts an unmarked gateway id at 200k: knowledge windows above 200k are
clamped unless the model is natively 1M, and the discovery `max_input_tokens` is not part of the
window computation. The only per-model lever a proxy has is the `[1m]` selector (Desktop 3P:
`supports1m` / `prefer1m`). Today it is granted by two different rules:

| Surface | Rule today | Owner |
|---|---|---|
| `ocx claude` launch env, tier slots | window >= 1M, or > 200k and >= compact window (829,800) | `src/claude/context-windows.ts:133-136`, `:230-274` |
| Desktop Code-tab picker, CLI `cc` picker | window >= 1M only | `src/claude/intercept/picker-models.ts:51-54` |
| Anthropic discovery `· 1M` variant | window >= 1M only (`auto` passed, unused) | `src/claude/model-info.ts:150-176` |
| Desktop 3P `supports1m` / `prefer1m` | window >= 1M only | `src/claude/desktop-3p.ts:254`, `src/claude/desktop-profile.ts:362`, `src/server/management/shared.ts:417` |
| Generated subagent defs | window >= 1M only | `src/claude/subagent-model.ts:23-33`, `:79` |

The narrow rule exists because those runners may not inherit `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, so
a marked 872k model could outgrow its real window before proactive compaction (the #854 defect
was a 372k route marked while the compact window was 350k). wp1 removes the failure mode: an
overflow now arrives as `prompt is too long` and Claude Code compacts reactively. The compaction
floor still applies, so only windows >= 829,800 widen; 262k / 256k / 400k windows stay at 200k.

## Decisions

- One predicate for the unpaired surfaces, in a leaf module so `desktop-3p.ts` and
  `desktop-profile.ts` can use it without importing `context-windows.ts` (which imports
  `desktop-3p.ts`).
- Real Anthropic routes keep the >= 1M rule everywhere (they ride the native passthrough; the
  existing "Anthropic passthrough guard" in `context-windows.ts:196-205` and `model-info.ts:250` stays).
- Discovery uses the fixed unpaired rule, not the configurable launch compact window: a custom
  `autoCompactWindow: 350000` must not re-admit a 372k variant (#854). The server's `auto` only
  switches the rule off: `autoContext: false` (and wp3's `200k`) fall back to >= 1M.
- Scope note (architect D3): discovery stays a choice list. Its base and `· Fast` rows remain
  unmarked (200k-accounted) by design; the `· 1M` row is the long-context choice there. The
  surfaces that pick a default (Desktop picker, `cc` picker, launch env slots, Desktop 3P
  `prefer1m`, generated subagents) are the ones made 1M by default.

## Diff

### NEW `src/claude/long-context.ts`

```ts
/**
 * Long-context thresholds shared by every Claude surface (devlog/_plan/261009_claude_1m_default/020).
 * A leaf module: desktop-3p.ts and desktop-profile.ts need the predicate, and context-windows.ts
 * already imports desktop-3p.ts.
 */
import { isAnthropicInstanceId } from "../providers/anthropic-instance-id";

export const ONE_MILLION = 1_000_000;

/** A window at or below this is Claude Code's own default accounting; widening it gains nothing. */
export const AUTO_CONTEXT_FLOOR = 200_000;

/** (comment moved verbatim from context-windows.ts:30-41) */
export const AUTO_COMPACT_WINDOW_DEFAULT = 829_800;

/**
 * Whether a window earns the 1M selection on a surface whose Claude Code runner may not inherit
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW (Desktop pickers, discovery, Desktop 3P, generated subagents).
 * A window >= 1M always does. A smaller one does when it can host the default compact window, so
 * a runner that has the variable compacts in time, and one that lacks it overflows into the
 * `prompt is too long` envelope (wp1) and compacts reactively.
 */
export function isLongContextWindow(window: number | undefined): boolean {
  if (typeof window !== "number" || window <= 0) return false;
  return window >= ONE_MILLION || (window > AUTO_CONTEXT_FLOOR && window >= AUTO_COMPACT_WINDOW_DEFAULT);
}

/** Desktop 3P / dashboard eligibility. Real Anthropic routes (either pool) need a genuine 1M window. */
export function claudeSurfaceSupportsOneMillion(provider: string, window: number | undefined): boolean {
  if (isAnthropicInstanceId(provider)) return typeof window === "number" && window >= ONE_MILLION;
  return isLongContextWindow(window);
}
```

### MODIFY `src/claude/context-windows.ts`

- Replace `const ONE_MILLION = 1_000_000;` (`:19`) and the two constant definitions (`:42-43`) with
  `import { AUTO_COMPACT_WINDOW_DEFAULT, AUTO_CONTEXT_FLOOR, ONE_MILLION } from "./long-context";`
  plus `export { AUTO_COMPACT_WINDOW_DEFAULT, AUTO_CONTEXT_FLOOR } from "./long-context";` (public
  names unchanged for every importer).
- Add after `AUTO_CONTEXT_OFF` (`:66`):

```ts
/**
 * Marking mode for surfaces whose runner may not inherit the compaction env (Desktop pickers,
 * discovery, generated subagents). Equals isLongContextWindow; kept as a mode so the existing
 * withOneMillionMarker / shouldMarkOneMillion helpers serve every surface.
 */
export const UNPAIRED_AUTO_CONTEXT: AutoContextMode = { enabled: true, compactWindow: AUTO_COMPACT_WINDOW_DEFAULT };
```

### MODIFY `src/claude/intercept/picker-models.ts`

- Import `UNPAIRED_AUTO_CONTEXT` instead of `AUTO_CONTEXT_OFF`.
- `:51-54` before:

```ts
/** Desktop runners do not inherit the proxy's compaction env: mark only real >=1M windows. */
function pickerSelector(alias: string, contextWindow: number | undefined): string {
  return withOneMillionMarker(alias, contextWindow === undefined ? {} : { [alias]: contextWindow }, AUTO_CONTEXT_OFF)!;
}
```

after:

```ts
/**
 * Desktop runners do not inherit the proxy's compaction env, so a long window (>= the default
 * compact window) is marked on the strength of the `prompt is too long` recovery instead (020).
 */
function pickerSelector(alias: string, contextWindow: number | undefined): string {
  return withOneMillionMarker(alias, contextWindow === undefined ? {} : { [alias]: contextWindow }, UNPAIRED_AUTO_CONTEXT)!;
}
```

`buildPickerModels` skips `anthropic/claude-*` already (`:61`); `buildCliPickerModels` the same (`:79`).

Both picker builders pass the row's provider: `pickerSelector(alias, contextWindow, provider)` uses
`isAnthropicInstanceId(provider) ? AUTO_CONTEXT_OFF : UNPAIRED_AUTO_CONTEXT`, so a sub-1M
`anthropic2` row (Pool 2 is not skipped by the `anthropic/claude-*` filter at `:60`, `:80`) is never
widened (audit blocker 4).

### MODIFY `src/claude/context-windows.ts:187,199` (Pool 2 guard, audit blocker 4)

`m.provider === "anthropic"` -> `isAnthropicInstanceId(m.provider)` in both the passthrough `capped`
set and the `registrable` filter, so the launch window map treats Pool 2 rows like Pool 1.

### MODIFY `src/claude/model-info.ts`

- Import `shouldMarkOneMillion` with `AUTO_CONTEXT_OFF`.
- `push1mVariant` gains a mode parameter and replaces the >= 1M gate:

```ts
  const push1mVariant = (
    base: AnthropicModelInfo,
    contextWindow: number | undefined,
    maxInputTokens?: number,
    selectorId?: string,
    mode: AutoContextMode = variantMode,
  ) => {
    // The [1m] marker makes Claude Code account 1e6 tokens for the row. A window >= 1M always
    // earns it; a long window earns it under the server's auto-context mode, because the
    // compaction floor sits under it and an overflow is answered as `prompt is too long`,
    // which Claude Code compacts on (020). A 372k route under a 350k compact window was the
    // #854 defect; the floor keeps such windows out.
    if (!shouldMarkOneMillion(contextWindow, mode)) return;
    if (base.id.includes("[1m]")) return;
    ...
    // A long window under 1M must not be advertised as 1e6 input (architect D3).
    const ceiling = typeof maxInputTokens === "number" && maxInputTokens > 0 ? maxInputTokens : contextWindow;
    const advertised = typeof ceiling === "number" && ceiling > 0 ? Math.min(ONE_MILLION, ceiling) : ONE_MILLION;
```

  with, before the loops: `const variantMode = auto.enabled ? UNPAIRED_AUTO_CONTEXT : AUTO_CONTEXT_OFF;`
  (`auto` disabled by `autoContext: false`, `maxContextTokens`, or wp3's `200k`).
- Routed call `:251` passes `isAnthropicInstanceId(m.provider) ? AUTO_CONTEXT_OFF : variantMode` as the mode (`anthropic2` is the same Anthropic implementation, `src/providers/anthropic-instance-id.ts`, a no-import leaf).
- Comment block `:150-155` replaced by the one above.

### MODIFY Desktop 3P eligibility (three owners, one predicate)

- `src/claude/desktop-3p.ts:254`: `const supports1m = claudeSurfaceSupportsOneMillion(provider, contextWindow) ? { supports1m: true as const } : {};` (import from `./long-context`). `DESKTOP_SUPPORTS_1M_THRESHOLD` stays exported (= `ONE_MILLION`) for the Anthropic rule and its existing test.
- `src/claude/desktop-profile.ts:362`: `supports1m: claudeSurfaceSupportsOneMillion(route.slice(0, route.indexOf("/")), model.contextWindow),`.
- `src/server/management/shared.ts:417`: `supports1m: claudeSurfaceSupportsOneMillion(route.slice(0, route.indexOf("/")), modelByRoute.get(route)?.contextWindow),`; comment keeps "SAME predicate".

### MODIFY `src/claude/subagent-model.ts`

- `:30`: `shouldMarkOneMillion(authoritativeWindow, UNPAIRED_AUTO_CONTEXT) ? (withOneMillionMarker(selector, windows, UNPAIRED_AUTO_CONTEXT) ?? selector) : bare`.
- `:79`: the requested-marker admission uses `isLongContextWindow(window)` instead of `window >= 1_000_000`.
- Doc comment `:16-22` updated: generated defs follow the unpaired long-context rule.

### Tests

Updated (intentional behavior change, comments rewritten):

- `tests/claude-integration/claude-picker-models.test.ts:84-91`: 872k / 922k natives now end in `[1m]`; gpt-5.5 (272k) stays unmarked. Title becomes "picker marks long native windows on the prompt-too-long recovery".
- `tests/claude-integration/claude-model-info.test.ts:124-129`: with the default `auto` argument (`AUTO_CONTEXT_OFF`) no native variants still holds; add a sibling case in the new file for the server mode.
- `tests/claude-integration/claude-picker-models.test.ts:93-102`: the 999,999 row now ends in `[1m]`; add 829,799 (bare) and 829,800 (`[1m]`) rows for the floor.
- `tests/claude-integration/claude-subagent-model-force.test.ts:46`: the 999,999 boundary becomes 829,799 (bare) plus 829,800 (`[1m]`); 1,000,000 unchanged.
- `tests/clients/desktop-3p.test.ts:214-231`: `optedIn` (1M cap -> Sol 922,000) now carries `supports1m` / `prefer1m`; `uncapped` and `capped` (272,000) unchanged.

NEW `tests/claude-integration/claude-long-context-eligibility.test.ts` (registered in `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`):

1. `isLongContextWindow`: 200,000 / 262,144 / 829,799 false; 829,800 / 872,000 / 1,000,000 true; undefined / 0 false.
2. `claudeSurfaceSupportsOneMillion("anthropic", 872_000)` false, `("native", 872_000)` true.
3. Discovery: a routed 400,000 row under `{ enabled: true, compactWindow: 350_000 }` gets no variant (fixed floor); a routed 900,000 row without `maxInputTokens` gets a variant advertising 900,000. `buildAnthropicModelInfos(["gpt-6-astra"], [], UNPAIRED_AUTO_CONTEXT, "readable", undefined, { modelWindows: { "gpt-6-astra": 872_000 } })` has a `[1m]` variant with `max_input_tokens` 872,000 and display `· 1M`; with `AUTO_CONTEXT_OFF` none; a routed `anthropic` row at 872,000 gets none under either mode; a routed 262,144 row gets none.
4. Desktop 3P: `generateDesktop3pModels(["gpt-6-astra"], [], undefined, { modelWindows: { "gpt-6-astra": 872_000 } })` emits `supports1m` + `prefer1m`; `[{ provider: "kimi", id: "k3", contextWindow: 262_144 }]` emits neither.
5. Pool 2: `buildPickerModels` with `{ provider: "anthropic2", id: "x", contextWindow: 872_000 }` stays bare; `buildClaudeContextWindows([], [{ provider: "anthropic2", id: "x", contextWindow: 872_000 }])` has no entry for it.
6. Subagent: `withSubagentContextMarker("ocx-claude-native--gpt-6-astra", { "ocx-claude-native--gpt-6-astra": 872_000 })` ends in `[1m]`; at 262,144 stays bare.

## Verification

- `bun run typecheck`
- `bun test tests/claude-integration/claude-long-context-eligibility.test.ts tests/claude-integration/claude-picker-models.test.ts tests/claude-integration/claude-model-info.test.ts tests/clients/desktop-3p.test.ts tests/clients/desktop-profile.test.ts tests/claude-integration/claude-desktop-1m.test.ts tests/claude-integration/claude-subagent-model-force.test.ts tests/claude-integration/claude-cli-picker.test.ts`
- `bun run structure:check`
- Full suite: exact-head CI.

## Risks

- A runner without the compaction env compacts reactively once per overflow instead of
  proactively. That costs one refused request per long session, against today's state where the
  model is unusable past 200k.
- `prefer1m` now defaults Desktop 3P long-window models to the 1M variant. wp3's `200k` policy
  drops `prefer1m` for users who want the old default.
