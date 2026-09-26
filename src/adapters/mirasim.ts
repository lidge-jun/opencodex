import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../types";
import type { TranslatorBudget } from "../lib/translator-budget";
import type { AdapterTierMetadata } from "../providers/fastwire";
import { createAnthropicAdapter } from "./anthropic";
import type { AdapterFetchContext, AdapterRequest, ProviderAdapter } from "./base";
import { createResponsesPassthroughAdapter } from "./openai-responses";
import {
  fetchMirasim,
  MIRASIM_INTERNAL_THREAD_HEADER,
  MIRASIM_INTERNAL_WIRE_HEADER,
} from "./mirasim/transport";
import { cachedMirasimThinkingShape } from "./mirasim/control-plane";
import {
  ensureMirasimClaudeAgentSystemMarker,
  mergeMirasimAnthropicBetaHeaders,
} from "./mirasim/anthropic";

type MirasimWire = "anthropic" | "responses";

const RESPONSE_WIRE_HEADER = "x-opencodex-mirasim-response-wire";
const MIRASIM_GPT6_NATIVE_CUSTOM_TOOLS = new Set(["exec"]);

function parseMirasimModelSelector(modelId: string): { modelId: string; longContext: boolean } {
  const trimmed = modelId.trim();
  const longContext = /\[1m\]$/i.test(trimmed);
  return {
    modelId: longContext ? trimmed.replace(/\[1m\]$/i, "").trim() : trimmed,
    longContext,
  };
}

function wireForModel(modelId: string): MirasimWire {
  const normalized = parseMirasimModelSelector(modelId).modelId.toLowerCase();
  if (normalized.startsWith("claude-")) return "anthropic";
  if (normalized.startsWith("gpt-") || normalized === "kimi-k3") return "responses";
  throw new Error(`Mirasim supports Claude, GPT, and Kimi K3 relay models only (received ${modelId})`);
}

function requestWire(request: AdapterRequest): MirasimWire {
  const declared = Object.entries(request.headers)
    .find(([name]) => name.toLowerCase() === MIRASIM_INTERNAL_WIRE_HEADER)?.[1];
  if (declared === "anthropic" || declared === "responses") return declared;
  const path = new URL(request.url).pathname;
  return path.startsWith("/v1/messages") ? "anthropic" : "responses";
}

function responseWire(response: Response): MirasimWire {
  const wire = response.headers.get(RESPONSE_WIRE_HEADER);
  if (wire === "anthropic" || wire === "responses") return wire;
  throw new Error("Mirasim response is missing its internal wire marker");
}

function isMirasimAnthropicTerminal(event: AdapterEvent): boolean {
  return event.type === "done" || event.type === "incomplete" || event.type === "error";
}

