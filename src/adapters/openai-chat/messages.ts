import { isNativeOpenAIChatTarget, stripBracketedModelSuffix } from "./wire";
import { reasoningDetailSegmentForWire } from "./response-events";
import { isVolcengineArkPaygChatTarget } from "./tool-schema";
import { contentPartsToText } from "../image";
import { EMPTY_TOOL_OUTPUT_ANNOTATION, isWhitespaceOnlyTextPartArray } from "../empty-tool-output-annotation";
import { identifyRoutedModel } from "../identity";
import { buildNonOpenAIToolCatalogNudgeForTools, shouldInjectNonOpenAIToolCatalogNudge } from "../tool-catalog-nudge";
import { registryEntryForProviderDestination } from "../../providers/registry";
import { peekReasoningForCall } from "../../responses/reasoning-replay-cache";
import type { OcxAssistantMessage, OcxContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig, OcxTextContent, OcxThinkingContent, OcxToolCall } from "../../types";
import { modelInList, namespacedToolName } from "../../types";

/**
 * The translated Chat route has no video mapping: this adapter does not implement one,
 * and the marker records that fact so the payload is not dropped in silence.
 *
 * The wording is deliberately about opencodex's own translation, not the provider or
 * model. An earlier revision said "unsupported by this provider", which attributed an
 * opencodex mapping limit to upstream capability the proxy has not established. Native
 * Chat passthrough and Google inline video are unaffected by this route.
 */
const VIDEO_UNSUPPORTED_MARKER = "[video omitted: the translated Chat route has no video mapping]";

export function developerSystemText(message: OcxMessage): string | undefined {
  if (message.role !== "developer") return undefined;
  if (typeof message.content === "string") return message.content;
  if (message.content.some(part => part.type === "image")) return undefined;
  return message.content.map(part => (part as OcxTextContent).text).join("");
}

/**
 * Chat-completions image_url parts for images carried inside a tool result (issue #888). role:"tool"
 * content is text-only on every chat provider, so these ride in a follow-up user message instead of
 * being flattened to the "[image]" marker the model can't actually see. Data URLs and remote https
 * URLs are both valid in image_url.url, unlike Gemini inline_data which needs base64.
 */
export function toolResultTextForWire(content: string | OcxContentPart[], annotateEmpty = false): string {
  // An empty content array is a present-but-empty result; `contentPartsToText` would
  // otherwise fall back to the "[image]" marker and hide the emptiness from the model.
  if (annotateEmpty && Array.isArray(content) && content.length === 0) return EMPTY_TOOL_OUTPUT_ANNOTATION;
  if (typeof content === "string") {
    if (annotateEmpty && content.trim() === "") return EMPTY_TOOL_OUTPUT_ANNOTATION;
    return content;
  }
  const text = content.filter((p) => p.type === "text").map((p) => (p as OcxTextContent).text).join("");
  // A whitespace-only text-part array is the array twin of a blank string; the
  // shared emptiness contract (same module as the Responses adapter) annotates it
  // instead of forwarding whitespace the model silently accepts. Image parts and
  // any other non-text part keep the array non-empty.
  if (annotateEmpty && isWhitespaceOnlyTextPartArray(content)) {
    return EMPTY_TOOL_OUTPUT_ANNOTATION;
  }
  if (text) {
    const untransportableImages = content.filter((p) => p.type === "image" && !p.imageUrl).length;
    return `${text}${"[image]".repeat(untransportableImages)}`;
  }
  return contentPartsToText(content);
}

export function toolResultImageChatParts(content: string | OcxContentPart[]): unknown[] {
  if (typeof content === "string") return [];
  const parts: unknown[] = [];
  for (const p of content) {
    if (p.type !== "image" || !p.imageUrl) continue;
    parts.push({ type: "image_url", image_url: { url: p.imageUrl, ...(p.detail ? { detail: p.detail } : {}) } });
  }
  return parts;
}

