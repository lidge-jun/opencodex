import { collectResponsesToolGroups } from "../responses/tool-groups";
import { relaySseWithPayloadRewrite, type SsePayloadRewrite } from "./sse-payload-rewrite";
import type { TranslatorBudget } from "../lib/translator-budget";

interface NamespacedTool {
  namespace: string;
  name: string;
}

const IMAGE_GEN_NAMESPACE = "image_gen";
const IMAGE_GEN_DOTTED_PREFIX = `${IMAGE_GEN_NAMESPACE}.`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Restrict the generic bridge map to Codex's standalone image namespace and accept the dotted
 * alias emitted by earlier compatibility attempts. Legacy flat dotted declarations are recovered
 * from the raw request because the generic parser does not assign them a namespace. Exact declared
 * names avoid splitting arbitrary double-underscore function names that belong to unrelated tools.
 */
export function imageGenToolCallAliases(
  toolNsMap: ReadonlyMap<string, NamespacedTool>,
  requestBody?: unknown,
  translatorBudget?: TranslatorBudget,
): Map<string, NamespacedTool> {
  const aliases = new Map<string, NamespacedTool>();
  const retainAlias = (key: string, tool: NamespacedTool) => {
    if (aliases.has(key)) {
      aliases.set(key, tool);
      return;
    }
    translatorBudget?.chargeRetained(
      Buffer.byteLength(key) + Buffer.byteLength(tool.namespace) + Buffer.byteLength(tool.name),
      { kind: "request_copies" },
    );
    aliases.set(key, tool);
  };
  for (const [wireName, tool] of toolNsMap) {
    if (tool.namespace !== IMAGE_GEN_NAMESPACE) continue;
    retainAlias(wireName, tool);
    retainAlias(`${tool.namespace}.${tool.name}`, tool);
  }
  for (const group of collectResponsesToolGroups(requestBody)) {
    for (const tool of group) {
      if (
        !isPlainObject(tool)
        || tool.type !== "function"
        || typeof tool.name !== "string"
        || !tool.name.startsWith(IMAGE_GEN_DOTTED_PREFIX)
        || tool.name.length === IMAGE_GEN_DOTTED_PREFIX.length
      ) continue;
      const localName = tool.name.slice(IMAGE_GEN_DOTTED_PREFIX.length);
      const target = { namespace: IMAGE_GEN_NAMESPACE, name: localName };
      retainAlias(`${IMAGE_GEN_NAMESPACE}__${localName}`, target);
      retainAlias(tool.name, target);
    }
  }
  return aliases;
}

/** Recursively restore only exact image-gen function-call aliases in a parsed Responses payload. */
function restoreImageGenCalls(
  value: unknown,
  aliases: ReadonlyMap<string, NamespacedTool>,
): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const restored = value.map(entry => {
      const result = restoreImageGenCalls(entry, aliases);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { value: restored, changed: true } : { value, changed: false };
  }
  if (!isPlainObject(value)) return { value, changed: false };

  let changed = false;
  const restored: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const result = restoreImageGenCalls(entry, aliases);
    restored[key] = result.value;
    changed ||= result.changed;
  }

  const name = typeof value.name === "string" ? value.name : undefined;
  const target = value.type === "function_call" && name ? aliases.get(name) : undefined;
  if (target) {
    restored.name = target.name;
    restored.namespace = target.namespace;
    changed = true;
  }
  return changed ? { value: restored, changed: true } : { value, changed: false };
}

/** Restore image-gen function calls in a non-streaming Responses JSON document. */
export function restoreImageGenCallsInJson(
  text: string,
  aliases: ReadonlyMap<string, NamespacedTool>,
): string {
  if (aliases.size === 0) return text;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return text;
  }
  const restored = restoreImageGenCalls(payload, aliases);
  return restored.changed ? JSON.stringify(restored.value) : text;
}

/** Payload rewrite for composition with other client-facing SSE transforms. */
export function createImageGenCallRestoreRewrite(
  aliases: ReadonlyMap<string, NamespacedTool>,
): SsePayloadRewrite | undefined {
  if (aliases.size === 0) return undefined;
  return (payload) => restoreImageGenCallsInJson(payload, aliases);
}

/**
 * Restore upstream-safe image-gen aliases only on the client-facing SSE branch. The inspection and
 * continuation-cache branch must retain raw upstream names so a replay can be sent back unchanged.
 */
export function relaySseWithImageGenCallRestore(
  body: ReadableStream<Uint8Array>,
  aliases: ReadonlyMap<string, NamespacedTool>,
  translatorBudget: TranslatorBudget,
): ReadableStream<Uint8Array> {
  const rewrite = createImageGenCallRestoreRewrite(aliases);
  return rewrite ? relaySseWithPayloadRewrite(body, rewrite, translatorBudget) : body;
}
