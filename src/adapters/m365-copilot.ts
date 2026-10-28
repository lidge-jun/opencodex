import { createHash } from "node:crypto";
import type { ProviderAdapter, IncomingMeta } from "./base";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../types";
import { namespacedToolName } from "../types";
import { createOpenAIChatAdapter } from "./openai-chat";
import { M365_COPILOT_BASE_URL } from "../providers/m365-copilot-models";
import { m365CopilotClaims } from "../oauth/m365-copilot";
import { SendBudgetExhaustedError } from "../lib/upstream-retry";
import { estimateTokens } from "../lib/token-estimate";
import { formatMessages, formatToolResponse, parseToolCalls, isProseDocument, fabricatedToolResponseAt, truncateAtFabricatedToolResponse, type Message, type ToolDef, type ToolChoice } from "./m365-copilot/tools";
import { defaultFramingForModel } from "./m365-copilot/fenced";
import { createM365Conversation, runM365CopilotTurn, M365CopilotTurnError, type M365Conversation, type M365TurnOptions } from "./m365-copilot/transport";
import { m365ImageUrls, uploadM365Images } from "./m365-copilot/images";

interface ConversationState { conversation: M365Conversation; sent: number; prefix: string; sentImages: number; imagePrefix: string; accessed: number; tail: Promise<void>; pendingNote?: string }
const conversations = new Map<string, ConversationState>();
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function clearM365CopilotConversations(): void { conversations.clear(); }

