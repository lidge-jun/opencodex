/** Passive routing facts only. No catalog discovery, persistence, targets, or credentials. */
import { comboPublicModelId, isValidComboId } from "../combos/identifiers";
import type { OcxConfig } from "../types";

export const MAX_ROUTE_CATALOG_BYTES = 1024 * 1024;
export interface RouteCatalogFacts { version: 1; combos: Array<{ publicId: string; comboId: string }> }
export function parseRouteCatalogFacts(raw: unknown): RouteCatalogFacts | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join(",") !== "combos,version"
    || !("version" in raw) || raw.version !== 1 || !("combos" in raw) || !Array.isArray(raw.combos) || raw.combos.length > 4096) return null;
  const seen = new Set<string>();
  const combos: RouteCatalogFacts["combos"] = [];
  for (const row of raw.combos) {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join(",") !== "comboId,publicId"
      || typeof row.comboId !== "string" || !isValidComboId(row.comboId) || typeof row.publicId !== "string"
      || !row.publicId || row.publicId.length > 512 || /[\x00-\x1f\x7f]/.test(row.publicId) || seen.has(row.publicId)) return null;
    seen.add(row.publicId); combos.push({ publicId: row.publicId, comboId: row.comboId });
  }
  return { version: 1, combos };
}
export function projectRouteCatalogFacts(config: OcxConfig): RouteCatalogFacts {
  const facts = parseRouteCatalogFacts({ version: 1, combos: Object.entries(config.combos ?? {}).map(([comboId, combo]) => ({
    publicId: comboPublicModelId(comboId, combo), comboId,
  })) });
  if (!facts || Buffer.byteLength(JSON.stringify(facts)) > MAX_ROUTE_CATALOG_BYTES) throw new Error("Route catalog facts are invalid or too large");
  return facts;
}
