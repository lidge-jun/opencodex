import { afterEach, expect, spyOn, test } from "bun:test";
import type { AdapterRequest } from "../../../src/adapters/base";
import { createKiroAdapter } from "../../../src/adapters/kiro";
import { safeKiroHttpErrorMessage } from "../../../src/adapters/kiro-errors";
import { fetchKiroWithRetry, resetKiroThrottleStateForTests } from "../../../src/adapters/kiro-retry";
import { getDebugLogEntries, resetDebugLogBufferForTests } from "../../../src/lib/debug-log-buffer";
import { clearDebugSetting, getDebugSettings, setDebugSettings } from "../../../src/lib/debug-settings";
import { encodeMessage } from "../../../src/lib/eventstream-decoder";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

const request: AdapterRequest = {
  url: "https://runtime.us-east-1.kiro.dev/", method: "POST", headers: { authorization: "Bearer old" }, body: "old-body",
};
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; resetKiroThrottleStateForTests(); });

function responseWithUrl(status: number, url: string): Response {
  const response = new Response("opaque", { status });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

async function runCompletionFallback(
  executor: typeof fetch,
  provider = { adapter: "kiro", baseUrl: "https://127.0.0.1", authMode: "oauth", apiKey: "fixture-token" } as OcxProviderConfig,
  onBuilt?: (request: AdapterRequest) => void,
): Promise<{ events: AdapterEvent[]; built: AdapterRequest }> {
  const parsed = {
    modelId: "claude-sonnet-4.5", stream: true, options: {},
    context: { messages: [{ role: "user", content: "do it" }],
      tools: [{ name: "bash", description: "Run a shell command", parameters: { type: "object" } }] },
  } as unknown as OcxParsedRequest;
  const adapter = withTestTranslatorBudget(createKiroAdapter(provider));
  const built = await adapter.buildRequest(parsed);
  onBuilt?.(built);
  const first = await adapter.fetchResponse!(built, { executor, stream: true });
  const events: AdapterEvent[] = [];
  for await (const event of adapter.parseStream(first)) events.push(event);
  return { events, built };
}

function incompleteStream(): Response {
  const frame = encodeMessage(
    { ":message-type": "event", ":event-type": "assistantResponseEvent" },
    new TextEncoder().encode(JSON.stringify({ content: "I am checking." })),
  );
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(frame); controller.close(); },
  }), { status: 200 });
}

test("initial, reset, gateway alternate and 429 recovery use the supplied executor", async () => {
  const urls: string[] = [];
  let pacingWaits = 0;
  const executor = Object.assign((async () => { throw new Error("paced executor called directly"); }) as typeof fetch, {
    waitForPacing: async () => { pacingWaits++; },
    unpacedFetch: (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (urls.length === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      if (urls.length === 2) return new Response("bad gateway", { status: 502 });
      return new Response("ok");
    }) as typeof fetch,
  });
  expect((await fetchKiroWithRetry(request, { executor, timeoutMs: 5_000 })).status).toBe(200);
  expect(urls).toEqual([request.url, request.url, "https://q.us-east-1.amazonaws.com/"]);
  expect(pacingWaits).toBe(3);

  let sends = 0;
  let throttlePacingWaits = 0;
  const throttleExecutor = Object.assign((async () => { throw new Error("paced executor called directly"); }) as typeof fetch, {
    waitForPacing: async () => { throttlePacingWaits++; },
    unpacedFetch: (async () => {
      sends++;
      return sends === 1 ? new Response("USER_REQUEST_RATE_EXCEEDED", { status: 429, headers: { "Retry-After": "0" } }) : new Response("ok");
    }) as typeof fetch,
  });
  expect((await fetchKiroWithRetry(request, { executor: throttleExecutor })).status).toBe(200);
  expect(sends).toBe(2);
  expect(throttlePacingWaits).toBe(2);
});

test("pacing refusal consumes no budget or physical ordinal", async () => {
  let reservations = 0;
  let sends = 0;
  const executor = Object.assign((async () => { sends++; return new Response("ok"); }) as typeof fetch, {
    waitForPacing: async () => { throw new Error("pacing refused"); },
  });
  const sendBudget = { reserveDispatch: () => { reservations++; throw new Error("unexpected reserve"); } } as never;
  const ordinals: number[] = [];
  await expect(fetchKiroWithRetry(request, {
    executor, sendBudget, onPhysicalSend: send => ordinals.push(send.ordinal),
  })).rejects.toThrow("pacing refused");
  expect({ reservations, sends, ordinals }).toEqual({ reservations: 0, sends: 0, ordinals: [] });
});

