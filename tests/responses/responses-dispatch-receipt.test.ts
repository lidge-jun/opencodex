import { afterEach, expect, test } from "bun:test";
import { providerFetch, sendWithConnectionPolicy } from "../../src/server/responses/fetch-helpers";
import { codexWsExchange } from "../../src/server/responses/codex-ws-exchange";
import { CodexWsSession } from "../../src/server/responses/codex-ws-session";
import { prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import {
  assertSendAdmission, requireSendAdmission, runWithSendAdmission, withSendAdmissionScope,
} from "../../src/server/responses/send-admission";
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
  static autoOpen = true;
  listeners = new Map<string, Set<(event: unknown) => void>>();
  sent: string[] = [];
  constructor() { FakeSocket.latest = this; if (FakeSocket.autoOpen) queueMicrotask(() => this.emit("open", {})); }
  addEventListener(name: string, fn: (event: unknown) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  }
  removeEventListener(name: string, fn: (event: unknown) => void) { this.listeners.get(name)?.delete(fn); }
  emit(name: string, event: unknown) { for (const fn of this.listeners.get(name) ?? []) fn(event); }
  send(data: string) { FakeSocket.onSend?.(data); this.sent.push(data); }
  close() {}
}

afterEach(() => { FakeSocket.onSend = undefined; FakeSocket.autoOpen = true; });

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

test("a WebSocket frame is not sent once the request's Combo admission is withdrawn", async () => {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  const init = streamingInit();
  const prepared = prepareCodexWsRequest(wsUrl, init)!;
  const session = new CodexWsSession("wss://chatgpt.com/backend-api/codex/responses", prepared.headers, false);
  let admitted = true, fallbacks = 0, receipts = 0;
  try {
    expect(session.reserve()).toBe(true);
    const result = await runWithSendAdmission(() => admitted ? undefined : new Response("fixture refusal", { status: 403 }), () => {
      const exchange = codexWsExchange({ session, url: wsUrl, init, prepared,
        sseFallback: (async () => { fallbacks++; return new Response("unexpected"); }) as unknown as typeof fetch,
        onPhysicalDispatch: () => { receipts++; },
      });
      // Withdrawn after the exchange started and before its socket opened.
      admitted = false;
      return exchange;
    });
    expect(result.refused).toBe(true);
    expect(result.response.status).toBe(403);
    expect(FakeSocket.latest.sent).toHaveLength(0);
    expect(receipts).toBe(0);
    expect(fallbacks).toBe(0);
  } finally { session.dispose(); }
});

test("an HTTP fallback a socket callback starts still checks the request's Combo admission", async () => {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  FakeSocket.autoOpen = false;
  const init = streamingInit();
  const prepared = prepareCodexWsRequest(wsUrl, init)!;
  const session = new CodexWsSession("wss://chatgpt.com/backend-api/codex/responses", prepared.headers, false);
  let admitted = true, fallbacks = 0;
  // Created outside the request's slot, like a native socket event.
  setTimeout(() => {
    admitted = false;
    FakeSocket.latest.emit("error", {});
  }, 10);
  try {
    expect(session.reserve()).toBe(true);
    const result = await runWithSendAdmission(() => admitted ? undefined : new Response("fixture refusal", { status: 403 }),
      () => codexWsExchange({ session, url: wsUrl, init, prepared,
        // The fallback's physical send reads the request's admission, as fetch-helpers does.
        sseFallback: (async () => { assertSendAdmission(); fallbacks++; return new Response("unexpected"); }) as unknown as typeof fetch,
      }));
    expect(result.refused).toBe(true);
    expect(result.response.status).toBe(403);
    expect(fallbacks).toBe(0);
  } finally { session.dispose(); }
});
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
  let receipts = 0, refunds = 0, httpSends = 0, overrides = 0, socketFailed = false;
  const budget = createRequestExecutionBudget(undefined, undefined, {
    charge: () => true, refund: () => { refunds++; },
  });
  const booking = budget.reserveDispatch({ sendClass: "initial", targetKey: "chatgpt/codex", countedExternally: true });
  if (!booking.allowed) throw new Error("fixture booking denied");
  FakeSocket.onSend = () => { expect(receipts).toBe(1); socketFailed = true; throw new Error("fixture socket send failure"); };
  const fetcher = providerFetch(wsProvider((async () => {
    httpSends++;
    return new Response("unexpected");
  }) as typeof fetch), "1.4.0", {
    onPhysicalDispatch: () => { receipts++; expect(booking.permit.use()).toBe(true); },
    // The override wraps the WS send once; its HTTP fallback must not re-run it (one logical send).
    dispatchOverride: async (input, init, execute) => { overrides++; return execute(input, init); },
    beforeDispatch: () => { if (socketFailed) throw new Error("fixture local HTTP refusal"); },
  });
  await expect(fetcher(wsUrl, streamingInit())).rejects.toThrow("fixture local HTTP refusal");
  booking.permit.release();
  expect(overrides).toBe(1); expect(httpSends).toBe(0); expect(receipts).toBe(1);
  expect(refunds).toBe(0); expect(budget.used).toBe(1);
});

test("a nested request's check stays in its own slot while the enclosing check still applies to its sends", async () => {
  const refusal = (status: number) => new Response(null, { status });
  let enclosingAdmitted = true;
  const result = await runWithSendAdmission(() => enclosingAdmitted ? undefined : refusal(403), async () => {
    // An auxiliary request names its own check, which refuses its send.
    const auxiliary = await withSendAdmissionScope(async () => {
      requireSendAdmission(() => refusal(409));
      assertSendAdmission();
      return new Response("sent");
    });
    expect(auxiliary.status).toBe(409);
    // The enclosing request still sends under its own check.
    expect(() => assertSendAdmission()).not.toThrow();
    enclosingAdmitted = false;
    const nested = await withSendAdmissionScope(async () => {
      assertSendAdmission();
      return new Response("sent");
    });
    expect(nested.status).toBe(403);
    return new Response("enclosing answer");
  });
  // A send refused by the enclosing check refuses the enclosing request too.
  expect(result.refused).toBe(true);
  expect(result.response.status).toBe(403);
});
