import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import type { Server } from "bun";
import { startMachineListener } from "../../src/client/machine-listener";
import type { LinkWebsocketRelayDeps, LinkWebsocketTimers } from "../../src/client/link-websocket";
import type { LinkTunnelGate } from "../../src/client/link-relay";
import { encodeClientText, LinkWsFrameReader, type LinkWsFrameEvent } from "../../src/client/link-ws-framer";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import type { OcxClientConnectionConfig } from "../../src/types";

/** Helpers for the Child side of the link WebSocket (lane T6): a Child listener, and Codex-shaped clients. */

export const connectedTunnel: LinkTunnelGate = { connected: () => ({ kind: "match" }), pending: () => false, waitForConnected: async () => true };

export function childConnection(tunnelPort: number, identity: { keyId: string; linkId: string; secret: string }): OcxClientConnectionConfig {
  return {
    serverUrl: "http://127.0.0.1:" + tunnelPort,
    managementUrl: "http://127.0.0.1:" + tunnelPort,
    managementTransport: "direct",
    transport: "link",
    link: { tunnelPort, linkId: identity.linkId },
    selectedClients: ["codex"],
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    apiKeyId: identity.keyId,
    tokenFingerprint: serviceApiTokenFingerprint(identity.secret),
    protocolVersion: 1,
    connectedAt: "2026-11-13T00:00:00.000Z",
    catalogSyncedAt: "2026-11-13T00:00:01.000Z",
  };
}

export function startChild(
  tunnelPort: number, identity: { keyId: string; linkId: string; secret: string },
  options: { tunnel?: LinkTunnelGate; websocket?: Partial<LinkWebsocketRelayDeps> } = {},
): Server<unknown> {
  return startMachineListener(0, {
    state: childConnection(tunnelPort, identity),
    linkKeySource: () => identity.secret,
    linkTunnel: options.tunnel ?? connectedTunnel,
    linkWebsocket: options.websocket,
  });
}

/** Timers that fire only when the test says so. */
export function manualTimers(): { timers: LinkWebsocketTimers; fire(ms: number): number; pending(ms: number): number } {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 0;
  return {
    timers: {
      setTimeout(callback, ms) { next += 1; pending.set(next, { callback, ms }); return next; },
      clearTimeout(handle) { pending.delete(handle as number); },
    },
    fire(ms) {
      let fired = 0;
      for (const [handle, timer] of [...pending]) if (timer.ms === ms) { pending.delete(handle); timer.callback(); fired += 1; }
      return fired;
    },
    pending(ms) { return [...pending.values()].filter(timer => timer.ms === ms).length; },
  };
}

export interface RawAnswer { status: number; headers: Map<string, string>; body: string; raw: string; socket: Socket; rest: Buffer }

/** One upgrade request on a raw socket, as Codex would send it; resolves with the answer's head (and body). */
export function rawUpgrade(port: number, extra: Record<string, string> = {}, path = "/v1/responses"): { socket: Socket; answer: Promise<RawAnswer> } {
  const socket = connect({ host: "127.0.0.1", port });
  const headers = { host: "127.0.0.1:" + port, upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13",
    "sec-websocket-key": randomBytes(16).toString("base64"), authorization: "Bearer codex-local-credential", "thread-id": "thread-raw", ...extra };
  socket.write("GET " + path + " HTTP/1.1\r\n" + Object.entries(headers).map(([name, value]) => name + ": " + value).join("\r\n") + "\r\n\r\n");
  const answer = new Promise<RawAnswer>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buffer.subarray(0, end).toString("latin1");
      const lines = head.split("\r\n");
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(lines[0] ?? "")?.[1]);
      const map = new Map<string, string>();
      for (const line of lines.slice(1)) { const colon = line.indexOf(":"); if (colon > 0) map.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()); }
      const length = Number(map.get("content-length") ?? "0");
      if (status !== 101 && buffer.length < end + 4 + length) return;
      socket.off("data", onData);
      const body = status === 101 ? "" : buffer.subarray(end + 4, end + 4 + length).toString("utf8");
      resolve({ status, headers: map, body, raw: head, socket, rest: Buffer.from(buffer.subarray(end + 4 + (status === 101 ? 0 : length))) });
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
  return { socket, answer };
}

