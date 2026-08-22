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
const MAX_TIMEOUT_MS = 0x7fff_ffff;
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
  } catch (error) {
    if (signal.aborted) {
      throw new CodexWarmupError("transport", "Codex warmup request failed", {
        cause: error,
      });
    }
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

async function drainWarmupSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = new Uint8Array(Math.min(MAX_WARMUP_STREAM_BYTES, 64 * 1024));
  let bufferedBytes = 0;
  let scanOffset = 0;
  let bytesRead = 0;
  const abortError = () => new CodexWarmupError("transport", "Codex warmup request failed", {
    cause: signal.reason,
  });
  const cancelReader = () => {
    try {
      void reader.cancel(signal.reason).catch(() => {});
    } catch {
      // Some custom stream implementations throw synchronously from cancel().
    }
  };
  // Fetch implementations usually error the response body when their signal is
  // aborted, but a ReadableStream is not intrinsically coupled to that signal.
  // Race only the currently pending read against a removable abort listener;
  // Bun 1.3 can leave read() parked until a custom source's cancel promise
  // settles, while a shared never-settled race promise would retain one handler
  // per chunk. Cancellation remains best-effort and is never awaited.
  const readWithSignal = (): Promise<Awaited<ReturnType<typeof reader.read>>> => {
    if (signal.aborted) {
      cancelReader();
      return Promise.reject(abortError());
    }
    const read = reader.read();
    void read.catch(() => {});
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        action();
      };
      const onAbort = () => {
        cancelReader();
        finish(() => reject(abortError()));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      read.then(
        result => finish(() => resolve(result)),
        error => finish(() => reject(error)),
      );
    });
  };
  const ensureCapacity = (requiredBytes: number) => {
    if (requiredBytes <= buffer.byteLength) return;
    const grown = new Uint8Array(Math.min(
      MAX_WARMUP_STREAM_BYTES,
      Math.max(requiredBytes, buffer.byteLength * 2),
    ));
    grown.set(buffer.subarray(0, bufferedBytes));
    buffer = grown;
  };
  const findFrameDelimiter = (start: number): { index: number; length: 2 | 3 | 4 } | undefined => {
    for (let index = start; index < bufferedBytes - 1; index += 1) {
      const firstLength = buffer[index] === 10
        ? 1
        : buffer[index] === 13 && buffer[index + 1] === 10 ? 2 : 0;
      if (firstLength === 0) continue;
      const secondStart = index + firstLength;
      const secondLength = buffer[secondStart] === 10
        ? 1
        : buffer[secondStart] === 13 && buffer[secondStart + 1] === 10 ? 2 : 0;
      if (secondLength > 0) return { index, length: (firstLength + secondLength) as 2 | 3 | 4 };
    }
    return undefined;
  };
  const acceptFrame = (frame: Uint8Array): boolean => {
    const parsed = parseSseFrame(decoder.decode(frame));
    const type = eventTypeFromData(parsed);
    if (type === "response.completed") return true;
    if (type === "response.failed") throw new CodexWarmupError("stream_failed");
    if (type === "response.incomplete") throw new CodexWarmupError("stream_incomplete");
    if (type === "error") throw new CodexWarmupError("stream_error");
    return false;
  };

  try {
    if (signal.aborted) throw abortError();
    for (;;) {
      const { done, value } = await readWithSignal();
      if (signal.aborted) throw abortError();
      if (done) break;
      if (value.byteLength > MAX_WARMUP_STREAM_BYTES - bytesRead) {
        throw new CodexWarmupError("stream_too_large", "Codex warmup stream exceeded the size limit");
      }
      bytesRead += value.byteLength;
      ensureCapacity(bufferedBytes + value.byteLength);
      buffer.set(value, bufferedBytes);
      bufferedBytes += value.byteLength;

      let consumedBytes = 0;
      for (;;) {
        const delimiter = findFrameDelimiter(scanOffset);
        if (!delimiter) {
          // A delimiter can start at most three bytes before the next chunk.
          scanOffset = Math.max(consumedBytes, bufferedBytes - 3);
          break;
        }
        if (acceptFrame(buffer.subarray(consumedBytes, delimiter.index))) return;
        consumedBytes = delimiter.index + delimiter.length;
        scanOffset = consumedBytes;
      }
      if (consumedBytes > 0) {
        buffer.copyWithin(0, consumedBytes, bufferedBytes);
        bufferedBytes -= consumedBytes;
        scanOffset = Math.max(0, scanOffset - consumedBytes);
      }
    }

    if (bufferedBytes > 0 && acceptFrame(buffer.subarray(0, bufferedBytes))) return;

    throw new CodexWarmupError("no_terminal", "Codex warmup ended before completion");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A hostile cancel promise may keep the final read locked after timeout.
    }
  }
}

async function tryWarmup(options: CodexWarmupOptions, model: string): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new CodexWarmupError("transport", "Codex warmup request failed", {
      cause: new RangeError("Codex warmup timeout is outside the supported range"),
    });
  }
  // Bun 1.3 can leave AbortSignal.timeout() dormant while a custom response
  // stream has a pending read. A ref'ed timer and explicit controller make the
  // same deadline cover response headers and the full success/error body.
  const deadline = new AbortController();
  const signal = deadline.signal;
  const timer = setTimeout(() => {
    deadline.abort(new DOMException("Codex warmup timed out", "TimeoutError"));
  }, timeoutMs);

  try {
    let res: Response;
    try {
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
      await drainWarmupSse(body, signal);
    } finally {
      try {
        void body.cancel().catch(() => {});
      } catch {
        // Some custom stream implementations throw synchronously from cancel().
      }
    }
  } finally {
    clearTimeout(timer);
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
