import { parseComboTargets } from "./combo-input";
import { printCatalogResult } from "./catalog-command-result";

const ENUMS: Readonly<Record<string, readonly (string | null)[]>> = {
  strategy: ["failover", "round-robin", "random", "least-used", "reset-window", "jev"],
  defaultEffort: [null, "low", "medium", "high", "xhigh", "max", "ultra"],
  defaultEffortMode: ["fallback", "force"], reasoningEffortMode: ["strict", "adaptive"],
  imageInput: ["auto", "disabled"], cooldownWaitPolicy: ["before-last-resort"],
};
const STRINGS = new Set(["alias", "displayName", "decisionProvider", "decisionModel"]);
const RANGES: Readonly<Record<string, readonly [number, number]>> = {
  stickyLimit: [1, 100], cooldownMs: [1, 600_000], waitForCooldownMs: [0, 600_000],
  decisionTimeoutMs: [1_000, 120_000],
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function invalid(): never { throw new Error("Invalid combo receipt"); }

/** Shape/field ownership only; target graph/alias semantics remain on the server. */
function publicCombo(value: unknown): Record<string, unknown> {
  if (!record(value)) invalid();
  let targets: Array<Record<string, unknown>>;
  try { targets = parseComboTargets(value.targets); } catch { return invalid(); }
  const result: Record<string, unknown> = { targets };
  for (const [key, child] of Object.entries(value)) {
    if (key === "targets") continue;
    if (Object.hasOwn(ENUMS, key)) {
      if (!ENUMS[key]!.includes(child as string | null)) invalid();
    } else if (STRINGS.has(key)) {
      if (typeof child !== "string" || child.length > 4096) invalid();
    } else if (Object.hasOwn(RANGES, key)) {
      const [min, max] = RANGES[key]!;
      if (typeof child !== "number" || !Number.isSafeInteger(child) || child < min || child > max) invalid();
    } else if (key === "nativeAlias") {
      if (typeof child !== "boolean") invalid();
    } else invalid();
    result[key] = child;
  }
  return result;
}

export function printComboWriteResult(value: unknown, id: string, wantsJson: boolean): number {
  if (!record(value) || value.success !== true || value.id !== id || typeof value.model !== "string"
    || Object.keys(value).some(key => !["success", "id", "model", "combo", "catalogRefresh"].includes(key))) invalid();
  const combo = publicCombo(value.combo);
  const model = typeof combo.alias === "string" && combo.alias.trim() ? combo.alias.trim() : `combo/${id}`;
  if (value.model !== model) invalid();
  return printCatalogResult({ success: true, id, model: value.model, combo }, value.catalogRefresh,
    wantsJson, [`Saved combo ${id}.`]);
}
