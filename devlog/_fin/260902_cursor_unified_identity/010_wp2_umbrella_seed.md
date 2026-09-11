# WP2 / PR1 — the seed derives from the capability table

Scope IN: `src/adapters/cursor/{catalog,discovery}.ts`, `src/providers/{registry,derive}.ts`,
`src/types/provider.ts` (registry entry type only), tests.
Scope OUT: fast wire, `fastMode`, any request-path change.

Accept criteria: the Cursor row set equals capability bases + declared product bases;
every removed id still routes byte-identically; the Codex picker shows human labels;
seed and capability windows agree.

## Change map

| File | Action |
|---|---|
| `src/adapters/cursor/catalog.ts` | MODIFY — `CursorCapability.displayName`; window fixes; `cursorUmbrellaRows()` returns the label |
| `src/adapters/cursor/discovery.ts` | MODIFY — `CURSOR_PRODUCT_MODELS` (non-capability ids) + `CURSOR_STATIC_MODELS` derived; `cursorModelDisplayNames()` |
| `src/providers/registry.ts` | MODIFY — `modelDisplayNames` on the entry type + `ProviderConfigSeed`; cursor entry passes `cursorModelDisplayNames()` |
| `src/providers/derive.ts` | MODIFY — copy `entry.modelDisplayNames` into the seeded config |
| `tests/cursor-umbrella-rows.test.ts` | MODIFY — row-count and composition assertions |
| `tests/cursor-display-names.test.ts` | NEW — labels reach a built catalog row |

## 1. `catalog.ts` — labels and window truth

`CursorCapability` gains one field; every entry gains its label. Windows corrected to the
seed's measured values (`gemini-*` 1048576, `gpt-5.5-extra` 200000 — the seed carries the
observed numbers, the capability table was approximating).

```diff
 export interface CursorCapability {
   readonly variants: Partial<Record<CursorVariantKind, CursorVariantSpec>>;
   readonly defaultVariant: CursorVariantKind;
+  /** Human picker label ("Claude Opus 5"). Cursor's own picker shows these. */
+  readonly displayName: string;
   readonly window: number;
```

```diff
 const CONTEXT_1M = 1_000 * K;
+const CONTEXT_GEMINI = 1_048_576;
```

```diff
   "claude-4.5-opus": {
+    displayName: "Claude Opus 4.5",
     window: CONTEXT_200K,
```