/** Reads server frames off an upgraded raw socket. */
export class RawCodex {
  private readonly reader = new LinkWsFrameReader({ maxMessageBytes: 64 * 1024 * 1024, maxFragments: 4096 });
  readonly events: LinkWsFrameEvent[] = [];
  private waiters: Array<() => void> = [];
  ended = false;
  constructor(readonly socket: Socket, rest: Buffer) {
    socket.on("data", chunk => this.push(chunk));
    socket.on("close", () => { this.ended = true; this.wake(); });
    if (rest.length) this.push(rest);
  }
  private push(chunk: Buffer): void { try { this.events.push(...this.reader.push(chunk)); } catch { this.socket.destroy(); } this.wake(); }
  private wake(): void { const waiters = this.waiters; this.waiters = []; for (const wake of waiters) wake(); }
  async until(match: (event: LinkWsFrameEvent) => boolean): Promise<LinkWsFrameEvent | null> {
    for (;;) {
      const found = this.events.find(match);
      if (found) return found;
      if (this.ended) return null;
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
  }
  async count(type: LinkWsFrameEvent["type"], n: number): Promise<void> {
    while (this.events.filter(event => event.type === type).length < n && !this.ended) await new Promise<void>(resolve => this.waiters.push(resolve));
  }
}

/** A Codex-shaped client on Bun's WebSocket (it sends no Origin). */
export class CodexSocket {
  readonly messages: string[] = [];
  closeEvent: { code: number; reason: string } | null = null;
  private waiters: Array<() => void> = [];
  private constructor(readonly ws: WebSocket) {
    ws.onmessage = event => { this.messages.push(String(event.data)); this.wake(); };
    ws.onclose = event => { this.closeEvent = { code: event.code, reason: event.reason }; this.wake(); };
  }
  static open(port: number): Promise<CodexSocket> {
    const ws = new WebSocket("ws://127.0.0.1:" + port + "/v1/responses", { headers: { "thread-id": "thread-codex" }, perMessageDeflate: false } as unknown as string[]);
    const client = new CodexSocket(ws);
    return new Promise((resolve, reject) => {
      ws.onopen = () => resolve(client);
      ws.onerror = () => reject(new Error("upgrade refused"));
    });
  }
  private wake(): void { const waiters = this.waiters; this.waiters = []; for (const wake of waiters) wake(); }
  async next(count = 1): Promise<string[]> {
    while (this.messages.length < count && !this.closeEvent) await new Promise<void>(resolve => this.waiters.push(resolve));
    return this.messages.slice(0, count);
  }
  async closed(): Promise<{ code: number; reason: string }> {
    while (!this.closeEvent) await new Promise<void>(resolve => this.waiters.push(resolve));
    return this.closeEvent;
  }
}

/**
 * One model request sent the way codex-rs sends it (design C1, C5): over the WebSocket first; a 426 at
 * connect switches the session to HTTP for good and resends the same request; a 503 or a close before
 * the terminal costs one retry from `maxRetries`; with the budget spent the session switches to HTTP and
 * resends. `events` records each attempt's outcome in order.
 */
export async function codexRequest(port: number, body: string, options: { maxRetries: number; events: string[]; session?: { http: boolean } }): Promise<string> {
  const session = options.session ?? { http: false };
  let retries = 0;
  while (!session.http) {
    const { socket, answer } = rawUpgrade(port);
    const result = await answer;
    if (result.status === 426) { socket.destroy(); options.events.push("426"); session.http = true; break; }
    if (result.status !== 101) {
      socket.destroy();
      options.events.push(String(result.status));
      if (++retries > options.maxRetries) { options.events.push("fallback"); session.http = true; break; }
      continue;
    }
    const codex = new RawCodex(socket, result.rest);
    socket.write(encodeClientText(body));
    const terminal = await codex.until(event => (event.type === "text" && event.data.includes("response.completed")) || event.type === "close");
    socket.destroy();
    if (terminal?.type === "text") { options.events.push("ws:completed"); return terminal.data; }
    options.events.push("ws:closed:" + (terminal?.type === "close" ? terminal.code : "eof"));
    if (++retries > options.maxRetries) { options.events.push("fallback"); session.http = true; break; }
  }
  const response = await fetch("http://127.0.0.1:" + port + "/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body });
  const text = await response.text();
  options.events.push("http:" + response.status);
  return text;
}
