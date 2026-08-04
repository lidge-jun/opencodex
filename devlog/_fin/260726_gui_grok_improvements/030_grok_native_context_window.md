# 030 — WP3: native models reach Grok with no context window, so Sol shows 200k

## Cause

`src/grok/sync.ts:37-43` builds the injected model list:

```ts
models = [
  ...visibleNativeSlugs(config).map(id => ({ id })),          // <- no contextWindow
  ...routed.map(m => ({
    id: m.alias ?? `${m.provider}/${m.id}`,
    ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
  })),
];
```

Routed models carry their context window; native ones are mapped to a bare
`{ id }`. `src/grok/inject.ts:161-162` only writes the TOML line when the field is
present:

```ts
if (Number.isFinite(model.contextWindow) && (model.contextWindow ?? 0) > 0) {
  lines.push(`context_window = ${model.contextWindow}`);
}
```

So `gpt-5.6-sol` is registered with no `context_window`, and Grok falls back to
its own default — the 200k the user sees. The value is not unknown to us:
`src/codex/catalog/metadata.ts:57` defines
`NATIVE_GPT56_CONTEXT_WINDOW = 372_000`, and
`nativeOpenAiContextWindow(slug)` (`metadata.ts:69`) is the existing accessor,
already used by `nativeModelRows` at `metadata.ts:126-129`.

This is a real correctness bug, not cosmetics: a client that believes the window
is 200k will truncate or refuse input the proxy could have carried.

## MODIFY map

### `src/grok/sync.ts`

Import the accessor alongside the existing catalog imports and use it for the
native branch:

```ts
-    ...visibleNativeSlugs(config).map(id => ({ id })),
+    ...visibleNativeSlugs(config).map(id => {
+      const contextWindow = nativeOpenAiContextWindow(id);
+      return { id, ...(contextWindow !== undefined ? { contextWindow } : {}) };
+    }),
```

The conditional spread mirrors the routed branch exactly, so a native slug with
no recorded window behaves as it does today rather than emitting a bogus line.

Nothing in `src/grok/inject.ts` changes — it already does the right thing once the
field arrives.

## Blast radius to confirm at audit

`nativeOpenAiContextWindow` is the same source `nativeModelRows` uses for the
Models page, so the Grok config will agree with what the dashboard already shows.
The audit must check there is no separate, conflicting native-window source that
Grok should prefer.

## TESTS

`tests/grok-inject.test.ts` (or the existing Grok sync test): syncing a config
with a visible native `gpt-5.6-sol` emits `context_window = 372000` in the managed
block, and a native slug without a recorded window emits no line.

Mutation check: revert the sync change and confirm the new case fails.

## Verification (C)

| Command | Expected |
|---------|----------|
| `bun test tests/grok-*.test.ts` | pass |
| `bun run typecheck` | exit 0 |
