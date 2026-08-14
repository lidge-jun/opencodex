import net, { type Socket } from "node:net";

const DIRECT_LOCAL_HTTP_MAX_BYTES = 8 * 1024 * 1024;
const DIRECT_LOCAL_HTTP_TIMEOUT_MS = 10_000;

type DirectLocalHttpIo = {
  timeoutMs?: number;
  connect?: (hostname: string, port: number) => Socket;
};

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("direct local HTTP request aborted");
  error.name = "AbortError";
  return error;
}

function headerBoundary(bytes: Buffer): number {
  return bytes.indexOf("\r\n\r\n");
}

function validateTrailerLines(bytes: Buffer, start: number, end: number): void {
  if (end === start) return;
  for (const line of bytes.subarray(start, end).toString("latin1").split("\r\n")) {
    if (line.indexOf(":") <= 0) {
      throw new Error("direct local HTTP response has an invalid chunk trailer");
    }
  }
}

function decodeChunkedBody(body: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd < 0) throw new Error("direct local HTTP response has a truncated chunk header");
    const rawSize = body.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0]?.trim() ?? "";
    if (!/^[0-9a-f]+$/i.test(rawSize)) throw new Error("direct local HTTP response has an invalid chunk size");
    const size = Number.parseInt(rawSize, 16);
    offset = lineEnd + 2;
    if (size === 0) {
      if (body.length < offset + 2) throw new Error("direct local HTTP response has a truncated chunk trailer");
      if (body[offset] !== 13 || body[offset + 1] !== 10) {
        const trailerEnd = body.indexOf("\r\n\r\n", offset);
        if (trailerEnd < 0) {
          throw new Error("direct local HTTP response has a truncated chunk trailer");
        }
        validateTrailerLines(body, offset, trailerEnd);
        if (trailerEnd + 4 !== body.length) {
          throw new Error("direct local HTTP response has trailing bytes");
        }
      } else if (offset + 2 !== body.length) {
        throw new Error("direct local HTTP response has trailing bytes");
      }
      return Buffer.concat(chunks);
    }
    if (!Number.isSafeInteger(size) || offset + size + 2 > body.length) {
      throw new Error("direct local HTTP response has a truncated chunk body");
    }
    chunks.push(body.subarray(offset, offset + size));
    offset += size;
    if (body[offset] !== 13 || body[offset + 1] !== 10) {
      throw new Error("direct local HTTP response has an invalid chunk terminator");
    }
    offset += 2;
  }
}

type ResponseFraming =
  | { kind: "head"; searchFrom: number }
  | { kind: "content-length"; totalBytes: number }
  | { kind: "chunk-size"; offset: number; searchFrom: number }
  | { kind: "chunk-body"; offset: number; size: number }
  | { kind: "trailers"; offset: number; searchFrom: number }
  | { kind: "close" }
  | { kind: "complete" };

function parseResponseHead(bytes: Buffer, boundary: number): {
  status: number;
  statusText: string;
  headers: Headers;
} {
  const lines = bytes.subarray(0, boundary).toString("latin1").split("\r\n");
  const statusLine = lines.shift() ?? "";
  const match = /^HTTP\/1\.[01] ([0-9]{3})(?: (.*))?$/.exec(statusLine);
  if (!match) throw new Error("direct local HTTP response has an invalid status line");
  const status = Number(match[1]);
  if (status < 200 || status > 599) throw new Error("direct local HTTP response has an unsupported status");
  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error("direct local HTTP response has an invalid header");
    headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return { status, statusText: match[2] ?? "", headers };
}

