import { afterEach, expect, test } from "bun:test";
import { watchdogMs } from "../helpers/ci-watchdog";
import { codexWsExchange } from "../../src/server/responses/codex-ws-exchange";
import { CODEX_WS_SESSION_CLOSE_GRACE_MS, CodexWsSession } from "../../src/server/responses/codex-ws-session";
import { CODEX_RESPONSES_HTTP_URL, prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";
import {
  CODEX_WS_METADATA_MAX_BYTES, CODEX_WS_METADATA_MAX_HEADERS, CODEX_WS_METADATA_MAX_VALUE_BYTES,
} from "../../src/server/responses/codex-ws-metadata";

const realWebSocket = globalThis.WebSocket;
const flag = "x-reasoning-included";
const upgrade = (rawHeaders: unknown) => ({ statusCode: 101, rawHeaders });
const usage = { input_tokens: 11, output_tokens: 5, total_tokens: 16 };

class Socket extends EventTarget {
  static handshake: unknown;
  static lateHandshake: unknown;
  readyState = 0;
  sent = 0;
  constructor() {
    super();
    queueMicrotask(() => {
      if (Socket.handshake !== undefined) this.handshake(Socket.handshake);
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }
  handshake(value: unknown) {
    this.dispatchEvent(new MessageEvent("handshake", { data: value }));
  }
  send() {
    this.sent++;
    queueMicrotask(() => {
      if (Socket.lateHandshake !== undefined) this.handshake(Socket.lateHandshake);
      for (const event of [
        { type: "response.created", response: { id: "fixture-response", status: "in_progress", output: [] } },
        { type: "response.completed", response: { id: "fixture-response", status: "completed", output: [], usage } },
      ]) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
    });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

afterEach(() => {
  globalThis.WebSocket = realWebSocket;
  Socket.handshake = undefined;
  Socket.lateHandshake = undefined;
});

async function exchange(handshake: unknown, url = CODEX_RESPONSES_HTTP_URL) {
  Socket.handshake = handshake;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const init: RequestInit = {
    method: "POST", signal: AbortSignal.timeout(1000),
    body: JSON.stringify({ model: "fixture-model", stream: true, input: [] }),
  };
  const prepared = prepareCodexWsRequest(url, init)!;
  const session = new CodexWsSession("ws://127.0.0.1/fixture", prepared.headers);
  let fallbacks = 0;
  try {
    expect(session.reserve()).toBe(true);
    const response = await codexWsExchange({
      session, url, init, prepared, bunVersion: Bun.version,
      sseFallback: (async () => { fallbacks++; throw new Error("unexpected HTTP fallback"); }) as typeof fetch,
    });
    const text = await response.text();
    const terminal = text.split("\n").filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6))).find(event => event.type === "response.completed");
    expect(response.status).toBe(200);
    expect(terminal?.response.usage).toEqual(usage);
    expect((session.socket as unknown as Socket).sent).toBe(1);
    expect(fallbacks).toBe(0);
    return response;
  } finally {
    session.dispose();
  }
}

const invalidHandshakes: Array<[string, unknown]> = [
  ["unsupported handshake event", undefined],
  ["non-upgrade HTTP response", { statusCode: 200, rawHeaders: [flag, "true"] }],
  ["string status", { statusCode: "101", rawHeaders: [flag, "true"] }],
  ["non-array raw headers", upgrade({ [flag]: "true" })],
  ["incomplete header pair", upgrade([flag, "true", "unfinished"])],
  ["non-string header value", upgrade([flag, true])],
  ["invalid header name", upgrade([flag, "true", "bad name", "fixture"])],
  ["header injection", upgrade([flag, "true\r\nx-other: fixture"])],
  ["connection-nominated inclusion", upgrade([flag, "true", "Connection", "Upgrade, X-Reasoning-Included"])],
  ["too many raw headers", upgrade([flag, "true", ...Array.from({ length: CODEX_WS_METADATA_MAX_HEADERS },
    (_, index) => [`x-fixture-${index}`, "value"]).flat()])],
  ["oversized raw header block", upgrade([flag, "true", "x-fixture", "x".repeat(CODEX_WS_METADATA_MAX_BYTES)])],
  ["oversized inclusion value", upgrade([flag, "x".repeat(CODEX_WS_METADATA_MAX_VALUE_BYTES + 1)])],
  ["oversized combined duplicate value", upgrade([flag, "x".repeat(CODEX_WS_METADATA_MAX_VALUE_BYTES / 2),
    "X-Reasoning-Included", "y".repeat(CODEX_WS_METADATA_MAX_VALUE_BYTES / 2)])],
];

test.each(invalidHandshakes)("%s cannot manufacture an inclusion signal or break generation", async (_name, handshake) => {
  expect((await exchange(handshake)).headers.has(flag)).toBe(false);
});

test.each(["true", "false", ""])("preserves the actual upgrade value %j with mixed-case header spelling", async value => {
  expect((await exchange(upgrade(["X-Reasoning-Included", value]))).headers.get(flag)).toBe(value);
});

test("duplicate inclusion headers preserve their HTTP-combined value", async () => {
  expect((await exchange(upgrade([flag, "true", "X-Reasoning-Included", "false"]))).headers.get(flag)).toBe("true, false");
});

test("a handshake event after open cannot replace the validated connection default", async () => {
  Socket.lateHandshake = upgrade([flag, "false"]);
  expect((await exchange(upgrade([flag, "true"]))).headers.get(flag)).toBe("true");
});

test("a new connection without the header cannot inherit a previous connection's inclusion", async () => {
  expect((await exchange(upgrade([flag, "true"]))).headers.get(flag)).toBe("true");
  expect((await exchange(upgrade([]))).headers.has(flag)).toBe(false);
});

test("non-canonical Responses transports keep their existing header policy", async () => {
  const response = await exchange(upgrade([flag, "true"]), "https://api.openai.com/v1/responses");
  expect(response.headers.has(flag)).toBe(false);
});

interface CloseTimer { callback: () => void; delay: number; unref: () => void }
class ClosingSocket extends EventTarget {
  readyState = 0;
  closeCalls = 0;
  terminateCalls = 0;
  closeMode: "stall" | "sync" | "throw" = "stall";
  terminateThrows = false;
  readonly closeListeners = new Set<EventListenerOrEventListenerObject>();
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    super.addEventListener(type, listener, options);
    if (type === "close" && listener) this.closeListeners.add(listener);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    super.removeEventListener(type, listener, options);
    if (type === "close" && listener) this.closeListeners.delete(listener);
  }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  peerClose() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  close() {
    this.closeCalls++;
    if (this.closeMode === "throw") throw new Error("fixture close failure");
    this.readyState = 2;
    if (this.closeMode === "sync") this.peerClose();
  }
  terminate?: () => void = () => {
    this.terminateCalls++;
    if (this.terminateThrows) throw new Error("fixture terminate failure");
    this.peerClose();
  };
}

/** Synchronous clock scope: no awaited work runs while global timers are replaced. */
function withClosingSession(run: (fixture: {
  session: CodexWsSession; socket: ClosingSocket; timers: Set<CloseTimer>;
  expire(): void; unrefs(): number; changes(): number;
}) => void, retainable = false) {
  const savedSocket = globalThis.WebSocket;
  const savedSet = globalThis.setTimeout;
  const savedClear = globalThis.clearTimeout;
  const timers = new Set<CloseTimer>();
  let unrefs = 0, changes = 0;
  globalThis.WebSocket = ClosingSocket as unknown as typeof WebSocket;
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    const timer = { callback, delay, unref: () => { unrefs++; } };
    timers.add(timer);
    return timer;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((timer: CloseTimer) => { timers.delete(timer); }) as unknown as typeof clearTimeout;
  try {
    const session = new CodexWsSession("ws://127.0.0.1/fixture", {}, retainable, () => { changes++; });
    run({ session, socket: session.socket as unknown as ClosingSocket, timers,
      unrefs: () => unrefs, changes: () => changes,
      expire() {
        for (const timer of [...timers]) {
          timers.delete(timer);
          timer.callback();
        }
      },
    });
  } finally {
    globalThis.setTimeout = savedSet;
    globalThis.clearTimeout = savedClear;
    globalThis.WebSocket = savedSocket;
  }
}

test("private closing handshake has one unrefed grace timer and one forced teardown", () => {
  withClosingSession(({ session, socket, timers, expire, unrefs, changes }) => {
    socket.open();
    expect(session.reserve()).toBe(true);
    const reason = new Error("fixture cancellation");
    let observed: Error | undefined;
    session.bindOwner(error => { observed = error; });
    session.dispose(reason);
    expect(observed).toBe(reason);
    expect(session.closed).toBe(true);
    expect(session.busy).toBe(false);
    expect(socket.closeCalls).toBe(1);
    expect(socket.terminateCalls).toBe(0);
    expect(timers.size).toBe(1);
    expect([...timers][0]!.delay).toBe(CODEX_WS_SESSION_CLOSE_GRACE_MS);
    expect(unrefs()).toBe(1);
    session.dispose();
    expect(timers.size).toBe(1);
    expire();
    expect(socket.terminateCalls).toBe(1);
    expect(socket.readyState).toBe(3);
    expect(timers.size).toBe(0);
    expect(socket.closeListeners.size).toBe(0);
    expect(changes()).toBe(1);
  });
});

test("private closing handshake cancels fallback on asynchronous and synchronous close", () => {
  for (const mode of ["stall", "sync"] as const) withClosingSession(({ session, socket, timers, expire }) => {
    socket.open(); socket.closeMode = mode;
    session.dispose();
    if (mode === "stall") socket.peerClose();
    expect(timers.size).toBe(0);
    expect(socket.closeListeners.size).toBe(0);
    expire();
    expect(socket.terminateCalls).toBe(0);
  });
});

test("retained closing handshake keeps immediate disposal and successful reuse", () => {
  withClosingSession(({ session, socket, timers }) => {
    socket.open(); session.reserve(); session.release("fixture-completed");
    expect(session.hasCompleted("fixture-completed")).toBe(true);
    expect(session.reserve()).toBe(true);
    expect(socket.closeCalls).toBe(0);
    expect(timers.size).toBe(0);
    session.dispose();
    expect(socket.closeCalls).toBe(1);
    expect(socket.terminateCalls).toBe(1);
    expect(timers.size).toBe(0);
  }, true);
});

test("private closing handshake contains close and terminate exceptions", () => {
  withClosingSession(({ session, socket, timers, changes }) => {
    socket.closeMode = "throw";
    session.dispose();
    expect(socket.terminateCalls).toBe(1);
    expect(timers.size).toBe(0);
    expect(socket.closeListeners.size).toBe(0);
    expect(changes()).toBe(1);
  });
  withClosingSession(({ session, socket, timers, expire }) => {
    socket.open(); socket.terminateThrows = true;
    session.dispose(); expire();
    expect(socket.terminateCalls).toBe(1);
    expect(timers.size).toBe(0);
    expect(socket.closeListeners.size).toBe(0);
  });
});

test("private closing handshake remains bounded when the exchange owner throws", () => {
  withClosingSession(({ session, socket, expire, changes }) => {
    socket.open(); session.reserve();
    session.bindOwner(() => { throw new Error("fixture owner failure"); });
    expect(() => session.dispose()).toThrow("fixture owner failure");
    expect(changes()).toBe(1);
    expire();
    expect(socket.terminateCalls).toBe(1);
  });
});

test("private closing handshake covers completed releases, failed releases and connecting sockets", () => {
  for (const completedId of ["fixture-completed", null]) withClosingSession(({ session, socket, expire }) => {
    socket.open(); session.reserve(); session.release(completedId); expire();
    expect(socket.terminateCalls).toBe(1);
  });
  withClosingSession(({ session, socket, expire }) => {
    session.dispose(); expire();
    expect(socket.terminateCalls).toBe(1);
  });
});

test("private closing handshake creates no timer after a remote close", () => {
  withClosingSession(({ session, socket, timers }) => {
    socket.open(); socket.peerClose(); session.dispose();
    expect(socket.closeCalls).toBe(0);
    expect(socket.terminateCalls).toBe(0);
    expect(timers.size).toBe(0);
  });
});

test("private closing handshake adds no observer or timer without optional terminate", () => {
  for (const mode of ["stall", "throw"] as const) withClosingSession(({ session, socket, timers, unrefs, changes }) => {
    socket.open(); socket.terminate = undefined; socket.closeMode = mode;
    session.dispose();
    expect(socket.closeCalls).toBe(1);
    expect(timers.size).toBe(0);
    expect(socket.closeListeners.size).toBe(0);
    expect(unrefs()).toBe(0);
    expect(changes()).toBe(1);
  });
});

test.each(["dispose", "release"] as const)("private %s closes a real peer that withholds its close reply", async mode => {
  // A raw peer accepts the upgrade and reads Close, but deliberately never answers it.
  // Keep the native client's close and terminate operations intact on both Bun versions.
  const keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  let listener: ReturnType<typeof Bun.listen> | undefined;
  let session: CodexWsSession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolvePeerClosed!: () => void;
  const peerClosed = new Promise<void>(resolve => { resolvePeerClosed = resolve; });
  let headers = Buffer.alloc(0), closeFrame = Buffer.alloc(0), upgraded = false;
  try {
    listener = Bun.listen({
      hostname: "127.0.0.1", port: 0,
      socket: {
        data(socket, data) {
          if (!upgraded) {
            headers = Buffer.concat([headers, data]);
            const boundary = headers.indexOf("\r\n\r\n");
            if (boundary < 0) return;
            const key = /^Sec-WebSocket-Key:\s*(.+)\r?$/im.exec(headers.subarray(0, boundary).toString())?.[1]?.trim();
            if (!key) { socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"); return; }
            const accept = new Bun.CryptoHasher("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
            upgraded = true;
            socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"
              + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
            data = headers.subarray(boundary + 4);
          }
          closeFrame = Buffer.concat([closeFrame, data]);
        },
        end(socket) { socket.end(); resolvePeerClosed(); },
        close() { resolvePeerClosed(); },
      },
    });
    session = new CodexWsSession(`ws://127.0.0.1:${listener.port}`, {});
    const socket = session.socket;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer); timer = undefined;
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error("fixture WebSocket failed to open")); };
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
      timer = setTimeout(onError, watchdogMs(3000));
    });
    expect(session.reserve()).toBe(true);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("disposed private socket left its peer open")), watchdogMs(3000));
    });
    if (mode === "release") session.release("fixture-completed");
    else session.dispose();
    expect(session.closed).toBe(true);
    expect(session.busy).toBe(false);
    expect(session.reserve()).toBe(false);
    await Promise.race([peerClosed, deadline]);
    expect(closeFrame.length).toBeGreaterThanOrEqual(2);
    expect(closeFrame[0]! & 0x0f).toBe(0x08);
    expect(socket.readyState).toBe(3);
  } finally {
    clearTimeout(timer);
    session?.dispose();
    try { (session?.socket as (WebSocket & { terminate?: () => void }) | undefined)?.terminate?.(); } catch { /* fixture teardown */ }
    listener?.stop(true);
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}, watchdogMs(5000));