export function messagesToChatFormat(parsed: OcxParsedRequest, provider: OcxProviderConfig): unknown[] {
  const out: unknown[] = [];
  const { context, options } = parsed;
  const replayCacheScope = parsed._reasoningReplayScope;

  interface PendingToolCall { id: string; name: string }
  let pendingToolCalls: PendingToolCall[] = [];
  let deferredBarrierMessages: unknown[] = [];
  let pendingToolResultImageParts: unknown[] = [];
  let mintedIdSeq = 0;
  const seenWireCallIds = new Set<string>();

  const mintCallId = (): string => {
    let id = "";
    do {
      id = `call_ocx_minted_${++mintedIdSeq}`;
    } while (seenWireCallIds.has(id));
    seenWireCallIds.add(id);
    return id;
  };

  const releaseDeferredBarriers = (): void => {
    if (deferredBarrierMessages.length === 0) return;
    out.push(...deferredBarrierMessages);
    deferredBarrierMessages = [];
  };

  const flushToolResultImages = (): void => {
    if (pendingToolResultImageParts.length === 0) return;
    out.push({
      role: "user",
      content: [
        { type: "text", text: "[ocx] image output from the preceding tool result(s):" },
        ...pendingToolResultImageParts,
      ],
    });
    pendingToolResultImageParts = [];
  };

  const flushPendingToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return;
    for (const call of pendingToolCalls) {
      out.push({
        role: "tool",
        tool_call_id: call.id,
        content: `[ocx] no tool result was recorded for "${call.name}"; execution status unknown — do not treat this as success, failure, or user-provided input.`,
      });
    }
    pendingToolCalls = [];
    flushToolResultImages();
    releaseDeferredBarriers();
  };

  const nativeOpenAI = isNativeOpenAIChatTarget(provider);
  // Hoisting a newly appended reminder rewrites the reusable prompt prefix.
  // Keep this compatibility exception on the destination/model tested with OCG.
  const chronologicalSystem = parsed.modelId === "deepseek-v4.1-flash"
    && registryEntryForProviderDestination(provider)?.id === "opencode-go";
  const toolCatalogNudge = shouldInjectNonOpenAIToolCatalogNudge(provider)
    ? buildNonOpenAIToolCatalogNudgeForTools(context.tools, options.toolChoice)
    : undefined;
  const developerSystemParts = nativeOpenAI || chronologicalSystem
    ? []
    : context.messages
      .map(developerSystemText)
      .filter((part): part is string => part !== undefined && part.length > 0);
  const systemParts = [
    ...(context.systemPrompt ?? []),
    ...developerSystemParts,
    ...(toolCatalogNudge ? [toolCatalogNudge] : []),
  ];
  if (systemParts.length > 0) {
    const wireModelId = provider.modelSuffixBracketStrip
      ? stripBracketedModelSuffix(parsed.modelId)
      : parsed.modelId;
    const sys = identifyRoutedModel(systemParts.join("\n\n"), wireModelId);
    out.push({ role: "system", content: sys });
  }

  for (const msg of context.messages) {
    switch (msg.role) {
      case "user":
      case "developer": {
        const parts = typeof msg.content === "string" ? undefined : msg.content as OcxContentPart[];
        const hasImages = parts?.some(p => p.type === "image") ?? false;
        let chatMsg: Record<string, unknown>;
        if (msg.role === "developer" && !hasImages) {
          if (!nativeOpenAI && !chronologicalSystem) break;
          const text = typeof msg.content === "string"
            ? msg.content
            : parts!.map(p => (p as OcxTextContent).text).join("");
          // A non-text timeline part (video, for example) serializes to nothing here.
          // The generic path drops such a message; the chronological exception must not
          // turn it into an empty system message that some upstreams reject.
          if (!nativeOpenAI && text.length === 0) break;
          chatMsg = { role: nativeOpenAI ? "developer" : "system", content: text };
        } else if (typeof msg.content === "string") {
          chatMsg = { role: "user", content: msg.content };
        } else if (!hasImages) {
          // A video part has no `text`, so joining it produced "" and the whole message
          // was dropped: a video-only or text-plus-video turn vanished silently. OpenAI's
          // Chat Completions wire has no video content part, so state the omission
          // instead of losing it. Scoped to this adapter's wire, not a claim about video
          // support in general — native Chat passthrough and Google inline video are
          // unaffected.
          chatMsg = {
            role: "user",
            content: parts!.map(p => (p.type === "video"
              ? VIDEO_UNSUPPORTED_MARKER
              : (p as OcxTextContent).text)).join(""),
          };
        } else {
          const chatParts = parts!.map(p => {
            if (p.type === "image") {
              return { type: "image_url", image_url: { url: p.imageUrl, ...(p.detail ? { detail: p.detail } : {}) } };
            }
            // Previously this produced { type: "text", text: undefined } for a video
            // part — a malformed part, worse than a drop because it can fail upstream
            // schema validation.
            if (p.type === "video") return { type: "text", text: VIDEO_UNSUPPORTED_MARKER };
            return { type: "text", text: (p as OcxTextContent).text };
          });
          chatMsg = { role: "user", content: chatParts };
        }
        if (pendingToolCalls.length > 0) deferredBarrierMessages.push(chatMsg);
        else out.push(chatMsg);
        break;
      }
      case "assistant": {
        const aMsg = msg as OcxAssistantMessage;
        const textParts = aMsg.content.filter(p => p.type === "text") as OcxTextContent[];
        const thinkingParts = aMsg.content.filter(p => p.type === "thinking") as OcxThinkingContent[];
        const toolCalls = aMsg.content.filter(p => p.type === "toolCall") as OcxToolCall[];
        const chatMsg: Record<string, unknown> = { role: "assistant" };
        if (textParts.length > 0) chatMsg.content = textParts.map(p => p.text).join("");
        let reasoningContent = thinkingParts.map(p => p.thinking).join("");
        if (
          reasoningContent.length === 0
          && toolCalls.length > 0
          && modelInList(provider.preserveReasoningContentModels, parsed.modelId)
        ) {
          const cached = toolCalls
            .map(tc => (tc.id ? peekReasoningForCall(tc.id, replayCacheScope) : undefined))
            .filter((text): text is string => typeof text === "string" && text.length > 0);
          // Parallel calls share one preceding reasoning block, which is
          // recorded under every call id — join unique texts only.
          if (cached.length > 0) {
            reasoningContent = [...new Set(cached)].join("\n");
          } else if (modelInList(provider.requiresReasoningPlaceholderModels ?? provider.preserveReasoningContentModels, parsed.modelId)) {
            // Fallback (extends #950, closes #1193): the replay cache is
            // bounded (64 entries / 256 KiB / 1 h TTL) and always misses on
            // long sessions, and some tool rounds carry no recorded reasoning
            // at all. DeepSeek thinking mode rejects ANY tool_call assistant
            // message missing reasoning_content with HTTP 400, so inject a
            // minimal placeholder rather than emit a bare continuation the
            // upstream will reject. Scoped to requiresReasoningPlaceholderModels
            // (defaulting to the preserve list): preserve-listed providers with
            // toggleable thinking (MiniMax low effort) opt out with `[]` so
            // non-thinking histories are never given a fabricated placeholder.
            reasoningContent = " ";
          }
        }
        if (reasoningContent.length > 0 && modelInList(provider.preserveReasoningContentModels, parsed.modelId)) {
          // MiniMax's interleaved-thinking contract requires the structured
          // reasoning_details array back on the next turn; a reasoning_content
          // string is the native-format pass-back the docs mark unsupported.
          if (modelInList(provider.reasoningDetailsModels, parsed.modelId)) {
            chatMsg.reasoning_details = [reasoningDetailSegmentForWire(reasoningContent)];
          } else {
            chatMsg.reasoning_content = reasoningContent;
          }
        }
        const hasReplayedReasoning = chatMsg.reasoning_content !== undefined || chatMsg.reasoning_details !== undefined;
        if (chatMsg.content === undefined && toolCalls.length === 0 && !hasReplayedReasoning) break;
        flushPendingToolCalls();
        const wireToolCalls = toolCalls.map(tc => {
          let id = tc.id;
          if (!id) id = mintCallId();
          else seenWireCallIds.add(id);
          return { tc, id };
        });
        if (wireToolCalls.length > 0) {
          chatMsg.tool_calls = wireToolCalls.map(({ tc, id }) => ({
            id,
            type: "function",
            function: { name: namespacedToolName(tc.namespace, tc.name), arguments: JSON.stringify(tc.arguments) },
          }));
          if (!chatMsg.content) chatMsg.content = emptyAssistantContent(provider);
        }
        if (hasReplayedReasoning && chatMsg.content === undefined && chatMsg.tool_calls === undefined) {
          chatMsg.content = emptyAssistantContent(provider);
        }
        out.push(chatMsg);
        pendingToolCalls = wireToolCalls.map(({ tc, id }) => ({ id, name: namespacedToolName(tc.namespace, tc.name) }));
        break;
      }
      case "toolResult": {
        let toolCallId = msg.toolCallId;
        const matchIdx = toolCallId ? pendingToolCalls.findIndex(c => c.id === toolCallId) : -1;
        if (matchIdx >= 0 && toolCallId) {
          out.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: toolResultTextForWire(msg.content, provider.annotateEmptyToolOutputs === true),
          });
          pendingToolResultImageParts.push(...toolResultImageChatParts(msg.content));
          pendingToolCalls.splice(matchIdx, 1);
          if (pendingToolCalls.length === 0) {
            flushToolResultImages();
            releaseDeferredBarriers();
          }
        } else {
          if (!toolCallId) toolCallId = `call_orphan_${out.length}`;
          flushPendingToolCalls();
          const name = safeToolName(msg.toolName);
          const cachedReasoning =
            toolCallId && modelInList(provider.preserveReasoningContentModels, parsed.modelId)
              ? peekReasoningForCall(toolCallId, replayCacheScope)
              : undefined;
          // Same fallback as the main-assistant path: never emit a bare orphan
          // tool_call continuation on a thinking-mode provider — inject a
          // placeholder when the replay cache missed (the bounded cache can
          // always miss on long sessions), or DeepSeek thinking mode 400s.
          // Gate on the preserve list too: reasoning_content is only ever
          // serialized for preserve-listed models, so a requires-only custom
          // entry must not fabricate it on this path (P2 on #1205).
          // `||` (not `??`): the cache never stores empty strings, but treat a
          // falsy hit as a miss so the placeholder still fires.
          const orphanReasoning =
            cachedReasoning
            || (modelInList(provider.preserveReasoningContentModels, parsed.modelId)
              && modelInList(provider.requiresReasoningPlaceholderModels ?? provider.preserveReasoningContentModels, parsed.modelId)
              ? " "
              : undefined);
          const orphanReasoningFields: Record<string, unknown> = !orphanReasoning
            ? {}
            : modelInList(provider.reasoningDetailsModels, parsed.modelId)
              ? { reasoning_details: [reasoningDetailSegmentForWire(orphanReasoning)] }
              : { reasoning_content: orphanReasoning };
          out.push({
            role: "assistant",
            content: emptyAssistantContent(provider),
            ...orphanReasoningFields,
            tool_calls: [{
              id: toolCallId,
              type: "function",
              function: { name, arguments: "{}" },
            }],
          });
          seenWireCallIds.add(toolCallId);
          out.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: toolResultTextForWire(msg.content, provider.annotateEmptyToolOutputs === true),
          });
          pendingToolResultImageParts.push(...toolResultImageChatParts(msg.content));
          flushToolResultImages();
        }
        break;
      }
    }
  }

  flushPendingToolCalls();
  releaseDeferredBarriers();
  return out;
}

export function safeToolName(name: string | undefined): string {
  const raw = name && name.trim().length > 0 ? name : "tool_result";
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized;
}

export function emptyAssistantContent(provider: OcxProviderConfig): string | { type: "text"; text: string }[] {
  return isVolcengineArkPaygChatTarget(provider) ? [{ type: "text", text: "" }] : "";
}
