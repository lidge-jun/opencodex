import { isPlainObject as isRecord } from "./openai-responses/internal";
import { hasItemProvenance, isHistoricalItem, tagHistoricalInputItems } from "../responses/item-provenance";

function toolKey(tool: Record<string, unknown>): string | undefined {
  if (typeof tool.type !== "string" || !tool.type) return undefined;
  const name = typeof tool.name === "string" ? tool.name : "";
  return tool.type + "\0" + name;
}

/**
 * Zed's OpenAI Responses schema accepts message and call items, not Codex's private
 * additional_tools wrapper. Drop every wrapper. Item provenance owns current-turn
 * membership; a numeric prefix is accepted only for input not yet tagged.
 * A non-array tools field is left untouched so a malformed catalog is not replaced
 * by a partial promotion.
 */
export function liftZedAdditionalTools(providerRequest: Record<string, unknown>, replayPrefixLength: number): void {
  if (!Array.isArray(providerRequest.input)) return;
  if (providerRequest.tools !== undefined && !Array.isArray(providerRequest.tools)) return;

  const taggedInput = providerRequest.input.some(hasItemProvenance) ? providerRequest.input
    : tagHistoricalInputItems(providerRequest.input, Number.isFinite(replayPrefixLength) ? replayPrefixLength : 0);
  const input: unknown[] = [];
  const promoted: unknown[] = [];
  let changed = false;
  for (const item of taggedInput) {
    if (isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
      changed = true;
      if (!isHistoricalItem(item)) promoted.push(...item.tools);
      continue;
    }
    input.push(item);
  }
  if (!changed) return;

  const seen = new Set<string>();
  const tools: unknown[] = [];
  const existing = Array.isArray(providerRequest.tools) ? providerRequest.tools : [];
  for (const tool of [...existing, ...promoted]) {
    if (!isRecord(tool)) {
      tools.push(tool);
      continue;
    }
    const key = toolKey(tool);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    tools.push(tool);
  }
  providerRequest.input = input;
  providerRequest.tools = tools;
}
