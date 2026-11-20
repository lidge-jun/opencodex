import { describe, expect, test } from "bun:test";
import net from "node:net";
import { listen, TunnelFixtureScope } from "../helpers/opaque-proxy-tunnel";
import { credentialPinnedProviderConfigError, modelAdapterRecordConfigError } from "../../src/config/provider-validation";
import { pinnedWireAdapter } from "../../src/types/wire";
import { M365_COPILOT_BASE_URL } from "../../src/providers/m365-copilot-models";
import { createM365Conversation, m365SocketDialOptions, runM365CopilotTurn } from "../../src/adapters/m365-copilot/transport";
import { createM365CopilotAdapter, clearM365CopilotConversations } from "../../src/adapters/m365-copilot";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { SendBudgetExhaustedError } from "../../src/lib/upstream-retry";
import type { IncomingMeta } from "../../src/adapters/base";
import type { AdapterEvent } from "../../src/types";

describe("M365 stored credential boundary", () => {
  test.each([
    { adapter: "openai-chat", baseUrl: "https://foreign.invalid/v1" },
    { adapter: "m365-copilot", baseUrl: "https://foreign.invalid/v1" },
  ])("rejects a retargeted OAuth row: $adapter", row => {
    expect(credentialPinnedProviderConfigError("m365-copilot", row)).not.toBeNull();
  });

  test("pins model wires even when a persisted row selects a foreign adapter", () => {
    const row = { adapter: "openai-chat", baseUrl: "https://foreign.invalid/v1", authMode: "oauth" };
    expect(pinnedWireAdapter("m365-copilot", "future-model", row)).toBe("m365-copilot");
    expect(modelAdapterRecordConfigError({ "future-model": "openai-chat" }, "modelAdapters", "m365-copilot", row))
      .toContain("cannot be overridden");
    expect(credentialPinnedProviderConfigError("m365-copilot", { adapter: "m365-copilot", baseUrl: M365_COPILOT_BASE_URL })).toBeNull();
  });
});

