import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { LINK_RELAY_AUTH_PATH, LINK_RELAY_AUTH_VERSION, LINK_RELAY_SESSION_HEADER, linkRelayProof } from "../../src/link/relay-auth";

/** One HTTP response head (and its body, when it has a length) read off a raw socket. */
export interface WireHead { status: number; headers: Map<string, string>; body: string }

export type WireMessage =
  | { type: "text"; data: string }
  | { type: "close"; code: number | null; reason: string }
  | { type: "eof" };

/**
 * A minimal RFC 6455 client on one TCP connection. The relay-auth challenge, the session request
 * and the upgrade all share that connection, which is what the Home's peer check requires and what
 * the Child relay does. Test-only: masked client frames, unfragmented messages, no extensions.
 */
export class LinkWireClient {
  private buffer = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private ended = false;
  private upgraded = false;

  private constructor(private readonly socket: Socket) {
    socket.on("data", chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.wake(); });
    socket.on("close", () => { this.ended = true; this.wake(); });
    socket.on("error", () => { this.ended = true; this.wake(); });
  }

  static open(port: number): Promise<LinkWireClient> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => resolve(new LinkWireClient(socket)));
      socket.once("error", reject);
    });
  }

  get isUpgraded(): boolean { return this.upgraded; }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  private async more(): Promise<boolean> {
    if (this.ended) return false;
    await new Promise<void>(resolve => this.waiters.push(resolve));
    return true;
  }

  private take(length: number): Buffer {
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return Buffer.from(out);
  }

  async readHead(): Promise<WireHead> {
    let end = this.buffer.indexOf("\r\n\r\n");
    while (end < 0) {
      if (!await this.more()) throw new Error("socket closed before a response head");
      end = this.buffer.indexOf("\r\n\r\n");
    }
    const lines = this.take(end + 4).toString("latin1").split("\r\n");
    const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(lines[0] ?? "")?.[1]);
    const headers = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    if (status === 101) { this.upgraded = true; return { status, headers, body: "" }; }
    let body = "";
    const length = headers.get("content-length");
    if (length !== undefined) {
      const size = Number(length);
      while (this.buffer.length < size) if (!await this.more()) throw new Error("socket closed inside a body");
      body = this.take(size).toString("utf8");
    } else if (headers.get("transfer-encoding")?.toLowerCase() === "chunked") {
      for (;;) {
        let line = this.buffer.indexOf("\r\n");
        while (line < 0) { if (!await this.more()) throw new Error("socket closed inside a chunk"); line = this.buffer.indexOf("\r\n"); }
        const size = Number.parseInt(this.take(line + 2).toString("latin1"), 16);
        while (this.buffer.length < size + 2) if (!await this.more()) throw new Error("socket closed inside a chunk");
        body += this.take(size).toString("utf8");
        this.take(2);
        if (size === 0) break;
      }
    }
    return { status, headers, body };
  }

  /** Runs the relay-auth v2 challenge on this connection and returns the session nonce and the 204. */
  async challenge(identity: { keyId: string; linkId: string; fingerprint: string }, extra: Record<string, string> = {}): Promise<{ nonce: string; head: WireHead }> {
    const nonce = randomBytes(32).toString("hex");
    const query = new URLSearchParams({
      version: LINK_RELAY_AUTH_VERSION,
      key: identity.keyId,
      link: identity.linkId,
      nonce,
      proof: linkRelayProof(identity.fingerprint, "caller", identity.keyId, identity.linkId, nonce)!,
    });
    this.write("GET " + LINK_RELAY_AUTH_PATH + "?" + query + " HTTP/1.1", { host: "127.0.0.1", ...extra });
    return { nonce, head: await this.readHead() };
  }

  /** Sends a Responses WebSocket upgrade with the session nonce and the given credential. */
  async upgrade(options: { nonce?: string; bearer?: string; path?: string; method?: string; headers?: Record<string, string | null> } = {}): Promise<WireHead> {
    const headers: Record<string, string | null> = {
      host: "127.0.0.1",
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-version": "13",
      "sec-websocket-key": randomBytes(16).toString("base64"),
      ...(options.nonce ? { [LINK_RELAY_SESSION_HEADER]: options.nonce } : {}),
      ...(options.bearer ? { authorization: "Bearer " + options.bearer } : {}),
      ...options.headers,
    };
    const present = Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null));
    this.write((options.method ?? "GET") + " " + (options.path ?? "/v1/responses") + " HTTP/1.1", present);
    return this.readHead();
  }

  private write(requestLine: string, headers: Record<string, string>): void {
    const head = [requestLine, ...Object.entries(headers).map(([name, value]) => name + ": " + value), "", ""].join("\r\n");
    this.socket.write(head);
  }

  /** Sends one HTTP request with a body on this connection without reading the answer. */
  sendRequest(requestLine: string, headers: Record<string, string>, body: string | Uint8Array): void {
    this.write(requestLine, { ...headers, "content-length": String(Buffer.byteLength(body)) });
    this.socket.write(body);
  }

  sendText(data: string): void { this.sendFrame(0x1, Buffer.from(data, "utf8")); }

  sendJson(value: unknown): void { this.sendText(JSON.stringify(value)); }

  sendFrame(opcode: number, payload: Buffer): void {
    const mask = randomBytes(4);
    const size = payload.length;
    const head = size < 126 ? Buffer.from([0x80 | opcode, 0x80 | size])
      : size < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, size >> 8, size & 0xff])
        : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(size)); return b; })()]);
    const masked = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) masked[i] = payload[i]! ^ mask[i % 4]!;
    this.socket.write(Buffer.concat([head, mask, masked]));
  }

  /** The next text or close message from the server; pings are answered and skipped. */
  async nextMessage(): Promise<WireMessage> {
    for (;;) {
      while (this.buffer.length < 2) if (!await this.more()) return { type: "eof" };
      const opcode = this.buffer[0]! & 0x0f;
      let size = this.buffer[1]! & 0x7f;
      let offset = 2;
      if (size === 126) { while (this.buffer.length < 4) if (!await this.more()) return { type: "eof" }; size = this.buffer.readUInt16BE(2); offset = 4; }
      else if (size === 127) { while (this.buffer.length < 10) if (!await this.more()) return { type: "eof" }; size = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      while (this.buffer.length < offset + size) if (!await this.more()) return { type: "eof" };
      this.take(offset);
      const payload = this.take(size);
      if (opcode === 0x9) { this.sendFrame(0xa, payload); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : null;
        return { type: "close", code, reason: payload.subarray(2).toString("utf8") };
      }
      return { type: "text", data: payload.toString("utf8") };
    }
  }

  /** Reads messages until one satisfies the predicate, or the connection closes. */
  async until(predicate: (message: WireMessage) => boolean): Promise<WireMessage[]> {
    const seen: WireMessage[] = [];
    for (;;) {
      const message = await this.nextMessage();
      seen.push(message);
      if (predicate(message) || message.type !== "text") return seen;
    }
  }

  destroy(): void { this.socket.destroy(); }

  /** Stops reading: the server's sends back up into its own buffers, as with a stalled client. */
  pause(): void { this.socket.pause(); }
}

/** A JSON text frame's "type", or null for anything else. */
export function frameType(message: WireMessage): string | null {
  if (message.type !== "text") return null;
  try { return String((JSON.parse(message.data) as { type?: unknown }).type); } catch { return null; }
}

