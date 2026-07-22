/**
 * OpenAI Chat Completions inbound (/v1/chat/completions) for GitHub Copilot App
 * and other OpenAI-compatible clients.
 *
 * Translate-and-replay: Chat Completions body -> /v1/responses via handleResponses,
 * then bridge the Responses output back to Chat Completions SSE/JSON.
 */
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import { ChatCompletionsRequestError, chatCompletionsToResponsesBody } from "../chat/inbound";
import {
  chatCompletionsErrorResponse,
  collectChatCompletion,
  responsesJsonToChatCompletion,
  responsesSseToChatCompletionsSse,
} from "../chat/outbound";
import { estimateTokens } from "../lib/token-estimate";
import { routeModel } from "../router";
import type { OcxConfig } from "../types";
import { readJsonRequestBody } from "./request-decompress";
import { addFinalRequestLog, type RequestLogContext } from "./request-log";
import { responseWithDeferredRequestLog } from "./relay";
import { handleResponses } from "./responses";

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function readChatBody(req: Request): Promise<unknown> {
  try {
    return await readJsonRequestBody(req);
  } catch (err) {
    throw new ChatCompletionsRequestError(err instanceof Error && err.message ? err.message : "Invalid JSON body");
  }
}

export async function handleChatCompletions(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  logIds?: { requestId: string; start: number },
): Promise<Response> {
  let chatBody: unknown;
  let internalBody: Rec;
  try {
    chatBody = await readChatBody(req);
    internalBody = chatCompletionsToResponsesBody(chatBody);
  } catch (err) {
    const status = err instanceof ChatCompletionsRequestError ? 400 : 500;
    if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, status, { closeReason: "non_stream" });
    return chatCompletionsErrorResponse(status, err instanceof Error ? err.message : String(err));
  }

  const requestedModel = (chatBody as Rec).model as string;
  const stream = internalBody.stream === true;
  // Routed adapters only support streamed turns; always stream internally and fold
  // for non-streaming clients.
  internalBody.stream = true;

  let _nativeRoute = false;
  try {
    const route = routeModel(config, internalBody.model as string);
    logCtx.model = route.modelId;
    logCtx.providerAdapter = route.provider.adapter;
    logCtx.requestedModel = requestedModel;
    logCtx.provider = route.providerName;
    if (route.provider.adapter === "openai-responses") {
      _nativeRoute = true;
      // ChatGPT backend rejects store:true and unsupported sampling knobs.
      internalBody.store = false;
      delete internalBody.max_output_tokens;
      delete internalBody.temperature;
      delete internalBody.top_p;
      delete internalBody.stop;
      delete internalBody.user;
    } else if (internalBody.store === undefined) {
      internalBody.store = false;
    }
    if (route.provider.adapter === "cursor" || route.provider.adapter === "kiro") {
      const raw = chatBody as Rec;
      const parts: string[] = [];
      if (raw.messages !== undefined) parts.push(JSON.stringify(raw.messages));
      if (raw.tools !== undefined) parts.push(JSON.stringify(raw.tools));
      logCtx.usageLogInputTokens = Math.max(1, estimateTokens(parts.join("\n"), requestedModel));
    }
    if (internalBody.reasoning !== undefined) {
      const { supportedLadderFor } = await import("./effort-policy");
      const ladder = supportedLadderFor({ provider: route.provider, modelId: route.modelId });
      if (ladder !== undefined && ladder.length === 0) delete internalBody.reasoning;
    }
  } catch {
    /* unknown model: let handleResponses shape the 404 */
  }
  void _nativeRoute;

  const headers = new Headers({ "content-type": "application/json" });
  for (const name of FORWARD_HEADERS) {
    if (name === "authorization") continue;
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Prefer main ChatGPT auth so OpenAI-backed sidecars remain reachable on routed turns.
  try {
    const { getMainAccountToken } = await import("../codex/main-account");
    const token = getMainAccountToken();
    if (token) {
      headers.set("authorization", `Bearer ${token.accessToken}`);
      headers.set("chatgpt-account-id", token.chatgptAccountId);
    }
  } catch {
    /* optional */
  }

  const internalReq = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify(internalBody),
  });

  const upstream = await handleResponses(internalReq, config, logCtx, {
    abortSignal: req.signal,
  });
  const response = logIds
    ? responseWithDeferredRequestLog(upstream, logIds.requestId, logIds.start, logCtx)
    : upstream;

  if (!response.ok) {
    let message = `upstream error (${response.status})`;
    try {
      const text = await response.text();
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string; type?: string } | string; message?: string };
        const nested = typeof parsed?.error === "object" && parsed.error ? parsed.error.message : undefined;
        const flat = typeof parsed?.error === "string" ? parsed.error : parsed?.message;
        message = nested || flat || (text ? `upstream error (${response.status}): ${text.slice(0, 400)}` : message);
      } catch {
        if (text) message = `upstream error (${response.status}): ${text.slice(0, 400)}`;
      }
    } catch { /* keep fallback */ }
    const retryAfter = response.headers.get("retry-after");
    return new Response(JSON.stringify({
      error: {
        message,
        type: response.status === 401 ? "authentication_error"
          : response.status === 429 ? "rate_limit_error"
          : response.status >= 500 ? "server_error"
          : "invalid_request_error",
        param: null,
        code: null,
      },
    }), {
      status: response.status,
      headers: {
        "Content-Type": "application/json",
        ...(retryAfter ? { "Retry-After": retryAfter } : {}),
      },
    });
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream") && response.body) {
    const chatSse = responsesSseToChatCompletionsSse(response.body, requestedModel);
    if (stream) {
      return new Response(chatSse, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }
    const completion = await collectChatCompletion(chatSse, requestedModel);
    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Defensive: JSON despite stream:true.
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return chatCompletionsErrorResponse(502, "internal replay returned a non-JSON response", "server_error");
  }
  const status = (json as Rec)?.status;
  if (status === "failed") {
    const error = (json as { error?: { message?: string } }).error;
    return chatCompletionsErrorResponse(502, error?.message ?? "upstream request failed", "server_error");
  }
  const completion = responsesJsonToChatCompletion(json, requestedModel);
  if (!stream) {
    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Streaming client + JSON upstream: synthesize a minimal Chat Completions stream.
  const encoder = new TextEncoder();
  const id = typeof completion.id === "string" ? completion.id : `chatcmpl-${Date.now()}`;
  const created = typeof completion.created === "number" ? completion.created : Math.floor(Date.now() / 1000);
  const message = isRec((completion.choices as Rec[] | undefined)?.[0])
    ? ((completion.choices as Rec[])[0] as Rec).message as Rec | undefined
    : undefined;
  const content = message && typeof message.content === "string" ? message.content : "";
  const frames = [
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: requestedModel, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`,
    ...(content
      ? [`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: requestedModel, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`]
      : []),
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: requestedModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: completion.usage })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(encoder.encode(frames.join("")), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}


