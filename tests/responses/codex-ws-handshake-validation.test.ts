import { afterEach, expect, test } from "bun:test";
import { codexWsExchange } from "../../src/server/responses/codex-ws-exchange";
import { CodexWsSession } from "../../src/server/responses/codex-ws-session";
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
