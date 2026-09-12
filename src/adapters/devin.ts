/**
 * Devin / Cognition / Windsurf adapter.
 *
 * Uses the unofficial cloud-direct Connect-RPC client (GetChatMessage).
 * OpenCodex injects the OAuth API key onto provider.apiKey
 * before runTurn. This adapter maps OcxContext <-> ChatHistoryItem and
 * streams CloudChatEvent into AdapterEvent.
 */
import type { AdapterEvent, OcxAssistantMessage, OcxContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig, OcxTool, OcxToolCall, OcxToolResultMessage, OcxUsage } from "../types";
import type { IncomingMeta, ProviderAdapter } from "./base";
import { streamChatEvents, allocateCascadeId, CloudChatError, type ChatHistoryItem, type ToolDef } from "./devin/cloud-direct";
import { getCachedCatalog } from "./devin/cloud-direct/catalog";
import { DEVIN_DEFAULT_API_SERVER, resolveDevinApiServer } from "../oauth/devin";

export const DEVIN_API_SERVER = DEVIN_DEFAULT_API_SERVER;

const EFFORT_SUFFIXES = new Set(["low", "medium", "high", "xhigh", "max", "none", "1m", "max-1m", "none-1m", "fast"]);

/**
 * Cognition's catalog spells model ids with hyphens (`swe-1-7`), but the same
 * models appear elsewhere - other proxies, hand-written config - with the dotted
 * version number (`swe-1.7`). Left alone, a dotted id misses every catalog
 * lookup and then gets an effort suffix appended to a name the server does not
 * know, which Cognition answers with an opaque permission_denied.
 */
export function normalizeDevinModelId(modelId: string): string {
  return modelId.replace(/\./g, "-");
}

function hasEffortSuffix(modelId: string): boolean {
  const parts = modelId.split("-");
  return parts.length > 1 && EFFORT_SUFFIXES.has(parts[parts.length - 1]!);
}

/**
 * Resolve the wire model UID using the live catalog as the source of truth.
 * Cognition's catalog lists most models with an effort suffix
 * (e.g. `gpt-5-6-sol-high`); the base id alone is not accepted for those.
 *
 * If the catalog is available: use the exact UID when it exists, otherwise
 * append the reasoning effort (or `medium` default) and pick a variant the
 * account actually has.
 *
 * If the catalog is unavailable (degraded mode): append the effort suffix
 * for any base id that doesn't already carry one, mirroring the catalog shape.
 */
async function resolveWireModelUid(
  rawModelId: string,
  apiKey: string,
  host: string,
  reasoningEffort?: string,
): Promise<string> {
  const modelId = normalizeDevinModelId(rawModelId);
  if (hasEffortSuffix(modelId)) return modelId;
  const catalog = await getCachedCatalog(apiKey, host);
  if (catalog) {
    if (catalog.byUid.has(modelId)) return modelId;
    const effort = reasoningEffort && EFFORT_SUFFIXES.has(reasoningEffort) ? reasoningEffort : "medium";
    const suffixed = `${modelId}-${effort}`;
    if (catalog.byUid.has(suffixed)) return suffixed;
    // Fall back to any enabled variant of this base model.
    for (const uid of catalog.byUid.keys()) {
      if (uid.startsWith(modelId + "-") && !catalog.byUid.get(uid)?.disabled) return uid;
    }
  }
  // Degraded mode: append the default effort suffix.
  const effort = reasoningEffort && EFFORT_SUFFIXES.has(reasoningEffort) ? reasoningEffort : "medium";
  return `${modelId}-${effort}`;
}

export class DevinMissingCredentialError extends Error {
  constructor() {
    super("Devin live transport requires a Devin API key. Run ocx login devin to sign in with your Cognition/Devin account.");
    this.name = "DevinMissingCredentialError";
  }
}

export function resolveDevinToken(provider: OcxProviderConfig, headers?: Headers): string {
  const providerKey = provider.apiKey?.trim();
  if (providerKey) return providerKey;
  const forwarded = headers?.get("authorization") ?? headers?.get("Authorization");
  if (forwarded?.toLowerCase().startsWith("bearer ")) return forwarded.slice("bearer ".length).trim();
  const envToken = process.env.OPENCODEX_DEVIN_TEST_TOKEN?.trim();
  if (envToken) return envToken;
  throw new DevinMissingCredentialError();
}

