import net, { type Socket } from "node:net";
import tls, { type TLSSocket } from "node:tls";

const DEFAULT_SOCKS5_PORT = 1080;
const SOCKS5_CONNECT_TIMEOUT_MS = 30_000;
const SOCKS5_RESPONSE_TIMEOUT_MS = 200_000;
const MAX_RESPONSE_HEADER_BYTES = 64 * 1024;
const SOCKS5_VERSION = 0x05;
const SOCKS5_NO_AUTH = 0x00;
const SOCKS5_USER_PASS = 0x02;
const SOCKS5_CONNECT = 0x01;
const SOCKS5_DOMAIN = 0x03;
const SOCKS5_SUCCESS = 0x00;
const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

export class Socks5FetchError extends Error {
  override readonly name = "Socks5FetchError";
}

function proxyCredentials(proxy: URL): { username?: Uint8Array; password?: Uint8Array } {
  if (!proxy.username && !proxy.password) return {};
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(proxy.username);
    password = decodeURIComponent(proxy.password);
  } catch {
    throw new Socks5FetchError("SOCKS5 proxy credentials contain invalid percent encoding");
  }
  const usernameBytes = new TextEncoder().encode(username);
  const passwordBytes = new TextEncoder().encode(password);
  if (usernameBytes.byteLength > 255 || passwordBytes.byteLength > 255) {
    throw new Socks5FetchError("SOCKS5 proxy credentials must each fit in 255 UTF-8 bytes");
  }
  return { username: usernameBytes, password: passwordBytes };
}

function validateProxy(proxy: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(proxy);
  } catch {
    throw new Socks5FetchError("SOCKS5 proxy URL is invalid");
  }
  if (parsed.protocol !== "socks5:" && parsed.protocol !== "socks5h:") {
    throw new Socks5FetchError(`unsupported SOCKS5 proxy protocol: ${parsed.protocol}`);
  }
  if (!parsed.hostname) throw new Socks5FetchError("SOCKS5 proxy URL has no host");
  if (parsed.port && (!/^\d+$/.test(parsed.port) || Number(parsed.port) > 65535)) {
    throw new Socks5FetchError("SOCKS5 proxy port is invalid");
  }
  if (parsed.search || parsed.hash) throw new Socks5FetchError("SOCKS5 proxy URL must not contain a query or fragment");
  proxyCredentials(parsed);
  return parsed;
}

function targetPort(target: URL): number {
  if (target.port) return Number(target.port);
  return target.protocol === "https:" ? 443 : 80;
}

