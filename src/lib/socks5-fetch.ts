import net, { type Socket } from "node:net";
import tls, { type TLSSocket } from "node:tls";
import { classifyContentCoding, isNullBodyStatus } from "./http-response-semantics";

const DEFAULT_SOCKS5_PORT = 1080;
const SOCKS5_CONNECT_TIMEOUT_MS = 30_000;
const SOCKS5_RESPONSE_TIMEOUT_MS = 200_000;
const MAX_RESPONSE_HEADER_BYTES = 64 * 1024;
const MAX_BODY_SLICE_BYTES = 64 * 1024;
const MAX_DECODED_BODY_BYTES = 32 * 1024 * 1024;
const MAX_STREAM_DECODE_EXPANSION_RATIO = 128;
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
  if (parsed.port && (!/^\d+$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65535)) {
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
  private failure: Error | undefined;
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
    socket.resume();
  }

  private readonly onData = (chunk: Buffer | string): void => {
    const value = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (this.anyWaiters.length > 0) {
      this.anyWaiters.shift()!.resolve(value);
      return;
    }
    this.buffer = Buffer.concat([this.buffer, value]);
    this.flushExact();
    if (this.buffer.byteLength >= MAX_BODY_SLICE_BYTES) this.socket.pause();
  };

  private readonly onError = (error: Error): void => {
    this.failure = error;
    this.ended = true;
    this.rejectExact(error);
    this.rejectAny(error);
  };

  private readonly onEnd = (): void => {
    this.ended = true;
    this.rejectExact(this.failure ?? new Socks5FetchError("SOCKS5 socket ended before the expected bytes arrived"));
    if (this.failure) this.rejectAny(this.failure);
    else while (this.anyWaiters.length > 0) this.anyWaiters.shift()!.resolve(Buffer.alloc(0));
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
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("The operation was aborted"));
    if (this.buffer.byteLength >= length) {
      const value = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      if (this.buffer.byteLength < MAX_BODY_SLICE_BYTES) this.socket.resume();
      return Promise.resolve(value);
    }
    if (this.ended) return Promise.reject(this.failure ?? new Socks5FetchError("SOCKS5 socket ended before the expected bytes arrived"));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.exactWaiters.indexOf(waiter);
        if (index >= 0) this.exactWaiters.splice(index, 1);
        waiter.reject(signal?.reason ?? new Error("The operation was aborted"));
      };
      // Store this exact object so cancellation removes the queued waiter.
      const waiter = {
        length,
        resolve: (value: Buffer) => { signal?.removeEventListener("abort", onAbort); resolve(value); },
        reject: (error: unknown) => { signal?.removeEventListener("abort", onAbort); reject(error); },
      };
      this.exactWaiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else this.socket.resume();
    });
  }

  async readUntil(delimiter: Buffer, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    // Keep partial framing outside the shared buffer: readAny must wait for NEW
    // bytes instead of returning the same unterminated prefix in a microtask loop.
    let pending = Buffer.alloc(0);
    for (;;) {
      const chunk = await this.readAny(signal);
      if (chunk.byteLength === 0) throw new Socks5FetchError("SOCKS5 upstream closed before response headers");
      pending = Buffer.concat([pending, chunk]);
      const index = pending.indexOf(delimiter);
      if (index >= 0) {
        const end = index + delimiter.byteLength;
        if (end > maxBytes) throw new Socks5FetchError("SOCKS5 upstream response headers are too large");
        // Another data event may have arrived while the read promise resumed.
        this.buffer = Buffer.concat([pending.subarray(end), this.buffer]);
        if (this.buffer.byteLength >= MAX_BODY_SLICE_BYTES) this.socket.pause();
        return pending.subarray(0, end);
      }
      if (pending.byteLength >= maxBytes) throw new Socks5FetchError("SOCKS5 upstream response headers are too large");
    }
  }

  readAny(signal?: AbortSignal): Promise<Buffer> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("The operation was aborted"));
    if (this.buffer.byteLength > 0) {
      const value = this.buffer;
      this.buffer = Buffer.alloc(0);
      this.socket.resume();
      return Promise.resolve(value);
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve(Buffer.alloc(0));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.anyWaiters.indexOf(waiter);
        if (index >= 0) this.anyWaiters.splice(index, 1);
        waiter.reject(signal?.reason ?? new Error("The operation was aborted"));
      };
      const waiter = {
        resolve: (value: Buffer) => { signal?.removeEventListener("abort", onAbort); resolve(value); },
        reject: (error: unknown) => { signal?.removeEventListener("abort", onAbort); reject(error); },
      };
      this.anyWaiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else this.socket.resume();
    });
  }

  dispose(): void {
    this.socket.pause();
    this.socket.removeListener("data", this.onData);
    this.socket.removeListener("error", this.onError);
    this.socket.removeListener("end", this.onEnd);
    this.socket.removeListener("close", this.onEnd);
    if (this.buffer.byteLength > 0) this.socket.unshift(this.buffer);
    this.buffer = Buffer.alloc(0);
    this.rejectExact(new Socks5FetchError("SOCKS5 reader disposed"));
    this.rejectAny(new Socks5FetchError("SOCKS5 reader disposed"));
  }
}

