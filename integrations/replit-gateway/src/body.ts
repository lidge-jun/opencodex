import type { GatewayErrorCategory } from "./errors";
import { DECIMAL_INTEGER_PATTERN } from "./constants";

export type StrictContentLengthResult =
  | { ok: true; length: number | null }
  | { ok: false; category: GatewayErrorCategory };

export function parseStrictContentLength(header: string | null): StrictContentLengthResult {
  if (header === null) {
    return { ok: true, length: null };
  }
  const trimmed = header.trim();
  if (!DECIMAL_INTEGER_PATTERN.test(trimmed)) {
    return { ok: false, category: "request_too_large" };
  }
  const length = Number(trimmed);
  if (!Number.isSafeInteger(length)) {
    return { ok: false, category: "request_too_large" };
  }
  return { ok: true, length };
}

export type BoundedBodyResult =
  | { ok: true; body: Uint8Array }
  | { ok: false; category: GatewayErrorCategory };

export type ContentEncodingValidationResult =
  | { ok: true }
  | { ok: false; category: GatewayErrorCategory };

export interface ReadBoundedBodyOptions {
  signal?: AbortSignal;
  callerAborted?: () => boolean;
  clientTimedOut?: () => boolean;
}

const STRIPPED_RELAY_HEADERS = new Set([
  "authorization",
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  "content-encoding",
]);

function classifyIngressAbort(options?: ReadBoundedBodyOptions): GatewayErrorCategory {
  if (options?.clientTimedOut?.()) return "client_timeout";
  if (options?.callerAborted?.()) return "client_aborted";
  return "client_aborted";
}

export function validateRequestContentEncoding(req: Request): ContentEncodingValidationResult {
  const encoding = req.headers.get("content-encoding");
  if (!encoding) {
    return { ok: true };
  }
  const normalized = encoding.trim().toLowerCase();
  if (normalized === "identity") {
    return { ok: true };
  }
  return { ok: false, category: "unsupported_content_encoding" };
}

type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<StreamReadResult> {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  return new Promise<StreamReadResult>((resolve, reject) => {
    const onAbort = () => {
      reader.cancel().catch(() => {});
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    reader.read().then(
      (result) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function readBoundedBody(
  req: Request,
  maxBytes: number,
  options?: ReadBoundedBodyOptions,
): Promise<BoundedBodyResult> {
  const declared = parseStrictContentLength(req.headers.get("content-length"));
  if (!declared.ok) {
    return declared;
  }
  if (declared.length !== null && declared.length > maxBytes) {
    return { ok: false, category: "request_too_large" };
  }

  const reader = req.body?.getReader();
  if (!reader) {
    return { ok: true, body: new Uint8Array() };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let abortListener: (() => void) | undefined;

  const removeAbortListener = () => {
    if (abortListener && options?.signal) {
      options.signal.removeEventListener("abort", abortListener);
      abortListener = undefined;
    }
  };

  if (options?.signal) {
    if (options.signal.aborted) {
      try {
        await reader.cancel();
      } catch {
        return { ok: false, category: "internal" };
      }
      return { ok: false, category: classifyIngressAbort(options) };
    }
    abortListener = () => {
      reader.cancel().catch(() => {});
    };
    options.signal.addEventListener("abort", abortListener, { once: true });
  }

  try {
    while (true) {
      if (options?.signal?.aborted) {
        try {
          await reader.cancel();
        } catch {
          return { ok: false, category: "internal" };
        }
        return { ok: false, category: classifyIngressAbort(options) };
      }

      const { done, value } = await readStreamChunk(reader, options?.signal);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          return { ok: false, category: "internal" };
        }
        return { ok: false, category: "request_too_large" };
      }
      chunks.push(value);
    }
  } catch (error) {
    if (options?.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      return { ok: false, category: classifyIngressAbort(options) };
    }
    try {
      await reader.cancel();
    } catch {
      return { ok: false, category: "internal" };
    }
    return { ok: false, category: "internal" };
  } finally {
    removeAbortListener();
  }

  if (declared.length !== null && total !== declared.length) {
    return { ok: false, category: "request_too_large" };
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body };
}

export function createRelayHandoffRequest(original: Request, body: Uint8Array): Request {
  const headers = new Headers();
  original.headers.forEach((value, key) => {
    if (!STRIPPED_RELAY_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  headers.set("content-length", String(body.byteLength));
  return new Request(original.url, {
    method: original.method,
    headers,
    body: body.slice(),
  });
}

/** @deprecated Use createRelayHandoffRequest — strips client credentials before relay. */
export const createReplayableRequest = createRelayHandoffRequest;
