/**
 * Chat Completions -> IR, directly (the Antigravity direct lane).
 *
 * The bridge decodes a Chat conversation twice: `chatCompletionsToResponsesBody`
 * (`src/chat/inbound.ts`) projects it into Responses items, then `parseRequest`
 * (`src/responses/parser.ts`) turns those items into the IR. This module walks the Chat messages
 * once and builds the IR conversation itself: system text, messages, tool calls and results,
 * prior reasoning and the tool catalog. It is the request-side twin of the direct client encoders
 * (`src/protocols/encoders/`).
 *
 * Contract: for every Chat body the bridge accepts, `chatConversationToIr(body, model)` equals
 * the `context` of `parseRequest(chatCompletionsToResponsesBody(body))`, and every body the bridge
 * refuses is refused here with the same `ChatCompletionsRequestError` message in the same order.
 * `tests/protocols/chat-ir-parity.test.ts` holds both sides over a fixture corpus. The rules
 * mirrored here are the Chat translator's walk (leading-system hoist, held mid-batch
 * instructions, tool-call naming, legacy function pairing) and the parser's assembly for the item
 * kinds that walk produces (pending reasoning, the assistant placeholder, reasoning that arrives
 * after its call, tool-result naming).
 *
 * Request settings (model, stream, reasoning, limits, tool choice, format) are not decoded here:
 * they travel through the Responses core on `chatSettingsToResponsesBody`, so effort policy,
 * tier and routing keep their single owner.
 */
import {
  assistantReasoningText,
  ChatCompletionsRequestError,
  contentToText,
  fileFromPart,
  videoFromPart,
} from "../../chat/inbound";
import { chatImageUrlFromPart } from "../../chat/image-parts";
import { untranslatedChatInputMedia, untranslatedInputMediaMessage } from "../../responses/input-media";
import { inlineDocumentFromDataUrl } from "../../responses/inline-document";
import { functionCallArgumentsFromText } from "../../responses/parser";
import { normalizeVisualizationContext } from "../../responses/visualization-directives";
import { hasRoutedIdentity, nameRoutedIdentity } from "../../adapters/identity";
import { createToolChoiceResolver, namespacedToolName } from "../../types";
import type {
  OcxAssistantMessage,
  OcxContentPart,
  OcxContext,
  OcxMessage,
  OcxParsedRequest,
  OcxThinkingContent,
  OcxTool,
  OcxToolCall,
} from "../../types";
import type { PolicyRequestEvidence } from "../../routing/evaluator";

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The parser's request-time naming of a proxy-authored identity sentence (#5217). */
function nameDestination(text: string, modelId: string): string {
  return hasRoutedIdentity(text) ? nameRoutedIdentity(text, modelId) : text;
}

function imageDetail(part: Rec): string | undefined {
  const detail = isRec(part.image_url) ? part.image_url.detail : part.detail;
  return detail === "auto" || detail === "low" || detail === "high" ? detail : undefined;
}

/** One file part as the IR carries inline bytes: a document, or the marker when undecodable. */
function filePart(part: Rec): OcxContentPart | null {
  const file = fileFromPart(part);
  if (!file) return null;
  const fileData = file.file_data as string;
  const filename = typeof file.filename === "string" ? file.filename : undefined;
  return inlineDocumentFromDataUrl(fileData, filename)
    ?? { type: "text", text: filename ? `[file: ${filename}]` : "[file: inline data]" };
}

/** User or tool content parts in source order; `media: false` keeps only text and images. */
function contentParts(content: unknown, media = true): OcxContentPart[] {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: OcxContentPart[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      if (raw.length > 0) parts.push({ type: "text", text: raw });
      continue;
    }
    if (!isRec(raw)) continue;
    if ((raw.type === "text" || raw.type === "input_text" || raw.type === "output_text") && typeof raw.text === "string") {
      parts.push({ type: "text", text: raw.text });
      continue;
    }
    const imageUrl = chatImageUrlFromPart(raw);
    if (imageUrl) {
      const detail = imageDetail(raw);
      parts.push({ type: "image", imageUrl, ...(detail ? { detail } : {}) });
      continue;
    }
    const video = videoFromPart(raw);
    if (video) {
      if (media) parts.push({ type: "video", videoUrl: video.url, ...(video.processing ? { processing: video.processing } : {}) });
      continue;
    }
    if (!media) continue;
    const file = filePart(raw);
    if (file) parts.push(file);
  }
  return parts;
}

/** The parser collapses a lone text part to a plain string; images and documents stay structured. */
function collapsed(parts: OcxContentPart[]): string | OcxContentPart[] {
  return parts.length === 1 && parts[0]!.type === "text" ? parts[0]!.text : parts;
}

