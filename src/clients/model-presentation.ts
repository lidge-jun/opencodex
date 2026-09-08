import { CURSOR_CAPABILITIES } from "../adapters/cursor/catalog";
import { nativeOpenAiCapabilityDisplayName } from "../codex/catalog/metadata";
import type { ExportModel } from "./config-export/contracts";

const KNOWN_ACRONYMS = new Set(["gpt", "glm", "grok"]);

function titleWord(word: string): string {
  const lower = word.toLowerCase();
  if (KNOWN_ACRONYMS.has(lower)) return lower.toUpperCase();
  if (/^\d+\.\d+$/.test(word)) return word;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Last-resort label when no catalog or operator name exists. Joins dotted version
 * tails (`5-1` → `5.1`, `2-5` → `2.5`) so Raycast reads like a product name
 * instead of a slug.
 */
function humanizeModelSlug(modelId: string): string {
  const parts = modelId.split("-");
  const words: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const next = parts[index + 1];
    if (/^\d+$/.test(part) && next !== undefined && /^\d+$/.test(next)) {
      words.push(`${part}.${next}`);
      index += 1;
      continue;
    }
    words.push(part);
  }
  return words.map(titleWord).join(" ");
}

function wireModelId(model: ExportModel): string {
  if (model.id?.trim()) return model.id.trim();
  const slash = model.namespaced.lastIndexOf("/");
  return slash >= 0 ? model.namespaced.slice(slash + 1) : model.namespaced;
}

/**
 * Human-facing model label for clients whose picker shows `name` verbatim.
 *
 * Raycast has no second column for provider, so the shared `exportModelLabel`
 * suffix `(anthropic)` would be noise — and its fallback is the raw wire id
 * because management slugs are deliberately withheld from ExportModel. Resolve
 * operator labels first, then the canonical capability tables, then a slug
 * humanizer.
 */
export function exportPresentationLabel(model: ExportModel): string {
  const configured = model.displayName?.trim();
  if (configured) return configured;
  const wireId = wireModelId(model);
  const fromCursor = CURSOR_CAPABILITIES[wireId]?.displayName;
  if (fromCursor) return fromCursor;
  if (model.native) {
    const native = nativeOpenAiCapabilityDisplayName(wireId);
    if (native) return native;
  }
  return humanizeModelSlug(wireId);
}
