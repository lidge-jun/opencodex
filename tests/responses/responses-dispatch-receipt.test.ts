import { afterEach, expect, test } from "bun:test";
import { providerFetch, sendWithConnectionPolicy } from "../../src/server/responses/fetch-helpers";
import { codexWsExchange } from "../../src/server/responses/codex-ws-exchange";
import { CodexWsSession } from "../../src/server/responses/codex-ws-session";
import { prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";
import { isNonReplayableResponse } from "../../src/lib/upstream-retry";
import { streamingInit } from "../helpers/ws-upstream-fixtures";

const realWebSocket = globalThis.WebSocket;
afterEach(() => { globalThis.WebSocket = realWebSocket; });

for (const nested of [false, true]) test(`HTTP receipt follows rebuilt executor and fires once (${nested})`, async () => {
  let receipts = 0, sends = 0;
  const physical = (async (input) => {
    sends++;
    expect(String(input)).toBe("https://fixture.invalid/rebuilt");
    expect(receipts).toBe(1);
    return new Response("fixture");
  }) as typeof fetch;
  const fetcher = providerFetch(Object.assign({ adapter: "openai-responses", baseUrl: "https://fixture.invalid" }, { fetch: physical }), "1.3.14", {
    onPhysicalDispatch: () => { receipts++; },
    dispatchOverride: async (_input, init, execute) => sendWithConnectionPolicy(
      nested ? execute : physical, "https://fixture.invalid/rebuilt", { ...init }),
  });
  expect((await fetcher("https://fixture.invalid/original", { method: "POST", body: "{}" })).status).toBe(200);
  expect(sends).toBe(1); expect(receipts).toBe(1);
});

test("HTTP local dispatch refusal leaves receipt and physical executor untouched", async () => {
  let receipts = 0, sends = 0;
  const fetcher = providerFetch(Object.assign({ adapter: "openai-responses", baseUrl: "https://fixture.invalid" }, { fetch: (async () => {
    sends++; return new Response("unexpected");
  }) as unknown as typeof fetch }), "1.3.14", {
    onPhysicalDispatch: () => { receipts++; },
    dispatchOverride: async () => { throw new Error("fixture local refusal"); },
  });
  await expect(fetcher("https://fixture.invalid/refused", { method: "POST", body: "{}" })).rejects.toThrow("fixture local refusal");
  expect(receipts).toBe(0); expect(sends).toBe(0);
});

class FakeSocket {
  static latest: FakeSocket;
  listeners = new Map<string, Set<(event: unknown) => void>>();
  sent: string[] = [];
  constructor() { FakeSocket.latest = this; queueMicrotask(() => this.emit("open", {})); }
  addEventListener(name: string, fn: (event: unknown) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  }
  removeEventListener(name: string, fn: (event: unknown) => void) { this.listeners.get(name)?.delete(fn); }
  emit(name: string, event: unknown) { for (const fn of this.listeners.get(name) ?? []) fn(event); }
  send(data: string) { this.sent.push(data); }
  close() {}
}

test("WebSocket post-send receipt failure never falls back or becomes replayable", async () => {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  const url = "https://chatgpt.com/backend-api/codex/responses", init = streamingInit();
  const prepared = prepareCodexWsRequest(url, init)!;
  const session = new CodexWsSession("wss://chatgpt.com/backend-api/codex/responses", prepared.headers, false);
  let fallbacks = 0, receipts = 0;
  try {
    expect(session.reserve()).toBe(true);
    const response = await codexWsExchange({ session, url, init, prepared,
      sseFallback: (async () => { fallbacks++; return new Response("unexpected"); }) as unknown as typeof fetch,
      onPhysicalDispatch: () => { receipts++; throw new Error("fixture receipt failure"); },
    });
    expect(response.status).toBe(502); expect(isNonReplayableResponse(response)).toBe(true);
    expect(await response.text()).toContain("fixture receipt failure");
    expect(FakeSocket.latest.sent).toHaveLength(1); expect(receipts).toBe(1); expect(fallbacks).toBe(0);
    expect([...FakeSocket.latest.listeners.values()].every(set => set.size === 0)).toBe(true);
  } finally { session.dispose(); }
});