export function createM365CopilotAdapter(provider: OcxProviderConfig, deps: { turn?: (options: M365TurnOptions) => Promise<string> } = {}): ProviderAdapter {
  const formatter = createOpenAIChatAdapter({ ...provider, adapter: "openai-chat" });
  return {
    name: "m365-copilot", reportsPhysicalSends: true,
    buildRequest: (parsed, incoming) => formatter.buildRequest(parsed, incoming),
    parseStream: (response, budget, tier) => formatter.parseStream(response, budget, tier),
    parseResponse: (response, budget, tier) => formatter.parseResponse!(response, budget, tier),
    async runTurn(parsed: OcxParsedRequest, incoming: IncomingMeta, emit: (event: AdapterEvent) => void) {
      if (provider.baseUrl.replace(/\/$/, "") !== M365_COPILOT_BASE_URL) throw new Error("Microsoft 365 Copilot requires its fixed Microsoft endpoint");
      const token = provider.apiKey;
      if (!token) { emit({ type: "error", message: "Sign in to Microsoft 365 Copilot first", status: 401, retryable: false }); return; }
      const claims = m365CopilotClaims(token);
      const request = await formatter.buildRequest(parsed, incoming);
      let messages: Message[];
      let tools: ToolDef[] | undefined;
      let toolChoice: ToolChoice;
      try { const body = JSON.parse(request.body); messages = body.messages; tools = body.tools; toolChoice = body.tool_choice; }
      finally { request.releaseBodyObservation?.(); }
      request.body = "";
      if (!Array.isArray(messages)) throw new Error("Microsoft 365 Copilot request has no messages");
      const first = messages.find(message => message.role === "user");
      const key = digest(JSON.stringify([claims.oid, claims.tid, parsed.modelId, incoming.headers.get("session_id") ?? incoming.headers.get("x-codex-session-id"), first?.content, tools?.map(tool => tool.function.name).sort()]));
      for (const [id, state] of conversations) if (Date.now() - state.accessed > 30 * 60_000) conversations.delete(id);
      let state = conversations.get(key);
      if (!state) {
        if (conversations.size >= 64) conversations.delete(conversations.keys().next().value!);
        state = { conversation: createM365Conversation(), sent: 0, prefix: "", sentImages: 0, imagePrefix: "", accessed: Date.now(), tail: Promise.resolve() };
        conversations.set(key, state);
      }
      const previous = state.tail;
      let release!: () => void;
      state.tail = new Promise(resolve => { release = resolve; });
      await previous;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        incoming.abortSignal?.throwIfAborted();
        const imageUrls = m365ImageUrls(parsed.context.messages);
        if (messages.length <= state.sent || state.prefix !== digest(JSON.stringify(messages.slice(0, state.sent)))
          || state.sentImages > imageUrls.length || state.sentImages > 0 && state.imagePrefix !== digest(JSON.stringify(imageUrls.slice(0, state.sentImages)))) {
          state.conversation = createM365Conversation(); state.sent = 0; state.sentImages = 0; state.imagePrefix = ""; state.pendingNote = undefined;
        }
        const fresh = messages.slice(state.sent).filter(message => message.role !== "assistant");
        let text = state.sent === 0 ? formatMessages(messages, tools, toolChoice, undefined, defaultFramingForModel(parsed.modelId))
          : fresh.map(message => message.role === "tool" ? formatToolResponse(message, messages) : formatMessages([message])).join("\n\n");
        if (state.pendingNote) { text = state.pendingNote + "\n" + text; state.pendingNote = undefined; }
        if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new M365CopilotTurnError("Microsoft 365 Copilot request exceeded its size limit", 413);
        const toolMode = !!tools?.length && toolChoice !== "none";
        let emittedToolCalls = 0;
        let thinkingText = "";
        heartbeat = setInterval(() => emit({ type: "heartbeat" }), 5_000);
        const images = await uploadM365Images(imageUrls.slice(state.sentImages), token, parsed.modelId, state.conversation.conversationId, provider, incoming.abortSignal, incoming.translatorBudget, incoming.beforePhysicalSend);
        const answer = await (deps.turn ?? runM365CopilotTurn)({ token, model: parsed.modelId, text, images, conversation: state.conversation, signal: incoming.abortSignal, budget: incoming.translatorBudget,
          route: provider,
          onText: delta => { if (!toolMode) emit({ type: "text_delta", text: delta }); },
          onThinking: thinking => { if (!thinking) return; thinkingText += thinking; emit({ type: "thinking_delta", thinking }); },
          beforeSend: () => {
            incoming.beforePhysicalSend?.();
            const admission = incoming.sendBudget?.reserveDispatch({ sendClass: "initial", targetKey: "m365-copilot|" + parsed.modelId + "|" + digest(claims.oid + claims.tid) });
            if (admission && !admission.allowed || admission?.allowed && !admission.permit.use()) throw new SendBudgetExhaustedError("m365-copilot");
            incoming.onPhysicalSend?.({ ordinal: 1 });
          },
        });
        state.sent = messages.length; state.prefix = digest(JSON.stringify(messages)); state.accessed = Date.now();
        state.sentImages = imageUrls.length; state.imagePrefix = digest(JSON.stringify(imageUrls));
        if (toolMode) {
          if (fabricatedToolResponseAt(answer, tools) >= 0) state.pendingNote = "Only tool calls returned to the client were executed. Any tool output you wrote yourself did not happen; the following is the real client output.";
          const cleaned = truncateAtFabricatedToolResponse(answer, tools);
          const result = parseToolCalls(cleaned, tools);
          if (isProseDocument(result, cleaned, tools)) emit({ type: "text_delta", text: cleaned });
          else {
            if (result.textContent) emit({ type: "text_delta", text: result.textContent });
            for (const call of result.toolCalls) {
              if (!tools!.some(tool => tool.function.name === call.function.name)) throw new M365CopilotTurnError("Microsoft 365 Copilot returned an undeclared tool");
              const alias = request.convertedRoutedNamespaceToolAliases?.get(call.function.name);
              const name = alias ? namespacedToolName(alias.namespace, alias.name) : call.function.name;
              const original = parsed.context.tools?.find(tool => namespacedToolName(tool.namespace, tool.name) === name);
              const args = JSON.parse(call.function.arguments);
              emit({ type: "tool_call_start", id: call.id, name });
              emit({ type: "tool_call_delta", arguments: original?.freeform && typeof args.input === "string" ? args.input : call.function.arguments });
              emit({ type: "tool_call_end" });
              emittedToolCalls++;
            }
          }
        }
        // ChatHub reports no token counts; estimate from the full prompt the model sees and its reply.
        // shortcut: image tokens use a fixed allowance, replace when Microsoft exposes image usage.
        const inputTokens = estimateTokens(JSON.stringify([messages, tools ?? []], (key, value) => key === "image_url" ? "[image]" : value), parsed.modelId) + imageUrls.length * 256;
        const outputTokens = estimateTokens(answer + thinkingText, parsed.modelId);
        emit({ type: "done", stopReason: emittedToolCalls ? "tool_use" : "stop", endTurn: emittedToolCalls === 0, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: true } });
      } catch (error) {
        conversations.delete(key);
        if (error instanceof M365CopilotTurnError) emit({ type: "error", message: error.message, status: error.status, retryable: false });
        else throw error;
      } finally { if (heartbeat) clearInterval(heartbeat); release(); }
    },
  };
}
