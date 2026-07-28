import { collectResponsesToolGroups } from "../responses/tool-groups";

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
): Map<string, NamespacedTool> {
  const aliases = new Map<string, NamespacedTool>();
  for (const [wireName, tool] of toolNsMap) {
    if (tool.namespace !== IMAGE_GEN_NAMESPACE) continue;
    aliases.set(wireName, tool);
    aliases.set(`${tool.namespace}.${tool.name}`, tool);
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
      aliases.set(`${IMAGE_GEN_NAMESPACE}__${localName}`, target);
      aliases.set(tool.name, target);
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

/** Split one complete SSE event block while retaining its original blank-line delimiter. */
function nextSseBlock(buffer: string): { block: string; delimiter: string; rest: string } | null {
  const match = buffer.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) return null;
  return {
    block: buffer.slice(0, match.index),
    delimiter: match[0],
    rest: buffer.slice(match.index + match[0].length),
  };
}

/** Join all data lines from one SSE event according to the event-stream field rules. */
function sseDataPayload(block: string): string | null {
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return data.length > 0 ? data.join("\n") : null;
}

/** Replace an SSE event's data field while preserving non-data fields and newline style. */
function replaceSseDataPayload(block: string, payload: string): string {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  const rewritten: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (!line.startsWith("data:")) {
      rewritten.push(line);
      continue;
    }
    if (!replaced) {
      rewritten.push(`data: ${payload}`);
      replaced = true;
    }
  }
  return replaced ? rewritten.join(newline) : block;
}

/**
 * Restore upstream-safe image-gen aliases only on the client-facing SSE branch. The inspection and
 * continuation-cache branch must retain raw upstream names so a replay can be sent back unchanged.
 */
export function relaySseWithImageGenCallRestore(
  body: ReadableStream<Uint8Array>,
  aliases: ReadonlyMap<string, NamespacedTool>,
): ReadableStream<Uint8Array> {
  if (aliases.size === 0) return body;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const emitProcessedBlocks = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    flushFinal = false,
  ): void => {
    let next: { block: string; delimiter: string; rest: string } | null;
    while ((next = nextSseBlock(buffer))) {
      buffer = next.rest;
      const payload = sseDataPayload(next.block);
      const restoredPayload = payload ? restoreImageGenCallsInJson(payload, aliases) : undefined;
      const block = payload && restoredPayload !== undefined && restoredPayload !== payload
        ? replaceSseDataPayload(next.block, restoredPayload)
        : next.block;
      controller.enqueue(encoder.encode(block + next.delimiter));
    }
    if (flushFinal && buffer.length > 0) {
      const payload = sseDataPayload(buffer);
      const restoredPayload = payload ? restoreImageGenCallsInJson(payload, aliases) : undefined;
      const block = payload && restoredPayload !== undefined && restoredPayload !== payload
        ? replaceSseDataPayload(buffer, restoredPayload)
        : buffer;
      controller.enqueue(encoder.encode(block));
      buffer = "";
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        emitProcessedBlocks(controller, true);
        controller.close();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      emitProcessedBlocks(controller);
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}