describe("M365 native socket egress", () => {
  test("an inherited SOCKS route is also refused", () => {
    const previousProxy = process.env.HTTPS_PROXY, previousBypass = process.env.NO_PROXY;
    process.env.HTTPS_PROXY = "socks5://127.0.0.1:9";
    process.env.NO_PROXY = "";
    try {
      expect(() => m365SocketDialOptions({}, "wss://substrate.office.com/m365Copilot", {}))
        .toThrow("supports only HTTP(S) proxies");
    } finally {
      if (previousProxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = previousProxy;
      if (previousBypass === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = previousBypass;
    }
  });

  test.each(["socks5", "socks5h"])("%s is refused with a config error before any socket dial", async scheme => {
    let dials = 0;
    const token = "header." + Buffer.from(JSON.stringify({
      oid: "11111111-1111-1111-1111-111111111111", tid: "22222222-2222-2222-2222-222222222222", exp: 4102444800,
    })).toString("base64url") + ".signature";
    await expect(Promise.resolve().then(() => runM365CopilotTurn({
      token, model: "claude-sonnet", text: "fixture", conversation: createM365Conversation(), onText() {},
      route: { proxy: `${scheme}://127.0.0.1:9` },
      createSocket() { dials++; throw new Error("unexpected socket dial"); },
    }))).rejects.toThrow("supports only HTTP(S) proxies");
    expect(dials).toBe(0);
  });

  test.each(["ws", "wss"])("%s: a refusing HTTP proxy receives the socket attempt and the destination receives no direct connection", async scheme => {
    let proxyRequests = 0, directRequests = 0;
    let proxyRequestLine = "";
    const scope = new TunnelFixtureScope();
    const destination = net.createServer(socket => {
      directRequests++;
      socket.destroy();
    });
    const proxy = net.createServer(socket => socket.once("data", data => {
      proxyRequests++;
      proxyRequestLine = data.toString().split("\r\n")[0]!;
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    }));
    const NativeSocket = globalThis.WebSocket;
    const token = "header." + Buffer.from(JSON.stringify({
      oid: "11111111-1111-1111-1111-111111111111", tid: "22222222-2222-2222-2222-222222222222", exp: 4102444800,
    })).toString("base64url") + ".signature";
    try {
      const destinationPort = await listen(scope, destination), proxyPort = await listen(scope, proxy);
      // Keep Bun's actual constructor and proxy implementation; substitute only the upstream URL.
      globalThis.WebSocket = class extends (NativeSocket as unknown as typeof Bun.WebSocket) {
        constructor(_url: string | URL, options?: Bun.WebSocketOptions) {
          super(`${scheme}://127.0.0.1:${destinationPort}/chathub`, options);
        }
      } as typeof WebSocket;
      await expect(runM365CopilotTurn({
        token, model: "claude-sonnet", text: "fixture", conversation: createM365Conversation(), onText() {},
        route: { proxy: `http://127.0.0.1:${proxyPort}` }, signal: AbortSignal.timeout(3000),
      })).rejects.toThrow("connection");
      expect(proxyRequests).toBe(1);
      expect(directRequests).toBe(0);
      expect(proxyRequestLine).toBe(`CONNECT 127.0.0.1:${destinationPort} HTTP/1.1`);
    } finally {
      globalThis.WebSocket = NativeSocket;
      await scope.close();
    }
  });
});

describe("M365 final physical admission settles its send-budget reservation", () => {
  // A loopback ChatHub counts chat frames; the shared budget's observer counts charges and refunds.
  const probe = async (options: { admit: boolean; abortBeforeSend?: boolean }) => {
    let frames = 0, receipts = 0, charges = 0, refunds = 0;
    const controller = new AbortController();
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req, srv) { if (srv.upgrade(req)) return; return new Response(null, { status: 400 }); }, websocket: {
      message(ws, data) {
        const frame = JSON.parse(String(data).split("\x1e")[0]!);
        if (frame.protocol) { if (options.abortBeforeSend) controller.abort(); else ws.send("{}\x1e"); return; }
        if (frame.target !== "chat") return;
        frames++;
        ws.send(JSON.stringify({ type: 1, target: "update", arguments: [{ messages: [{ author: "bot", messageId: "m", text: "ok" }] }] }) + "\x1e");
        ws.send(JSON.stringify({ type: 2, item: { result: { value: "Success" } } }) + "\x1e");
      },
    } });
    const sendBudget = createRequestExecutionBudget(undefined, undefined, {
      charge: () => { charges++; return true; }, refund: () => { refunds++; }, beforePhysicalSend: () => options.admit,
    });
    const token = "header." + Buffer.from(JSON.stringify({
      oid: "11111111-1111-1111-1111-111111111111", tid: "22222222-2222-2222-2222-222222222222", exp: 4102444800,
    })).toString("base64url") + ".signature";
    const adapter = createM365CopilotAdapter({ adapter: "m365-copilot", baseUrl: M365_COPILOT_BASE_URL, apiKey: token, authMode: "oauth" }, {
      turn: turn => runM365CopilotTurn({ ...turn, createSocket: () => new WebSocket("ws://127.0.0.1:" + server.port) }),
    });
    const events: AdapterEvent[] = [];
    let error: unknown;
    try {
      await adapter.runTurn!({ modelId: "claude-sonnet", stream: true, options: {}, context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] } },
        { headers: new Headers(), translatorBudget: createTranslatorBudget(), abortSignal: controller.signal, sendBudget, onPhysicalSend: () => { receipts++; } } as unknown as IncomingMeta,
        event => events.push(event));
    } catch (caught) { error = caught; } finally { server.stop(true); clearM365CopilotConversations(); }
    return { frames, receipts, charges, retained: charges - refunds, used: sendBudget.used, events, error };
  };

  test("an admitted chat sends one frame with one receipt and one charge", async () => {
    const result = await probe({ admit: true });
    expect(result.error).toBeUndefined();
    expect(result.events.some(event => event.type === "done")).toBe(true);
    expect({ frames: result.frames, receipts: result.receipts, charges: result.charges, retained: result.retained, used: result.used })
      .toEqual({ frames: 1, receipts: 1, charges: 1, retained: 1, used: 1 });
  });

  test("a refused final admission sends nothing and refunds its reservation", async () => {
    const result = await probe({ admit: false });
    expect(result.error).toBeInstanceOf(SendBudgetExhaustedError);
    expect({ frames: result.frames, receipts: result.receipts, retained: result.retained, used: result.used })
      .toEqual({ frames: 0, receipts: 0, retained: 0, used: 0 });
  });

  test("an abort before the chat frame books no charge", async () => {
    const result = await probe({ admit: true, abortBeforeSend: true });
    expect(result.events.some(event => event.type === "error")).toBe(true);
    expect({ frames: result.frames, receipts: result.receipts, charges: result.charges, used: result.used })
      .toEqual({ frames: 0, receipts: 0, charges: 0, used: 0 });
  });
});