function advanceResponseFraming(bytes: Buffer, initial: ResponseFraming): ResponseFraming {
  let framing = initial;
  for (;;) {
    if (framing.kind === "complete" || framing.kind === "close") return framing;
    if (framing.kind === "head") {
      const boundary = bytes.indexOf("\r\n\r\n", framing.searchFrom);
      if (boundary < 0) {
        if (bytes.length > 64 * 1024) throw new Error("direct local HTTP response headers exceed the byte cap");
        return { kind: "head", searchFrom: Math.max(0, bytes.length - 3) };
      }
      const { status, headers } = parseResponseHead(bytes, boundary);
      const bodyStart = boundary + 4;
      if (status === 204 || status === 205 || status === 304) {
        if (bytes.length > bodyStart) {
          throw new Error("direct local HTTP response has a body for a bodyless status");
        }
        return { kind: "complete" };
      }
      if (/\bchunked\b/i.test(headers.get("transfer-encoding") ?? "")) {
        framing = { kind: "chunk-size", offset: bodyStart, searchFrom: bodyStart };
        continue;
      }
      const rawLength = headers.get("content-length");
      if (rawLength === null) return { kind: "close" };
      if (!/^[0-9]+$/.test(rawLength)) throw new Error("direct local HTTP response has an invalid content length");
      const length = Number(rawLength);
      const totalBytes = bodyStart + length;
      if (!Number.isSafeInteger(length) || totalBytes > DIRECT_LOCAL_HTTP_MAX_BYTES) {
        throw new Error("direct local HTTP response exceeds the byte cap");
      }
      framing = { kind: "content-length", totalBytes };
      continue;
    }
    if (framing.kind === "content-length") {
      if (bytes.length > framing.totalBytes) {
        throw new Error("direct local HTTP response has trailing bytes");
      }
      return bytes.length === framing.totalBytes ? { kind: "complete" } : framing;
    }
    if (framing.kind === "chunk-size") {
      const lineEnd = bytes.indexOf("\r\n", framing.searchFrom);
      if (lineEnd < 0) {
        if (bytes.length - framing.offset > 8 * 1024) {
          throw new Error("direct local HTTP response chunk header exceeds the byte cap");
        }
        return {
          ...framing,
          searchFrom: Math.max(framing.offset, bytes.length - 1),
        };
      }
      const rawSize = bytes.subarray(framing.offset, lineEnd).toString("ascii").split(";", 1)[0]?.trim() ?? "";
      if (!/^[0-9a-f]+$/i.test(rawSize)) throw new Error("direct local HTTP response has an invalid chunk size");
      const size = Number.parseInt(rawSize, 16);
      if (!Number.isSafeInteger(size) || size > DIRECT_LOCAL_HTTP_MAX_BYTES) {
        throw new Error("direct local HTTP response chunk exceeds the byte cap");
      }
      const offset = lineEnd + 2;
      framing = size === 0
        ? { kind: "trailers", offset, searchFrom: offset }
        : { kind: "chunk-body", offset, size };
      continue;
    }
    if (framing.kind === "chunk-body") {
      const terminator = framing.offset + framing.size;
      if (terminator + 2 > bytes.length) return framing;
      if (bytes[terminator] !== 13 || bytes[terminator + 1] !== 10) {
        throw new Error("direct local HTTP response has an invalid chunk terminator");
      }
      framing = { kind: "chunk-size", offset: terminator + 2, searchFrom: terminator + 2 };
      continue;
    }
    if (bytes.length < framing.offset + 2) return framing;
    if (bytes[framing.offset] === 13 && bytes[framing.offset + 1] === 10) {
      if (bytes.length > framing.offset + 2) {
        throw new Error("direct local HTTP response has trailing bytes");
      }
      return { kind: "complete" };
    }
    const trailerEnd = bytes.indexOf("\r\n\r\n", framing.searchFrom);
    if (trailerEnd >= 0) {
      validateTrailerLines(bytes, framing.offset, trailerEnd);
      if (bytes.length > trailerEnd + 4) {
        throw new Error("direct local HTTP response has trailing bytes");
      }
      return { kind: "complete" };
    }
    if (bytes.length - framing.offset > 64 * 1024) {
      throw new Error("direct local HTTP response trailers exceed the byte cap");
    }
    return { ...framing, searchFrom: Math.max(framing.offset, bytes.length - 3) };
  }
}

function parseResponse(bytes: Buffer): Response {
  const boundary = headerBoundary(bytes);
  if (boundary < 0) throw new Error("direct local HTTP response has no header boundary");
  const { status, statusText, headers } = parseResponseHead(bytes, boundary);

  let body = bytes.subarray(boundary + 4);
  if (/\bchunked\b/i.test(headers.get("transfer-encoding") ?? "")) {
    body = decodeChunkedBody(body);
    headers.delete("transfer-encoding");
    headers.delete("content-length");
  } else {
    const rawLength = headers.get("content-length");
    if (rawLength !== null) {
      if (!/^[0-9]+$/.test(rawLength)) throw new Error("direct local HTTP response has an invalid content length");
      const length = Number(rawLength);
      if (!Number.isSafeInteger(length) || body.byteLength < length) {
        throw new Error("direct local HTTP response body is truncated");
      }
      body = body.subarray(0, length);
    }
  }

  const bodyless = status === 204 || status === 205 || status === 304;
  return new Response(bodyless ? null : new Uint8Array(body), {
    status,
    statusText,
    headers,
  });
}