function markResponseWire(response: Response, wire: MirasimWire): Response {
  const headers = new Headers(response.headers);
  headers.set(RESPONSE_WIRE_HEADER, wire);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function threadIdentity(parsed: OcxParsedRequest): string | undefined {
  return parsed._clientThreadId ?? parsed._codexOwnThreadId;
}

function relayEffortForBudget(budget: number): string {
  if (budget <= 1_024) return "low";
  if (budget <= 8_192) return "medium";
  if (budget <= 24_576) return "high";
  return "xhigh";
}

function relayBudgetForEffort(effort: string): number | undefined {
  switch (effort) {
    case "low": return 1_024;
    case "medium": return 8_192;
    case "high": return 24_576;
    case "xhigh": return 32_768;
    case "max": return 128_000;
    default: return undefined;
  }
}

function normalizedRelayEffort(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const effort = value.trim().toLowerCase();
  if (effort === "minimal") return "low";
  if (effort === "ultra") return "max";
  return ["low", "medium", "high", "xhigh", "max"].includes(effort) ? effort : undefined;
}

/**
 * The inspected Mirasim 0.0.336 fallback catalog treats every Claude model as adaptive. OpenCodex's
 * native Anthropic adapter deliberately uses Anthropic's own per-model shape, where e.g. Haiku 4.5
 * and Opus 4.6 can serialize a token budget. Normalize that already-translated body at this final
 * provider boundary so the shared translator remains correct for api.anthropic.com as well.
 */
function normalizeMirasimWireBody(
  bodyText: string,
  wire: MirasimWire,
  requestedReasoning: string | undefined,
  claudeShape: "adaptive" | "budget" | undefined,
): string {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bodyText;
    body = parsed as Record<string, unknown>;
  } catch {
    return bodyText;
  }

  if (wire === "responses") {
    // Mirasim's Codex lane is not an ordinary Responses-compatible endpoint. The inspected
    // reference client always drives it as a stateless SSE turn, even when the caller requested a
    // bounded JSON response. Mirror that exact wire contract here; the Responses delivery layer
    // converts the terminal SSE snapshot back to JSON for non-streaming callers.
    body.stream = true;
    body.store = false;
    body.parallel_tool_calls = true;
    body.include = ["reasoning.encrypted_content"];
    const reasoning = body.reasoning;
    if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
      const record = reasoning as Record<string, unknown>;
      const effort = normalizedRelayEffort(record.effort);
      if (effort) record.effort = effort;
    }
    if (typeof body.reasoning_effort === "string") {
      const effort = normalizedRelayEffort(body.reasoning_effort);
      if (effort) {
        const current = body.reasoning;
        body.reasoning = {
          ...(current && typeof current === "object" && !Array.isArray(current)
            ? current as Record<string, unknown>
            : {}),
          effort,
        };
        delete body.reasoning_effort;
      }
    }
    return JSON.stringify(body);
  }

  ensureMirasimClaudeAgentSystemMarker(body);

  const requested = requestedReasoning?.trim().toLowerCase();
  const thinking = body.thinking && typeof body.thinking === "object" && !Array.isArray(body.thinking)
    ? body.thinking as Record<string, unknown>
    : undefined;
  const outputConfig = body.output_config && typeof body.output_config === "object" && !Array.isArray(body.output_config)
    ? body.output_config as Record<string, unknown>
    : {};

  const adaptive = claudeShape !== "budget";
  const applyBudget = (budget: number): void => {
    const maxTokens = typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens)
      ? Math.floor(body.max_tokens)
      : undefined;
    let bounded = Math.max(1_024, Math.floor(budget));
    if (maxTokens !== undefined && bounded >= maxTokens) {
      bounded = maxTokens - 1;
      if (bounded < 1_024) {
        throw new Error("Mirasim Claude thinking budget must be at least 1024 and below max_tokens");
      }
    }
    body.thinking = { type: "enabled", budget_tokens: bounded };
    delete outputConfig.effort;
    delete body.temperature;
    delete body.top_p;
  };

  if (requested === "none") {
    body.thinking = { type: "disabled" };
    delete outputConfig.effort;
  } else if (requested === "auto") {
    if (adaptive) {
      body.thinking = { type: "adaptive" };
      delete outputConfig.effort;
      delete body.temperature;
      delete body.top_p;
    } else {
      applyBudget(1_024);
    }
  } else {
    let effort = normalizedRelayEffort(requested);
    if (!effort && thinking?.type === "enabled" && typeof thinking.budget_tokens === "number") {
      effort = relayEffortForBudget(thinking.budget_tokens);
    }
    if (!effort && thinking?.type === "adaptive") {
      effort = normalizedRelayEffort(outputConfig.effort);
    }
    if (adaptive) {
      if (effort) {
        body.thinking = { type: "adaptive" };
        outputConfig.effort = effort;
        delete body.temperature;
        delete body.top_p;
      }
    } else {
      let budget = effort ? relayBudgetForEffort(effort) : undefined;
      if (budget === undefined && thinking?.type === "enabled" && typeof thinking.budget_tokens === "number") {
        budget = thinking.budget_tokens;
      }
      if (budget !== undefined) applyBudget(budget);
    }
  }

  if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;
  else delete body.output_config;
  return JSON.stringify(body);
}

/**
 * Mirasim is a transport adapter, not a third protocol translator. Claude requests are serialized
 * by the existing Anthropic adapter; GPT and Kimi K3 requests are serialized by the existing
 * Responses adapter. This wrapper owns only model->wire selection and Mirasim's signed transport.
 */