function textFromParts(content: string | OcxContentPart[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part.type === "text" ? part.text : "")).filter(Boolean).join("\n");
}

function toolResultText(message: OcxToolResultMessage): string {
  const body = textFromParts(message.content);
  return message.isError ? ("ERROR: " + body) : body;
}

function assistantToolCalls(message: OcxAssistantMessage): Array<{ id: string; name: string; arguments: string }> {
  return message.content
    .filter((part): part is OcxToolCall => part.type === "toolCall")
    .map((part) => ({
      id: part.id,
      name: part.name,
      arguments: JSON.stringify(part.arguments ?? {}),
    }));
}

function assistantText(message: OcxAssistantMessage): string {
  return message.content
    // Thinking stays out of the replayed content. Cognition has no reasoning
    // replay field, and folding chain-of-thought into assistant text sends it
    // back as visible prior output - which the model then treats as something
    // it said to the user.
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

export function mapOcxMessagesToDevin(parsed: OcxParsedRequest): ChatHistoryItem[] {
  const items: ChatHistoryItem[] = [];
  const system = parsed.context.systemPrompt?.filter((line) => line.trim().length > 0).join("\n");
  if (system) items.push({ role: "system", content: system });

  for (const message of parsed.context.messages) {
    const mapped = mapOneMessage(message);
    if (mapped) items.push(mapped);
  }
  return items;
}

function mapOneMessage(message: OcxMessage): ChatHistoryItem | undefined {
  if (message.role === "user" || message.role === "developer") {
    const text = textFromParts(message.content).trim();
    if (!text) return undefined;
    return { role: message.role === "developer" ? "system" : "user", content: text };
  }
  if (message.role === "assistant") {
    const toolCalls = assistantToolCalls(message);
    const text = assistantText(message);
    if (!text && toolCalls.length === 0) return undefined;
    return {
      role: "assistant",
      content: text || "",
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "tool",
      content: toolResultText(message),
      tool_call_id: message.toolCallId,
    };
  }
  return undefined;
}

export function mapOcxToolsToDevin(tools: OcxTool[] | undefined): ToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ?? { type: "object", properties: {} },
  }));
}

