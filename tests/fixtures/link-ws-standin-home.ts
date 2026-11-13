import { createServer, type Server, type Socket } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import {
  LINK_RELAY_AUTH_PATH, LINK_RELAY_SESSION_HEADER, LINK_RELAY_WS_STATE_HEADER, LINK_RELAY_WS_STATE_PROOF_HEADER, linkRelayProof,
  linkRelayProofMatches, linkWebsocketStateProof,
} from "../../src/link/relay-auth";

/**
 * A stand-in Home for the Child side of the link WebSocket (lane T6), on a raw TCP server so a test
 * controls every byte: the relay-auth answer and its WebSocket state pair, the 101, and the frames.
 * A session nonce is valid only on the connection whose challenge produced it, as on a real Home.
 * Server frames are sent unmasked; client frames must be masked. Test-only.
 */

export type StandinState = "on" | "off" | "none" | "bad-proof";

export interface StandinRequest { method: string; path: string; headers: Map<string, string>; connection: number }

export type StandinUpgrade =
  | { kind: "accept"; extraHeaders?: string[]; omitAccept?: boolean; wrongAccept?: boolean; head?: Buffer }
  | { kind: "refuse"; status: number; body?: string }
  | { kind: "raw"; bytes: string }
  | { kind: "hang" };

export type StandinFrame =
  | { type: "text"; data: string }
  | { type: "binary"; bytes: number }
  | { type: "close"; code: number | null; reason: string }
  | { type: "ping"; payload: Buffer }
  | { type: "pong"; payload: Buffer }
  | { type: "unmasked" };

export class StandinSocket {
  readonly frames: StandinFrame[] = [];
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private waiters: Array<() => void> = [];
  ended = false;

  constructor(readonly socket: Socket, readonly request: StandinRequest) {}

  feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) break;
      const b0 = this.buffer[0]!, b1 = this.buffer[1]!;
      let length = b1 & 0x7f, offset = 2;
      if (length === 126) { if (this.buffer.length < 4) break; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (this.buffer.length < 10) break; length = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      const masked = (b1 & 0x80) !== 0;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) break;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (masked) { const mask = this.buffer.subarray(offset - 4, offset); for (let i = 0; i < length; i++) payload[i]! ^= mask[i & 3]!; }
      else this.frames.push({ type: "unmasked" });
      this.buffer = this.buffer.subarray(offset + length);
      const opcode = b0 & 0x0f, fin = (b0 & 0x80) !== 0;
      if (opcode === 8) this.frames.push({ type: "close", code: length >= 2 ? payload.readUInt16BE(0) : null, reason: payload.subarray(2).toString("utf8") });
      else if (opcode === 9) this.frames.push({ type: "ping", payload });
      else if (opcode === 10) this.frames.push({ type: "pong", payload });
      else {
        if (opcode !== 0) this.fragmentOpcode = opcode;
        this.fragments.push(payload);
        if (fin) {
          const message = Buffer.concat(this.fragments);
          this.fragments = [];
          this.frames.push(this.fragmentOpcode === 1 ? { type: "text", data: message.toString("utf8") } : { type: "binary", bytes: message.length });
        }
      }
    }
    this.wake();
  }

  wake(): void { const waiters = this.waiters; this.waiters = []; for (const wake of waiters) wake(); }

  /** Resolves once a frame matching `match` has arrived (or the socket ended). */
  async until(match: (frame: StandinFrame) => boolean): Promise<StandinFrame | null> {
    for (;;) {
      const found = this.frames.find(match);
      if (found) return found;
      if (this.ended) return null;
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
  }

  async closed(): Promise<void> {
    while (!this.ended) await new Promise<void>(resolve => this.waiters.push(resolve));
  }

  sendFrame(opcode: number, payload: Buffer, fin = true): void {
    const length = payload.length;
    const head = length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, length])
      : length <= 0xffff ? Buffer.from([(fin ? 0x80 : 0) | opcode, 126, length >> 8, length & 0xff])
      : (() => { const b = Buffer.alloc(10); b[0] = (fin ? 0x80 : 0) | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(length), 2); return b; })();
    this.socket.write(Buffer.concat([head, payload]));
  }

  sendText(text: string): void { this.sendFrame(1, Buffer.from(text, "utf8")); }

  sendClose(code?: number, reason = ""): void {
    if (code === undefined) { this.sendFrame(8, Buffer.alloc(0)); return; }
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.sendFrame(8, payload);
  }

  raw(bytes: Buffer): void { this.socket.write(bytes); }
  destroy(): void { this.socket.destroy(); }
}

