/** Gemini payloads remain source text: parsing is validation, never serialization. */
export const GEMINI_NATIVE_MAX_BYTES = 16 * 1024 * 1024;
export const GEMINI_NATIVE_ERROR_CODE = "gemini_native_upstream_error";

export function validateGeminiObject(raw: string): void {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
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

export function wrapGeminiRequest(raw: string, model: string, project: string): string {
  validateGeminiObject(raw);
  const envelope = JSON.stringify({ model, project, userAgent: "antigravity", requestType: "agent", requestId: `agent-${crypto.randomUUID()}` });
  return `${envelope.slice(0, -1)},"request":${raw}}`;
}

/** Bounded SSE framing. Only the CCA response envelope is removed. */
export function geminiSseTransform(maxBytes = GEMINI_NATIVE_MAX_BYTES, onNativeError?: () => void): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let lineParts: string[] = [], data: string[] = [], eventBytes = 0, afterCR = false;
  const candidates = new Map<number, boolean>();
  let nativeError = false, blocked = false;
  const complete = () => nativeError || (candidates.size ? [...candidates.values()].every(Boolean) : blocked);
  function observe(raw: string) {
    const value = JSON.parse(raw) as { candidates?: Array<{ index?: number; finishReason?: string }>; error?: unknown; promptFeedback?: { blockReason?: string } };
    if (!nativeError && value.error && typeof value.error === "object" && !Array.isArray(value.error)) {
      nativeError = true;
      try { onNativeError?.(); } catch { /* Observational callbacks never change delivery. */ }
    }
    blocked ||= !!value.promptFeedback?.blockReason;
    if (value.candidates !== undefined && !Array.isArray(value.candidates)) throw new Error("invalid Gemini candidates");
    for (const [position, candidate] of (value.candidates ?? []).entries()) {
      if (!candidate || typeof candidate !== "object") throw new Error("invalid Gemini candidate");
      const index = candidate.index ?? position;
      if (!Number.isSafeInteger(index) || index < 0 || candidates.size >= 1024 && !candidates.has(index)) throw new Error("invalid Gemini candidate index");
      candidates.set(index, candidates.get(index) === true || typeof candidate.finishReason === "string" && candidate.finishReason.length > 0);
    }
  }
  function emit(controller: TransformStreamDefaultController<Uint8Array>) {
    if (data.length) {
      const payload = data.join("\n");
      if (payload.trim() === "[DONE]") {
        if (!complete()) throw new Error("premature Gemini stream terminator");
      } else {
        const response = unwrapGeminiResponse(payload);
        observe(response);
        controller.enqueue(encoder.encode(`data: ${response.replaceAll("\n", "\ndata: ")}\n\n`));
      }
    }
    data = []; eventBytes = 0;
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
        afterCR = byte === 13;
        start = i + 1;
      }
      appendLineBytes(chunk.subarray(start));
    },
    flush() {
      const tail = decoder.decode();
      if (tail) lineParts.push(tail);
      if (lineParts.join("").trim() || data.length) throw new Error("truncated Gemini SSE event");
      if (!complete()) throw new Error("incomplete Gemini generation");
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
