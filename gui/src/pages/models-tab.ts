/**
 * Models tab identity and hash mapping.
 *
 * Mirrors `logs-tab-keydown.ts`: the hash is the source of truth, so refresh, bookmark,
 * and Back/Forward all keep the tab choice. Kept out of `Models.tsx` because that file
 * is already large and because the tests want to import this directly.
 */

import { navigateHash, normalizeHashPath, splitHashQuery } from "../hash-routing";
import { JEV_AUTO_CREATE_HASH } from "../app-routing";

/**
 * `catalog` rather than `models` for the first tab: the page is Models and its first
 * tab shows the plain model list, so a distinct id keeps "the page" and "the tab" from
 * ever having to be disambiguated in code. The visible label is still "Models".
 */
export type ModelsTab = "catalog" | "combos" | "routing" | "compatibility";

export const MODELS_TABS: readonly ModelsTab[] = ["catalog", "combos", "routing", "compatibility"];

export function modelsTabHash(tab: ModelsTab): string {
  return tab === "catalog" ? "models" : `models/${tab}`;
}

/**
 * Legacy top-level hashes resolve here too, and that is not redundancy with the
 * resolver's redirect.
 *
 * The redirect rewrites `#combos` to `#models/combos` with replaceState, which
 * deliberately emits no `hashchange`. Tab state is therefore initialized from the
 * ORIGINAL hash: recognising only the nested form would land a cold load at `#combos`
 * on the catalog while the URL claimed Combos.
 */
export function readModelsTab(hash = window.location.hash): ModelsTab {
  // A compatibility prefilter rides in `?query` (protocol-deep-links.ts); the tab is the path.
  const raw = splitHashQuery(normalizeHashPath(hash)).path;
  if (raw === "models/combos" || raw === JEV_AUTO_CREATE_HASH || raw === "combos" || raw.startsWith("combos/")) return "combos";
  if (raw === "models/routing" || raw === "routing" || raw.startsWith("routing/")) return "routing";
  if (raw === "models/compatibility" || raw === "lab" || raw.startsWith("lab/")) return "compatibility";
  return "catalog";
}

/** Deliberate navigation: pushes a history entry so Back/Forward restore the tab. */
export function selectModelsTab(next: ModelsTab): void {
  navigateHash(modelsTabHash(next));
}

export function modelsTabDomId(tab: ModelsTab): string {
  return `models-tab-${tab}`;
}

export function modelsPanelDomId(tab: ModelsTab): string {
  return `models-panel-${tab}`;
}
