import { isPlainObject } from "./internal";
import { promoteClientLoadedTools } from "./tool-schema";
import { rewriteRoutedCustomToolsForUpstream } from "../../responses/custom-tool-compat";

export class MuseToolCatalogCompatibilityError extends Error {
  constructor() {
    super("Malformed tool catalog for Meta Responses.");
    this.name = "MuseToolCatalogCompatibilityError";
  }
}

function validateCatalog(tools: unknown): void {
  if (!Array.isArray(tools)) throw new MuseToolCatalogCompatibilityError();
  for (const tool of tools) {
    if (!isPlainObject(tool) || typeof tool.type !== "string") throw new MuseToolCatalogCompatibilityError();
    if (["namespace", "function", "custom"].includes(tool.type)
      && (typeof tool.name !== "string" || tool.name.length === 0)) throw new MuseToolCatalogCompatibilityError();
    if (tool.type === "namespace") validateCatalog(tool.tools);
  }
}

/**
 * Meta rejects Codex's additional_tools input items. Capture the current catalog
 * before history rewrites can shift the replay boundary or consume duplicate names.
 * Historical messages and search results remain replay context, never declarations.
 * The caller gates this projection on the actual Meta destination.
 */
export function normalizeMuseToolCatalog(body: unknown, replayPrefixLength = 0, supportsCustomTools?: boolean): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  // Namespace lowering drops malformed groups; reject them before any partial promotion.
  if (body.tools !== undefined) validateCatalog(body.tools);
  for (const item of body.input) {
    if (isPlainObject(item) && (item.type === "additional_tools"
      || (item.type === "tool_search_output" && item.tools !== undefined))) {
      validateCatalog(item.tools);
    }
  }
  const start = Number.isFinite(replayPrefixLength)
    ? Math.min(body.input.length, Math.max(0, Math.trunc(replayPrefixLength))) : 0;
  const current = promoteClientLoadedTools({ ...body, input: body.input.slice(start) });
  if (!isPlainObject(current) || !Array.isArray(current.input)) return body;
  const tools: unknown[] = Array.isArray(current.tools) ? [...current.tools] : [];
  for (const item of current.input) {
    if (isPlainObject(item) && item.type === "additional_tools" && Array.isArray(item.tools)) tools.push(...item.tools);
  }
  // Replay still needs the old declarations to lower custom calls and their outputs.
  // Retain only that input projection, never the historical declaration/restore sets.
  const replay = rewriteRoutedCustomToolsForUpstream(body, supportsCustomTools).body;
  const replayInput = isPlainObject(replay) && Array.isArray(replay.input) ? replay.input : body.input;
  const input = replayInput.filter(item => !isPlainObject(item) || item.type !== "additional_tools");
  const hasCatalog = current.tools !== undefined || input.length !== body.input.length;
  return { ...body, input, ...(hasCatalog ? { tools } : {}) };
}