export function createDevinAdapter(
  provider: OcxProviderConfig,
  context: { providerId?: string } = {},
): ProviderAdapter {
  // Which credential slot holds this row's tenant. Defaults to `devin` so every
  // existing caller — including the tests that construct this adapter directly —
  // behaves exactly as before.
  const credentialProviderId = context.providerId ?? "devin";
  const cascadeIds = new Map<string, string>();
  const CASCADE_ID_MAX = 256;

  return {
    name: "devin",

    buildRequest() {
      return {
        url: provider.baseUrl || DEVIN_API_SERVER,
        method: "POST",
        headers: {},
        body: "",
      };
    },

    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield {
        type: "error",
        message: "Devin adapter uses runTurn; the fetch/parseStream path is disabled.",
      };
    },

    async runTurn(parsed: OcxParsedRequest, incoming: IncomingMeta, emit: (event: AdapterEvent) => void) {
      if (incoming.abortSignal?.aborted) {
        emit({ type: "error", message: "Devin turn was aborted before start." });
        return;
      }
      let apiKey: string;
      try {
        apiKey = resolveDevinToken(provider, incoming.headers);
      } catch (error) {
        emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
        return;
      }

      const threadKey = parsed._clientThreadId || parsed.previousResponseId || "default";
      let cascadeId = cascadeIds.get(threadKey);
      if (!cascadeId) {
        // Evict oldest entries to bound memory in long-running proxy processes.
        if (cascadeIds.size >= CASCADE_ID_MAX) {
          const firstKey = cascadeIds.keys().next().value;
          if (firstKey) cascadeIds.delete(firstKey);
        }
        cascadeId = allocateCascadeId();
        cascadeIds.set(threadKey, cascadeId);
      }

      const rawModelId = parsed.modelId.includes("/") ? parsed.modelId.slice(parsed.modelId.lastIndexOf("/") + 1) : parsed.modelId;
      // The signed-in account's tenant decides the host, not the static registry
      // entry: an EU or FedStart account that used provider.baseUrl would send
      // every RPC to the US server it is not provisioned on.
      const host = resolveDevinApiServer(provider.baseUrl, credentialProviderId);
      const modelUid = await resolveWireModelUid(rawModelId, apiKey, host, parsed.options.reasoning);
      let openToolId: string | undefined;
      let usage: OcxUsage | undefined;
      let stopReason: string | undefined;

      const closeOpenTool = () => {
        if (!openToolId) return;
        emit({ type: "tool_call_end" });
        openToolId = undefined;
      };

      try {
        for await (const event of streamChatEvents({
          apiKey,
          apiServerUrl: host,
          modelUid,
          messages: mapOcxMessagesToDevin(parsed),
          tools: mapOcxToolsToDevin(parsed.context.tools),
          cascadeId,
          // Without these the request falls back to the encoder's defaults
          // (8192 output, a 128k context window, temperature 0.7), so a client
          // that asked for a 4k cap never got one.
          completionOpts: {
            ...(typeof parsed.options.maxOutputTokens === "number" ? { maxOutputTokens: parsed.options.maxOutputTokens } : {}),
            ...(typeof parsed.options.temperature === "number" ? { temperature: parsed.options.temperature } : {}),
            ...(typeof parsed.options.topP === "number" ? { topP: parsed.options.topP } : {}),
          },
          signal: incoming.abortSignal,
        })) {
          if (incoming.abortSignal?.aborted) {
            // Emitting nothing here left the bridge to synthesize adapter_eof.
            // Say what happened instead, the way the other runTurn-only adapter
            // does, and carry any usage already seen.
            closeOpenTool();
            emit({ type: "error", message: "Devin turn was aborted.", ...(usage ? { usage } : {}) });
            return;
          }
          if (event.kind === "text") {
            closeOpenTool();
            if (event.text) emit({ type: "text_delta", text: event.text });
            continue;
          }
          if (event.kind === "reasoning") {
            if (event.text) emit({ type: "thinking_delta", thinking: event.text });
            continue;
          }
          if (event.kind === "tool_call_start") {
            closeOpenTool();
            openToolId = event.id;
            emit({ type: "tool_call_start", id: event.id, name: event.name });
            continue;
          }
          if (event.kind === "tool_call_args") {
            if (event.argsDelta) emit({ type: "tool_call_delta", arguments: event.argsDelta });
            continue;
          }
          if (event.kind === "finish") {
            closeOpenTool();
            // A natural completion carries no stopReason: the bridge reads any
            // truthy value as "this turn did not reach a final answer", so
            // reporting "stop" costs every clean Devin turn its final_answer
            // phase.
            stopReason = event.reason === "length" ? "max_tokens" : event.reason === "stop" ? undefined : event.reason;
            continue;
          }
          if (event.kind === "usage") {
            const total = event.totalTokens ?? ((event.promptTokens ?? 0) + (event.completionTokens ?? 0));
            usage = {
              inputTokens: event.promptTokens ?? 0,
              outputTokens: event.completionTokens ?? 0,
              ...(total > 0 ? { totalTokens: total } : {}),
              ...(event.cachedInputTokens !== undefined ? { cachedInputTokens: event.cachedInputTokens } : {}),
              ...(event.cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens: event.cacheCreationInputTokens } : {}),
              ...(event.reasoningTokens !== undefined ? { reasoningOutputTokens: event.reasoningTokens } : {}),
            };
            continue;
          }
        }
        closeOpenTool();
        if (incoming.abortSignal?.aborted) {
          emit({ type: "error", message: "Devin turn was aborted.", ...(usage ? { usage } : {}) });
        } else {
          emit({ type: "done", ...(usage ? { usage } : {}), ...(stopReason ? { stopReason } : {}) });
        }
      } catch (error) {
        closeOpenTool();
        if (incoming.abortSignal?.aborted) {
          emit({ type: "error", message: "Devin turn was aborted.", ...(usage ? { usage } : {}) });
          return;
        }
        const message = error instanceof CloudChatError
          ? ("Devin cloud error" + (error.code ? " " + error.code : "") + ": " + error.message)
          : error instanceof Error ? error.message : String(error);
        // Usage that already arrived is still real; dropping it loses the
        // accounting for a turn that did most of its work before failing.
        emit({ type: "error", message, ...(usage ? { usage } : {}) });
      }
    },
  };
}
