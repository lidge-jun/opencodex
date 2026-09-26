import { randomUUID } from "node:crypto";
import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "./base";
import { createAnthropicAdapter } from "./anthropic";
import { createGoogleAdapter } from "./google";
import { createOpenAIChatAdapter } from "./openai-chat";
import { createResponsesPassthroughAdapter } from "./openai-responses";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../types";
import type { TranslatorBudget } from "../lib/translator-budget";
import { redactSecretString } from "../lib/redact";
import {
  normalizeZedProvider,
  resolveZedModels,
  zedLlmFetch,
  ZED_HEADERS,
  type ZedCredentials,
} from "../providers/zed";

type ZedProvider = "anthropic" | "open_ai" | "google" | "x_ai";

interface ZedDelegate {
  provider: ZedProvider;
  adapter: ProviderAdapter;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function zedCredentials(provider: OcxProviderConfig, parsed: OcxParsedRequest): ZedCredentials {
  const accessToken = provider.apiKey?.trim();
  const userId = parsed._zedAuthContext?.userId?.trim();
  if (!accessToken) throw new Error("Zed access token missing — run ocx login zed");
  if (!userId) throw new Error("Zed account identity missing — run ocx login zed again");
  return { userId, accessToken };
}

function delegateProvider(provider: OcxProviderConfig, zedProvider: ZedProvider): OcxProviderConfig {
  const common: OcxProviderConfig = {
    ...provider,
    authMode: "key",
    apiKey: "zed-delegate-placeholder",
    models: undefined,
    liveModels: false,
  };
  if (zedProvider === "anthropic") {
    return { ...common, adapter: "anthropic", baseUrl: "https://api.anthropic.com" };
  }
  if (zedProvider === "google") {
    return { ...common, adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", googleMode: "ai-studio" };
  }
  if (zedProvider === "open_ai") {
    return { ...common, adapter: "openai-responses", baseUrl: "https://api.openai.com/v1" };
  }
  return { ...common, adapter: "openai-chat", baseUrl: "https://api.x.ai/v1" };
}

function forceStreaming(parsed: OcxParsedRequest): OcxParsedRequest {
  const rawBody = isRecord(parsed._rawBody) ? { ...parsed._rawBody, stream: true } : parsed._rawBody;
  return { ...parsed, stream: true, _rawBody: rawBody };
}

function providerFromCatalog(catalog: Awaited<ReturnType<typeof resolveZedModels>> | undefined, model: string): ZedProvider {
  const raw = catalog?.rawById.get(model);
  return normalizeZedProvider(raw?.provider, model);
}

function nativeErrorPayload(provider: ZedProvider, message: string): Record<string, unknown> {
  if (provider === "anthropic") {
    return { type: "error", error: { type: "api_error", message } };
  }
  if (provider === "open_ai") {
    return { type: "error", error: { message } };
  }
  return { error: { message } };
}

function nativeTerminalPayload(provider: ZedProvider): Record<string, unknown> {
  if (provider === "anthropic") return { type: "message_stop" };
  if (provider === "google") return { candidates: [{ finishReason: "STOP" }] };
  if (provider === "open_ai") return { type: "response.completed", response: { output: [] } };
  return { choices: [{ delta: {}, finish_reason: "stop" }] };
}

function normalizedStatus(value: unknown): { type: string; message?: string } | undefined {
  if (typeof value === "string") return { type: value };
  if (!isRecord(value)) return undefined;
  if (typeof value.type === "string") {
    return {
      type: value.type,
      ...(typeof value.message === "string" ? { message: value.message } : {}),
    };
  }
  const first = Object.entries(value)[0];
  if (!first) return undefined;
  const [type, body] = first;
  if (isRecord(body)) {
    return { type, ...(typeof body.message === "string" ? { message: body.message } : {}) };
  }
  return { type };
}

function zedEventStream(
  body: ReadableStream<Uint8Array>,
  provider: ZedProvider,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let finished = false;
  const output = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        processLine(line, controller);
        if (finished) return;
        newline = buffer.indexOf("\n");
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) processLine(buffer, controller);
      if (!finished) emit(controller, nativeTerminalPayload(provider));
    },
  });

  function emit(controller: TransformStreamDefaultController<Uint8Array>, payload: Record<string, unknown>): void {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  }

  function processLine(line: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    let text = line.replace(/\r$/, "").trim();
    if (!text) return;
    if (text.startsWith("data:")) text = text.slice(5).trimStart();
    if (text === "[DONE]") {
      emit(controller, nativeTerminalPayload(provider));
      finished = true;
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; } catch { return; }
    if (!isRecord(parsed)) return;
    if (Object.hasOwn(parsed, "status")) {
      const status = normalizedStatus(parsed.status);
      if (status?.type === "failed" || status?.type === "error") {
        emit(controller, nativeErrorPayload(provider, status.message ?? "Zed request failed"));
        finished = true;
      } else if (status?.type === "stream_ended" || status?.type === "completed") {
        emit(controller, nativeTerminalPayload(provider));
        finished = true;
      }
      return;
    }
    const event = Object.hasOwn(parsed, "event") ? parsed.event : parsed;
    if (!isRecord(event)) return;
    emit(controller, event);
  }

  return body.pipeThrough(output);
}

