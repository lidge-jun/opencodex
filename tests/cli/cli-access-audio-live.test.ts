import type { AudioClientSocket } from "../../src/cli/access-audio-live";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { handleAccessAudioCommand, type AccessAudioDeps } from "../../src/cli/access-audio";
import { resolveAudioClient } from "../../src/server/audio-client";
import type { OcxConfig } from "../../src/types";

const KEY = "ocx_data_audio_live_synthetic";
const argv = ["live-check", "--model", "synthetic-live", "--api-key-stdin", "--json"];
const originalToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const servers: ReturnType<typeof Bun.serve>[] = [];
let out: ReturnType<typeof spyOn<typeof console, "log">>;
let err: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  out = spyOn(console, "log").mockImplementation(() => {});
  err = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  out.mockRestore(); err.mockRestore();
  if (originalToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN; else process.env.OPENCODEX_API_AUTH_TOKEN = originalToken;
});
function deps(port: number, extra: AccessAudioDeps = {}, key = KEY): AccessAudioDeps {
  return {
    readClientConnectionState: () => ({ kind: "disconnected" }),
    findLiveProxy: async () => ({ hostname: "127.0.0.1", port, pid: 1, source: "runtime" }),
    stdinImpl: Readable.from([Buffer.from(key)]),
    audioReadyTimeoutMs: 1000, audioCloseTimeoutMs: 500,
    ...extra,
  };
}
function output() { return out.mock.calls.map(row => row.join(" ")).join("\n"); }
function errors() { return err.mock.calls.map(row => row.join(" ")).join("\n"); }
function config(keys = true): OcxConfig {
  return { providers: {}, defaultProvider: "none", apiKeys: keys ? [{ id: "one", name: "one", key: KEY, createdAt: "2026-10-01T00:00:00Z" }] : [] } as OcxConfig;
}
function fixture(frames: (string | Uint8Array)[], options: { keys?: boolean; closeCode?: number; onUpdate?: () => void } = {}) {
  const messages: unknown[] = [];
  const requests: Request[] = [];
  let upgrades = 0;
  let closed!: () => void;
  const closeObserved = new Promise<void>(resolve => { closed = resolve; });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      requests.push(request);
      const client = resolveAudioClient(request, config(options.keys !== false), true);
      if (client instanceof Response) return client;
      if (!client) throw new Error("missing fixture admission");
      upgrades++;
      if (server.upgrade(request, { headers: { "sec-websocket-protocol": client.protocol! } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      close() { closed(); },
      message(socket, data) {
        const message = JSON.parse(String(data)); messages.push(message);
        if (message.type === "session.update") {
          options.onUpdate?.();
          for (const frame of frames) socket.send(frame);
          if (options.closeCode !== undefined) socket.close(options.closeCode);
        }
      },
    },
  });
  servers.push(server);
  return { server, messages, requests, closeObserved, get upgrades() { return upgrades; } };
}

// Only the impossible-to-observe native stuck-close/deadline paths use this
// minimal transport double. Native endpoints below own carrier/redirect proof.
class ControlledSocket {
  readyState: number = WebSocket.CONNECTING;
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onerror: WebSocket["onerror"] = null;
  onclose: WebSocket["onclose"] = null;
  sent: string[] = [];
  terminated = false;
  closeCode: number | undefined;
  constructor(readonly update: (socket: ControlledSocket) => void, readonly acknowledgeClose = false) {
    queueMicrotask(() => { this.readyState = WebSocket.OPEN; this.onopen?.call(this.native(), new Event("open")); });
  }
  native(): AudioClientSocket { return this as unknown as AudioClientSocket; }
  message(value: unknown) { this.onmessage?.call(this.native(), new MessageEvent("message", { data: JSON.stringify(value) })); }
  send(value: string) { this.sent.push(value); if (JSON.parse(value).type === "session.update") this.update(this); }
  close(code: number) {
    this.closeCode = code; this.readyState = WebSocket.CLOSING;
    if (this.acknowledgeClose) queueMicrotask(() => {
      this.readyState = WebSocket.CLOSED;
      this.onclose?.call(this.native(), new CloseEvent("close", { code: 1000 }));
    });
  }
  terminate() { this.terminated = true; this.readyState = WebSocket.CLOSED; }
}