async function socks5Connect(proxy: string, target: URL, signal?: AbortSignal): Promise<Socket> {
  const parsedProxy = validateProxy(proxy);
  const credentials = proxyCredentials(parsedProxy);
  const proxyHost = parsedProxy.hostname.replace(/^\[|\]$/g, "");
  const socket = await connectSocket(proxyHost, Number(parsedProxy.port) || DEFAULT_SOCKS5_PORT, signal);
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
    if (reply[2] !== 0x00 || ![0x01, SOCKS5_DOMAIN, 0x04].includes(reply[3]!)) {
      throw new Socks5FetchError("SOCKS5 proxy returned an invalid address type or reserved byte");
    }
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
  // This transport assembles the body itself, so a content-coding it did not ask for becomes
  // its own problem to undo. Ask for none by default and leave an explicit caller choice
  // alone: `fetchWithHeaderTimeout` selects identity for some streaming calls and preserves a
  // caller's selection elsewhere, and silently overriding that would make the two disagree.
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
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

function parseChunkSize(line: string): number {
  const token = line.split(";", 1)[0]!.trim();
  if (!/^[0-9a-fA-F]+$/.test(token)) {
    throw new Socks5FetchError("SOCKS5 upstream returned an invalid chunk size");
  }
  const size = Number.parseInt(token, 16);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Socks5FetchError("SOCKS5 upstream returned an invalid chunk size");
  }
  return size;
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
  if (bodylessResponse(method, status)) {
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
  const onAbort = () => socket.destroy();
  signal.addEventListener("abort", onAbort, { once: true });
  const readChunk = async (): Promise<Buffer | null> => {
    if (chunked) {
      if (chunkRemaining === 0) {
        const line = (await reader.readUntil(CRLF, MAX_RESPONSE_HEADER_BYTES, signal)).subarray(0, -2).toString("ascii");
        const size = parseChunkSize(line);
        if (size === 0) {
          while (true) {
            const trailer = await reader.readUntil(CRLF, MAX_RESPONSE_HEADER_BYTES, signal);
            if (trailer.equals(CRLF)) break;
          }
          return null;
        }
        chunkRemaining = size;
      }
      const value = await reader.read(Math.min(chunkRemaining, MAX_BODY_SLICE_BYTES), signal);
      chunkRemaining -= value.byteLength;
      if (chunkRemaining === 0) {
        const ending = await reader.read(2, signal);
        if (!ending.equals(CRLF)) throw new Socks5FetchError("SOCKS5 upstream returned an invalid chunk terminator");
      }
      return value;
    }
    if (remaining !== undefined) {
      if (remaining === 0) return null;
      const value = await reader.read(Math.min(remaining, MAX_BODY_SLICE_BYTES), signal);
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

/** Statuses and methods that carry no response body, whatever the headers say about one. */
function bodylessResponse(method: string, status: number): boolean {
  // 205 belongs here for the same reason 204 does, and leaving it out was not a judgement call:
  // a peer that resets the caller's view sends no body, so the Response constructor rejects one.
  return method === "HEAD" || isNullBodyStatus(status) || (status >= 100 && status < 200);
}

/**
 * Undo the content-coding this transport has to undo itself.
 *
 * `fetch` decodes content-codings below the Response constructor. This one assembles the body
 * from a raw socket, so `new Response(body, { headers })` hands the compressed bytes straight
 * to whatever reads them: `response.json()` throws SyntaxError on the gzip magic number and an
 * SSE reader sees noise instead of frames. The request asks for `identity`, so a coded
 * response means an upstream ignored that; gzip and deflate are undone here, and any other
 * coding fails closed rather than surfacing bytes no caller can parse.
 *
 * Buffered decoded bodies have an absolute cap. Event streams instead have an expansion bound,
 * so a long stream can continue without allowing a tiny coded response to inflate unchecked.
 * Identity bodies retain their existing streaming behavior; providers are asked to use that path.
 */
function contentCodingFormat(headers: Headers): "gzip" | "deflate" | undefined {
  const coding = classifyContentCoding(headers);
  if (coding.kind === "identity") return undefined;
  if (coding.kind === "decodable") return coding.format;
  throw new Socks5FetchError("SOCKS5 upstream returned an unsupported content-encoding: " + coding.coding);
}

/** Bound buffered bodies absolutely and event streams relative to consumed coded bytes. */
function decodedBody(
  body: ReadableStream<Uint8Array>,
  format: "gzip" | "deflate",
  eventStream: boolean,
): ReadableStream<Uint8Array> {
  const decompressor = new DecompressionStream(format) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  let codedBytes = 0;
  let decodedBytes = 0;
  const countedBody = eventStream ? body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      codedBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  })) : body;
  return countedBody.pipeThrough(decompressor).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      decodedBytes += chunk.byteLength;
      const limit = eventStream
        ? Math.max(MAX_DECODED_BODY_BYTES, codedBytes * MAX_STREAM_DECODE_EXPANSION_RATIO)
        : MAX_DECODED_BODY_BYTES;
      if (decodedBytes > limit) {
        throw new Socks5FetchError(eventStream
          ? "SOCKS5 decoded event stream exceeds expansion limit"
          : `SOCKS5 decoded response exceeds ${MAX_DECODED_BODY_BYTES} byte cap`);
      }
      controller.enqueue(chunk);
    },
  }));
}