/**
 * Fetch one bodyless local HTTP GET or POST over a direct TCP connection.
 *
 * Bun's global fetch and Bun 1.3's node:http compatibility layer can honor
 * HTTP(S)_PROXY. Local identity and capability probes must not expose headers
 * to, or accept a fabricated response from, such a proxy. node:net connects to
 * the selected listener without consulting proxy environment variables. Each
 * caller retains an injected fetch seam for deterministic unit tests.
 */
export async function directLocalHttpFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  io: DirectLocalHttpIo = {},
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
  const body = init.body ?? (input instanceof Request ? input.body : null);

  if (url.protocol !== "http:") throw new Error("direct local request must use HTTP");
  if (url.username || url.password) throw new Error("direct local request URL must not contain credentials");
  if ((method !== "GET" && method !== "POST") || body !== null) {
    throw new Error("direct local request must be a bodyless GET or POST");
  }
  if (signal?.aborted) throw abortReason(signal);

  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.delete("proxy-authorization");
  headers.delete("proxy-connection");
  if (method === "POST") headers.set("content-length", "0");
  else headers.delete("content-length");
  headers.set("host", url.host);
  headers.set("connection", "close");
  const headerLines: string[] = [];
  headers.forEach((value, key) => { headerLines.push(`${key}: ${value}`); });
  const requestBytes = Buffer.from(
    `${method} ${url.pathname}${url.search} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`,
    "latin1",
  );
  const parsedHostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const hostname = parsedHostname;
  const port = url.port ? Number(url.port) : 80;
  const timeoutMs = io.timeoutMs ?? DIRECT_LOCAL_HTTP_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("direct local HTTP timeout must be positive");
  }

  return await new Promise<Response>((resolve, reject) => {
    let socket: Socket | undefined;
    let settled = false;
    let receivedBytes = 0;
    let responseBytes = Buffer.allocUnsafe(4 * 1024);
    let framing: ResponseFraming = { kind: "head", searchFrom: 0 };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      socket?.setTimeout(0);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { socket?.destroy(); } catch { /* ignore */ }
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(parseResponse(responseBytes.subarray(0, receivedBytes)));
      } catch (parseError) {
        reject(parseError instanceof Error ? parseError : new Error(String(parseError)));
      }
    };
    const onAbort = () => {
      const error = signal ? abortReason(signal) : new Error("direct local HTTP request aborted");
      finish(error);
    };

    socket = (io.connect ?? ((host, selectedPort) => net.createConnection({
      host,
      port: selectedPort,
      autoSelectFamily: true,
    })))(hostname, port);
    socket.setTimeout(timeoutMs, () => {
      const error = new Error("direct local HTTP request timed out");
      error.name = "TimeoutError";
      finish(error);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    socket.on("connect", () => {
      try { socket?.write(requestBytes); } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("data", chunk => {
      if (settled) return;
      const bytes = Buffer.from(chunk);
      receivedBytes += bytes.byteLength;
      if (receivedBytes > DIRECT_LOCAL_HTTP_MAX_BYTES) {
        finish(new Error("direct local HTTP response exceeds the byte cap"));
        return;
      }
      if (receivedBytes > responseBytes.byteLength) {
        let capacity = responseBytes.byteLength;
        while (capacity < receivedBytes) capacity = Math.min(DIRECT_LOCAL_HTTP_MAX_BYTES, capacity * 2);
        const grown = Buffer.allocUnsafe(capacity);
        responseBytes.copy(grown);
        responseBytes = grown;
      }
      bytes.copy(responseBytes, receivedBytes - bytes.byteLength);
      try {
        framing = advanceResponseFraming(responseBytes.subarray(0, receivedBytes), framing);
        if (framing.kind === "complete") finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("end", () => finish());
    socket.once("error", error => finish(error));
    socket.once("close", () => finish());
  });
}
