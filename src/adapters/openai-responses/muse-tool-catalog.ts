import { isPlainObject } from "./internal";
import { promoteClientLoadedTools } from "./tool-schema";
import { rewriteRoutedCustomToolsForUpstream } from "../../responses/custom-tool-compat";
import { hasItemProvenance, isHistoricalItem } from "../../responses/item-provenance";

export class MuseToolCatalogCompatibilityError extends Error {
  constructor() {
    super("Malformed tool catalog for Meta Responses.");
    this.name = "MuseToolCatalogCompatibilityError";
  }
}

function isRepresentableName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0
    && [...name].every(character => character.charCodeAt(0) > 0x1f && character.charCodeAt(0) !== 0x7f);
}

function normalizeCatalog(tools: unknown, inNamespace = false): Record<string, unknown>[] {
  if (!Array.isArray(tools)) throw new MuseToolCatalogCompatibilityError();
  return tools.flatMap(tool => {
    if (!isPlainObject(tool) || typeof tool.type !== "string") throw new MuseToolCatalogCompatibilityError();
    if (inNamespace && tool.type !== "function" && tool.type !== "custom") throw new MuseToolCatalogCompatibilityError();
    if (tool.type === "function" && isPlainObject(tool.function)) {
      const { function: definition, ...outer } = tool;
      tool = { ...outer, ...definition, type: "function" };
    }
    if (["namespace", "function", "custom"].includes(tool.type)
      && !isRepresentableName(tool.name)) throw new MuseToolCatalogCompatibilityError();
    if (tool.type !== "namespace") return [tool];
    return [{ ...tool, tools: normalizeCatalog(tool.tools, true) }];
  });
}

function flattenBuiltinNamespace(tools: Record<string, unknown>[]): Record<string, unknown>[] {
  const bareNames = new Set(tools.filter(tool => tool.type !== "namespace").map(tool => tool.name));
  return tools.flatMap(tool => {
    if (tool.type !== "namespace" || tool.name !== "functions") return [tool];
    // Match namespace lowering: an explicit bare declaration owns this identity,
    // even when it occurs later or in a different current declaration carrier.
    return (tool.tools as Record<string, unknown>[]).filter(child => !bareNames.has(child.name))
      .map(child => tool.defer_loading === undefined ? child : { defer_loading: tool.defer_loading, ...child });
  });
}

/**
 * Meta rejects Codex's additional_tools input items. Capture the current catalog
 * before history rewrites can shift the replay boundary or consume duplicate names.
 * Historical messages and search results remain replay context, never declarations.
 * The caller gates this projection on the actual Meta destination.
 */
export function normalizeMuseToolCatalog(body: unknown, replayPrefixLength = 0, supportsCustomTools?: boolean): unknown {
  if (!isPlainObject(body)) return body;
  // Namespace lowering drops malformed groups; reject them before any partial promotion.
  const topLevelTools = body.tools === undefined ? undefined : normalizeCatalog(body.tools);
  if (!Array.isArray(body.input)) return topLevelTools === undefined ? body : { ...body, tools: flattenBuiltinNamespace(topLevelTools) };
  const start = Number.isFinite(replayPrefixLength)
    ? Math.min(body.input.length, Math.max(0, Math.trunc(replayPrefixLength))) : 0;
  // Item provenance owns membership once present: an earlier rewrite (Zed lifting a replayed
  // wrapper) may already have shortened the input below the numeric prefix.
  const originalInput: unknown[] = body.input;
  const tagged = originalInput.some(hasItemProvenance);
  const isCurrent = (item: unknown, index: number) => tagged ? !isHistoricalItem(item) : index >= start;
  const normalizedInput = body.input.map((item, index) => {
    if (!isCurrent(item, index)) return item;
    if (isPlainObject(item) && (item.type === "additional_tools"
      || (item.type === "tool_search_output" && item.tools !== undefined))) {
      const tools = normalizeCatalog(item.tools);
      return { ...item, tools: item.type === "tool_search_output" ? flattenBuiltinNamespace(tools) : tools };
    }
    return item;
  });
  const currentInput = normalizedInput.filter((_item, index) => isCurrent(originalInput[index], index));
  const declared = [...(topLevelTools ?? [])];
  for (const item of currentInput) {
    if (isPlainObject(item) && item.type === "additional_tools" && Array.isArray(item.tools)) declared.push(...item.tools);
  }
  // All current declarations precede discoveries, regardless of their carrier.
  const current = promoteClientLoadedTools({ ...body, tools: flattenBuiltinNamespace(declared), input: currentInput });
  const tools = isPlainObject(current) && Array.isArray(current.tools) ? current.tools : declared;
  // Replay still needs the old declarations to lower custom calls and their outputs.
  // Retain only that input projection, never the historical declaration/restore sets.
  const replay = rewriteRoutedCustomToolsForUpstream({ ...body, input: normalizedInput }, supportsCustomTools).body;
  const replayInput = isPlainObject(replay) && Array.isArray(replay.input) ? replay.input : normalizedInput;
  const input = replayInput.filter(item => !isPlainObject(item) || item.type !== "additional_tools");
  const hasCatalog = topLevelTools !== undefined || tools.length > 0 || input.length !== body.input.length;
  return { ...body, input, ...(hasCatalog ? { tools } : {}) };
}