/** Read response heads until the final one, consuming the interim informational answers. */
async function finalResponseHead(
  reader: SocketReader,
  signal: AbortSignal,
): Promise<{ status: number; statusText: string; headers: Headers }> {
  let head = parseResponseHead(await reader.readUntil(HEADER_END, MAX_RESPONSE_HEADER_BYTES, signal));
  while (head.status >= 100 && head.status < 200 && head.status !== 101) {
    head = parseResponseHead(await reader.readUntil(HEADER_END, MAX_RESPONSE_HEADER_BYTES, signal));
  }
  return head;
}

/**
 * A promise that rejects with the caller's abort reason, and a way to stop listening.
 *
 * Destroying the socket is not enough to end a pending `bodyReader.read()`: that promise belongs
 * to the caller's body stream, which knows nothing about this socket. Racing it against this one
 * is what turns an abort into a settled fetch instead of a permanently pending one.
 */
function abortRejection(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let onAbort = (): void => { /* replaced below */ };
  const promise = new Promise<never>((_resolve, reject) => {
    // Reject with the caller's reason exactly, including `null` and `false`. A real
    // `AbortSignal` always has one — `abort()` with no argument supplies an AbortError — so
    // the fallback covers only a hand-built signal that exposes none.
    onAbort = () => reject(signal.reason === undefined ? new Error("The operation was aborted") : signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  // The race below may settle on another branch first; this rejection must not be reported as
  // unhandled when nobody is left waiting for it.
  promise.catch(() => { /* surfaced by whoever loses the race */ });
  return { promise, dispose: () => signal.removeEventListener("abort", onAbort) };
}

/**
 * The two races below have different possible outcomes, so they have different result types.
 * One union covering both would let the compiler accept reading `value` off a drain result,
 * which is the kind of mistake a type is supposed to catch rather than describe.
 */
type Answered = { kind: "answered" };
type BodyStep = { kind: "chunk"; value: Uint8Array } | { kind: "end" } | Answered;
type DrainStep = { kind: "drained" } | Answered;

/**
 * Send the request body, settling on caller abort or on an answer that arrives first.
 *
 * A peer is entitled to answer a request it has not finished receiving — a 413 or a 401 lands
 * while a large body is still going out — and a body stream is entitled to stall. Waiting for
 * the upload to finish before looking at the socket made those two facts combine into a fetch
 * that never settles, with the answer already sitting in the receive buffer.
 *
 * `answered` covers the head settling either way: a final response means the peer has stopped
 * reading, and a terminal socket failure means nothing more can be written. Which of the two it
 * was belongs to whoever awaits the head, so this only needs to know that it happened.
 */
async function uploadRequestBody(
  socket: Socket,
  request: Request,
  chunked: boolean,
  head: Promise<unknown>,
): Promise<void> {
  const body = request.body;
  if (!body) return;
  const signal = request.signal;
  const bodyReader = body.getReader();
  const abort = abortRejection(signal);
  const answered: Promise<Answered> = head.then(
    (): Answered => ({ kind: "answered" }),
    (): Answered => ({ kind: "answered" }),
  );
  let completed = false;
  try {
    for (;;) {
      const read: Promise<BodyStep> = bodyReader.read().then(
        (result): BodyStep => (result.done ? { kind: "end" } : { kind: "chunk", value: result.value }),
      );
      // Releasing the lock below rejects a read still waiting on a source that stopped
      // producing. That rejection is this function's own doing, not a failure to report.
      read.catch(() => { /* settled by releasing the reader */ });
      const step = await Promise.race([read, answered, abort.promise]);
      if (step.kind === "answered") break;
      if (step.kind === "end") {
        completed = true;
        break;
      }
      const payload = chunked
        ? Buffer.concat([Buffer.from(`${step.value.byteLength.toString(16)}\r\n`), Buffer.from(step.value), CRLF])
        : step.value;
      if (socket.write(payload)) continue;
      const drain: Promise<DrainStep> = waitForDrain(socket, signal).then((): DrainStep => ({ kind: "drained" }));
      if ((await Promise.race([drain, answered, abort.promise])).kind === "answered") break;
    }
    // A terminating chunk written after the peer has already answered goes into a conversation
    // that is over, and a peer that has moved on may read it as the head of the next request.
    if (completed && chunked && !socket.write("0\r\n\r\n")) {
      const drain: Promise<DrainStep> = waitForDrain(socket, signal).then((): DrainStep => ({ kind: "drained" }));
      await Promise.race([drain, answered, abort.promise]);
    }
  } finally {
    abort.dispose();
    if (!completed) {
      // Cancelling runs the caller's own cancel algorithm, which is free to never settle, so it
      // is started rather than awaited. Releasing the lock is what actually frees a read still
      // waiting on a body that stopped producing.
      void bodyReader.cancel().catch(() => { /* the caller's stream owns this outcome */ });
    }
    try { bodyReader.releaseLock(); } catch { /* already released */ }
  }
}

export async function socks5Fetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  proxy: string,
): Promise<Response> {
  const protocol = (init as (RequestInit & { protocol?: string }) | undefined)?.protocol;
  if (protocol === "http2" || protocol === "h2") {
    throw new Socks5FetchError("SOCKS5 transport cannot honor an explicit HTTP/2 pin");
  }
  const request = new Request(input, init);
  const target = new URL(request.url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Socks5FetchError(`SOCKS5 fetch only supports HTTP(S) URLs, got ${target.protocol}`);
  }
  const tunnel = await socks5Connect(proxy, target, request.signal);
  if (request.signal.aborted) {
    tunnel.destroy();
    throw request.signal.reason ?? new Error("The operation was aborted");
  }
  let socket: Socket = tunnel;
  let reader: SocketReader | undefined;
  // Pending reads carry the abort reason; destruction must not enqueue an
  // unhandled socket error after their listeners have been removed.
  const onAbort = () => socket.destroy();
  request.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (target.protocol === "https:") socket = await secureSocket(tunnel, target, request.signal);
    socket.setTimeout(SOCKS5_RESPONSE_TIMEOUT_MS, () => {
      socket.destroy(new Socks5FetchError("SOCKS5 upstream request timed out"));
    });
    // Observe socket errors and early responses while uploading, not only after it.
    reader = new SocketReader(socket);
    const headers = requestHeaders(request, target);
    const head = `${request.method} ${target.pathname}${target.search} HTTP/1.1\r\n${headers.text}\r\n`;
    socket.write(head);
    // Start reading the answer before the upload finishes, and keep one consumer of the socket
    // reader for the whole exchange. The upload races this promise so an early final response or
    // a terminal socket failure ends it, instead of leaving it waiting on a body chunk that is
    // never coming while the answer sits in the receive buffer.
    const pendingHead = finalResponseHead(reader, request.signal);
    // The upload observes this promise through a handler of its own; this one keeps a rejection
    // from being reported as unhandled in the window before the await below.
    pendingHead.catch(() => { /* rethrown by the await below */ });
    await uploadRequestBody(socket, request, headers.chunked, pendingHead);
    const responseHead = await pendingHead;
    // A bodyless response has no coded bytes to undo, so its `content-encoding` describes the
    // representation it would have sent and must neither be decoded nor refused — a HEAD whose
    // peer advertises brotli is a correct answer, not an unreadable body. For everything else,
    // reject a coding this transport cannot undo before the body stream takes the socket, so the
    // failure path is the ordinary one below rather than an orphaned reader.
    const codingFormat = bodylessResponse(request.method, responseHead.status)
      ? undefined
      : contentCodingFormat(responseHead.headers);
    const body = responseBody(reader, socket, request.signal, responseHead.headers, responseHead.status, request.method);
    const responseHeaders = new Headers(responseHead.headers);
    if (codingFormat !== undefined) {
      responseHeaders.delete("content-encoding");
      // The declared length describes the coded bytes, not what the caller now reads.
      responseHeaders.delete("content-length");
    }
    const responseBodyStream = body !== null && codingFormat !== undefined
      ? decodedBody(
        body,
        codingFormat,
        responseHead.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream",
      )
      : body;
    request.signal.removeEventListener("abort", onAbort);
    return new Response(responseBodyStream, {
      status: responseHead.status,
      statusText: responseHead.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    request.signal.removeEventListener("abort", onAbort);
    reader?.dispose();
    socket.destroy();
    // An aborted caller gets its own reason back. Several waiters inside this transport can win
    // the race that settles an abort, and they do not agree on what to do with a reason they
    // consider absent: the socket reader substitutes an Error for a null reason, others coerce
    // anything that is not an Error. Without this, the same `abort(null)` surfaces as an Error
    // or as null depending on scheduling. `undefined` is left alone so a hand-built signal
    // still reaches the thrown cause below.
    if (request.signal.aborted && request.signal.reason !== undefined) throw request.signal.reason;
    throw error;
  }
}
