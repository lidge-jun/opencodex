import { describe, expect, test } from "bun:test";
import net from "node:net";
import { listen, TunnelFixtureScope } from "../helpers/opaque-proxy-tunnel";
import { credentialPinnedProviderConfigError, modelAdapterRecordConfigError } from "../../src/config/provider-validation";
import { pinnedWireAdapter } from "../../src/types/wire";
import { M365_COPILOT_BASE_URL } from "../../src/providers/m365-copilot-models";
import { createM365Conversation, runM365CopilotTurn } from "../../src/adapters/m365-copilot/transport";

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
