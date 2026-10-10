import { afterEach, expect, test } from "bun:test";
import { providerFetch, sendWithConnectionPolicy } from "../../src/server/responses/fetch-helpers";
import { codexWsExchange } from "../../src/server/responses/codex-ws-exchange";
import { CodexWsSession } from "../../src/server/responses/codex-ws-session";
import { prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
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
  static onSend: ((data: string) => void) | undefined;
  listeners = new Map<string, Set<(event: unknown) => void>>();
  sent: string[] = [];
  constructor() { FakeSocket.latest = this; queueMicrotask(() => this.emit("open", {})); }
  addEventListener(name: string, fn: (event: unknown) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  }
  removeEventListener(name: string, fn: (event: unknown) => void) { this.listeners.get(name)?.delete(fn); }
  emit(name: string, event: unknown) { for (const fn of this.listeners.get(name) ?? []) fn(event); }
  send(data: string) { FakeSocket.onSend?.(data); this.sent.push(data); }
  close() {}
}

afterEach(() => { FakeSocket.onSend = undefined; });

test("WebSocket receipt refusal before send rejects without fallback", async () => {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  const url = "https://chatgpt.com/backend-api/codex/responses", init = streamingInit();
  const prepared = prepareCodexWsRequest(url, init)!;
  const session = new CodexWsSession("wss://chatgpt.com/backend-api/codex/responses", prepared.headers, false);
  let fallbacks = 0, receipts = 0;
  try {
    expect(session.reserve()).toBe(true);
    await expect(codexWsExchange({ session, url, init, prepared,
      sseFallback: (async () => { fallbacks++; return new Response("unexpected"); }) as unknown as typeof fetch,
      onPhysicalDispatch: () => { receipts++; throw new Error("fixture receipt failure"); },
    })).rejects.toThrow("fixture receipt failure");
    expect(FakeSocket.latest.sent).toHaveLength(0); expect(receipts).toBe(1); expect(fallbacks).toBe(0);
    expect([...FakeSocket.latest.listeners.values()].every(set => set.size === 0)).toBe(true);
  } finally { session.dispose(); }
});

const wsUrl = "https://chatgpt.com/backend-api/codex/responses";
const wsProvider = (physical: typeof fetch) => Object.assign({ adapter: "openai-responses", baseUrl: wsUrl }, { fetch: physical });

test("providerFetch WS send failure shares one receipt with HTTP fallback", async () => {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  let receipts = 0, httpSends = 0, receiptAtSend = -1;
  FakeSocket.onSend = () => { receiptAtSend = receipts; expect(receipts).toBe(1); throw new Error("fixture socket send failure"); };
  const fetcher = providerFetch(wsProvider((async () => {
    httpSends++;
    expect(receipts).toBe(1);
    return new Response("fallback");
  }) as typeof fetch), "1.4.0", { onPhysicalDispatch: () => { receipts++; } });
  expect(await (await fetcher(wsUrl, streamingInit())).text()).toBe("fallback");
  expect(httpSends).toBe(1); expect(receipts).toBe(1); expect(receiptAtSend).toBe(1);
});

test("normal WebSocket frame receives exactly one receipt", async () => {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  let receipts = 0, httpSends = 0;
  FakeSocket.onSend = () => {
    expect(receipts).toBe(1);
    queueMicrotask(() => FakeSocket.latest.emit("message", { data: JSON.stringify({ type: "response.completed", response: { id: "r1", status: "completed" } }) }));
  };
  const fetcher = providerFetch(wsProvider((async () => { httpSends++; return new Response("unexpected"); }) as typeof fetch), "1.4.0", {
    onPhysicalDispatch: () => { receipts++; },
  });
  expect(await (await fetcher(wsUrl, streamingInit())).text()).toContain("response.completed");
  expect(receipts).toBe(1); expect(httpSends).toBe(0);
});

test("D7: accepted WS receipt remains charged if send and local HTTP admission both fail", async () => {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  let receipts = 0, refunds = 0, httpSends = 0, overrides = 0;
  const budget = createRequestExecutionBudget(undefined, undefined, {
    charge: () => true, refund: () => { refunds++; },
  });
  const booking = budget.reserveDispatch({ sendClass: "initial", targetKey: "chatgpt/codex", countedExternally: true });
  if (!booking.allowed) throw new Error("fixture booking denied");
  FakeSocket.onSend = () => { expect(receipts).toBe(1); throw new Error("fixture socket send failure"); };
  const fetcher = providerFetch(wsProvider((async () => {
    httpSends++;
    return new Response("unexpected");
  }) as typeof fetch), "1.4.0", {
    onPhysicalDispatch: () => { receipts++; expect(booking.permit.use()).toBe(true); },
    dispatchOverride: async () => { overrides++; throw new Error("fixture local HTTP refusal"); },
  });
  await expect(fetcher(wsUrl, streamingInit())).rejects.toThrow("fixture local HTTP refusal");
  booking.permit.release();
  expect(overrides).toBe(1); expect(httpSends).toBe(0); expect(receipts).toBe(1);
  expect(refunds).toBe(0); expect(budget.used).toBe(1);
});
