import { usageFromGemini } from "../adapters/google-usage";
import type { OcxUsage } from "../types";

/** Gemini payloads remain source text: parsing is validation, never serialization. */
export const GEMINI_NATIVE_MAX_BYTES = 16 * 1024 * 1024;
export const GEMINI_NATIVE_ERROR_CODE = "gemini_native_upstream_error";
const SAFE_UPSTREAM_ERROR = '{"error":{"code":502,"message":"Antigravity upstream rejected the request","status":"INTERNAL"}}';

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function validateGeminiObject(raw: string): Record<string, unknown> {
  const object = jsonObject(JSON.parse(raw));
  if (!object) throw new Error("expected a JSON object");
  return object;
}

const GEMINI_THINKING_LEVEL = /^(minimal|low|medium|high|xhigh)$/i;
const ANTIGRAVITY_WIRE_EFFORT = /-(low|medium|high|xhigh)$/;

/** Capture only reasoning values sent on the wire, without rewriting the request. */
export function geminiNativeReasoningFields(body: Record<string, unknown>, model: string) {
  const wireEffort = ANTIGRAVITY_WIRE_EFFORT.exec(model)?.[1];
  const generation = jsonObject(body.generationConfig ?? body.generation_config);
  const thinking = jsonObject(generation?.thinkingConfig ?? generation?.thinking_config);
  const level = thinking?.thinkingLevel ?? thinking?.thinking_level;
  if (typeof level === "string" && GEMINI_THINKING_LEVEL.test(level)) {
    const requestedEffort = level.toLowerCase();
    return {
      requestedEffort, effectiveEffort: wireEffort ?? requestedEffort,
      reasoningWireField: "thinkingLevel", reasoningWireValue: level,
    };
  }
  const budget = thinking?.thinkingBudget ?? thinking?.thinking_budget;
  if (level === undefined && typeof budget === "number" && Number.isSafeInteger(budget) && budget >= -1) {
    return {
      requestedEffort: budget === -1 ? "auto" : budget === 0 ? "none" : String(budget),
      effectiveEffort: wireEffort,
      reasoningWireField: "thinkingBudget", reasoningWireValue: budget === -1 ? "-1" : budget,
    };
  }
  return { effectiveEffort: wireEffort };
}

/** Find a top-level member's original value, including exact numeric/string spelling. */
export function rawJsonMember(raw: string, member: string): string {
  validateGeminiObject(raw);
  let depth = 0, start = -1, key: string | undefined, found: string | undefined;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      const begin = i++;
      for (; i < raw.length; i++) {
        if (raw[i] === "\\") i++;
        else if (raw[i] === '"') break;
      }
      if (depth === 1 && start < 0) key = JSON.parse(raw.slice(begin, i + 1)) as string;
      continue;
    }
    if (ch === ":" && depth === 1 && start < 0) { start = i + 1; continue; }
    if ((ch === "," && depth === 1) || (ch === "}" && depth === 1)) {
      if (key === member) {
        if (found !== undefined) throw new Error("duplicate envelope member");
        found = raw.slice(start, i).trim();
      }
      key = undefined; start = -1;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  if (found === undefined) throw new Error("missing envelope member");
  return found;
}

export function unwrapGeminiResponse(raw: string): string {
  const response = rawJsonMember(raw, "response");
  validateGeminiObject(response);
  return response;
}

