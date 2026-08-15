import { readBoundedResponseBody } from "../lib/bounded-body";

export class CodexWarmupError extends Error {
  code: "http_status" | "missing_body" | "stream_failed" | "stream_incomplete" | "stream_error" | "stream_too_large" | "invalid_sse" | "no_terminal" | "transport";
  status?: number;
  /** Upstream error detail extracted from the response body (truncated to 512 chars). */
  upstreamDetail?: string;

  constructor(
    code: CodexWarmupError["code"],
    message = "Codex warmup failed",
    options: { status?: number; cause?: unknown; upstreamDetail?: string } = {},
  ) {
    super(message);
    this.name = "CodexWarmupError";
    this.code = code;
    this.status = options.status;
    this.upstreamDetail = options.upstreamDetail;
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

/** Read the first MAX_ERROR_BODY_BYTES of a response body and extract an error message. */
async function readErrorDetail(res: Response, signal: AbortSignal): Promise<string | undefined> {
  try {
    const body = await readBoundedResponseBody(res, {
      signal,
      maxBytes: MAX_ERROR_BODY_BYTES,
      fatalUtf8: true,
    });
    if (!body.displaySafe) return undefined;
    const trimmed = body.text;
    try {
      const json = JSON.parse(trimmed) as Record<string, unknown>;
      // ChatGPT backend error shape: { error: { message: "..." } } or { detail: "..." }
      const nested = json.error;
      if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).message === "string") {
        return ((nested as Record<string, unknown>).message as string).slice(0, 512);
      }
      if (typeof json.detail === "string") return json.detail.slice(0, 512);
      if (typeof json.error === "string") return (json.error as string).slice(0, 512);
      if (typeof json.message === "string") return json.message.slice(0, 512);
    } catch {
      // Non-JSON response body may contain sensitive data (tokens, credentials).
      // Only surface structured error messages, never raw text.
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function safeWarmupReason(err: unknown): string {
  if (err instanceof CodexWarmupError) {
    const base = err.status ? `${err.code}:${err.status}` : err.code;
    return err.upstreamDetail ? `${base} — ${err.upstreamDetail}` : base;
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
    const upstreamDetail = await readErrorDetail(res, signal);
    throw new CodexWarmupError("http_status", "Codex warmup was rejected", {
      status: res.status,
      upstreamDetail,
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
