import { expect, test } from "bun:test";
import { createM365CopilotAdapter, clearM365CopilotConversations } from "../../src/adapters/m365-copilot";
import { M365_COPILOT_BASE_URL } from "../../src/providers/m365-copilot-models";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { providerFetch } from "../../src/server/responses/fetch-helpers";
import { markEgressTransparentExecutor } from "../../src/lib/provider-egress";
import { m365SocketDialOptions } from "../../src/adapters/m365-copilot/transport";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";

const token = "header." + Buffer.from(JSON.stringify({
  oid: "11111111-1111-1111-1111-111111111111", tid: "22222222-2222-2222-2222-222222222222", exp: 4102444800,
})).toString("base64url") + ".signature";

async function runFixture(mode: "absent" | "opaque" | "routed" | "wrapped-custom" | "override" | "transparent" | "tls" | "foreign-provider" | "foreign-origin", image = false) {
  const NativeSocket = globalThis.WebSocket;
  let connections = 0, executorCalls = 0, admissions = 0;
  const events: AdapterEvent[] = [];
  const budget = createTranslatorBudget();
  const destination = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, server) { connections++; return server.upgrade(req) ? undefined : new Response("fixture"); },
    websocket: { message(socket, data) {
      const frame = JSON.parse(String(data).split("\x1e")[0]!);
      if (frame.protocol) socket.send("{}\x1e");
      if (frame.target === "chat") socket.send(JSON.stringify({ type: 2, item: {
        result: { value: "Success" }, messages: [{ author: "bot", messageType: "Chat", text: "fixture success" }],
      } }) + "\x1e");
    } },
  });
  try {
    globalThis.WebSocket = class extends (NativeSocket as unknown as typeof Bun.WebSocket) {
      constructor(_url: string | URL, options?: Bun.WebSocketOptions) {
        super(`ws://127.0.0.1:${destination.port}/fixture`, options);
      }
    } as typeof WebSocket;
    const provider: OcxProviderConfig = { adapter: "m365-copilot", baseUrl: M365_COPILOT_BASE_URL,
      apiKey: token, authMode: "oauth", proxy: "direct" };
    const refuse = Object.assign(async () => { executorCalls++; throw new Error("fixture refuses egress"); },
      { preconnect: globalThis.fetch.preconnect }) as typeof fetch;
    const executor = mode === "absent" ? undefined : mode === "opaque" ? refuse : mode === "transparent" ? markEgressTransparentExecutor(refuse) : providerFetch(
      mode === "wrapped-custom" ? { ...provider, fetch: refuse } as OcxProviderConfig
        : mode === "tls" ? { ...provider, tlsProfile: "chrome" } as OcxProviderConfig
        : mode === "foreign-origin" ? { ...provider, baseUrl: "https://foreign.invalid" } : provider,
      undefined, { providerName: mode === "foreign-provider" ? "foreign" : "m365-copilot", ...(mode === "override" ? { dispatchOverride: refuse } : {}) },
    );
    const parsed: OcxParsedRequest = { modelId: "claude-sonnet", stream: true, options: {}, context: {
      messages: [{ role: "user", timestamp: 0, content: image
        // Invalid bytes prevent external egress even if the pre-upload refusal regresses.
        ? [{ type: "text", text: "fixture" }, { type: "image", imageUrl: "data:image/png;base64,AAAA" }]
        : "fixture" }],
    } };
    await createM365CopilotAdapter(provider).runTurn!(parsed, {
      headers: new Headers(), translatorBudget: budget, abortSignal: AbortSignal.timeout(3000),
      ...(executor ? { providerFetch: executor } : {}), beforePhysicalSend: () => { admissions++; },
    }, event => events.push(event));
    return { connections, executorCalls, admissions, events };
  } finally {
    globalThis.WebSocket = NativeSocket;
    await destination.stop(true); budget.dispose(); clearM365CopilotConversations();
  }
}

test.each([false, true])("opaque incoming executor refuses before socket or upload (image=%s)", async image => {
  const result = await runFixture("opaque", image);
  expect(result.connections).toBe(0);
  expect(result.executorCalls).toBe(0);
  expect(result.admissions).toBe(0);
  expect(result.events).toEqual([expect.objectContaining({ type: "error", status: 400, retryable: false,
    message: expect.stringContaining("request-scoped fetch executor") })]);
});

test.each(["absent", "routed"] as const)("%s executor preserves normal native socket turns", async mode => {
  const result = await runFixture(mode);
  expect(result.connections).toBe(1);
  expect(result.events).toContainEqual({ type: "text_delta", text: "fixture success" });
  expect(result.events.at(-1)).toMatchObject({ type: "done" });
});

test.each(["wrapped-custom", "override", "transparent", "tls", "foreign-provider", "foreign-origin"] as const)("%s executor cannot authorize a native socket", async mode => {
  const result = await runFixture(mode, true);
  expect(result.connections).toBe(0);
  expect(result.admissions).toBe(0);
  expect(result.executorCalls).toBe(0);
  expect(result.events).toEqual([expect.objectContaining({ type: "error", status: 400, retryable: false })]);
});

test("socket authority captures the request route and bypass list rather than the adapter's fallback route", () => {
  const noProxy = ["bypass.invalid"];
  const provider: OcxProviderConfig = { baseUrl: M365_COPILOT_BASE_URL, proxy: "http://127.0.0.1:9", noProxy };
  const executor = providerFetch(provider, undefined, { providerName: "m365-copilot" });
  provider.proxy = "direct"; noProxy.push("substrate.office.com");
  expect(m365SocketDialOptions({ proxy: "direct", providerFetch: executor }, "wss://substrate.office.com/m365Copilot", {}))
    .toEqual({ headers: {}, proxy: "http://127.0.0.1:9/" });
  expect(m365SocketDialOptions({ providerFetch: executor }, "wss://bypass.invalid/fixture", {})).toEqual({ headers: {} });
});