/** Check validated JSON source, including escaped strings and duplicate members. */
export function containsGeminiCredential(raw: string, credentials: readonly string[]): boolean {
  if (!credentials.length) return false;
  const contains = (text: string) => credentials.some(value => text.includes(value));
  if (contains(raw)) return true;
  if (!raw.includes("\\")) return false;

  const delimiters = /["\\]/g;
  let start = -1, escaped = false;
  for (let match = delimiters.exec(raw); match; match = delimiters.exec(raw)) {
    if (match[0] === "\\") {
      escaped = true;
      delimiters.lastIndex++;
    } else if (start < 0) {
      start = match.index;
    } else {
      if (escaped && contains(JSON.parse(raw.slice(start, delimiters.lastIndex)))) return true;
      start = -1;
      escaped = false;
    }
  }
  return false;
}

export function wrapGeminiRequest(raw: string, model: string, project: string): string {
  validateGeminiObject(raw);
  const envelope = JSON.stringify({ model, project, userAgent: "antigravity", requestType: "agent", requestId: `agent-${crypto.randomUUID()}` });
  return `${envelope.slice(0, -1)},"request":${raw}}`;
}

interface GeminiStreamObservers {
  onNativeError?: () => void;
  onUsage?: (usage: OcxUsage) => void;
  onOutput?: (visible: boolean, thought: boolean) => void;
}

/** Decode bounded upstream SSE events and frame the unwrapped JSON for the client. */
export function geminiSseTransform(
  maxBytes = GEMINI_NATIVE_MAX_BYTES,
  observers?: GeminiStreamObservers,
  format: "sse" | "array" = "sse",
  credentials: readonly string[] = [],
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let lineParts: string[] = [], data: string[] = [], eventBytes = 0, afterCR = false;
  const candidates = new Map<number, boolean>();
  let terminal = false, blocked = false, arrayOpened = false;
  let usage: OcxUsage | undefined;
  const reportUsage = () => {
    if (!usage) return;
    try { observers?.onUsage?.(usage); } catch { /* Observational callbacks never change delivery. */ }
  };
  const complete = () => candidates.size ? [...candidates.values()].every(Boolean) : blocked;
  const closeArray = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (format === "array") controller.enqueue(encoder.encode("\n]"));
  };
  function observe(raw: string) {
    const value = JSON.parse(raw) as {
      candidates?: Array<{ index?: number; finishReason?: string; content?: { parts?: unknown } }>;
      promptFeedback?: { blockReason?: string };
      usageMetadata?: unknown;
    };
    if (Object.hasOwn(value, "error") || containsGeminiCredential(raw, credentials)) {
      terminal = true;
      try { observers?.onNativeError?.(); } catch { /* Observational callbacks never change delivery. */ }
      return SAFE_UPSTREAM_ERROR;
    }
    blocked ||= !!value.promptFeedback?.blockReason;
    if (value.candidates !== undefined && !Array.isArray(value.candidates)) throw new Error("invalid Gemini candidates");
    let visible = false, thought = false;
    for (const [position, candidate] of (value.candidates ?? []).entries()) {
      if (!candidate || typeof candidate !== "object") throw new Error("invalid Gemini candidate");
      const index = candidate.index ?? position;
      if (!Number.isSafeInteger(index) || index < 0 || candidates.size >= 1024 && !candidates.has(index)) throw new Error("invalid Gemini candidate index");
      candidates.set(index, candidates.get(index) === true || typeof candidate.finishReason === "string" && candidate.finishReason.length > 0);
      if (observers?.onOutput && Array.isArray(candidate.content?.parts)) {
        for (const rawPart of candidate.content.parts) {
          const part = jsonObject(rawPart);
          if (!part || !(typeof part.text === "string" && part.text.length > 0) && !jsonObject(part.functionCall ?? part.function_call)) continue;
          if (part.thought === true) thought = true;
          else visible = true;
        }
      }
    }
    if (visible || thought) {
      try { observers?.onOutput?.(visible, thought); } catch { /* Observational callbacks never change delivery. */ }
    }
    if (observers?.onUsage) usage = usageFromGemini(value.usageMetadata) ?? usage;
    return raw;
  }
  function emit(controller: TransformStreamDefaultController<Uint8Array>) {
    if (data.length) {
      const payload = data.join("\n");
      if (payload.trim() === "[DONE]") {
        if (!complete()) throw new Error("premature Gemini stream terminator");
        reportUsage();
        terminal = true;
      } else {
        const response = observe(unwrapGeminiResponse(payload));
        if (format === "sse") {
          controller.enqueue(encoder.encode(`data: ${response.replaceAll("\n", "\ndata: ")}\n\n`));
        } else {
          controller.enqueue(encoder.encode((arrayOpened ? ",\n" : "[\n") + response));
          arrayOpened = true;
        }
      }
    }
    data = []; eventBytes = 0;
    if (terminal) {
      closeArray(controller);
      controller.terminate();
    }
  }
  function appendLineBytes(bytes: Uint8Array) {
    if (!bytes.byteLength) return;
    eventBytes += bytes.byteLength;
    if (eventBytes > maxBytes) throw new Error("Gemini SSE event too large");
    const text = decoder.decode(bytes, { stream: true });
    if (text) lineParts.push(text);
  }
  function endLine(controller: TransformStreamDefaultController<Uint8Array>) {
    const tail = decoder.decode();
    if (tail) lineParts.push(tail);
    const line = lineParts.join("");
    lineParts = [];
    if (!line) emit(controller);
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return new TransformStream({
    transform(chunk, controller) {
      let start = 0;
      // Scan only new bytes; CR/LF cannot occur inside a UTF-8 continuation sequence.
      for (let i = 0; i < chunk.byteLength; i++) {
        const byte = chunk[i];
        if (afterCR) {
          afterCR = false;
          if (byte === 10) { start = i + 1; continue; }
        }
        if (byte !== 10 && byte !== 13) continue;
        appendLineBytes(chunk.subarray(start, i));
        endLine(controller);
        if (terminal) return;
        afterCR = byte === 13;
        start = i + 1;
      }
      appendLineBytes(chunk.subarray(start));
    },
    flush(controller) {
      const tail = decoder.decode();
      if (tail) lineParts.push(tail);
      if (lineParts.join("").trim() || data.length) throw new Error("truncated Gemini SSE event");
      if (!complete()) throw new Error("incomplete Gemini generation");
      reportUsage();
      closeArray(controller);
    },
  });
}

/** Read source text with a byte cap and cancellation, without parsing or re-encoding it. */
export async function readGeminiText(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<string | null> {
  signal.throwIfAborted();
  if (!body) return "";
  const reader = body.getReader();
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  const parts: string[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) return null;
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
  }
}
