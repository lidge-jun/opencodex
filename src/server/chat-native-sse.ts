import { chatCompletionsErrorBody } from "../chat/outbound";
import { classifyError, CYBER_POLICY_ERROR_CODE, isCyberPolicyCode } from "../lib/errors";
import { redactSecretString } from "../lib/redact";
import {
  isTranslatorBudgetExceededError,
  TRANSLATOR_MAX_SSE_EVENT_BYTES,
  type TranslatorBudget,
} from "../lib/translator-budget";
import type { OcxUsage } from "../types";
import { nextSseBlock, replaceSseDataPayload, sseDataPayload } from "./sse-payload-rewrite";

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function usageFromChat(value: unknown): OcxUsage | undefined {
  if (!isRec(value)) return undefined;
  const prompt = typeof value.prompt_tokens === "number" ? value.prompt_tokens : undefined;
  const completion = typeof value.completion_tokens === "number" ? value.completion_tokens : undefined;
  if (prompt === undefined && completion === undefined) return undefined;
  const promptDetails = isRec(value.prompt_tokens_details) ? value.prompt_tokens_details : undefined;
  const completionDetails = isRec(value.completion_tokens_details) ? value.completion_tokens_details : undefined;
  return {
    inputTokens: prompt ?? 0,
    outputTokens: completion ?? 0,
    ...(typeof promptDetails?.cached_tokens === "number" ? { cachedInputTokens: promptDetails.cached_tokens } : {}),
    ...(typeof completionDetails?.reasoning_tokens === "number"
      ? { reasoningOutputTokens: completionDetails.reasoning_tokens }
      : {}),
  };
}

export function structuredError(value: unknown): {
  message: string;
  type?: string;
  code?: string | null;
  status?: number;
} | null {
  if (!isRec(value) || value.error === undefined || value.error === null) return null;
  const error = value.error;
  if (typeof error === "string") return { message: redactSecretString(error) };
  if (!isRec(error)) return { message: "upstream error" };
  const rawMessage = typeof error.message === "string" ? error.message : "upstream error";
  return {
    message: redactSecretString(rawMessage),
    ...(typeof error.type === "string" ? { type: error.type } : {}),
    ...(error.code === null || typeof error.code === "string" ? { code: error.code } : {}),
    ...(typeof error.status === "number" && Number.isInteger(error.status) ? { status: error.status } : {}),
  };
}