function createDelegate(provider: OcxProviderConfig, zedProvider: ZedProvider): ProviderAdapter {
  const config = delegateProvider(provider, zedProvider);
  if (zedProvider === "anthropic") return createAnthropicAdapter(config);
  if (zedProvider === "google") return createGoogleAdapter(config);
  if (zedProvider === "open_ai") return createResponsesPassthroughAdapter(config);
  return createOpenAIChatAdapter(config);
}

export function createZedAdapter(provider: OcxProviderConfig): ProviderAdapter {
  let delegate: ZedDelegate | undefined;
  let credentials: ZedCredentials | undefined;

  const buildRequest = async (parsed: OcxParsedRequest, incoming: IncomingMeta): Promise<AdapterRequest> => {
    credentials = zedCredentials(provider, parsed);
    const threadId = parsed._clientThreadId ?? parsed._codexOwnThreadId ?? parsed.previousResponseId ?? randomUUID();
    const promptId = randomUUID();
    let catalog: Awaited<ReturnType<typeof resolveZedModels>> | undefined;
    try {
      catalog = await resolveZedModels(
        credentials,
        incoming.providerFetch ? { fetchFn: incoming.providerFetch } : undefined,
      );
    } catch {
      /* Model inference fallback below; a transient catalog outage must not block passthrough. */
    }
    const zedProvider = providerFromCatalog(catalog, parsed.modelId);
    const selected = createDelegate(provider, zedProvider);
    const built = await selected.buildRequest(forceStreaming(parsed), incoming);
    let providerRequest: unknown;
    try { providerRequest = JSON.parse(built.body) as unknown; } catch { throw new Error("Zed delegate produced an invalid request body"); }
    if (zedProvider === "google" && isRecord(providerRequest)) delete providerRequest.safetySettings;
    if (!isRecord(providerRequest)) throw new Error("Zed delegate produced a non-object request body");
    delegate = { provider: zedProvider, adapter: selected };
    const requestUrl = `${provider.baseUrl.replace(/\/+$/, "")}/completions`;
    return {
      url: requestUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson, text/event-stream, */*",
        "User-Agent": "OpenCodex/zed",
        "x-zed-version": "0.200.0",
        [ZED_HEADERS.clientSupportsStatus]: "true",
        [ZED_HEADERS.clientSupportsStreamEnded]: "true",
      },
      body: JSON.stringify({
        thread_id: threadId,
        prompt_id: promptId,
        provider: zedProvider,
        model: parsed.modelId,
        provider_request: providerRequest,
      }),
      ...(built.tierLog ? { tierLog: built.tierLog } : {}),
    };
  };

  const adapter: ProviderAdapter = {
    name: "zed",
    formatErrorBody(status, _headers, payloadText) {
      let payload: unknown;
      try { payload = JSON.parse(payloadText) as unknown; } catch { payload = undefined; }
      const record = isRecord(payload) ? payload : undefined;
      const error = isRecord(record?.error) ? record.error : undefined;
      const code = typeof record?.code === "string" ? record.code : typeof error?.code === "string" ? error.code : "";
      const message = typeof record?.message === "string" ? record.message
        : typeof error?.message === "string" ? error.message
          : "Zed upstream request failed";
      return `Zed${code ? ` ${redactSecretString(code)}` : ""}: ${redactSecretString(message)} (HTTP ${status})`;
    },
    buildRequest,
    async fetchResponse(request, ctx) {
      if (!credentials) throw new Error("Zed request credentials were not initialized");
      const fetchFn = ctx?.executor ?? globalThis.fetch;
      return zedLlmFetch(credentials, "/completions", {
        fetchFn,
        signal: ctx?.abortSignal,
        baseUrl: provider.baseUrl,
        fetchInit: {
          method: request.method,
          headers: request.headers,
          body: request.body,
        },
      });
    },
    async *parseStream(response: Response, budget: TranslatorBudget): AsyncGenerator<AdapterEvent> {
      if (!response.body) {
        yield { type: "error", message: "Zed response had no body" };
        return;
      }
      if (!delegate) {
        yield { type: "error", message: "Zed response arrived before request translation" };
        return;
      }
      const translated = new Response(zedEventStream(response.body, delegate.provider), {
        status: response.status,
        headers: { "Content-Type": "text/event-stream" },
      });
      yield* delegate.adapter.parseStream(translated, budget);
    },
    async parseResponse(response: Response, budget: TranslatorBudget): Promise<AdapterEvent[]> {
      const events: AdapterEvent[] = [];
      for await (const event of adapter.parseStream(response, budget)) events.push(event);
      return events;
    },
  };
  return adapter;
}