function assistantTextParts(content: unknown): Array<{ type: "text"; text: string }> {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: Array<{ type: "text"; text: string }> = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      if (raw.length > 0) parts.push({ type: "text", text: raw });
      continue;
    }
    if (isRec(raw) && (raw.type === "text" || raw.type === "output_text") && typeof raw.text === "string") {
      parts.push({ type: "text", text: raw.text });
    }
  }
  return parts;
}

/**
 * The parser keeps an unsigned reasoning item's serialized form as its placeholder signature.
 * The Chat translator's item is `{type, summary, content}` with one text in each, so the value is
 * spelled out rather than produced by a Responses round trip.
 */
function unsignedReasoningSignature(text: string): string {
  return JSON.stringify({
    type: "reasoning",
    summary: [{ type: "summary_text", text }],
    content: [{ type: "reasoning_text", text }],
  });
}

/**
 * The parser's parameter normalization. The bridge's schema parse hands the parser a shallow
 * copy of the caller's record, so this copies too: a sanitizer that edits the catalog in place
 * must not reach the caller's body, which the lane may still need to re-decode.
 * Shared with the direct Messages decoder (`messages-ir.ts`), whose tools pass the same schema.
 */
export function normalizedParameters(raw: unknown): Record<string, unknown> {
  // The bridge's `z.record` copies own keys except `__proto__`, which JSON.parse can create.
  const copy: Record<string, unknown> = {};
  if (isRec(raw)) {
    for (const key of Object.keys(raw)) {
      if (key !== "__proto__") copy[key] = raw[key];
    }
  }
  if (isRec(raw) && raw.type === "object") return copy;
  return { ...copy, type: "object" };
}

function functionTool(name: string, description: unknown, parameters: unknown, strict: unknown): OcxTool {
  const tool: OcxTool = {
    name,
    description: typeof description === "string" ? description : "",
    parameters: normalizedParameters(isRec(parameters) ? parameters : undefined),
  };
  if (typeof strict === "boolean") tool.strict = strict;
  return tool;
}