function normalizedChunk(value: Rec, requestedModel: string): Rec {
  return {
    ...value,
    id: typeof value.id === "string" ? value.id : `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion.chunk",
    created: typeof value.created === "number" ? value.created : Math.floor(Date.now() / 1000),
    model: requestedModel,
  };
}

export function jsonCompletionSse(value: Rec, requestedModel: string): string {
  const id = typeof value.id === "string" ? value.id : `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = typeof value.created === "number" ? value.created : Math.floor(Date.now() / 1000);
  const model = requestedModel;
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const choice = isRec(choices[0]) ? choices[0] : {};
  const message = isRec(choice.message) ? choice.message : {};
  const frames: Rec[] = [{
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  }];
  const delta: Rec = {};
  if (typeof message.content === "string" && message.content.length > 0) delta.content = message.content;
  if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
    delta.reasoning_content = message.reasoning_content;
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    delta.tool_calls = message.tool_calls.map((tool, index) => isRec(tool) ? { index, ...tool } : tool);
  }
  if (Object.keys(delta).length > 0) {
    frames.push({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: null }] });
  }
  frames.push({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: typeof choice.finish_reason === "string" ? choice.finish_reason : "stop" }],
    ...(value.usage !== undefined ? { usage: value.usage } : {}),
  });
  return `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
}

interface NativeChatSseOptions {
  requestedModel: string;
  translatorBudget: TranslatorBudget;
  signal: AbortSignal;
  onFirstOutput?: () => void;
  onUsage: (usage: OcxUsage) => void;
  onTerminal?: (status: number, message?: string) => void;
  onCancel?: () => void;
}

export function nativeChatSse(
  body: ReadableStream<Uint8Array>,
  options: NativeChatSseOptions,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const scope = { kind: "live_transient" as const };
  let buffer = "";
  let bufferBytes = 0;
  let queuedBytes = 0;
  let sawFinish = false;
  let sawDone = false;
  let firstOutput = false;
  let settled = false;
  let cancelled = false;
  let cancelledBySignal = false;

  const releaseQueued = () => {
    if (queuedBytes === 0) return;
    options.translatorBudget.releaseRetained(queuedBytes, scope);
    queuedBytes = 0;
  };
  const replaceBuffer = (next: string) => {
    const nextBytes = encoder.encode(next).byteLength;
    const reservation = options.translatorBudget.reserveTransient(nextBytes, scope);
    reservation.commitRetained();
    options.translatorBudget.releaseRetained(bufferBytes, scope);
    buffer = next;
    bufferBytes = nextBytes;
  };
  const appendBuffer = (fragment: string) => {
    if (!fragment) return;
    const fragmentBytes = encoder.encode(fragment).byteLength;
    const nextBytes = bufferBytes + fragmentBytes;
    if (nextBytes > TRANSLATOR_MAX_SSE_EVENT_BYTES) {
      throw new Error("upstream SSE event exceeded the safe limit", { cause: { code: "translation_buffer_limit" } });
    }
    const reservation = options.translatorBudget.reserveTransient(nextBytes, scope);
    try {
      buffer += fragment;
      reservation.commitRetained();
      options.translatorBudget.releaseRetained(bufferBytes, scope);
      bufferBytes = nextBytes;
    } catch (error) {
      reservation.release();
      throw error;
    }
  };
  const enqueue = (controller: ReadableStreamDefaultController<Uint8Array>, text: string) => {
    const bytes = encoder.encode(text);
    const reservation = options.translatorBudget.reserveTransient(bytes.byteLength, scope);
    controller.enqueue(bytes);
    reservation.commitRetained();
    queuedBytes += bytes.byteLength;
  };
  const releaseBuffer = () => {
    options.translatorBudget.releaseRetained(bufferBytes, scope);
    buffer = "";
    bufferBytes = 0;
  };
  const settle = (status: number, message?: string) => {
    if (settled) return;
    settled = true;
    options.signal.removeEventListener("abort", onAbort);
    options.onTerminal?.(status, message);
  };
  const fail = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    message: string,
    code: string,
    status = 502,
    type = "upstream_error",
  ) => {
    const safeMessage = redactSecretString(message);
    try {
      const frame = `data: ${JSON.stringify(chatCompletionsErrorBody(status, safeMessage, type, code))}\n\n`;
      if (code === "translation_buffer_limit") controller.enqueue(encoder.encode(frame));
      else enqueue(controller, frame);
    } catch { /* controller may already be closed */ }
    releaseBuffer();
    settle(status, safeMessage);
    try { void reader.cancel(new Error(safeMessage)).catch(() => {}); } catch { /* already closed */ }
    try { controller.close(); } catch { /* already closed */ }
  };
  const processBlock = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    block: string,
    delimiter: string,
  ): void => {
    const payload = sseDataPayload(block);
    if (payload === null) {
      enqueue(controller, block + delimiter);
      return;
    }
    const trimmed = payload.trim();
    if (trimmed === "[DONE]") {
      sawDone = true;
      enqueue(controller, replaceSseDataPayload(block, "[DONE]") + delimiter);
      settle(200);
      try { void reader.cancel().catch(() => {}); } catch { /* already closed */ }
      controller.close();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      fail(controller, "upstream returned malformed SSE JSON", "upstream_sse_invalid");
      return;
    }
    if (!isRec(parsed)) {
      fail(controller, "upstream returned an invalid SSE event", "upstream_sse_invalid");
      return;
    }
    const error = structuredError(parsed);
    if (error) {
      const status = error.status ?? 502;
      const classified = classifyError(status, error.type ?? "upstream_error", error.message);
      if (isCyberPolicyCode(error.code)) {
        classified.code = CYBER_POLICY_ERROR_CODE;
        classified.type = "invalid_request_error";
      } else if (error.code !== undefined && error.code !== null) {
        classified.code = error.code;
      }
      const safe = chatCompletionsErrorBody(status, classified.message, classified.type, classified.code);
      enqueue(controller, replaceSseDataPayload(block, JSON.stringify(safe)) + delimiter);
      settle(isCyberPolicyCode(classified.code) ? 400 : status, classified.message);
      try { void reader.cancel(new Error(classified.message)).catch(() => {}); } catch { /* already closed */ }
      controller.close();
      return;
    }
    const usage = usageFromChat(parsed.usage);
    if (usage) options.onUsage(usage);
    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    if (choices.some(choice => isRec(choice) && typeof choice.finish_reason === "string" && choice.finish_reason.length > 0)) {
      sawFinish = true;
    }
    if (!firstOutput && choices.some(choice => {
      if (!isRec(choice) || !isRec(choice.delta)) return false;
      const delta = choice.delta;
      return (typeof delta.content === "string" && delta.content.length > 0)
        || (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0)
        || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0);
    })) {
      firstOutput = true;
      options.onFirstOutput?.();
    }
    enqueue(controller, replaceSseDataPayload(block, JSON.stringify(normalizedChunk(parsed, options.requestedModel))) + delimiter);
  };

  function onAbort() {
    cancelledBySignal = true;
    if (!settled) {
      settled = true;
      options.onCancel?.();
    }
    try { void reader.cancel(options.signal.reason).catch(() => {}); } catch { /* already closed */ }
  }
  if (options.signal.aborted) onAbort();
  else options.signal.addEventListener("abort", onAbort, { once: true });

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      releaseQueued();
      try {
        for (;;) {
          const next = nextSseBlock(buffer);
          if (next) {
            replaceBuffer(next.rest);
            processBlock(controller, next.block, next.delimiter);
            return;
          }
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (cancelledBySignal) {
            releaseBuffer();
            controller.close();
            return;
          }
          if (!done) {
            appendBuffer(decoder.decode(value, { stream: true }));
            continue;
          }
          appendBuffer(decoder.decode());
          if (buffer.trim().length > 0) {
            fail(controller, "upstream SSE ended with an unterminated event", "upstream_sse_unterminated");
            return;
          }
          releaseBuffer();
          if (sawDone || sawFinish) {
            if (!sawDone) enqueue(controller, "data: [DONE]\n\n");
            settle(200);
            controller.close();
          } else {
            fail(controller, "upstream SSE ended before a terminal event", "upstream_sse_truncated");
          }
          return;
        }
      } catch (error) {
        const overflow = isTranslatorBudgetExceededError(error)
          || (error instanceof Error && (error.cause as { code?: unknown } | undefined)?.code === "translation_buffer_limit");
        fail(
          controller,
          overflow ? "upstream SSE event exceeded the safe limit" : error instanceof Error ? error.message : String(error),
          overflow ? "translation_buffer_limit" : "upstream_sse_error",
        );
      }
    },
    cancel(reason) {
      cancelled = true;
      releaseQueued();
      releaseBuffer();
      options.signal.removeEventListener("abort", onAbort);
      if (!settled) {
        settled = true;
        options.onCancel?.();
      }
      try { return reader.cancel(reason).then(() => undefined, () => undefined); } catch { return Promise.resolve(); }
    },
  });
}