function connectSocket(hostname: string, port: number, signal?: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted"));
      return;
    }
    const socket = net.createConnection({ host: hostname, port });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      fail(new Socks5FetchError("SOCKS5 proxy connection timed out"));
    }, SOCKS5_CONNECT_TIMEOUT_MS);
    const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error("The operation was aborted"));
    const onConnect = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => fail(new Socks5FetchError("SOCKS5 proxy closed before connecting"));
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      cleanup();
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class SocketReader {
  private buffer = Buffer.alloc(0);
  private ended = false;
  private readonly exactWaiters: Array<{
    length: number;
    resolve: (value: Buffer) => void;
    reject: (error: unknown) => void;
  }> = [];
  private readonly anyWaiters: Array<{
    resolve: (value: Buffer) => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(private readonly socket: Socket) {
    socket.on("data", this.onData);
    socket.once("error", this.onError);
    socket.once("end", this.onEnd);
    socket.once("close", this.onEnd);
  }

  private readonly onData = (chunk: Buffer | string): void => {
    const value = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (this.anyWaiters.length > 0) {
      this.anyWaiters.shift()!.resolve(value);
      return;
    }
    this.buffer = Buffer.concat([this.buffer, value]);
    this.flushExact();
  };

  private readonly onError = (error: Error): void => {
    this.ended = true;
    this.rejectExact(error);
    this.rejectAny(error);
  };

  private readonly onEnd = (): void => {
    this.ended = true;
    this.rejectExact(new Socks5FetchError("SOCKS5 socket ended before the expected bytes arrived"));
    while (this.anyWaiters.length > 0) this.anyWaiters.shift()!.resolve(Buffer.alloc(0));
  };

  private flushExact(): void {
    while (this.exactWaiters.length > 0 && this.buffer.byteLength >= this.exactWaiters[0]!.length) {
      const waiter = this.exactWaiters.shift()!;
      const value = this.buffer.subarray(0, waiter.length);
      this.buffer = this.buffer.subarray(waiter.length);
      waiter.resolve(value);
    }
  }

  private rejectExact(error: unknown): void {
    while (this.exactWaiters.length > 0) this.exactWaiters.shift()!.reject(error);
  }

  private rejectAny(error: unknown): void {
    while (this.anyWaiters.length > 0) this.anyWaiters.shift()!.reject(error);
  }

  read(length: number, signal?: AbortSignal): Promise<Buffer> {
    if (this.buffer.byteLength >= length) {
      const value = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      return Promise.resolve(value);
    }
    if (this.ended) return Promise.reject(new Socks5FetchError("SOCKS5 socket ended before the expected bytes arrived"));
    return new Promise((resolve, reject) => {
      const waiter = { length, resolve, reject };
      const onAbort = () => {
        signal?.removeEventListener("abort", onAbort);
        const index = this.exactWaiters.indexOf(waiter);
        if (index >= 0) this.exactWaiters.splice(index, 1);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("The operation was aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.exactWaiters.push({
        length,
        resolve: value => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: error => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
    });
  }

  async readUntil(delimiter: Buffer, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    while (true) {
      const index = this.buffer.indexOf(delimiter);
      if (index >= 0) {
        const end = index + delimiter.byteLength;
        const value = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end);
        return value;
      }
      if (this.buffer.byteLength > maxBytes) throw new Socks5FetchError("SOCKS5 upstream response headers are too large");
      const chunk = await this.readAny(signal);
      if (chunk.byteLength === 0) throw new Socks5FetchError("SOCKS5 upstream closed before response headers");
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }
  }

  readAny(signal?: AbortSignal): Promise<Buffer> {
    if (this.buffer.byteLength > 0) {
      const value = this.buffer;
      this.buffer = Buffer.alloc(0);
      return Promise.resolve(value);
    }
    if (this.ended) return Promise.resolve(Buffer.alloc(0));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const onAbort = () => {
        signal?.removeEventListener("abort", onAbort);
        const index = this.anyWaiters.indexOf(waiter);
        if (index >= 0) this.anyWaiters.splice(index, 1);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("The operation was aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.anyWaiters.push({
        resolve: value => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: error => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
    });
  }

  dispose(): void {
    this.socket.removeListener("data", this.onData);
    this.socket.removeListener("error", this.onError);
    this.socket.removeListener("end", this.onEnd);
    this.socket.removeListener("close", this.onEnd);
    if (this.buffer.byteLength > 0) this.socket.unshift(this.buffer);
    this.rejectExact(new Socks5FetchError("SOCKS5 reader disposed"));
    this.rejectAny(new Socks5FetchError("SOCKS5 reader disposed"));
  }
}

async function socks5Connect(proxy: string, target: URL, signal?: AbortSignal): Promise<Socket> {
  const parsedProxy = validateProxy(proxy);
  const credentials = proxyCredentials(parsedProxy);
  const socket = await connectSocket(parsedProxy.hostname, Number(parsedProxy.port) || DEFAULT_SOCKS5_PORT, signal);
  socket.setTimeout(SOCKS5_CONNECT_TIMEOUT_MS, () => {
    socket.destroy(new Socks5FetchError("SOCKS5 handshake timed out"));
  });
  const reader = new SocketReader(socket);
  try {
    const methods = credentials.username ? Buffer.from([SOCKS5_NO_AUTH, SOCKS5_USER_PASS]) : Buffer.from([SOCKS5_NO_AUTH]);
    socket.write(Buffer.from([SOCKS5_VERSION, methods.byteLength, ...methods]));
    const greeting = await reader.read(2, signal);
    if (greeting[0] !== SOCKS5_VERSION) throw new Socks5FetchError("SOCKS5 proxy returned an invalid greeting");
    if (greeting[1] === SOCKS5_USER_PASS && credentials.username && credentials.password) {
      socket.write(Buffer.from([
        0x01,
        credentials.username.byteLength,
        ...credentials.username,
        credentials.password.byteLength,
        ...credentials.password,
      ]));
      const auth = await reader.read(2, signal);
      if (auth[0] !== 0x01 || auth[1] !== 0x00) throw new Socks5FetchError("SOCKS5 proxy authentication failed");
    } else if (greeting[1] !== SOCKS5_NO_AUTH) {
      throw new Socks5FetchError("SOCKS5 proxy does not accept an offered authentication method");
    }

    const hostname = new TextEncoder().encode(target.hostname);
    if (hostname.byteLength > 255) throw new Socks5FetchError("SOCKS5 target hostname is too long");
    const port = targetPort(target);
    socket.write(Buffer.from([
      SOCKS5_VERSION,
      SOCKS5_CONNECT,
      0x00,
      SOCKS5_DOMAIN,
      hostname.byteLength,
      ...hostname,
      port >> 8,
      port & 0xff,
    ]));
    const reply = await reader.read(4, signal);
    if (reply[0] !== SOCKS5_VERSION) throw new Socks5FetchError("SOCKS5 proxy returned an invalid connect response");
    if (reply[1] !== SOCKS5_SUCCESS) throw new Socks5FetchError(`SOCKS5 proxy refused the connection (code ${reply[1]})`);
    const addressLength = reply[3] === 0x01 ? 4 : reply[3] === SOCKS5_DOMAIN ? (await reader.read(1, signal))[0]! : 16;
    await reader.read(addressLength + 2, signal);
    socket.setTimeout(0);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    reader.dispose();
  }
}

function requestHeaders(request: Request, target: URL): { text: string; chunked: boolean } {
  const headers = new Headers(request.headers);
  if (!headers.has("host")) headers.set("host", target.host);
  if (!headers.has("connection")) headers.set("connection", "close");
  const chunked = request.body !== null
    && !headers.has("content-length")
    && !headers.has("transfer-encoding");
  if (chunked) headers.set("transfer-encoding", "chunked");
  return {
    text: [...headers.entries()].map(([key, value]) => `${key}: ${value}\r\n`).join(""),
    chunked,
  };
}

async function secureSocket(socket: Socket, target: URL, signal: AbortSignal): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({
      socket,
      servername: target.hostname,
      rejectUnauthorized: true,
    });
    const onAbort = () => {
      tlsSocket.destroy();
      reject(signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted"));
    };
    const onSecureConnect = () => {
      signal.removeEventListener("abort", onAbort);
      resolve(tlsSocket);
    };
    tlsSocket.once("secureConnect", onSecureConnect);
    tlsSocket.once("error", error => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseResponseHead(raw: Buffer): { status: number; statusText: string; headers: Headers } {
  const text = raw.toString("latin1");
  const lines = text.split("\r\n");
  const statusLine = lines.shift() ?? "";
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);
  if (!match) throw new Socks5FetchError("SOCKS5 upstream returned an invalid HTTP response");
  const headers = new Headers();
  for (const line of lines) {
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Socks5FetchError("SOCKS5 upstream returned an invalid HTTP header");
    headers.append(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return { status: Number(match[1]), statusText: match[2] ?? "", headers };
}

function waitForDrain(socket: Socket, signal: AbortSignal): Promise<void> {
  if (socket.destroyed) return Promise.reject(new Socks5FetchError("SOCKS5 socket closed while sending the request"));
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      socket.removeListener("drain", onDrain);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onDrain = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Socks5FetchError("SOCKS5 socket closed while sending the request"));
    const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted"));
    socket.once("drain", onDrain);
    socket.once("error", onError);
    socket.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (socket.destroyed) onClose();
    else if (signal.aborted) onAbort();
  });
}

function responseBody(
  reader: SocketReader,
  socket: Socket,
  signal: AbortSignal,
  headers: Headers,
  status: number,
  method: string,
): ReadableStream<Uint8Array> | null {
  const bodyless = method === "HEAD" || status === 204 || status === 304 || (status >= 100 && status < 200);
  if (bodyless) {
    reader.dispose();
    socket.setTimeout(0);
    socket.destroy();
    return null;
  }
  const lengthHeader = headers.get("content-length");
  const contentLength = lengthHeader === null ? undefined : Number(lengthHeader);
  if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
    throw new Socks5FetchError("SOCKS5 upstream returned an invalid content-length");
  }
  const chunked = (headers.get("transfer-encoding") ?? "").toLowerCase().split(",").some(value => value.trim() === "chunked");
  let remaining = contentLength;
  let chunkRemaining = 0;
  let complete = false;
  const finish = () => {
    if (complete) return;
    complete = true;
    signal.removeEventListener("abort", onAbort);
    reader.dispose();
    socket.setTimeout(0);
    socket.destroy();
  };
  const onAbort = () => socket.destroy(signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  const readChunk = async (): Promise<Buffer | null> => {
    if (chunked) {
      if (chunkRemaining === 0) {
        const line = (await reader.readUntil(CRLF, MAX_RESPONSE_HEADER_BYTES, signal)).subarray(0, -2).toString("ascii");
        const size = Number.parseInt(line.split(";", 1)[0]!.trim(), 16);
        if (!Number.isSafeInteger(size) || size < 0) throw new Socks5FetchError("SOCKS5 upstream returned an invalid chunk size");
        if (size === 0) {
          while (true) {
            const trailer = await reader.readUntil(CRLF, MAX_RESPONSE_HEADER_BYTES, signal);
            if (trailer.equals(CRLF)) break;
          }
          return null;
        }
        chunkRemaining = size;
      }
      const value = await reader.read(chunkRemaining, signal);
      chunkRemaining = 0;
      const ending = await reader.read(2, signal);
      if (!ending.equals(CRLF)) throw new Socks5FetchError("SOCKS5 upstream returned an invalid chunk terminator");
      return value;
    }
    if (remaining !== undefined) {
      if (remaining === 0) return null;
      const value = await reader.read(Math.min(remaining, 64 * 1024), signal);
      remaining -= value.byteLength;
      return value;
    }
    const value = await reader.readAny(signal);
    return value.byteLength === 0 ? null : value;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const value = await readChunk();
        if (value === null) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        finish();
        controller.error(error);
        socket.destroy();
      }
    },
    cancel() {
      finish();
      socket.destroy();
    },
  });
}