test("budget refusal prevents alternate dispatch", async () => {
  const urls: string[] = [];
  let reservations = 0;
  const executor = (async (input: RequestInfo | URL) => {
    urls.push(String(input)); return new Response("bad gateway", { status: 503 });
  }) as typeof fetch;
  const sendBudget = { reserveDispatch: () => {
    reservations++;
    return reservations === 1 ? { allowed: true, permit: { use: () => true } } : { allowed: false, reason: "total-exhausted" };
  } } as never;
  await expect(fetchKiroWithRetry(request, { executor, sendBudget })).rejects.toMatchObject({ name: "SendBudgetExhaustedError" });
  expect(urls).toEqual([request.url]);
});

test.each([502, 503, 504])("canonical HTTP %i rotates once and final failure is fixed text", async status => {
  const urls: string[] = [];
  const executor = (async (input: RequestInfo | URL) => { urls.push(String(input)); return new Response("opaque", { status }); }) as typeof fetch;
  const result = await fetchKiroWithRetry(request, { executor });
  expect(result.status).toBe(status);
  expect(urls).toEqual([request.url, "https://q.us-east-1.amazonaws.com/"]);
  expect(await result.text()).toBe(status === 504 ? "Kiro upstream gateway timeout" : "Kiro upstream service unavailable");
});

test("500, 521 and custom URLs do not rotate", async () => {
  for (const status of [500, 521]) {
    const urls: string[] = [];
    const executor = (async (input: RequestInfo | URL) => { urls.push(String(input)); return new Response("opaque", { status }); }) as typeof fetch;
    expect((await fetchKiroWithRetry(request, { executor })).status).toBe(status);
    expect(urls).toEqual([request.url]);
  }
  const urls: string[] = [];
  const custom = { ...request, url: "https://example.invalid/generate" };
  const executor = (async (input: RequestInfo | URL) => { urls.push(String(input)); return new Response("opaque", { status: 503 }); }) as typeof fetch;
  await fetchKiroWithRetry(custom, { executor });
  expect(urls).toEqual([custom.url]);
});

test("gateway response URL selects the region actually dispatched", async () => {
  const urls: string[] = [];
  const executor = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return urls.length === 1 ? responseWithUrl(503, "https://runtime.eu-west-1.kiro.dev/") : new Response("ok");
  }) as typeof fetch;
  expect((await fetchKiroWithRetry({ ...request }, { executor })).status).toBe(200);
  expect(urls).toEqual([request.url, "https://q.eu-west-1.amazonaws.com/"]);
});

test("empty response URL uses the request URL after dispatch override rebuild", async () => {
  const urls: string[] = [];
  const mutable = { ...request };
  const executor = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    if (urls.length === 1) {
      mutable.url = "https://runtime.eu-west-1.kiro.dev/";
      return new Response(null, { status: 503 });
    }
    return new Response("ok");
  }) as typeof fetch;
  expect((await fetchKiroWithRetry(mutable, { executor })).status).toBe(200);
  expect(urls).toEqual([request.url, "https://q.eu-west-1.amazonaws.com/"]);
});

test("noncanonical dispatched response URL blocks gateway rotation", async () => {
  const urls: string[] = [];
  const executor = (async (input: RequestInfo | URL) => { urls.push(String(input)); return responseWithUrl(503, "https://custom.invalid/"); }) as typeof fetch;
  expect((await fetchKiroWithRetry(request, { executor })).status).toBe(503);
  expect(urls).toEqual([request.url]);
});

test("account switch before alternate sends rebuilt account headers and body", async () => {
  const urls: string[] = [];
  const bodies: string[] = [];
  const bearers: string[] = [];
  const mutable = { ...request };
  const executor = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (urls.length === 0) {
      mutable.url = "https://runtime.eu-west-1.kiro.dev/";
      mutable.headers = { authorization: "Bearer new" };
      mutable.body = "new-body";
    }
    urls.push(String(input));
    bodies.push(String(init?.body));
    bearers.push(new Headers(init?.headers).get("authorization") ?? "");
    return urls.length === 1 ? new Response(null, { status: 503 }) : new Response("ok");
  }) as typeof fetch;
  await fetchKiroWithRetry(mutable, { executor });
  expect(urls).toEqual([request.url, "https://q.eu-west-1.amazonaws.com/"]);
  expect(bodies).toEqual(["old-body", "new-body"]);
  expect(bearers).toEqual(["Bearer old", "Bearer new"]);
});

