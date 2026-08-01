# 060 — WP6: context formatting, native windows, unknown display (D1a + D1b + D4)

Root causes in `030a_defect_investigation.md` §D1 and §D4. This doc is the
implementation contract.

## Scope

IN: format windows ≥ 1 MiB as `1M`; give native Desktop models their real context
window in BOTH the DTO and the desktop-3p writer path; a deliberate display for an
unknown window instead of a blank.
OUT: the `supports1m`/`prefer1m` UI chip (WP7); any change to the 1M threshold logic;
any per-route metadata correction (separate, only if a specific model is named).

## D1a — formatting

`gui/src/pages/ClaudeDesktop.tsx:104-110` `formatContextWindow` and
`gui/src/pages/Grok.tsx:21-26` `formatContext` both do `value / 1_000_000`. Providers
report `1_048_576` (2^20), producing `1.048576M`.

Modify both helpers identically: a window at or above 1 MiB is a whole `1M`. The
thousand separator is the only sub-MiB formatting concern and is already handled by the
`{n}k` branch.

```diff
 function formatContextWindow(value: number | undefined, t: TFn): string | null {
   if (!value) return null;
+  // 1 MiB and above is a whole "1M": providers report 2^20 (1048576), and
+  // 1048576 / 1e6 = 1.048576 reads as a bug.
+  if (value >= 1_048_576) return t("claudeDesktop.contextM", { n: Math.round(value / 1_048_576) });
   return value >= 1_000_000
     ? t("claudeDesktop.contextM", { n: value / 1_000_000 })
     : t("claudeDesktop.contextK", { n: Math.round(value / 1_000) });
 }
```

Same change in `Grok.tsx`'s `formatContext`. Both then route through
`claudeDesktop.contextM` (`"{n}M context"`), so no new locale key is needed for the 1M
case itself.

## D1b — native context windows (DTO AND writer path)

`buildClaudeDesktopState` (`src/server/management/shared.ts:193-200`) builds native
rows without a context window. The apply route (`agent-settings-routes.ts:445-457`)
strips native rows before `writeDesktop3pConfig`. Reviewer blocker: fixing only the
DTO would let a chip claim a capability the written config cannot emit.

Modify `shared.ts:193-200` to include the native window:

```diff
   const profileModels: DesktopProfileModel[] = [
-    ...visibleNativeSlugs(config).map(id => ({ route: `native/${id}`, label: `${id} (native)` })),
+    ...visibleNativeSlugs(config).map(id => {
+      const contextWindow = nativeOpenAiContextWindow(id);
+      return { route: `native/${id}`, label: `${id} (native)`,
+        ...(contextWindow !== undefined ? { contextWindow } : {}) };
+    }),
```

And make the writer path carry it too, so apply/auto-apply/CLI agree. In
`agent-settings-routes.ts:445-457` the apply currently passes only routed contexts;
native slugs reach `writeDesktop3pConfig` as bare slugs. Pass the native window through
the same path (extend the routed-model mapping or the `writeDesktop3pConfig` native
argument) using `nativeOpenAiContextWindow`, so a native 1M/372k model's capability is
resolved from one accessor everywhere.

The `available` map and `modelByRoute` already key off `profileModels`, so adding the
field flows to `DesktopModel.contextWindow` with no other change (`shared.ts:213-220`).

## D4 — unknown context display

A model with no known window currently renders nothing (`{context && ...}`). Replace
the silent blank with an explicit muted marker, so "we do not know" is
distinguishable from "we know it is small":

In `ClaudeDesktop.tsx` row summary, where `context` is rendered, fall back to a new
locale key `claudeDesktop.contextUnknown` (`en` "context unknown", `ko` "컨텍스트 불명",
ja/zh/de/ru equivalents) rendered with the muted context styling. `Grok.tsx` already
shows `—` for absent windows, which is acceptable there; align it to the same key for
consistency.

## Locale keys — NEW

| Key | en | ko |
|-----|----|----|
| `claudeDesktop.contextUnknown` | `context unknown` | `컨텍스트 불명` |

ja `コンテキスト不明`, zh `上下文未知`, de `Kontext unbekannt`, ru `контекст неизвестен`.

## TESTS

`gui/tests/claude-desktop-context.test.ts` (NEW):

- `1048576` → `"1M context"` (not `1.048576M`); `1_000_000` → `"1M context"`;
- `200_000` → `"200k context"`; `372_000` → `"372k context"`; `undefined` → `null`;

`tests/claude-desktop-dto.test.ts` (extend or NEW):

- `buildClaudeDesktopState` native rows carry `nativeOpenAiContextWindow`
  (e.g. `native/gpt-5.6-sol` → `372_000`);
- a native 1M-capable model resolves the same window in the writer path as in the DTO.

## Verification (C)

| Command | Expected |
|---------|----------|
| `cd gui && bun test tests/claude-desktop-context.test.ts` | pass |
| `bun test tests/claude-desktop-dto.test.ts tests/desktop-3p.test.ts` | pass |
| `cd gui && bun run test` / `bun run typecheck` / `bun run lint:gui` / `lint:i18n` / `privacy:scan` | green |
| headless render | antigravity row shows `1M context`, native rows show their real window, no `1.048576M` |
