import { readBoundedResponseBody } from "../lib/bounded-body";

export class CodexWarmupError extends Error {
  code: "http_status" | "missing_body" | "stream_failed" | "stream_incomplete" | "stream_error" | "stream_too_large" | "invalid_sse" | "no_terminal" | "transport";
  status?: number;

  constructor(
    code: CodexWarmupError["code"],
    message = "Codex warmup failed",
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "CodexWarmupError";
    this.code = code;
    this.status = options.status;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export interface CodexWarmupOptions {
  accessToken: string;
  chatgptAccountId: string;
  model?: string;
  timeoutMs?: number;
}

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_MODEL = "gpt-5.4-mini";
const FALLBACK_MODELS = ["gpt-5.5"];
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY_BYTES = 2048;
const MAX_WARMUP_STREAM_BYTES = 1024 * 1024;

/** Bound and release an upstream error body without exposing provider-controlled text. */
async function drainErrorBody(res: Response, signal: AbortSignal): Promise<void> {
  try {
    await readBoundedResponseBody(res, {
      signal,
      maxBytes: MAX_ERROR_BODY_BYTES,
      fatalUtf8: true,
    });
  } catch {
    // The bounded reader owns cancellation for oversized, invalid, or stalled bodies.
  }
}

function safeWarmupReason(err: unknown): string {
  if (err instanceof CodexWarmupError) {
    return err.status ? `${err.code}:${err.status}` : err.code;
  }
  return "transport";
}

export function codexWarmupFailureReason(err: unknown): string {
  return safeWarmupReason(err);
}

function eventTypeFromData(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  return typeof record.type === "string" ? record.type : undefined;
}

function parseSseFrame(frame: string): unknown | null {
  const dataLines = frame
    .split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data) as unknown;
  } catch (err) {
    throw new CodexWarmupError("invalid_sse", "Codex warmup received invalid SSE", { cause: err });
  }
}

async function drainWarmupSse(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytesRead = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_WARMUP_STREAM_BYTES - bytesRead) {
        throw new CodexWarmupError("stream_too_large", "Codex warmup stream exceeded the size limit");
      }
      bytesRead += value.byteLength;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const frameEnd = buffer.search(/\r?\n\r?\n/);
        if (frameEnd < 0) break;
        const frame = buffer.slice(0, frameEnd);
        const delimiterLength = buffer[frameEnd] === "\r" ? 4 : 2;
        buffer = buffer.slice(frameEnd + delimiterLength);
        const parsed = parseSseFrame(frame);
        const type = eventTypeFromData(parsed);
        if (type === "response.completed") return;
        if (type === "response.failed") throw new CodexWarmupError("stream_failed");
        if (type === "response.incomplete") throw new CodexWarmupError("stream_incomplete");
        if (type === "error") throw new CodexWarmupError("stream_error");
      }
    }

    if (buffer.trim()) {
      const parsed = parseSseFrame(buffer);
      const type = eventTypeFromData(parsed);
      if (type === "response.completed") return;
      if (type === "response.failed") throw new CodexWarmupError("stream_failed");
      if (type === "response.incomplete") throw new CodexWarmupError("stream_incomplete");
      if (type === "error") throw new CodexWarmupError("stream_error");
    }

    throw new CodexWarmupError("no_terminal", "Codex warmup ended before completion");
  } finally {
    reader.releaseLock();
  }
}

async function tryWarmup(options: CodexWarmupOptions, model: string): Promise<void> {
  let signal: AbortSignal;
  let res: Response;
  try {
    signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    res = await fetch(CODEX_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        "ChatGPT-Account-Id": options.chatgptAccountId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        instructions: "Reply with OK.",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        stream: true,
        store: false,
      }),
      signal,
    });
  } catch (err) {
    throw new CodexWarmupError("transport", "Codex warmup request failed", { cause: err });
  }

  if (!res.ok) {
    await drainErrorBody(res, signal);
    throw new CodexWarmupError("http_status", "Codex warmup was rejected", {
      status: res.status,
    });
  }
  const body = res.body;
  if (!body) throw new CodexWarmupError("missing_body");

  try {
    await drainWarmupSse(body);
  } finally {
    try {
      void body.cancel().catch(() => {});
    } catch {
      // Some custom stream implementations throw synchronously from cancel().
    }
  }
}

export async function warmCodexAccount(options: CodexWarmupOptions): Promise<void> {
  const primaryModel = options.model?.trim() || DEFAULT_MODEL;
  try {
    await tryWarmup(options, primaryModel);
    return;
  } catch (err) {
    // Retry with fallback models on 400 (model may not be available for this account).
    if (!(err instanceof CodexWarmupError) || err.status !== 400) throw err;
    let lastErr = err;
    for (const fallback of FALLBACK_MODELS) {
      if (fallback === primaryModel) continue;
      try {
        await tryWarmup(options, fallback);
        return;
      } catch (retryErr) {
        if (retryErr instanceof CodexWarmupError) lastErr = retryErr;
      }
    }
    throw lastErr;
  }
}