test("header deadline becomes 504 without rotating; caller abort preserves its reason", async () => {
  const urls: string[] = [];
  const executor = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(new TypeError("transport abort wrapper"));
      else signal?.addEventListener("abort", () => reject(new TypeError("transport abort wrapper")), { once: true });
    });
  }) as typeof fetch;
  const timed = await fetchKiroWithRetry(request, { executor, timeoutMs: 1 });
  expect(timed.status).toBe(504);
  expect(await timed.text()).toBe("Kiro upstream gateway timeout");
  expect(urls).toEqual([request.url]);
  const caller = new AbortController();
  const reason = new DOMException("caller closed", "AbortError");
  caller.abort(reason);
  await expect(fetchKiroWithRetry(request, { executor, abortSignal: caller.signal })).rejects.toBe(reason);
  expect(urls).toEqual([request.url]);

  const inFlight = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const pending = fetchKiroWithRetry(request, { executor: (async (input, init) => { markStarted(); return executor(input, init); }) as typeof fetch,
    abortSignal: inFlight.signal, timeoutMs: 5_000 });
  await started;
  inFlight.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(urls).toEqual([request.url, request.url]);
});

test("public 5xx formatter and diagnostics omit upstream body details", () => {
  const raw = JSON.stringify({ message: "private upstream incident marker" });
  for (const status of [500, 502, 503, 504, 521]) {
    expect(safeKiroHttpErrorMessage(status, new Headers(), raw)).toBe(
      status === 504 ? "Kiro upstream gateway timeout" : "Kiro upstream service unavailable",
    );
  }
});

test("completion fallback after visible progress keeps executor, does not rotate, and masks 503", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async () => { throw new Error("global fetch bypassed provider egress"); }) as typeof fetch;
  const executor = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return urls.length === 1 ? incompleteStream() : new Response(JSON.stringify({ message: "private fallback incident marker" }), { status: 503 });
  }) as typeof fetch;
  const { events, built } = await runCompletionFallback(executor);
  expect(urls).toEqual([built.url, built.url]);
  expect(events.at(-1)).toMatchObject({ type: "error", status: 503, message: "Kiro upstream service unavailable" });
  expect(JSON.stringify(events)).not.toContain("private fallback incident marker");
  expect(events.some(event => event.type === "done")).toBe(false);
});

test("dispatch override on completion fallback sends the rebuilt initial request", async () => {
  const offeredBodies: string[] = [];
  const physicalBodies: string[] = [];
  const bearers: string[] = [];
  const urls: string[] = [];
  let initial!: AdapterRequest;
  const executor = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    const switched = urls.length > 1;
    offeredBodies.push(String(init?.body));
    // Mirrors the server dispatch override: selection changed after the fallback was built,
    // so the physical send takes the new account's rebuilt initial request.
    const sentBody = switched ? initial.body : String(init?.body);
    const sentHeaders = switched ? new Headers({ authorization: "Bearer new-token" }) : new Headers(init?.headers);
    physicalBodies.push(sentBody);
    bearers.push(sentHeaders.get("authorization") ?? "");
    return switched ? new Response(JSON.stringify({ message: "private fallback incident marker" }), { status: 503 }) : incompleteStream();
  }) as typeof fetch;
  const { events, built } = await runCompletionFallback(executor, undefined, request => { initial = request; });
  expect(urls).toEqual([built.url, built.url]);
  expect(offeredBodies[1]).not.toBe(initial.body);
  expect(physicalBodies).toEqual([initial.body, initial.body]);
  expect(bearers).toEqual(["Bearer fixture-token", "Bearer new-token"]);
  expect(JSON.stringify(events)).not.toContain("private fallback incident marker");
  expect(JSON.stringify(events).split("I am checking.").length - 1).toBeLessThanOrEqual(1);
});

test("upstream 5xx marker reaches neither client nor debug ring or stderr", async () => {
  const marker = "opaque-upstream-secret-marker-020";
  const priorDebug = getDebugSettings().runtimeOverride.debug;
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  resetDebugLogBufferForTests();
  setDebugSettings({ debug: true });
  try {
    const direct = await fetchKiroWithRetry({ ...request, url: "https://example.invalid/generate" }, {
      executor: (async () => new Response(JSON.stringify({ message: marker }), { status: 521 })) as typeof fetch,
    });
    expect(await direct.text()).toBe("Kiro upstream service unavailable");
    let sends = 0;
    const events = (await runCompletionFallback((async () => {
      sends++;
      return sends === 1 ? incompleteStream() : new Response(JSON.stringify({ message: marker }), { status: 503 });
    }) as typeof fetch)).events;
    expect(JSON.stringify(events)).not.toContain(marker);
    const debugText = getDebugLogEntries().map(entry => entry.line).join("\n");
    const stderrText = stderr.mock.calls.map(args => args.join(" ")).join("\n");
    expect(debugText).not.toContain(marker);
    expect(stderrText).not.toContain(marker);
    expect(debugText).toContain("[ocx:kiro:http_error]");
  } finally {
    stderr.mockRestore();
    if (priorDebug === undefined) clearDebugSetting("debug"); else setDebugSettings({ debug: priorDebug });
    resetDebugLogBufferForTests();
  }
});
