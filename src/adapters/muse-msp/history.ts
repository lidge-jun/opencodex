import { createHash } from "node:crypto";
import type { OcxContext, OcxMessage } from "../../types";
import { MuseMspError } from "./connection";

/** Canonicalize JSON objects, preserving array order and all semantic fields. */
function canonical(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (++budget.nodes > 100_000 || depth > 64) throw new MuseMspError("invalid_history");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1, budget));
  if (typeof value !== "object" || !value || Object.getPrototypeOf(value) !== Object.prototype) throw new MuseMspError("invalid_history");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key];
    // Parsed optional fields may be present as undefined; JSON would omit them.
    if (child !== undefined) result[key] = canonical(child, depth + 1, budget);
  }
  return result;
}

function stableMessages(messages: readonly OcxMessage[], omitDerivedModel = false): unknown[] {
  return messages.map(message => {
    // Parser-generated timestamps change on each parse and do not represent client history.
    const { timestamp: _timestamp, ...rest } = message;
    // The Responses parser derives this from the current request selector, not
    // from the replayed message. The owner separately binds the physical model.
    if (omitDerivedModel && rest.role === "assistant") {
      const { model: _model, ...stable } = rest;
      // Codex's search sidecar can replay commentary without its optional phase.
      if (stable.phase === "commentary") { const { phase: _phase, ...withoutPhase } = stable; return withoutPhase; }
      return stable;
    }
    return rest;
  });
}

/** Snapshot the independently parsed initial prefix and the call that will be emitted. */
export function museHistoryDigest(context: OcxContext, name: string, args: Record<string, unknown>, namespace?: string, freeform = false): string {
  if (!name || typeof name !== "string" || Buffer.byteLength(name) > 512 || !args || Array.isArray(args) || typeof args !== "object" ||
      (namespace !== undefined && (typeof namespace !== "string" || !namespace || Buffer.byteLength(namespace) > 512))) {
    throw new MuseMspError("invalid_history");
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(canonical({ systemPrompt: context.systemPrompt, tools: context.tools,
      messages: stableMessages(context.messages, true), call: { name, namespace, args, freeform } }));
  } catch { throw new MuseMspError("invalid_history"); }
  if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw new MuseMspError("invalid_history");
  return createHash("sha256").update("opencodex.muse-history.v1\0").update(encoded).digest("hex");
}

/** Full parsed history and request options, excluding parser-generated timestamps only. */
export function museConversationDigest(context: OcxContext, options: unknown): string {
  let encoded: string;
  try { encoded = JSON.stringify(canonical({ systemPrompt: context.systemPrompt, tools: context.tools, messages: stableMessages(context.messages, true), options })); }
  catch { throw new MuseMspError("invalid_history"); }
  if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw new MuseMspError("invalid_history");
  return createHash("sha256").update("opencodex.muse-conversation.v1\0").update(encoded).digest("hex");
}

/** Hash a bounded model input array without retaining prompts or tool results. */
export function museModelInputDigest(input: unknown): string {
  if (!Array.isArray(input) || input.length > 16_384) throw new MuseMspError("invalid_history");
  let encoded: string;
  try { encoded = JSON.stringify(canonical(input)); } catch { throw new MuseMspError("invalid_history"); }
  if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw new MuseMspError("invalid_history");
  return createHash("sha256").update("opencodex.muse-model-input.v1\0").update(encoded).digest("hex");
}

/**
 * Extract a single text result from parsed full history. Rebuild the initial prefix
 * by removing only the final emitted tool call; the registry compares the resulting
 * digest to its independently captured value. Delta-only and multimodal inputs fail.
 */
export function museContinuation(context: OcxContext): { clientCallId: string; historyDigest: string; output: string } {
  const messages = context.messages;
  const output = messages.at(-1), assistant = messages.at(-2);
  if (!output || output.role !== "toolResult" || typeof output.content !== "string" || (output.isError && output.toolName !== "web_search") ||
      output.containsEncryptedContent || !assistant || assistant.role !== "assistant" || assistant.content.length < 1) {
    throw new MuseMspError("invalid_continuation");
  }
  const call = assistant.content.at(-1);
  if (!call || call.type !== "toolCall" || !call.id || call.id !== output.toolCallId || call.name !== output.toolName ||
      call.namespace !== output.toolNamespace || (call.customWireName !== undefined && call.customWireName !== call.name) || call.providerMetadata || call.thoughtSignature) {
    throw new MuseMspError("invalid_continuation");
  }
  const prefix: OcxMessage[] = messages.slice(0, -2);
  if (assistant.content.length > 1) prefix.push({ ...assistant, content: assistant.content.slice(0, -1) });
  return { clientCallId: call.id, historyDigest: museHistoryDigest({ ...context, messages: prefix }, call.name, call.arguments, call.namespace, call.customWireName !== undefined), output: output.content };
}