/** `tools` then legacy `functions`, deduplicated by name as the parser's catalog merge does. */
function toolCatalog(raw: Rec): OcxTool[] {
  const declared: OcxTool[] = [];
  if (Array.isArray(raw.tools)) {
    for (const entry of raw.tools) {
      if (!isRec(entry) || entry.type !== "function") continue;
      if (typeof entry.name === "string" && entry.name.length > 0) {
        declared.push(functionTool(entry.name, entry.description, entry.parameters, entry.strict));
      } else if (isRec(entry.function) && typeof entry.function.name === "string" && entry.function.name.length > 0) {
        const fn = entry.function;
        declared.push(functionTool(fn.name as string, fn.description, fn.parameters, fn.strict));
      }
    }
  }
  if (raw.functions !== undefined) {
    if (!Array.isArray(raw.functions)) throw new ChatCompletionsRequestError("functions must be an array");
    for (const entry of raw.functions) {
      if (!isRec(entry) || typeof entry.name !== "string" || entry.name.length === 0) {
        throw new ChatCompletionsRequestError("functions entries require a name");
      }
      declared.push(functionTool(entry.name, entry.description, entry.parameters, undefined));
    }
  }
  const seen = new Set<string>();
  return declared.filter(tool => {
    const key = namespacedToolName(tool.namespace, tool.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface ChatIrConversation {
  /** The model the conversation was decoded for; identity naming and placeholders depend on it. */
  modelId: string;
  context: OcxContext;
}

/**
 * Decode a Chat body's conversation straight into the IR context. Throws
 * `ChatCompletionsRequestError` exactly where `chatCompletionsToResponsesBody` would.
 */
export function chatConversationToIr(raw: unknown, modelId: string): ChatIrConversation {
  if (!isRec(raw) || !Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw new ChatCompletionsRequestError("messages must be a non-empty array");
  }
  const unsupportedMedia = untranslatedChatInputMedia(raw);
  if (unsupportedMedia) throw new ChatCompletionsRequestError(untranslatedInputMediaMessage(unsupportedMedia));

  const now = Date.now();
  const systemParts: string[] = [];
  const messages: OcxMessage[] = [];
  let emitted = false;
  const pending: OcxThinkingContent[] = [];
  const knownNameByCallId = new Map<string, string>();
  const legacyAwaiting: Array<{ callId: string; name: string }> = [];
  let legacyCallSequence = 0;
  const awaitingToolResult = new Set<string>();
  const heldInstructions: string[] = [];

  const pushDeveloper = (text: string): void => {
    emitted = true;
    pending.length = 0;
    messages.push({ role: "developer", content: nameDestination(text, modelId), timestamp: now });
  };
  const releaseHeldInstructions = (): void => {
    if (heldInstructions.length === 0) return;
    pushDeveloper(heldInstructions.join("\n\n"));
    heldInstructions.length = 0;
  };
  const beginConversationTurn = (): void => {
    releaseHeldInstructions();
    awaitingToolResult.clear();
    legacyAwaiting.length = 0;
  };
  const assistantHolder = (): OcxAssistantMessage => {
    const last = messages[messages.length - 1];
    let holder: OcxAssistantMessage;
    if (last && last.role === "assistant") holder = last;
    else {
      holder = { role: "assistant", content: [], model: modelId, timestamp: now };
      messages.push(holder);
    }
    if (pending.length > 0) {
      holder.content.push(...pending);
      pending.length = 0;
    }
    return holder;
  };
  const pushToolCall = (callId: string, name: string, args: string): void => {
    emitted = true;
    const call: OcxToolCall = { type: "toolCall", id: callId, name, arguments: functionCallArgumentsFromText(callId, args) };
    assistantHolder().content.push(call);
    awaitingToolResult.add(callId);
  };
  const toolOwner = (callId: string): { name: string; namespace?: string } => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role !== "assistant") continue;
      for (const part of message.content) {
        if (part.type === "toolCall" && part.id === callId) return { name: part.name, namespace: part.namespace };
      }
    }
    return { name: "" };
  };
  const pushToolResult = (callId: string, content: string | OcxContentPart[]): void => {
    emitted = true;
    // Reasoning replayed after the call it belongs to joins that call's assistant turn (#950).
    if (pending.length > 0) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]!;
        if (message.role !== "assistant") continue;
        if (message.content.some(part => part.type === "toolCall" && part.id === callId)) {
          message.content = [...pending, ...message.content];
          break;
        }
      }
    }
    pending.length = 0;
    const owner = toolOwner(callId);
    messages.push({
      role: "toolResult", toolCallId: callId, toolName: owner.name, toolNamespace: owner.namespace,
      content, isError: false, timestamp: now,
    });
    awaitingToolResult.delete(callId);
    if (awaitingToolResult.size === 0) releaseHeldInstructions();
  };

  for (const msg of raw.messages) {
    if (!isRec(msg)) continue;
    const role = typeof msg.role === "string" ? msg.role : "";
    switch (role) {
      case "system":
      case "developer": {
        if (!emitted) {
          const text = contentToText(msg.content).trim();
          if (text) systemParts.push(text);
          break;
        }
        const text = contentToText(msg.content).trim();
        if (!text) break;
        if (awaitingToolResult.size > 0) heldInstructions.push(text);
        else pushDeveloper(text);
        break;
      }
      case "user": {
        beginConversationTurn();
        const parts = contentParts(msg.content);
        if (parts.length > 0) {
          emitted = true;
          pending.length = 0;
          messages.push({ role: "user", content: collapsed(parts), timestamp: now });
        }
        break;
      }
      case "assistant": {
        beginConversationTurn();
        const reasoningText = assistantReasoningText(msg);
        if (reasoningText !== undefined) {
          emitted = true;
          const part: OcxThinkingContent = {
            type: "thinking",
            thinking: reasoningText,
            signature: unsignedReasoningSignature(reasoningText),
          };
          // Consecutive unsigned reasoning folds into one block, as the parser does.
          const previous = pending[pending.length - 1];
          if (previous && !previous.redacted) {
            pending[pending.length - 1] = { ...part, thinking: `${previous.thinking}\n${part.thinking}` };
          } else {
            pending.push(part);
          }
        }
        const text = assistantTextParts(msg.content);
        if (text.length > 0) {
          emitted = true;
          messages.push({
            role: "assistant",
            content: pending.length > 0 ? [...pending, ...text] : text,
            model: modelId,
            timestamp: now,
          });
          pending.length = 0;
        }
        if (msg.tool_calls !== undefined && Array.isArray(msg.tool_calls)) {
          for (const entry of msg.tool_calls) {
            if (!isRec(entry)) continue;
            const fn = isRec(entry.function) ? entry.function : null;
            let name = typeof fn?.name === "string" ? fn.name : typeof entry.name === "string" ? entry.name : "";
            const args = typeof fn?.arguments === "string"
              ? fn.arguments
              : typeof entry.arguments === "string"
                ? entry.arguments
                : JSON.stringify(fn?.arguments ?? entry.arguments ?? {});
            const callId = typeof entry.id === "string" && entry.id.length > 0
              ? entry.id
              : typeof entry.call_id === "string" && entry.call_id.length > 0
                ? entry.call_id
                : `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
            if (!name) name = knownNameByCallId.get(callId) ?? "";
            if (!name) throw new ChatCompletionsRequestError("tool_calls entries require function.name");
            knownNameByCallId.set(callId, name);
            pushToolCall(callId, name, args);
          }
        }
        if (msg.function_call !== undefined && msg.function_call !== null) {
          const value = msg.function_call;
          if (!isRec(value) || typeof value.name !== "string" || value.name.length === 0) {
            throw new ChatCompletionsRequestError("assistant function_call requires a name");
          }
          const args = typeof value.arguments === "string" ? value.arguments : JSON.stringify(value.arguments ?? {});
          const callId = `call_legacy_${String(++legacyCallSequence).padStart(4, "0")}`;
          knownNameByCallId.set(callId, value.name);
          pushToolCall(callId, value.name, args);
          legacyAwaiting.push({ callId, name: value.name });
        }
        break;
      }
      case "function": {
        if (Array.isArray(msg.content) && msg.content.some(part => isRec(part) && chatImageUrlFromPart(part))) {
          throw new ChatCompletionsRequestError(
            "Legacy function-result image translation is not implemented. Use tool_calls and role:tool with tool_call_id.",
          );
        }
        const name = typeof msg.name === "string" ? msg.name : "";
        if (!name) throw new ChatCompletionsRequestError("function messages require a name");
        const pendingIndex = legacyAwaiting.findIndex(call => call.name === name);
        if (pendingIndex < 0) throw new ChatCompletionsRequestError(`function result has no pending call named ${name}`);
        const [call] = legacyAwaiting.splice(pendingIndex, 1);
        pushToolResult(call!.callId, contentToText(msg.content));
        break;
      }
      case "tool": {
        const callId = typeof msg.tool_call_id === "string" ? msg.tool_call_id
          : typeof msg.tool_use_id === "string" ? msg.tool_use_id
          : "";
        if (!callId) throw new ChatCompletionsRequestError("tool messages require tool_call_id");
        const parts = contentParts(msg.content, false);
        pushToolResult(callId, parts.some(part => part.type === "image") ? parts : contentToText(msg.content));
        break;
      }
      default:
        break;
    }
  }
  releaseHeldInstructions();

  if (!emitted && systemParts.length === 0) {
    throw new ChatCompletionsRequestError("messages must include at least one user/assistant/tool turn");
  }
  const tools = toolCatalog(raw);
  const context: OcxContext = {
    ...(systemParts.length > 0 ? { systemPrompt: [nameDestination(systemParts.join("\n\n"), modelId)] } : {}),
    messages,
    ...(tools.length > 0 ? { tools } : {}),
  };
  return { modelId, context: normalizeVisualizationContext(context) };
}

/**
 * Put a directly decoded conversation onto the request the core parsed from the settings-only
 * body. The conversation is re-decoded if the core settled a different model id than the one the
 * ingress decoded for, because identity naming and assistant placeholders carry it. The tool
 * choice is checked against the decoded catalog, which the settings-only parse could not see.
 */
export function withDirectChatConversation(
  base: OcxParsedRequest,
  chatBody: unknown,
  decoded: ChatIrConversation,
): OcxParsedRequest {
  const conversation = decoded.modelId === base.modelId ? decoded : chatConversationToIr(chatBody, base.modelId);
  const choice = base.options.toolChoice;
  if (choice && typeof choice === "object") {
    const selectors = "allowedTools" in choice ? choice.allowedTools : [choice.name];
    const resolver = createToolChoiceResolver(conversation.context.tools ?? []);
    for (const selector of selectors) {
      if (resolver.candidateCount(selector) > 1) throw new Error(`ambiguous tool_choice name: ${selector}`);
    }
  }
  return { ...base, context: conversation.context };
}

/**
 * The policy-routing evidence the core would have read from the bridge body
 * (`evidenceFromBody`): a non-empty tool catalog, and an image in a user message. An image in a
 * tool result sits under `output` on the bridge body, which that scan does not read, so it is
 * not evidence here either.
 */
export function chatIrRouteEvidence(conversation: ChatIrConversation): PolicyRequestEvidence {
  const tools = (conversation.context.tools?.length ?? 0) > 0;
  const image = conversation.context.messages.some(message => message.role === "user"
    && Array.isArray(message.content) && message.content.some(part => part.type === "image"));
  return {
    ...(tools ? { toolsRequired: true } : {}),
    ...(image ? { imageInputRequired: true } : {}),
  };
}