export interface StandinHome {
  port: number;
  /** TCP connections accepted, in order. */
  connections(): number;
  requests: StandinRequest[];
  sockets: StandinSocket[];
  /** Resolves with the next upgraded socket. */
  nextSocket(): Promise<StandinSocket>;
  /** Resolves once the given connection (1-based, in accept order) has closed. */
  whenClosed(connection: number): Promise<void>;
  stop(): Promise<void>;
}

export interface StandinHomeOptions {
  identity: { keyId: string; linkId: string; secret: string };
  state?: (request: StandinRequest) => StandinState;
  upgrade?: (request: StandinRequest) => StandinUpgrade;
  /** Hold the relay-auth answer until the returned promise settles (ordering tests). */
  holdChallenge?: (request: StandinRequest) => Promise<void> | undefined;
  /** Answer the relay-auth challenge with this status instead of 204. */
  challengeStatus?: () => number;
  /** Plain (non-upgrade) data requests: status and body. */
  data?: (request: StandinRequest) => { status: number; body?: string };
  /**
   * Plain data requests the test answers itself on the raw socket (a streamed or held response). Returning true takes the
   * connection over: `rest` is what had arrived after the request head, and everything after it goes only to the socket's
   * own listeners, never parsed as requests.
   */
  stream?: (request: StandinRequest, socket: Socket, rest: Buffer) => boolean;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function startStandinHome(options: StandinHomeOptions): Promise<StandinHome> {
  const fingerprint = serviceApiTokenFingerprint(options.identity.secret);
  const { keyId, linkId } = options.identity;
  const requests: StandinRequest[] = [];
  const sockets: StandinSocket[] = [];
  const socketWaiters: Array<(socket: StandinSocket) => void> = [];
  const open = new Set<Socket>();
  const closed = new Set<number>();
  const closeWaiters = new Map<number, Array<() => void>>();
  let connectionCount = 0;
  const server: Server = createServer(socket => {
    connectionCount += 1;
    const connection = connectionCount;
    open.add(socket);
    socket.on("close", () => {
      open.delete(socket);
      closed.add(connection);
      for (const wake of closeWaiters.get(connection) ?? []) wake();
      closeWaiters.delete(connection);
    });
    socket.on("error", () => {});
    const nonces = new Set<string>();
    let buffer = Buffer.alloc(0);
    let upgraded: StandinSocket | null = null;
    let streamed = false;
    let busy = false;
    const answer = (status: number, headers: Record<string, string>, body = ""): void => {
      const lines = ["HTTP/1.1 " + status + " X", ...Object.entries(headers).map(([n, v]) => n + ": " + v), "content-length: " + Buffer.byteLength(body)];
      socket.write(lines.join("\r\n") + "\r\n\r\n" + body);
    };
    const handle = async (request: StandinRequest): Promise<void> => {
      const url = new URL(request.path, "http://standin");
      if (url.pathname === LINK_RELAY_AUTH_PATH) {
        const q = url.searchParams;
        const nonce = q.get("nonce") ?? "";
        const ok = q.get("key") === keyId && q.get("link") === linkId
          && linkRelayProofMatches(q.get("proof"), linkRelayProof(fingerprint, "caller", keyId, linkId, nonce));
        await options.holdChallenge?.(request);
        const status = options.challengeStatus?.() ?? 204;
        if (!ok || status !== 204) { answer(ok ? status : 404, {}); return; }
        nonces.add(nonce);
        const state = options.state?.(request) ?? "on";
        const headers: Record<string, string> = { "x-opencodex-link-proof": linkRelayProof(fingerprint, "listener", keyId, linkId, nonce)! };
        if (state === "on" || state === "off") {
          headers[LINK_RELAY_WS_STATE_HEADER] = state;
          headers[LINK_RELAY_WS_STATE_PROOF_HEADER] = linkWebsocketStateProof(fingerprint, keyId, linkId, nonce, state)!;
        } else if (state === "bad-proof") {
          headers[LINK_RELAY_WS_STATE_HEADER] = "on";
          headers[LINK_RELAY_WS_STATE_PROOF_HEADER] = linkWebsocketStateProof(fingerprint, keyId, linkId, nonce, "off")!;
        }
        answer(204, headers);
        return;
      }
      const nonce = request.headers.get(LINK_RELAY_SESSION_HEADER) ?? "";
      if (!nonces.delete(nonce) || request.headers.get("authorization") !== "Bearer " + options.identity.secret) {
        answer(404, { "content-type": "application/json" }, '{"error":"not_found"}');
        return;
      }
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const decision = options.upgrade?.(request) ?? { kind: "accept" };
        if (decision.kind === "hang") return;
        if (decision.kind === "refuse") { answer(decision.status, { "content-type": "application/json" }, decision.body ?? '{"error":"refused"}'); return; }
        if (decision.kind === "raw") { socket.write(decision.bytes); return; }
        const key = request.headers.get("sec-websocket-key") ?? "";
        const accept = decision.wrongAccept ? createHash("sha1").update("x" + GUID).digest("base64") : createHash("sha1").update(key + GUID).digest("base64");
        const lines = ["HTTP/1.1 101 Switching Protocols", "upgrade: websocket", "connection: Upgrade",
          ...(decision.omitAccept ? [] : ["sec-websocket-accept: " + accept]), ...(decision.extraHeaders ?? [])];
        upgraded = new StandinSocket(socket, request);
        sockets.push(upgraded);
        socket.write(Buffer.concat([Buffer.from(lines.join("\r\n") + "\r\n\r\n"), decision.head ?? Buffer.alloc(0)]));
        const waiter = socketWaiters.shift();
        waiter?.(upgraded);
        if (buffer.length) { const rest = buffer; buffer = Buffer.alloc(0); upgraded.feed(rest); }
        return;
      }
      if (options.stream?.(request, socket, buffer)) { streamed = true; buffer = Buffer.alloc(0); return; }
      const reply = options.data?.(request) ?? { status: 404, body: '{"error":"not_found"}' };
      answer(reply.status, { "content-type": "application/json" }, reply.body ?? "");
    };
    const pump = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        while (!upgraded && !streamed) {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) break;
          const lines = buffer.subarray(0, end).toString("latin1").split("\r\n");
          buffer = buffer.subarray(end + 4);
          const [method = "", path = ""] = (lines[0] ?? "").split(" ");
          const headers = new Map<string, string>();
          for (const line of lines.slice(1)) {
            const colon = line.indexOf(":");
            if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
          }
          const request = { method, path, headers, connection };
          requests.push(request);
          await handle(request);
        }
      } finally { busy = false; }
    };
    socket.on("data", chunk => {
      if (upgraded) { upgraded.feed(chunk); return; }
      if (streamed) return;
      buffer = Buffer.concat([buffer, chunk]);
      void pump();
    });
    socket.on("close", () => { if (upgraded) { upgraded.ended = true; upgraded.wake(); } });
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        connections: () => connectionCount,
        requests,
        sockets,
        nextSocket: () => new Promise(resolveSocket => socketWaiters.push(resolveSocket)),
        whenClosed: connection => closed.has(connection) ? Promise.resolve()
          : new Promise<void>(resolveClose => closeWaiters.set(connection, [...(closeWaiters.get(connection) ?? []), resolveClose])),
        stop: () => new Promise<void>(done => { for (const socket of open) socket.destroy(); server.close(() => done()); }),
      });
    });
  });
}

/** A fresh link identity for tests. */
export function standinIdentity(): { keyId: string; linkId: string; secret: string } {
  return { keyId: "standin-key", linkId: "lnk_" + randomBytes(8).toString("hex"), secret: "standin-secret-" + randomBytes(8).toString("hex") };
}