export function createMirasimAdapter(provider: OcxProviderConfig): ProviderAdapter {
  if (typeof provider.apiKey !== "string" || provider.apiKey.trim() === "") {
    throw new Error("Mirasim OAuth token missing - run ocx login mirasim");
  }

  // Mirasim authenticates the relay itself. Delegate serializers therefore run as ordinary API-key
  // destinations so Anthropic subscription-OAuth-only prompt/header mutations are not injected.
  const anthropic = createAnthropicAdapter({
    ...provider,
    adapter: "anthropic",
    authMode: "key",
    apiKey: provider.apiKey,
  });
  const responsesProvider = {
    ...provider,
    adapter: "openai-responses" as const,
    authMode: "key" as const,
    apiKey: provider.apiKey,
    upstreamWebsocket: false,
  };
  const responses = createResponsesPassthroughAdapter(responsesProvider);
  const gpt6Responses = createResponsesPassthroughAdapter(responsesProvider, {
    routedCustomToolPassthroughNames: MIRASIM_GPT6_NATIVE_CUSTOM_TOOLS,
  });

  const parser = (wire: MirasimWire, modelId?: string): ProviderAdapter => {
    if (wire === "anthropic") return anthropic;
    return modelId && /^gpt-6(?:-|$)/i.test(modelId) ? gpt6Responses : responses;
  };

  return {
    name: "mirasim",
    passthroughFor(parsed) {
      return wireForModel(parsed.modelId) === "responses";
    },
    // fetchMirasim uses createAdapterPhysicalSend, so it owns first-send admission/observation.
    reportsPhysicalSends: true,

    async buildRequest(parsed, incoming) {
      const selected = parseMirasimModelSelector(parsed.modelId);
      const wire = wireForModel(selected.modelId);
      const delegate = parser(wire, selected.modelId);
      const wireParsed = selected.modelId === parsed.modelId
        ? parsed
        : { ...parsed, modelId: selected.modelId };
      const request = await delegate.buildRequest(wireParsed, incoming);
      if (wire === "anthropic") {
        mergeMirasimAnthropicBetaHeaders(request.headers, incoming?.headers, selected.longContext);
      }
      const claudeShape = wire === "anthropic"
        ? cachedMirasimThinkingShape(provider.apiKey!, selected.modelId)
        : undefined;
      request.body = normalizeMirasimWireBody(
        request.body,
        wire,
        parsed.options.reasoning,
        claudeShape,
      );
      request.headers[MIRASIM_INTERNAL_WIRE_HEADER] = wire;
      const thread = threadIdentity(parsed);
      if (thread) request.headers[MIRASIM_INTERNAL_THREAD_HEADER] = thread;
      return request;
    },

    async fetchResponse(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response> {
      const wire = requestWire(request);
      const response = await fetchMirasim(request, provider.apiKey!, ctx);
      // Both wires carry an internal marker because routed compaction deliberately leaves the
      // native passthrough lane and re-enters the adapter parser. The public passthrough response
      // boundary strips this private header before client delivery.
      return markResponseWire(response, wire);
    },

    async *parseStream(
      response: Response,
      budget: TranslatorBudget,
      tierMetadata?: AdapterTierMetadata,
    ): AsyncGenerator<AdapterEvent> {
      const wire = responseWire(response);
      const delegate = parser(wire);
      for await (const event of delegate.parseStream(response, budget, tierMetadata)) {
        yield event;
        if (wire === "anthropic" && isMirasimAnthropicTerminal(event)) {
          // Mirasim's relay may keep the HTTP/SSE transport open after Anthropic's
          // application-level message_stop. The shared Anthropic parser deliberately supports
          // providers that need EOF fallback semantics, so normalize only this provider boundary:
          // once a terminal semantic event is visible, closing this wrapper triggers iterator
          // cleanup and cancels the still-open relay body instead of making web-search wait for
          // transport EOF and trip its post-terminal drain guard.
          return;
        }
      }
    },

    async parseResponse(
      response: Response,
      budget: TranslatorBudget,
      tierMetadata?: AdapterTierMetadata,
    ): Promise<AdapterEvent[]> {
      const delegate = parser(responseWire(response));
      if (!delegate.parseResponse) {
        const events: AdapterEvent[] = [];
        for await (const event of delegate.parseStream(response, budget, tierMetadata)) events.push(event);
        return events;
      }
      return delegate.parseResponse(response, budget, tierMetadata);
    },

    formatErrorBody(status: number, headers: Headers, payloadText: string): string {
      const wire = headers.get(RESPONSE_WIRE_HEADER);
      const delegate = wire === "anthropic" ? anthropic : responses;
      return delegate.formatErrorBody?.(status, headers, payloadText) ?? payloadText;
    },
  };
}