describe("live audio readiness and bounded closure", () => {
  test.each(["session.started", "session.updated"])("native %s plus normal closure is success", async type => {
    const f = fixture([JSON.stringify({ type, session: { id: "synthetic-session", secret: KEY } })]);
    expect(await handleAccessAudioCommand(argv, deps(f.server.port!))).toBe(0);
    expect(JSON.parse(output())).toEqual({ schemaVersion: 1, ready: true, close: "confirmed", check: "session-readiness", event: type });
    expect(errors()).toBe("");
    expect(f.requests).toHaveLength(1);
    const request = f.requests[0]!;
    expect(new URL(request.url).pathname).toBe("/v1/live"); expect(new URL(request.url).searchParams.get("model")).toBe("synthetic-live");
    expect(request.headers.get("sec-websocket-protocol")).toBe(`opencodex-audio, opencodex-key.${Buffer.from(KEY).toString("base64url")}`);
    for (const header of ["authorization", "x-opencodex-api-key", "x-api-key", "cookie"]) expect(request.headers.has(header)).toBe(false);
    await f.closeObserved;
    expect(f.messages).toEqual([
      { type: "session.update", session: { instructions: "", audio: { output: { voice: "cove" } }, delegation: { type: "client" } } },
      { type: "session.close" },
    ]);
    expect(output()).not.toContain(KEY); expect(output()).not.toContain("synthetic-session");
  });
  test.each(["wrong", "zero"])("real native handshake admission refuses %s key before upgrade", async mode => {
    const f = fixture([], { keys: mode !== "zero" });
    expect(await handleAccessAudioCommand(argv, deps(f.server.port!, {}, mode === "wrong" ? "synthetic-wrong" : KEY))).toBe(1);
    expect(f.upgrades).toBe(0); expect(f.messages).toEqual([]); expect(f.requests).toHaveLength(1);
    expect(JSON.parse(output())).toMatchObject({ ready: false, close: "unverified" });
  });
  test.each([
    { type: "session.created", session: { id: "not-ready" } },
    { type: "session.started", session: { session_id: "not-ready" } },
    { type: "session.started", session: { id: " " } },
  ])("native open and non-readiness events cannot claim readiness", async frame => {
    const f = fixture([JSON.stringify(frame)]);
    expect(await handleAccessAudioCommand(argv, deps(f.server.port!, { audioReadyTimeoutMs: 20 }))).toBe(1);
    expect(JSON.parse(output())).toMatchObject({ ready: false });
    await f.closeObserved;
    expect(f.messages.map((m: unknown) => (m as { type: string }).type)).toEqual(["session.update", "session.close"]);
  });
  test.each([
    "malformed", "null", "[]", JSON.stringify({ type: [] }),
    JSON.stringify({ type: "error", message: KEY }), JSON.stringify({ type: "protocol.error", message: KEY }),
    JSON.stringify({ type: "session.started", session: { id: "x", status: "error" } }),
    JSON.stringify({ type: "session.updated", session: { id: "x", status: "failed" } }),
    JSON.stringify({ type: "session.started", session: { id: "x", status: "closed" } }),
  ])("bad native frame fails and later normal closure does not repair it", async frame => {
    const f = fixture([frame]);
    expect(await handleAccessAudioCommand(argv, deps(f.server.port!))).toBe(1);
    expect(JSON.parse(output())).toMatchObject({ ready: false });
    expect(output() + errors()).not.toContain(KEY);
  });
  test("binary frames fail safely", async () => {
    const f = fixture([new Uint8Array([1, 2, 3])]);
    expect(await handleAccessAudioCommand(argv, deps(f.server.port!))).toBe(1);
    expect(JSON.parse(output()).ready).toBe(false);
  });
  test("UTF-8 frame byte limit is tighter than code units", async () => {
    const f = fixture([JSON.stringify({ type: "notice", text: "한".repeat(22_000) })]);
    expect(await handleAccessAudioCommand(argv, deps(f.server.port!))).toBe(1);
    expect(JSON.parse(output()).ready).toBe(false);
  });
  test("aggregate frames cannot exceed 2 MiB without readiness", async () => {
    const frame = JSON.stringify({ type: "notice", text: "a".repeat(65_000) });
    const f = fixture(Array(33).fill(frame));
    expect(await handleAccessAudioCommand(argv, deps(f.server.port!))).toBe(1);
    expect(JSON.parse(output()).ready).toBe(false);
  });
  test("observed abnormal close after readiness stays partial", async () => {
    const code = await handleAccessAudioCommand(argv, deps(19001, { audioSocket: () => {
      const socket = new ControlledSocket(s => s.message({ type: "session.started", session: { id: "x" } }));
      socket.close = () => queueMicrotask(() => {
        socket.readyState = WebSocket.CLOSED;
        socket.onclose?.call(socket.native(), new CloseEvent("close", { code: 1011 }));
      });
      return socket.native();
    } }));
    expect(code).toBe(1);
    expect(JSON.parse(output())).toMatchObject({ ready: true, close: "unverified" });
  });
  test("stuck close is terminated and ready remains a nonzero partial result", async () => {
    let socket!: ControlledSocket;
    const code = await handleAccessAudioCommand(argv, deps(19001, {
      audioCloseTimeoutMs: 10,
      audioSocket: () => { socket = new ControlledSocket(s => s.message({ type: "session.started", session: { id: "x" } })); return socket.native(); },
    }));
    expect(code).toBe(1); expect(JSON.parse(output())).toMatchObject({ ready: true, close: "unverified" });
    expect(socket.terminated).toBe(true); expect(socket.closeCode).toBe(1000);
    expect(socket.sent.map(s => JSON.parse(s).type)).toEqual(["session.update", "session.close"]);
    expect([socket.onopen, socket.onmessage, socket.onerror, socket.onclose]).toEqual([null, null, null, null]);
  });
  test("normal close after protocol failure cannot repair failure", async () => {
    let socket!: ControlledSocket;
    const code = await handleAccessAudioCommand(argv, deps(19001, { audioSocket: () => {
      socket = new ControlledSocket(s => s.message({ type: "error", message: KEY }), true); return socket.native();
    } }));
    expect(code).toBe(1); expect(JSON.parse(output())).toMatchObject({ ready: false, close: "confirmed" });
    expect(output() + errors()).not.toContain(KEY);
  });
  test.each(["SIGINT", "SIGTERM", "external"])("%s terminates owned socket and returns signal exit", async kind => {
    const controller = new AbortController(); let socket!: ControlledSocket;
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const code = await handleAccessAudioCommand(argv, deps(19001, { signal: controller.signal, audioSocket: () => {
      socket = new ControlledSocket(() => {
        if (kind === "external") controller.abort(); else process.emit(kind as "SIGINT" | "SIGTERM");
      }); return socket.native();
    } }));
    expect(code).toBe(kind === "SIGTERM" ? 143 : 130); expect(socket.terminated).toBe(true);
    expect(output()).toBe(""); expect(errors()).toBe("");
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });
  test("target identity changed after socket closes remains failure", async () => {
    let pid = 1;
    expect(await handleAccessAudioCommand(argv, deps(19001, {
      findLiveProxy: async () => ({ hostname: "127.0.0.1", port: 19001, pid, source: "runtime" }),
      audioSocket: () => new ControlledSocket(s => { pid = 2; s.message({ type: "session.started", session: { id: "x" } }); }, true).native(),
    }))).toBe(1);
    expect(JSON.parse(output())).toMatchObject({ ready: true, close: "confirmed" });
    expect(errors()).toContain("failed");
  });
});

describe("native Bun WebSocket redirect refusal", () => {
  for (const status of [301, 302, 303, 307, 308]) for (const scheme of ["http:", "ws:"]) {
    test(`${status} to ${scheme} never forwards the key subprotocol`, async () => {
      let destinationRequests = 0, sourceRequests = 0;
      const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { destinationRequests++; return new Response(null, { status: 400 }); } }); servers.push(destination);
      const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { sourceRequests++; return Response.redirect(destination.url.href.replace("http:", scheme), status); } }); servers.push(source);
      expect(await handleAccessAudioCommand(argv, deps(source.port!))).toBe(1);
      expect(sourceRequests).toBe(1); expect(destinationRequests).toBe(0);
      expect(JSON.parse(output())).toEqual({ schemaVersion: 1, ready: false, close: "unverified", check: "session-readiness" });
      expect(output() + errors()).not.toContain(KEY);
      expect(output() + errors()).not.toContain(Buffer.from(KEY).toString("base64url"));
    });
  }
});