export async function socks5Fetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  proxy: string,
): Promise<Response> {
  const request = new Request(input, init);
  const target = new URL(request.url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Socks5FetchError(`SOCKS5 fetch only supports HTTP(S) URLs, got ${target.protocol}`);
  }
  const tunnel = await socks5Connect(proxy, target, request.signal);
  let socket: Socket = tunnel;
  const onAbort = () => socket.destroy(request.signal.reason instanceof Error ? request.signal.reason : new Error("The operation was aborted"));
  request.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (target.protocol === "https:") socket = await secureSocket(tunnel, target, request.signal);
    socket.setTimeout(SOCKS5_RESPONSE_TIMEOUT_MS, () => {
      socket.destroy(new Socks5FetchError("SOCKS5 upstream request timed out"));
    });
    const headers = requestHeaders(request, target);
    const head = `${request.method} ${target.pathname}${target.search} HTTP/1.1\r\n${headers.text}\r\n`;
    socket.write(head);
    if (request.body) {
      const bodyReader = request.body.getReader();
      try {
        while (true) {
          const next = await bodyReader.read();
          if (next.done) break;
          const body = headers.chunked
            ? Buffer.concat([Buffer.from(`${next.value.byteLength.toString(16)}\r\n`), Buffer.from(next.value), CRLF])
            : next.value;
          if (!socket.write(body)) await waitForDrain(socket, request.signal);
        }
        if (headers.chunked && !socket.write("0\r\n\r\n")) await waitForDrain(socket, request.signal);
      } finally {
        bodyReader.releaseLock();
      }
    }
    const reader = new SocketReader(socket);
    let responseHead = parseResponseHead(await reader.readUntil(HEADER_END, MAX_RESPONSE_HEADER_BYTES, request.signal));
    while (responseHead.status >= 100 && responseHead.status < 200 && responseHead.status !== 101) {
      responseHead = parseResponseHead(await reader.readUntil(HEADER_END, MAX_RESPONSE_HEADER_BYTES, request.signal));
    }
    const body = responseBody(reader, socket, request.signal, responseHead.headers, responseHead.status, request.method);
    request.signal.removeEventListener("abort", onAbort);
    return new Response(body, {
      status: responseHead.status,
      statusText: responseHead.statusText,
      headers: responseHead.headers,
    });
  } catch (error) {
    request.signal.removeEventListener("abort", onAbort);
    socket.destroy();
    throw error;
  }
}
