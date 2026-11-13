/**
 * Which Combos view the hash asks for: the overview (route board) at `#models/combos`, or the
 * full combo workspace at `#models/combos/advanced` and the JEV Auto deep link, which opens the
 * workspace's add flow.
 */
import { COMBOS_ADVANCED_HASH, JEV_AUTO_CREATE_HASH } from "../app-routing";
import { normalizeHashPath, splitHashQuery } from "../hash-routing";

export type CombosView = "overview" | "advanced";

export function readCombosView(hash = window.location.hash): CombosView {
  const path = splitHashQuery(normalizeHashPath(hash)).path;
  return path === COMBOS_ADVANCED_HASH || path === JEV_AUTO_CREATE_HASH ? "advanced" : "overview";
}
