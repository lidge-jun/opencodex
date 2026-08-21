import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import { createOpenAIChatAdapter } from "./openai-chat";
import type { AdapterFetchContext, AdapterRequest, IncomingMeta, ProviderAdapter } from "./base";
import type { TranslatorBudget } from "../lib/translator-budget";
import type { AdapterTierMetadata } from "../providers/fastwire";
import {
  WORKBUDDY_UPSTREAM_CHAT_URL,
  readWorkBuddyAuthHeaders,
  runtimeWorkBuddyNativeInputs,
} from "../oauth/workbuddy-credentials";

export const WORKBUDDY_MODELS = [
  "workbuddy/deepseek-v4-flash",
  "workbuddy/glm-5.3",
  "workbuddy/kimi-k3",
  "workbuddy/auto",
] as const;

const UPSTREAM_MODEL_BY_ID: Readonly<Record<string, string>> = {
  "workbuddy/deepseek-v4-flash": "deepseek-v4-flash",
  "workbuddy/glm-5.3": "glm-5.3",
  "workbuddy/kimi-k3": "kimi-k3",
  "workbuddy/auto": "auto",
  "deepseek-v4-flash": "deepseek-v4-flash",
  "glm-5.3": "glm-5.3",
  "kimi-k3": "kimi-k3",
  auto: "auto",
};

function isCanonicalWorkBuddyEndpoint(baseUrl: string): boolean {
  try {
    const actual = new URL(baseUrl.trim());
    const expected = new URL(WORKBUDDY_UPSTREAM_CHAT_URL);
    actual.pathname = actual.pathname.replace(/\/+$/, "") || "/";
    expected.pathname = expected.pathname.replace(/\/+$/, "") || "/";
    return actual.origin === expected.origin && actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

/** Map a routed WorkBuddy model id to the upstream console proxy model slug. */
export function resolveWorkBuddyUpstreamModel(modelId: string): string {
  const trimmed = modelId.trim();
  if (Object.hasOwn(UPSTREAM_MODEL_BY_ID, trimmed)) return UPSTREAM_MODEL_BY_ID[trimmed]!;
  const bare = trimmed.startsWith("workbuddy/") ? trimmed.slice("workbuddy/".length) : trimmed;
  return UPSTREAM_MODEL_BY_ID[bare] ?? bare;
}

/**
 * Strip WorkBuddy-only SSE events that break OpenAI-compatible clients:
 * `event: conversationId` followed by a non-JSON `data: conv-*` line.
 */
export function sanitizeWorkBuddySseBlock(rawText: string): string {
  const out: string[] = [];
  const lines = rawText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("event:")) {
      const eventName = line.slice(6).trim();
      if (eventName === "conversationId") {
        if (i + 1 < lines.length && lines[i + 1]!.startsWith("data:")) i++;
      }
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      out.push("data: [DONE]");
      continue;
    }
    try {
      JSON.parse(payload);
      out.push(`data: ${payload}`);
    } catch {
      /* drop non-JSON data lines such as conv-* ids */
    }
  }
  return out.length > 0 ? `${out.join("\n\n")}\n\n` : "";
}

function sanitizedSseReadableStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        while (buffer.includes("\n\n")) {
          const splitAt = buffer.indexOf("\n\n");
          const part = buffer.slice(0, splitAt);
          buffer = buffer.slice(splitAt + 2);
          const cleaned = sanitizeWorkBuddySseBlock(part);
          if (cleaned) controller.enqueue(encoder.encode(cleaned));
        }
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) {
            const cleaned = sanitizeWorkBuddySseBlock(buffer);
            if (cleaned) controller.enqueue(encoder.encode(cleaned));
          }
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function workBuddyHeadersFromProvider(provider: OcxProviderConfig): Record<string, string> {
  const authHeaders = readWorkBuddyAuthHeaders(runtimeWorkBuddyNativeInputs());
  if (provider.apiKey && provider.apiKey !== authHeaders.Authorization.slice("Bearer ".length)) {
    authHeaders.Authorization = `Bearer ${provider.apiKey}`;
  }
  return authHeaders;
}

/**
 * WorkBuddy console proxy adapter. Imports the desktop OAuth session, forces upstream
 * streaming (non-stream requests return error 11101), and sanitizes WorkBuddy-only SSE noise.
 */
export function createWorkBuddyAdapter(provider: OcxProviderConfig): ProviderAdapter {
  if (!isCanonicalWorkBuddyEndpoint(provider.baseUrl)) {
    throw new Error(
      "The workbuddy adapter only supports the canonical WorkBuddy console proxy endpoint.",
    );
  }
  const base = createOpenAIChatAdapter(provider);

  return {
    ...base,
    name: "workbuddy",

    buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta): AdapterRequest {
      const baseReq = base.buildRequest(parsed, incoming) as AdapterRequest;
      const body = JSON.parse(baseReq.body as string) as Record<string, unknown>;
      body.model = resolveWorkBuddyUpstreamModel(String(body.model ?? parsed.modelId));
      body.stream = true;
      const authHeaders = workBuddyHeadersFromProvider(provider);
      const headers: Record<string, string> = {
        ...authHeaders,
        Accept: "text/event-stream",
      };
      return {
        url: WORKBUDDY_UPSTREAM_CHAT_URL,
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(baseReq.reasoningLog ? { reasoningLog: baseReq.reasoningLog } : {}),
        ...(baseReq.tierLog ? { tierLog: baseReq.tierLog } : {}),
      };
    },

    async fetchResponse(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response> {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers as Record<string, string>,
        body: request.body,
        signal: ctx?.abortSignal,
      });
      if (!response.ok || !response.body) return response;
      const headers = new Headers(response.headers);
      headers.set("Content-Type", "text/event-stream");
      return new Response(sanitizedSseReadableStream(response.body), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },

    parseStream(
      response: Response,
      budget: TranslatorBudget,
      tierMetadata?: AdapterTierMetadata,
    ): ReturnType<NonNullable<ProviderAdapter["parseStream"]>> {
      return base.parseStream(response, budget, tierMetadata);
    },

    async parseResponse(
      response: Response,
      budget: TranslatorBudget,
      tierMetadata?: AdapterTierMetadata,
    ) {
      const events = [];
      for await (const event of base.parseStream(response, budget, tierMetadata)) {
        events.push(event);
      }
      return events;
    },
  };
}
