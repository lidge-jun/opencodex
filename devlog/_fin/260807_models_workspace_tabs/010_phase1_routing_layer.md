# Phase 1 — Routing layer

Owns the hash contract. Nothing renders differently after this phase; the point is
that the router can already describe the destination before any component exists to
fill it. Same order the `#debug` → `#logs/debug` move used.

**This phase is purely additive and stays green.** The `Page` union keeps `"combos"`
and `"routing"` until phase 2. The first draft of this plan removed them here, which
would have made every `page === "combos"` comparison in `App.tsx` a type error and
left one commit knowingly red — a red commit is not a checkpoint, it is a broken
bisect point. Removing a page and adding the tab that replaces it is one atomic
change, so both belong to phase 2.

## Target contract

| Hash | Page | Tab |
|------|------|-----|
| `models` | models | Models (catalog) |
| `models/combos` | models | Combos |
| `models/routing` | models | Routing |
| `combos` | models | → replace to `models/combos` |
| `routing` | models | → replace to `models/routing` |

Redirects are passive (`replaceState`), so Back is never trapped on a URL the router
immediately corrects. That is the existing `resolveAppHashChange` contract, not a new
rule.

## MODIFY `gui/src/app-routing.ts`

### 1. Add the tab hash list

Placed next to `DASHBOARD_TAB_HASHES`, same shape:

```ts
/**
 * Models owns three tabs. Catalog is the bare `#models`, so it has no suffix entry
 * here — same convention as Dashboard's Overview.
 */
export const MODELS_TAB_HASHES = ["models/combos", "models/routing"] as const;
```

### 2. Teach `hashBelongsToPage` the nested hashes

```diff
   return rawHash === page
     || (page === "logs" && rawHash === "logs/debug")
+    || (page === "models" && (MODELS_TAB_HASHES as readonly string[]).includes(rawHash))
     || (page === "dashboard" && ...
```

### 3. Nothing else changes here

`readPageFromHash` already answers `models` for `models/combos` and `models/routing`,
because it reads the first `/`-separated segment. The legacy `#combos` / `#routing`
redirects and the `Page` union removal are phase 2, where a destination exists to
redirect to.

## NEW `gui/src/pages/models-tab.ts`

Mirrors `gui/src/pages/logs-tab-keydown.ts`. Kept out of `Models.tsx` because that
file is already 1432 lines and this is the part the tests want to import directly.

```ts
import { navigateHash, normalizeHashPath } from "../hash-routing";

export type ModelsTab = "catalog" | "combos" | "routing";

export const MODELS_TABS: readonly ModelsTab[] = ["catalog", "combos", "routing"];

export function modelsTabHash(tab: ModelsTab): string {
  return tab === "catalog" ? "models" : `models/${tab}`;
}

export function readModelsTab(hash = window.location.hash): ModelsTab {
  const raw = normalizeHashPath(hash);
  // Legacy top-level hashes resolve here too. The redirect that rewrites `#combos` to
  // `#models/combos` runs via replaceState and emits NO hashchange, so tab state is
  // initialized from the ORIGINAL hash. Recognising only the nested form would land a
  // cold load at `#combos` on the catalog with the URL claiming Combos (audit B2).
  if (raw === "models/combos" || raw === "combos" || raw.startsWith("combos/")) return "combos";
  if (raw === "models/routing" || raw === "routing" || raw.startsWith("routing/")) return "routing";
  return "catalog";
}

export function selectModelsTab(next: ModelsTab): void {
  navigateHash(modelsTabHash(next));
}

export function modelsTabDomId(tab: ModelsTab): string { return `models-tab-${tab}`; }
export function modelsPanelDomId(tab: ModelsTab): string { return `models-panel-${tab}`; }
```

`catalog` is the internal id; the visible label is `Models` (user's call — the page is
"models" and the first tab is the plain list of them). The id stays distinct so the
code never has to disambiguate `models` the page from `models` the tab.

## NEW `tests/models-workspace-tabs.test.ts`

Phase-1 half (routing only — component assertions land in later phases):

- `readModelsTab` maps all three hashes and defaults unknown input to `catalog`.
- `readModelsTab` also maps the legacy `combos`, `combos/x`, `routing`, `routing/x`
  forms — the cold-load case from audit B2.
- `modelsTabHash` round-trips every tab through `readModelsTab`.
- `hashBelongsToPage("models/combos", "models")` and `("models/routing", "models")`
  are both true.
- `hashBelongsToPage` rejects an invented `models/nope`, so normalization strips it.
- `readPageFromHash("models/combos")` is `models` — the first segment wins.

No existing test changes in this phase. `tests/routing-intelligence-ui.test.ts` still
describes Routing as a top-level page and still passes, because the union is untouched.

## Verification

All four gates stay green: `bun run typecheck`, `bun run test`, `bun run lint:gui`,
`bun run build:gui`. Nothing in this phase can break a render path, because nothing
reads the new module yet.
