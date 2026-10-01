import { randomUUID } from "node:crypto";
import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "./base";
import { createAnthropicAdapter } from "./anthropic";
import { createGoogleAdapter } from "./google";
import { createOpenAIChatAdapter } from "./openai-chat";
import { createResponsesPassthroughAdapter } from "./openai-responses";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../types";
import { createTranslatorBudget, type TranslatorBudget } from "../lib/translator-budget";
import { redactSecretString } from "../lib/redact";
import {
  normalizeZedProvider,
  resolveZedModels,
  scrubZedCredentials,
  zedLlmFetch,
  ZED_HEADERS,
  type ZedCredentials,
} from "../providers/zed";

export type ZedProvider = "anthropic" | "open_ai" | "google" | "x_ai";

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

/** One Zed frame larger than this without a newline is treated as a broken stream, not buffered forever. */
const MAX_ZED_FRAME_CHARS = 1024 * 1024;

/** Whether a delegated native event is itself that protocol's terminal event. */
function isNativeTerminalEvent(event: Record<string, unknown>): boolean {
  if (event.type === "message_stop") return true;
  if (event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed") return true;
  if (Array.isArray(event.choices) && event.choices.some(choice => isRecord(choice) && choice.finish_reason != null)) return true;
  return Array.isArray(event.candidates) && event.candidates.some(candidate => isRecord(candidate) && candidate.finishReason != null);
}

/**
 * Translate Zed's NDJSON/SSE completion frames into the delegated provider's native SSE.
 *
 * The request declares support for the stream-ended status, so a well-formed response ends with
 * an explicit terminal status (or `[DONE]`). The stream fails closed instead of synthesizing a
 * success when that guarantee is broken: a malformed or non-object frame, a frame over
 * `MAX_ZED_FRAME_CHARS`, a partial trailing frame, or an EOF with neither a terminal status nor a
 * native terminal event becomes the provider-native error. Nothing is forwarded after a terminal
 * status or `[DONE]`; frames after a native terminal event still pass, because some wires (Chat
 * with usage) send a usage chunk after `finish_reason`. Upstream failure text goes through
 * `scrub`, which removes this account's token and user id.
 */
export function zedEventStream(
  body: ReadableStream<Uint8Array>,
  provider: ZedProvider,
  scrub: (text: string) => string = redactSecretString,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let finished = false;
  let sawNativeTerminal = false;
  const output = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (finished) return;
      buffer += decoder.decode(chunk, { stream: true });
      let start = 0;
      let newline = buffer.indexOf("\n", start);
      while (newline >= 0 && !finished) {
        processLine(buffer.slice(start, newline), controller);
        start = newline + 1;
        newline = buffer.indexOf("\n", start);
      }
      buffer = finished ? "" : buffer.slice(start);
      if (!finished && buffer.length > MAX_ZED_FRAME_CHARS) {
        buffer = "";
        fail(controller, "Zed stream frame exceeded the size limit");
      }
    },
    flush(controller) {
      if (finished) return;
      buffer += decoder.decode();
      if (buffer.trim()) {
        buffer = "";
        fail(controller, "Zed stream ended inside a partial frame");
        return;
      }
      if (sawNativeTerminal) emit(controller, nativeTerminalPayload(provider));
      else fail(controller, "Zed stream ended before completion");
    },
  });

  function emit(controller: TransformStreamDefaultController<Uint8Array>, payload: Record<string, unknown>): void {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  }

  function fail(controller: TransformStreamDefaultController<Uint8Array>, message: string): void {
    emit(controller, nativeErrorPayload(provider, message));
    finished = true;
  }

  function processLine(line: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    let text = line.replace(/\r$/, "").trim();
    if (!text) return;
    if (text.startsWith("data:")) text = text.slice(5).trimStart();
    if (!text || text.startsWith(":") || text.startsWith("event:")) return;
    if (text === "[DONE]") {
      emit(controller, nativeTerminalPayload(provider));
      finished = true;
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; } catch {
      fail(controller, "Zed stream sent a malformed frame");
      return;
    }
    if (!isRecord(parsed)) {
      fail(controller, "Zed stream sent a malformed frame");
      return;
    }
    if (Object.hasOwn(parsed, "status")) {
      const status = normalizedStatus(parsed.status);
      if (status?.type === "failed" || status?.type === "error") {
        fail(controller, status.message ? scrub(status.message) : "Zed request failed");
      } else if (status?.type === "stream_ended" || status?.type === "completed") {
        emit(controller, nativeTerminalPayload(provider));
        finished = true;
      }
      return;
    }
    const event = Object.hasOwn(parsed, "event") ? parsed.event : parsed;
    if (!isRecord(event)) {
      fail(controller, "Zed stream sent a malformed frame");
      return;
    }
    if (isNativeTerminalEvent(event)) sawNativeTerminal = true;
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

  const buildRequest = async (parsed: OcxParsedRequest, incoming?: IncomingMeta): Promise<AdapterRequest> => {
    credentials = zedCredentials(provider, parsed);
    const threadId = parsed._clientThreadId ?? parsed._codexOwnThreadId ?? parsed.previousResponseId ?? randomUUID();
    const promptId = randomUUID();
    let catalog: Awaited<ReturnType<typeof resolveZedModels>> | undefined;
    try {
      const catalogTimeout = AbortSignal.timeout(8_000);
      const catalogSignal = incoming?.abortSignal ? AbortSignal.any([incoming.abortSignal, catalogTimeout]) : catalogTimeout;
      catalog = await resolveZedModels(
        credentials,
        { signal: catalogSignal, ...(incoming?.providerFetch ? { fetchFn: incoming.providerFetch } : {}) },
      );
    } catch {
      /* Model inference fallback below; a transient catalog outage must not block passthrough. */
    }
    const zedProvider = providerFromCatalog(catalog, parsed.modelId);
    const selected = createDelegate(provider, zedProvider);
    const safeIncoming: IncomingMeta = {
     headers: incoming?.headers ?? new Headers(),
     translatorBudget: incoming?.translatorBudget ?? createTranslatorBudget(),
     ...(incoming?.providerFetch ? { providerFetch: incoming.providerFetch } : {}),
     ...(incoming?.abortSignal ? { abortSignal: incoming.abortSignal } : {}),
    };
    const built = await selected.buildRequest(forceStreaming(parsed), safeIncoming);
    let providerRequest: unknown;
    try { providerRequest = JSON.parse(built.body) as unknown; } catch { throw new Error("Zed delegate produced an invalid request body"); }
    if (zedProvider === "google" && isRecord(providerRequest)) delete providerRequest.safetySettings;
    if (zedProvider === "anthropic" && isRecord(providerRequest) && Array.isArray(providerRequest.messages)) {
      providerRequest.messages = providerRequest.messages.map((m: unknown) => {
        if (isRecord(m) && typeof m.content === "string") {
          return { ...m, content: [{ type: "text", text: m.content }] };
        }
        return m;
      });
    }
    if (zedProvider === "open_ai" && isRecord(providerRequest)) {
      if (typeof providerRequest.input === "string") {
        providerRequest.input = [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: providerRequest.input }],
          },
        ];
      } else if (Array.isArray(providerRequest.input)) {
        providerRequest.input = providerRequest.input.map((item: unknown) => {
          if (isRecord(item)) {
            const role = typeof item.role === "string" ? item.role : "user";
            const type = typeof item.type === "string" ? item.type : "message";
            if (typeof item.content === "string") {
              return { ...item, type, role, content: [{ type: "input_text", text: item.content }] };
            }
            if (Array.isArray(item.content)) {
              return {
                ...item,
                type,
                role,
                content: item.content.map((c: unknown) => {
                  if (isRecord(c) && c.type === "text") {
                    return { ...c, type: "input_text" };
                  }
                  return c;
                }),
              };
            }
            return { ...item, type, role };
          }
          return item;
        });
      }
    }
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
      const scrub = (text: string) => credentials ? scrubZedCredentials(text, credentials) : redactSecretString(text);
      return `Zed${code ? ` ${scrub(code)}` : ""}: ${scrub(message)} (HTTP ${status})`;
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
      const requestCredentials = credentials;
      const scrub = (text: string) => requestCredentials ? scrubZedCredentials(text, requestCredentials) : redactSecretString(text);
      const translated = new Response(zedEventStream(response.body, delegate.provider, scrub), {
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
