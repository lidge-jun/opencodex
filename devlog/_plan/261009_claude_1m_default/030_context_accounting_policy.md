# 030 wp3: `claudeCode.contextAccounting: "200k"` opt-in

## Why

After wp2 every Claude surface marks long windows as 1M by default. The user asked for 200k to
remain reachable as an explicit opt-in from the CLI and the dashboard. The existing
`autoContext: false` is not that switch: it only stops sub-1M widening, while windows >= 1M stay
marked (`context-windows.ts:133-136`).

## Semantics (decisions D4 of the architect consultation, accepted)

- Stored sparse like `autoContext`: absent = `"1m"` (default); `"200k"` is the only stored value.
  The API accepts `"1m"` (deletes the key) and `"200k"`; anything else is a 400. A hand-edited
  unknown value reads as the default.
- `"200k"` wins over `autoContext` and the compact window: `resolveAutoContext` returns a mode with
  `enabled: false` (so `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is not injected) and `accounting200k: true`
  (so `shouldMarkOneMillion` is false for every window). `maxContextTokens` keeps its own branch
  (it already returns `AUTO_CONTEXT_OFF`); with `"200k"` set it still injects
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` as before.
- A selector the user typed with `[1m]` keeps it (`withOneMillionMarker` returns already-marked
  selectors unchanged, `context-windows.ts:232`); the policy changes defaults, not explicit picks.
- Explicit choices stay available: discovery keeps the `· 1M` variant rows for windows >= 1M, and
  Desktop 3P keeps `supports1m` but drops `prefer1m`, so 1M is one click away.

## Field chain (PLAN-FIELD-CHAIN-01)

| Stage | Path |
|---|---|
| Type | `src/types/config.ts` `OcxClaudeCodeConfig.contextAccounting?: "200k"` next to `autoContext` (`:174`) |
| Creation: API | `src/server/management/agent-settings-routes.ts` PUT `/api/claude-code` body type (`:1460`) + validation block after `autoContext` (`:1724-1729`) |
| Creation: CLI | `src/cli/integrations.ts` `takeOption(args, "--context-accounting")` (`:76-91`), usage text (`:21-22`); `src/cli/capabilities-base.ts:574,578` and `src/cli/capabilities-integrations.ts:142,145` flag + usage; `bun run skill:surface` regenerates the skill map |
| Serialization | config JSON passthrough (`src/config/persist-unlocked.ts:81`, `src/config/schema/config-schema.ts:353` `.passthrough()`); no schema change |
| Read-back | GET `/api/claude-code` DTO (`agent-settings-routes.ts:1422`): `contextAccounting: config.claudeCode?.contextAccounting === "200k" ? "200k" : "1m"` |
| System env reconcile | `agent-settings-routes.ts:1843-1844` add `"contextAccounting"` to `systemEnvInputs` |
| Consumer: launch / system env / discovery | `resolveAutoContext` (`context-windows.ts:92`) is the single entry; `effectiveModelEnv`, `src/cli/claude.ts:407-418`, `src/server/system-env.ts:192,312-323`, `src/server/system-env-shell.ts:110-126`, `serve-options.ts:1053` all call it |
| Consumer: discovery variants | `model-info.ts` variant mode = `auto.accounting200k ? AUTO_CONTEXT_OFF : auto` (>= 1M rows stay selectable) |
| Consumer: pickers | `PickerRouteInput.auto?: AutoContextMode` (`picker-models.ts:15-20`), filled by `loadPickerRoutesFromCatalog` (`src/server/index/claude-intercept-lifecycle.ts:51-57`) with `resolveAutoContext(config.claudeCode)`; `pickerSelector` uses `input.auto?.accounting200k ? ACCOUNTING_200K : UNPAIRED_AUTO_CONTEXT` |
| Consumer: Desktop 3P | `generateDesktop3pModels(..., options?: { preferOneMillion?: boolean })` and `generateDesktop3pConfig(..., options?)` (`desktop-3p.ts:320`, `:377`, call `:401`); `prefer1m` emitted only when `preferOneMillion !== false`, in both the profile branch (`:221`) and the non-profile branch (`:266`, `:296`). The writer derives it from its freshly re-read config: `writeDesktop3pConfig` (`:656`) passes `{ preferOneMillion: latest.config.claudeCode?.contextAccounting !== "200k" }` at `:703`, so the apply (`native-integration-routes.ts:822-834`), CLI (`src/cli/claude-desktop.ts:537`) and sync (`config-routes.ts:804-822`) callers need no change. The remote export endpoint `serve-options.ts:1024-1027` passes the same option from its `config`. `writeRemoteDesktop3pConfig` writes the hub's entries verbatim (hub already applied its policy) |
| Consumer: subagents | `withSubagentContextMarker(selector, windows, mode = UNPAIRED_AUTO_CONTEXT)`; roster defs `src/claude/agents-inject.ts:100` and self def `:133` pass `subagentMarkingMode(config)`; `resolveSubagentForceModel` (`subagent-model.ts:81`) passes the same helper. `subagentMarkingMode(config) = resolveAutoContext(config.claudeCode).accounting200k ? ACCOUNTING_200K : UNPAIRED_AUTO_CONTEXT` lives in `subagent-model.ts` |
| Refresh | Picker snapshots rebuild on their staleness timer; Desktop 3P config is rewritten by the existing apply/sync paths (same as `autoContext` today). The PUT response adds no new side effect beyond the system-env reconcile; documented in the docs-site page |

## Diff

### MODIFY `src/claude/context-windows.ts`

```ts
export interface AutoContextMode {
  enabled: boolean;
  compactWindow: number;
  /** contextAccounting "200k": nothing is marked [1m] automatically, whatever its window. */
  accounting200k?: true;
}

/** The "200k" opt-in mode: no widening, no compact-window injection, no automatic marker. */
export const ACCOUNTING_200K: AutoContextMode = { enabled: false, compactWindow: AUTO_COMPACT_WINDOW_DEFAULT, accounting200k: true };

interface AutoContextConfigSlice { autoContext?: boolean; autoCompactWindow?: number; maxContextTokens?: number; contextAccounting?: string }

export function resolveAutoContext(claudeCode, envOverride?) {
  if (claudeCode?.contextAccounting === "200k") return ACCOUNTING_200K;
  ...unchanged
}

export function shouldMarkOneMillion(window, auto) {
  if (typeof window !== "number" || window <= 0) return false;
  if (auto.accounting200k) return false;
  ...unchanged
}
```

`effectiveModelEnv`'s `claudeCode` parameter type gains `contextAccounting?: string`.

### MODIFY `src/claude/subagent-model.ts` `withSubagentContextMarker` (architect reflection 2)

Explicit markers keep their existing safety rule; the mode only controls automatic marking:

```ts
export function withSubagentContextMarker(selector: string, windows: Record<string, number>, mode: AutoContextMode = UNPAIRED_AUTO_CONTEXT): string {
  const bare = stripOneMillionMarker(selector);
  const wasMarked = selector !== bare;
  const canonicalExact = wasMarked ? `${bare}[1m]` : selector;
  const authoritativeWindow = windows[selector] ?? windows[canonicalExact] ?? windows[bare];
  if (typeof authoritativeWindow === "number" && authoritativeWindow > 0) {
    // An explicit [1m] survives when the window can carry it, whatever the policy; an unsafe
    // inherited one is stripped. Only an unmarked selector depends on the mode.
    const marks = wasMarked
      ? shouldMarkOneMillion(authoritativeWindow, UNPAIRED_AUTO_CONTEXT)
      : shouldMarkOneMillion(authoritativeWindow, mode);
    return marks ? (withOneMillionMarker(selector, windows, UNPAIRED_AUTO_CONTEXT) ?? selector) : bare;
  }
  return wasMarked ? selector : bare;
}
```

Tests (in the new 030 test file): under `ACCOUNTING_200K` an unmarked 872k roster entry stays bare;
a picker-pinned self model `...[1m]` with an 872k window keeps its marker; a `[1m]` selector whose
window is 262,144 is stripped under both modes; force resolution of `kimi/k3[1m]` is unchanged.

### Other files

As listed in the chain table. GUI is wp4.

### docs-site

`docs-site/src/content/docs/**/claude-code*.md(x)` (exact path resolved at wp3 P): document
`ocx claude config set --context-accounting <1m|200k>` and the default. English source; other
locales get the same flag line without contradicting text.

## Tests

NEW `tests/claude-integration/claude-context-accounting.test.ts` (registered in layout files):

1. `resolveAutoContext({ contextAccounting: "200k" })` is `ACCOUNTING_200K`; `{ contextAccounting: "1m" }` and `{ contextAccounting: "bogus" }` resolve as default.
2. `effectiveModelEnv({ model: "native/gpt-6-astra", contextAccounting: "200k" }, { ...872k map })` has no `[1m]`; without the field it does; a typed `...[1m]` selector keeps its marker under 200k.
3. `buildPickerModels({ ..., auto: ACCOUNTING_200K })` leaves 872k and 1M rows unmarked.
4. `generateDesktop3pModels(["gpt-6-astra"], [], undefined, caps, { preferOneMillion: false })` has `supports1m` without `prefer1m`.
5. Discovery under `ACCOUNTING_200K`: 1M routed row keeps its `· 1M` variant; 872k native has none.
6. Management: PUT `{ contextAccounting: "200k" }` stores it, `"1m"` deletes it, `"x"` -> 400; GET reports `"200k"` / `"1m"` (reuse the existing claude-code route harness file named at P).
7. CLI: `ocx claude config set --context-accounting 200k` sends `{ contextAccounting: "200k" }` (existing integrations CLI test harness named at P).

## Verification

- `bun run typecheck`
- focused files above + `tests/ci-workflows/skill-ocx.test.ts` (capability map) + `bun run skill:surface:check`
- `bun run structure:check`

## P amendment (wp3 entry, after wp2 review)

wp2 changed two interfaces this doc relied on; the policy threads through them instead:

- `withSubagentContextMarker(selector, windows, accounting200k = false)`: the marking mode is now
  per selector (`subagentSelectorMode`: genuine 1M for Claude models, unpaired otherwise). Under
  `200k` an unmarked selector stays bare; an explicit `[1m]` keeps following its selector mode
  (kept when the window can carry it, stripped otherwise). `agents-inject.ts:100,133` and
  `resolveSubagentForceModel` pass `resolveAutoContext(config.claudeCode).accounting200k === true`;
  the `subagentMarkingMode` helper is not needed.
- Desktop eligibility is `claudeSurfaceSupportsOneMillion(provider, modelId, window)` /
  `routeSupportsOneMillion(route, window)`; the policy only drops `prefer1m`, so those predicates
  are unchanged.
- Discovery needs no change: `variantMode = auto.enabled ? UNPAIRED : OFF` already keeps the
  >= 1M variants under `ACCOUNTING_200K` (enabled false).

Audit of the amendment (PASS) notes: the earlier `withSubagentContextMarker(..., mode = UNPAIRED_AUTO_CONTEXT)`
snippet and the `subagentMarkingMode` chain row above are **superseded** by this amendment; the
picker keeps its Claude-model guard and takes `ACCOUNTING_200K` first; `shouldMarkOneMillion`
checks `accounting200k` before its >= 1M early return. wp3 B also carries the docs-site sync the
layer 1 and layer 2 branches still owe (cascaded onto those branches).