Labels, in table order (Cursor's own spellings, read from its picker on 2026-09-02):

```
claude-4.5-opus      Claude Opus 4.5      claude-4.6-opus     Claude Opus 4.6
claude-4.6-sonnet    Claude Sonnet 4.6    claude-4.5-sonnet   Claude Sonnet 4.5
claude-4-sonnet      Claude Sonnet 4      claude-fable-5      Claude Fable 5
claude-fable-5-1     Claude Fable 5.1     claude-fable-5.1    Claude Fable 5.1
claude-5.1-fable     Claude Fable 5.1     claude-sonnet-5     Claude Sonnet 5
claude-opus-4-7      Claude Opus 4.7      claude-opus-4-8     Claude Opus 4.8
claude-opus-5        Claude Opus 5        glm-5.2             GLM 5.2
glm-5.3              GLM 5.3              gemini-3.6-flash    Gemini 3.6 Flash
gemini-3.7-flash     Gemini 3.7 Flash     kimi-k3             Kimi K3
grok-4.5             Cursor Grok 4.5      grok-4.6            Cursor Grok 4.6
gpt-5.1              GPT-5.1              gpt-5.1-codex-max   GPT-5.1 Codex Max
gpt-5.1-codex-mini   GPT-5.1 Codex Mini   gpt-5.2             GPT-5.2
gpt-5.2-codex        GPT-5.2 Codex        gpt-5.3-codex       Codex 5.3
gpt-5.4              GPT-5.4              gpt-5.4-mini        GPT-5.4 Mini
gpt-5.4-nano         GPT-5.4 Nano         gpt-5.5             GPT-5.5
gpt-5.5-extra        GPT-5.5 Extra        gpt-5.6-sol         GPT-5.6 Sol
gpt-5.6-terra        GPT-5.6 Terra        gpt-5.6-luna        GPT-5.6 Luna
```

Grok keeps Cursor's own "Cursor Grok" spelling because that is what its picker shows and
because the wire id carries the `cursor-` prefix.

```diff
 export interface CursorUmbrellaRow {
   readonly id: string;
+  readonly displayName: string;
   readonly efforts: readonly string[];
```

```diff
     rows.push({
       id: baseId,
+      displayName: capability.displayName,
       efforts: spec.levels,
```

## 2. `discovery.ts` — the seed becomes derived

`CURSOR_STATIC_MODELS` stops being a hand-maintained list of 54 and becomes
routers + umbrella rows + declared product ids.

```diff
-export const CURSOR_STATIC_MODELS: readonly CursorModelInfo[] = normalizeCursorModels([
-  ...CURSOR_ROUTER_MODEL_IDS.map(id => ({ id, contextWindow: CONTEXT_200K, supportsReasoningEffort: false })),
-  { id: "claude-sonnet-5", contextWindow: CONTEXT_1M, supportsReasoningEffort: true },
-  ... 50 more hand-written rows ...
-]);
+/**
+ * Cursor products that are NOT a dimension of any capability base. Each carries its own
+ * label because there is no capability record to read one from. A row belongs here only
+ * when Cursor ships it as a distinct product; a variant of a cataloged base does not.
+ */
+export const CURSOR_PRODUCT_MODELS: readonly (CursorModelInfo & { displayName: string })[] = [
+  { id: "claude-4.5-haiku", displayName: "Claude Haiku 4.5", contextWindow: CONTEXT_200K },
+  { id: "composer-1", displayName: "Composer 1", contextWindow: CONTEXT_200K },
+  { id: "composer-2.5", displayName: "Composer 2.5", contextWindow: CONTEXT_200K },
+  { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", contextWindow: CONTEXT_GEMINI },
+  { id: "gemini-3-flash", displayName: "Gemini 3 Flash", contextWindow: CONTEXT_GEMINI },
+  { id: "gemini-3-pro", displayName: "Gemini 3 Pro", contextWindow: CONTEXT_GEMINI },
+  { id: "gemini-3-pro-image-preview", displayName: "Gemini 3 Pro Image", contextWindow: CONTEXT_200K },
+  { id: "gemini-3.1-pro", displayName: "Gemini 3.1 Pro", contextWindow: CONTEXT_GEMINI },
+  { id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash", contextWindow: CONTEXT_200K },
+  { id: "gpt-5-codex", displayName: "GPT-5 Codex", contextWindow: CONTEXT_272K },
+  { id: "gpt-5-mini", displayName: "GPT-5 Mini", contextWindow: CONTEXT_272K },
+  { id: "gpt-5.1-codex", displayName: "GPT-5.1 Codex", contextWindow: CONTEXT_272K },
+  { id: "kimi-k2.7-code", displayName: "Kimi K2.7 Code", contextWindow: CONTEXT_262K },
+];
+
+/**
+ * Real upstream wire ids that LOOK like a dimension of a cataloged base but are served as
+ * their own catalog row by Cursor. They stay rows; the parser already refuses to read them
+ * as synthetic markers (REAL_1M_WIRE_IDS / no capability base for gpt-5).
+ *
+ * claude-4-sonnet-1m: a distinct 1M-window row upstream, not claude-4-sonnet + ultra.
+ *   claude-4-sonnet has no maxMode evidence, so folding it would invent a capability.
+ * gpt-5-fast: there is no `gpt-5` capability base for it to be a dimension of.
+ * composer-2.5-fast: composer-2.5 has no effort/variant dimensions at all.
+ */
+export const CURSOR_REAL_ID_EXCEPTIONS: readonly (CursorModelInfo & { displayName: string })[] = [
+  { id: "claude-4-sonnet-1m", displayName: "Claude Sonnet 4 (1M)", contextWindow: CONTEXT_1M },
+  { id: "gpt-5-fast", displayName: "GPT-5 Fast", contextWindow: CONTEXT_272K },
+  { id: "composer-2.5-fast", displayName: "Composer 2.5 Fast", contextWindow: CONTEXT_200K },
+];
+
+/**
+ * Umbrella seed (devlog 260902_cursor_unified_identity): rows are DERIVED from
+ * CURSOR_CAPABILITIES via cursorUmbrellaRows(), so a capability change can no longer
+ * disagree with what the picker publishes. Thinking / fast / synthetic -1m remain
+ * routable aliases and add no rows.
+ */
+export const CURSOR_STATIC_MODELS: readonly CursorModelInfo[] = normalizeCursorModels([
+  ...CURSOR_ROUTER_MODEL_IDS.map(id => ({ id, contextWindow: CONTEXT_200K, supportsReasoningEffort: false })),
+  ...cursorUmbrellaRows().map(row => ({
+    id: row.id,
+    contextWindow: row.window,
+    supportsReasoningEffort: row.efforts.length > 0,
+  })),
+  ...CURSOR_PRODUCT_MODELS,
+  ...CURSOR_REAL_ID_EXCEPTIONS,
+]);
```

Import `cursorUmbrellaRows` alongside the existing `parseCursorVariantId` import
(`discovery.ts:8`). `catalog.ts` does not import `discovery.ts`, so no cycle appears.

New label accessor, mirroring `cursorModelContextWindows`:

```diff
+export function cursorModelDisplayNames(): Record<string, string> {
+  return Object.fromEntries([
+    ...cursorUmbrellaRows().map(row => [row.id, row.displayName] as const),
+    ...CURSOR_PRODUCT_MODELS.map(m => [m.id, m.displayName] as const),
+    ...CURSOR_REAL_ID_EXCEPTIONS.map(m => [m.id, m.displayName] as const),
+    ...CURSOR_ROUTER_MODEL_IDS.map(id => [id, cursorRouterDisplayName(id)] as const),
+  ]);
+}
```

Router labels: `auto` -> "Auto", `auto-balance` -> "Auto (Balanced)", `auto-cost` ->
"Auto (Cost)", `auto-intelligence` -> "Auto (Intelligence)".

Row-count arithmetic after the change: 4 routers + 34 umbrella + 13 product + 3 exceptions
= **54**. Measured against the current seed (`.tmp/probe2.ts`, 2026-09-02):

```
ROUTERS 4  CAPS 34  PRODUCT 13  EXC 3  TOTAL 54
DUPES []            # no id appears twice, so normalizeCursorModels drops nothing silently
DROPPED_VS_TODAY [] # every id the picker publishes today survives
ADDED_VS_TODAY []   # no new id appears
```

The published set is **identical**, so wp2 is a pure refactor of where rows come from: the
list stops being hand-maintained and starts deriving from the capability table. Behavior
changes in exactly two places — every row gains a label, and three windows are corrected.
That makes the existing alias/oracle tests a real regression bar rather than a formality.

## 3. `registry.ts` / `derive.ts` — the missing display-name path

```diff
   modelContextWindows?: Record<string, number>;
+  /** Registry-supplied picker labels; an operator's config value still wins. */
+  modelDisplayNames?: Record<string, string>;
   modelInputModalities?: Record<string, string[]>;
```

```diff
   "adapter" | "baseUrl" | ... | "models"
-  | "liveModels" | "contextWindow" | "modelContextWindows" | "modelInputModalities"
+  | "liveModels" | "contextWindow" | "modelContextWindows" | "modelDisplayNames" | "modelInputModalities"
```

```diff
     ...(entry.modelContextWindows ? { modelContextWindows: { ...entry.modelContextWindows } } : {}),
+    ...(entry.modelDisplayNames ? { modelDisplayNames: { ...entry.modelDisplayNames } } : {}),
```

Cursor entry:

```diff
     modelContextWindows: cursorModelContextWindows(CURSOR_STATIC_MODELS),
+    modelDisplayNames: cursorModelDisplayNames(),
```

The consumer needs no change: `applyProviderConfigHints` already calls
`configuredModelDisplayName(prov, model.id)` and sets `displayName` on the CatalogModel,
which `sync.ts` prefers over `routedDisplayName`. Operator overrides keep winning because
`derive.ts` only fills when the config value is absent.

## 4. Tests

`tests/cursor-umbrella-rows.test.ts` — replace the frozen composition assertions:

```diff
-    expect(CURSOR_STATIC_MODELS.length).toBe(51);
+    // 4 routers + 34 umbrella bases + 13 product ids + 3 real-id exceptions.
+    expect(CURSOR_STATIC_MODELS.length).toBe(54);
+  });
+
+  test("every umbrella row is seeded and no capability base is missing", () => {
+    const ids = new Set(CURSOR_STATIC_MODELS.map(m => m.id));
+    for (const row of cursorUmbrellaRows()) expect(ids.has(row.id)).toBe(true);
+  });
+
+  test("seed windows equal the capability windows they derive from", () => {
+    const seeded = new Map(CURSOR_STATIC_MODELS.map(m => [m.id, m.contextWindow]));
+    for (const row of cursorUmbrellaRows()) expect(seeded.get(row.id)).toBe(row.window);
   });
```

Existing `composer-2.5-fast` and pinned-session alias assertions stay green unchanged —
that is the regression bar for "every legacy id stays routable".

`tests/cursor-display-names.test.ts` (NEW) — the label must survive the config path, not
merely exist in a table:

```ts
test("cursor rows publish human labels through the seeded provider config", () => {
  const config = seedProviderConfig("cursor");           // providers/derive.ts
  expect(config.modelDisplayNames?.["kimi-k3"]).toBe("Kimi K3");
  expect(configuredModelDisplayName(config, "grok-4.6")).toBe("Cursor Grok 4.6");
  expect(configuredModelDisplayName(config, "claude-opus-5")).toBe("Claude Opus 5");
});

test("an operator override still wins over the registry label", () => {
  const config = seedProviderConfig("cursor");
  config.modelDisplayNames = { ...config.modelDisplayNames, "kimi-k3": "My K3" };
  expect(configuredModelDisplayName(config, "kimi-k3")).toBe("My K3");
});
```

## Risks

A derived seed inherits capability mistakes: a base added to `CURSOR_CAPABILITIES` now
appears in the picker automatically. That is the intent, and live `GetUsableModels`
filtering still removes anything the account cannot call.

`normalizeCursorModels` dedupes by id and sorts, so a product id colliding with a
capability base would silently drop one. No collision exists today
(`SEED_NOT_IN_CAPS` ∩ `CAPS` = ∅); the new row-composition test would catch a future one.
