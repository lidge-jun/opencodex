import { describe, expect, test } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../src/adapters/google";
import { getDebugLogEntries, resetDebugLogBufferForTests } from "../src/lib/debug-log-buffer";
import { resetDebugSettingsForTests, setDebugSettings } from "../src/lib/debug-settings";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import {
  CCA_STREAM_CLASSIFY_MAX_BYTES,
  CCA_STREAM_PROBE_MAX_BYTES,
  CcaProbeBuffer,
  fetchAntigravityWithRetry,
} from "../src/adapters/google-http";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

function parsed(stream = false): OcxParsedRequest {
  return {
    modelId: "gemini-3.5-flash",
    context: { messages: [{ role: "user", content: "hi" }] },
    stream,
    options: {},
  } as OcxParsedRequest;
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "google",
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "google-test-key",
    authMode: "key",
    ...overrides,
  };
}

function antigravityProvider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return provider({
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    apiKey: "antigravity-test-token",
    authMode: "oauth",
    googleMode: "cloud-code-assist",
    project: "project-test",
    ...overrides,
  });
}

function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n`).join("\n") + "\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function byteStreamResponse(chunks: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(events: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const collected: AdapterEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("google provider hardening", () => {
  test("AI Studio rejects a blank API key", async () => {
    const adapter = createGoogleAdapter(provider({ apiKey: "   " }));

    await expect(adapter.buildRequest(parsed())).rejects.toThrow(
      "google (AI Studio) requires a non-empty API key",
    );
  });

  test("Antigravity rejects a blank OAuth token", async () => {
    const adapter = createGoogleAdapter(antigravityProvider({ apiKey: "   " }));

    await expect(adapter.buildRequest(parsed())).rejects.toThrow(
      "google-antigravity oauth token missing — run ocx login google-antigravity",
    );
  });

  test("Antigravity rejects a blank baseUrl instead of substituting a default", async () => {
    const adapter = createGoogleAdapter(antigravityProvider({ baseUrl: "   " }));

    await expect(adapter.buildRequest(parsed())).rejects.toThrow(
      "google-antigravity requires a non-empty baseUrl",
    );
  });

  test("Antigravity rejects a cleartext http baseUrl before dispatch", async () => {
    const adapter = createGoogleAdapter(antigravityProvider({
      baseUrl: "http://daily-cloudcode-pa.googleapis.com",
    }));

    await expect(adapter.buildRequest(parsed())).rejects.toThrow(
      "google-antigravity requires an HTTPS baseUrl",
    );
  });

  test("CCA unary requests use the always-SSE endpoint", async () => {
    const request = await createGoogleAdapter(antigravityProvider()).buildRequest(parsed(false));
    expect(request.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  });

  test("AI Studio and Vertex unary requests retain generateContent", async () => {
    const aiStudio = await createGoogleAdapter(provider()).buildRequest(parsed(false));
    const vertex = await createGoogleAdapter(provider({
      baseUrl: "https://aiplatform.googleapis.com",
      googleMode: "vertex",
      apiKey: "vertex-test-key",
    })).buildRequest(parsed(false));
    expect(aiStudio.url).toContain(":generateContent");
    expect(aiStudio.url).not.toContain(":streamGenerateContent");
    expect(vertex.url).toContain(":generateContent");
    expect(vertex.url).not.toContain(":streamGenerateContent");
  });

  test("CCA empty first-host stream fails over to the production host", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      if (calls.length === 1) return sseResponse([{ response: { candidates: [] } }]);
      return sseResponse([
        { response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } },
        { response: { candidates: [{ finishReason: "STOP" }] } },
      ]);
    }) as typeof fetch;
    try {
      const adapter = createGoogleAdapter(antigravityProvider());
      const request = await adapter.buildRequest(parsed(false));
      const response = await adapter.fetchResponse!(request, { timeoutMs: 5_000, stream: false });
      const events = await adapter.parseResponse!(response);
      expect(calls).toEqual([
        "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      ]);
      expect(events).toContainEqual({ type: "text_delta", text: "ok" });
      expect(events.at(-1)?.type).toBe("done");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("CCA auth failure does not fail over to the second host", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ error: { status: "UNAUTHENTICATED", message: "bad token" } }), { status: 401 });
    }) as typeof fetch;
    try {
      const adapter = createGoogleAdapter(antigravityProvider());
      const request = await adapter.buildRequest(parsed(false));
      const response = await adapter.fetchResponse!(request, { timeoutMs: 5_000, stream: false });
      expect(response.status).toBe(401);
      expect(calls).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("CCA EOF terminal error does not fail over to the second host", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(
        'data: {"error":{"status":"UNAUTHENTICATED","message":"bad token"}}',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;
    try {
      const adapter = createGoogleAdapter(antigravityProvider());
      const request = await adapter.buildRequest(parsed(false));
      const response = await adapter.fetchResponse!(request, { timeoutMs: 5_000, stream: false });

      expect(response.status).toBe(200);
      expect(calls).toEqual([
        "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      ]);
      expect(await response.text()).toContain("UNAUTHENTICATED");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("CCA valid oversized SSE output stays on the first host", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    const largeText = "x".repeat(300 * 1024);
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return sseResponse([
        { response: { candidates: [{ content: { parts: [{ text: largeText }] } }] } },
        { response: { candidates: [{ finishReason: "STOP" }] } },
      ]);
    }) as typeof fetch;
    try {
      const adapter = createGoogleAdapter(antigravityProvider());
      const request = await adapter.buildRequest(parsed(false));
      const response = await adapter.fetchResponse!(request, { timeoutMs: 5_000, stream: false });
      const events = await adapter.parseResponse!(response);
      expect(calls).toHaveLength(1);
      expect(events).toContainEqual({ type: "text_delta", text: largeText });
      expect(events.at(-1)?.type).toBe("done");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("CCA probe buffer refuses bytes beyond its hard cap", () => {
    const cap = 16;
    const buffer = new CcaProbeBuffer(cap);
    expect(CCA_STREAM_PROBE_MAX_BYTES).toBe(100 * 1024 * 1024);
    expect(buffer.append(new Uint8Array(cap))).toBe(true);
    expect(buffer.append(new Uint8Array(1))).toBe(false);
    expect(buffer.length).toBe(cap);
  });

  test("CCA open empty SSE stream passes through at the classify cap without buffering 100 MiB", async () => {
    expect(CCA_STREAM_CLASSIFY_MAX_BYTES).toBe(256 * 1024);
    const encoder = new TextEncoder();
    const emptyFrame = encoder.encode("data:\n\n");
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let enqueuedBytes = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController;
        },
        pull(streamController) {
          // Keep the stream open so this is not the EOF-empty failover path, but stop
          // enqueueing well below the 100 MiB hard cap so the test itself never allocates it.
          if (enqueuedBytes >= CCA_STREAM_CLASSIFY_MAX_BYTES * 2) return;
          streamController.enqueue(emptyFrame);
          enqueuedBytes += emptyFrame.byteLength;
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const abortController = new AbortController();
    try {
      const request = {
        url: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        method: "POST",
        headers: {},
        body: "{}",
      };
      const response = await Promise.race([
        fetchAntigravityWithRetry(request, {
          timeoutMs: 5_000,
          abortSignal: abortController.signal,
          stream: true,
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("CCA classification hung past the classify cap")), 2_000);
        }),
      ]);
      expect(response.status).toBe(200);
      expect(calls).toEqual([
        "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      ]);
      expect(enqueuedBytes).toBeGreaterThanOrEqual(CCA_STREAM_CLASSIFY_MAX_BYTES);
      expect(enqueuedBytes).toBeLessThan(CCA_STREAM_PROBE_MAX_BYTES);
      await response.body?.cancel();
    } finally {
      abortController.abort();
      try { controller?.close(); } catch { /* already closed */ }
      globalThis.fetch = realFetch;
    }
  });

  test("CCA peer failures use retry and final error normalization", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      if (calls.length === 1) {
        return sseResponse([{ error: { status: "UNAVAILABLE", message: "try another host" } }]);
      }
      return new Response(
        JSON.stringify({ error: { status: "UNAVAILABLE", message: "peer overloaded" } }),
        { status: 503, headers: { "retry-after": "0" } },
      );
    }) as typeof fetch;
    try {
      const adapter = createGoogleAdapter(antigravityProvider());
      const request = await adapter.buildRequest(parsed(false));
      const response = await adapter.fetchResponse!(request, { timeoutMs: 5_000, stream: false });

      expect(response.status).toBe(503);
      expect(await response.text()).toBe("Antigravity server overloaded: peer overloaded");
      expect(calls).toEqual([
        "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("CCA returns the first event before an open upstream stream ends", async () => {
    const realFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        streamController.enqueue(encoder.encode(
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"first"}]}}]}}\n\n',
        ));
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const abortController = new AbortController();
    try {
      const adapter = createGoogleAdapter(antigravityProvider());
      const request = await adapter.buildRequest(parsed(true));
      const responsePromise = adapter.fetchResponse!(request, {
        timeoutMs: 5_000,
        abortSignal: abortController.signal,
        stream: true,
      });
      const returnedBeforeEof = await Promise.race([
        responsePromise.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
      ]);
      expect(returnedBeforeEof).toBe(true);
      const response = await responsePromise;
      await response.body?.cancel();
    } finally {
      abortController.abort();
      controller?.error(new Error("test stream closed"));
      globalThis.fetch = realFetch;
    }
  });

  test("CCA inline UNAVAILABLE fails over to the production host", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      if (calls.length === 1) {
        return sseResponse([{ error: { status: "UNAVAILABLE", message: "try another host" } }]);
      }
      return sseResponse([
        { response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } },
        { response: { candidates: [{ finishReason: "STOP" }] } },
      ]);
    }) as typeof fetch;
    try {
      const adapter = createGoogleAdapter(antigravityProvider());
      const request = await adapter.buildRequest(parsed(false));
      const response = await adapter.fetchResponse!(request, { timeoutMs: 5_000, stream: false });
      const events = await adapter.parseResponse!(response);
      expect(calls).toEqual([
        "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      ]);
      expect(events).toContainEqual({ type: "text_delta", text: "ok" });
      expect(events.at(-1)?.type).toBe("done");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("CCA does not POST the OAuth bearer to an http host", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return sseResponse([
        { response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } },
        { response: { candidates: [{ finishReason: "STOP" }] } },
      ]);
    }) as typeof fetch;
    try {
      const request = {
        url: "http://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        method: "POST",
        headers: { Authorization: "Bearer secret-token" },
        body: "{}",
      };
      const response = await fetchAntigravityWithRetry(request, { timeoutMs: 5_000 });
      expect(response.ok).toBe(true);
      expect(calls.filter(url => url.startsWith("http://"))).toEqual([]);
      expect(calls[0]).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("CCA geoblock maps to 403 without account carousel", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({
        error: { status: "PERMISSION_DENIED", message: "user location is not supported for the api use" },
      }), { status: 403 });
    }) as typeof fetch;
    try {
      const request = {
        url: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        method: "POST",
        headers: {},
        body: "{}",
      };
      const response = await fetchAntigravityWithRetry(request, {
        timeoutMs: 5_000,
      });
      expect(response.status).toBe(403);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("CCA inline quota error becomes a 429 without host failover", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return sseResponse([{
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "Quota exceeded for this account",
        },
      }]);
    }) as typeof fetch;
    try {
      const request = {
        url: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        method: "POST",
        headers: {},
        body: "{}",
      };
      const response = await fetchAntigravityWithRetry(request, {
        timeoutMs: 5_000,
      });
      expect(response.status).toBe(429);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("CCA peer HTTP 200 RESOURCE_EXHAUSTED after first-host 404 becomes a 429", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      if (String(input).includes("daily-cloudcode-pa.googleapis.com")) {
        return new Response("not found", { status: 404 });
      }
      return sseResponse([{
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "Quota exceeded for this account",
        },
      }]);
    }) as typeof fetch;
    try {
      const request = {
        url: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        method: "POST",
        headers: {},
        body: "{}",
      };
      const response = await fetchAntigravityWithRetry(request, {
        timeoutMs: 5_000,
      });
      expect(response.status).toBe(429);
      expect(calls).toEqual([
        "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("CCA peer HTTP 200 geoblock after first-host 503 remains 403 without a third host", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      if (String(input).includes("daily-cloudcode-pa.googleapis.com")) {
        return new Response("unavailable", { status: 503 });
      }
      return sseResponse([{
        error: {
          status: "PERMISSION_DENIED",
          message: "user location is not supported for the api use",
        },
      }]);
    }) as typeof fetch;
    try {
      const request = {
        url: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        method: "POST",
        headers: {},
        body: "{}",
      };
      const response = await fetchAntigravityWithRetry(request, {
        timeoutMs: 5_000,
      });
      expect(response.status).toBe(403);
      expect(calls).toEqual([
        "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("Antigravity rejects flat Gemini payloads without the response wrapper", async () => {
    const adapter = createGoogleAdapter(antigravityProvider());
    const flatPayload = { candidates: [{ content: { parts: [{ text: "unexpected" }] } }] };

    // SSE-framed flat payload: parseStream unwraps each data frame and rejects missing `response`.
    const streamEvents = await collect(adapter.parseStream(sseResponse([flatPayload])));
    expect(streamEvents).toEqual([{
      type: "error",
      message: "google-antigravity response missing response wrapper",
    }]);

    // Plain JSON without SSE framing: CCA parseResponse delegates to parseStream, which reads until
    // EOF without finding a `data:` frame and fails closed as truncated SSE transport.
    const responseEvents = await adapter.parseResponse!(
      sseResponse([flatPayload]),
    );
    expect(responseEvents).toEqual([{
      type: "error",
      message: "upstream stream ended with an incomplete SSE frame — possible truncation",
    }]);
  });

  test("truncated final JSON is a terminal stream error", async () => {
    const events = await collect(createGoogleAdapter(provider()).parseStream(
      new Response('data: {"candidates":[{"finishReason":"STOP"}', {
        headers: { "content-type": "text/event-stream" },
      }),
    ));

    expect(events.at(-1)).toEqual({
      type: "error",
      message: "malformed upstream SSE data frame",
    });
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  test("a malformed nested candidate is a terminal stream error", async () => {
    const events = await collect(createGoogleAdapter(provider()).parseStream(
      sseResponse([{ candidates: [null] }, { candidates: [{ finishReason: "STOP" }] }]),
    ));

    expect(events).toEqual([{
      type: "error",
      message: "google response contained invalid candidates (candidate_not_object; valueType=null)",
    }]);
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  // `content.parts` sits one rung below the candidate guard above. It is claimed model output
  // inside a well-formed frame, so it follows the same fail-closed rule rather than #1240's
  // root-frame padding rule. Before this, each of these escaped as a raw TypeError.
  const invalidPartsCases: [string, unknown, string][] = [
    ["an object container", {}, "google response contained invalid content parts (parts_not_array; valueType=object)"],
    ["a number container", 5, "google response contained invalid content parts (parts_not_array; valueType=number)"],
    ["a string container", "txt", "google response contained invalid content parts (parts_not_array; valueType=string)"],
    ["a null element", [null], "google response contained invalid content parts (part_not_object; partIndex=0; valueType=null)"],
    ["a number element", [5], "google response contained invalid content parts (part_not_object; partIndex=0; valueType=number)"],
    ["an array element", [[]], "google response contained invalid content parts (part_not_object; partIndex=0; valueType=array)"],
    ["a bad element after a good one", [{ text: "hi" }, null], "google response contained invalid content parts (part_not_object; partIndex=1; valueType=null)"],
  ];

  for (const [label, parts, message] of invalidPartsCases) {
    test(`${label} in content.parts is a terminal stream error`, async () => {
      const events = await collect(createGoogleAdapter(provider()).parseStream(
        sseResponse([
          { candidates: [{ content: { parts } }] },
          { candidates: [{ finishReason: "STOP" }] },
        ]),
      ));

      expect(events).toEqual([{ type: "error", message }]);
      expect(events.some(event => event.type === "done")).toBe(false);
    });

    test(`${label} in content.parts is a terminal non-streaming error`, async () => {
      const events = await createGoogleAdapter(provider()).parseResponse!(
        new Response(JSON.stringify({ candidates: [{ content: { parts }, finishReason: "STOP" }] }), { status: 200 }),
      );

      expect(events).toEqual([{ type: "error", message }]);
      expect(events.some(event => event.type === "done")).toBe(false);
    });
  }

  // A Google functionCall is delivered atomically in one part, so there is no later delta that
  // can repair a missing name. Passing one through violates AdapterEvent's string-name contract
  // and lets the bridge attempt to dispatch a call that cannot be identified. Keep streaming and
  // buffered parsing fail-closed on the same field shapes (#2233).
  const invalidFunctionCallCases: [string, unknown, string][] = [
    ["a string call", "x", "google response contained invalid function call (function_call_not_object; partIndex=0; valueType=string) — cannot dispatch"],
    ["a numeric call", 5, "google response contained invalid function call (function_call_not_object; partIndex=0; valueType=number) — cannot dispatch"],
    ["an array call", [], "google response contained invalid function call (function_call_not_object; partIndex=0; valueType=array) — cannot dispatch"],
    ["a call without a name", { args: {} }, "google response contained invalid function call name (function_call_name_invalid; partIndex=0; valueType=undefined) — cannot dispatch"],
    ["a call with a numeric name", { name: 5, args: {} }, "google response contained invalid function call name (function_call_name_invalid; partIndex=0; valueType=number) — cannot dispatch"],
    ["a call with an empty name", { name: "", args: {} }, "google response contained blank function call name (function_call_name_blank; partIndex=0; valueType=string) — cannot dispatch"],
    ["a call with a whitespace name", { name: "   ", args: {} }, "google response contained blank function call name (function_call_name_blank; partIndex=0; valueType=string) — cannot dispatch"],
  ];

  for (const [label, functionCall, message] of invalidFunctionCallCases) {
    test(`${label} is a terminal stream error`, async () => {
      const events = await collect(createGoogleAdapter(provider()).parseStream(
        sseResponse([{
          candidates: [{ content: { parts: [{ functionCall }] }, finishReason: "STOP" }],
        }]),
      ));

      expect(events).toEqual([{ type: "error", message }]);
      expect(events.some(event => event.type === "done")).toBe(false);
    });

    test(`${label} is a terminal non-streaming error`, async () => {
      const events = await createGoogleAdapter(provider()).parseResponse!(
        new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall }] }, finishReason: "STOP" }],
        }), { status: 200 }),
      );

      expect(events).toEqual([{ type: "error", message }]);
      expect(events.some(event => event.type === "done")).toBe(false);
    });
  }

  // Text is optional, but when present it must already be a string. Coercing an object or number
  // would invent assistant output, while terminating an otherwise valid turn would be harsher than
  // the field warrants. Drop only the malformed text field and keep other parts/terminal state.
  const nonStringTextParts: [string, Record<string, unknown>][] = [
    ["numeric text", { text: 5 }],
    ["object text", { text: { a: 1 } }],
    ["array text", { text: [1, 2] }],
    ["numeric thought text", { text: 5, thought: true }],
  ];

  for (const [label, part] of nonStringTextParts) {
    test(`${label} is dropped on both response paths`, async () => {
      const payload = {
        candidates: [{ content: { parts: [part] }, finishReason: "STOP" }],
      };
      const streamEvents = await collect(createGoogleAdapter(provider()).parseStream(sseResponse([payload])));
      const responseEvents = await createGoogleAdapter(provider()).parseResponse!(
        new Response(JSON.stringify(payload), { status: 200 }),
      );

      for (const events of [streamEvents, responseEvents]) {
        expect(events.some(event => event.type === "text_delta")).toBe(false);
        expect(events.some(event => event.type === "reasoning_raw_delta")).toBe(false);
        expect(events.some(event => event.type === "error")).toBe(false);
        expect(events.at(-1)?.type).toBe("done");
      }
    });
  }

  // `content` itself has the same status as `parts`: claimed output the parser cannot read. The
  // one tolerated non-record form is an empty array, which is how a JSON writer with no distinct
  // empty-object form spells an empty `content`. A NON-empty array is where the payload used to
  // disappear: `content?.parts` reads `undefined` from it, so the candidate completed empty.
  const invalidContentCases: [string, unknown, string][] = [
    ["a number", 5, "google response contained invalid content (content_not_object; valueType=number)"],
    ["a string", "txt", "google response contained invalid content (content_not_object; valueType=string)"],
    ["a boolean", true, "google response contained invalid content (content_not_object; valueType=boolean)"],
    ["a non-empty array holding the payload", [{ parts: [{ text: "lost" }] }], "google response contained invalid content (content_not_object; valueType=array)"],
  ];

  for (const [label, content, message] of invalidContentCases) {
    test(`${label} as candidate content is a terminal stream error`, async () => {
      const events = await collect(createGoogleAdapter(provider()).parseStream(
        sseResponse([
          { candidates: [{ content }] },
          { candidates: [{ finishReason: "STOP" }] },
        ]),
      ));

      expect(events).toEqual([{ type: "error", message }]);
      expect(events.some(event => event.type === "done")).toBe(false);
    });

    test(`${label} as candidate content is a terminal non-streaming error`, async () => {
      const events = await createGoogleAdapter(provider()).parseResponse!(
        new Response(JSON.stringify({ candidates: [{ content, finishReason: "STOP" }] }), { status: 200 }),
      );

      expect(events).toEqual([{ type: "error", message }]);
      expect(events.some(event => event.type === "done")).toBe(false);
    });
  }

  test("a null candidates container mid-stream is absence, not corruption", async () => {
    // The #1219 shape one rung in: before this, the frame between the content delta and the
    // finish chunk terminated a turn whose answer had already fully arrived.
    const events = await collect(createGoogleAdapter(provider()).parseStream(
      sseResponse([
        { candidates: [{ content: { parts: [{ text: "PONG" }] } }] },
        { candidates: null },
        { candidates: [{ finishReason: "STOP" }] },
      ]),
    ));

    expect(events).toContainEqual({ type: "text_delta", text: "PONG" });
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some(event => event.type === "error")).toBe(false);
  });

  test("a stream of nothing but null candidates still fails closed", async () => {
    // Absence is not a terminal signal, so the truncation guard still owns this stream: skipping
    // the frames must not turn a stream that never finished into a successful empty turn.
    const events = await collect(createGoogleAdapter(provider()).parseStream(
      sseResponse([{ candidates: null }, { candidates: null }]),
    ));

    expect(events.at(-1)).toEqual({
      type: "error",
      message: "upstream stream ended without a terminal signal — possible truncation",
    });
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  test("a malformed nested candidate is a terminal non-streaming error too", async () => {
    // The streaming parser has rejected these since #1332; the buffered parser returned a bare
    // `done`, reporting a claimed-but-malformed candidate to the caller as a successful empty turn.
    for (const [candidates, valueType] of [[[null], "null"], [[5], "number"], [["x"], "string"], [[[]], "array"]] as const) {
      const events = await createGoogleAdapter(provider()).parseResponse!(
        new Response(JSON.stringify({ candidates }), { status: 200 }),
      );

      expect(events).toEqual([{
        type: "error",
        message: `google response contained invalid candidates (candidate_not_object; valueType=${valueType})`,
      }]);
    }
  });

  test("a non-array candidates container is rejected rather than counted", async () => {
    // `"abc".length` is 3, so the emptiness check passed and `candidates[0]` was the character
    // `"a"`; `{}` and `5` were reported as an absent candidate list rather than a malformed one.
    for (const [candidates, valueType] of [["abc", "string"], [{}, "object"], [5, "number"], [true, "boolean"]] as const) {
      const streamEvents = await collect(createGoogleAdapter(provider()).parseStream(
        sseResponse([{ candidates }, { candidates: [{ finishReason: "STOP" }] }]),
      ));
      const responseEvents = await createGoogleAdapter(provider()).parseResponse!(
        new Response(JSON.stringify({ candidates }), { status: 200 }),
      );

      const expected = [{
        type: "error",
        message: `google response contained invalid candidates (candidates_not_array; valueType=${valueType})`,
      }];
      expect(streamEvents).toEqual(expected);
      expect(responseEvents).toEqual(expected);
    }
  });

  test("absent, null and empty containers stay legal on both paths", async () => {
    // Absence is not corruption: a finish-only chunk, an explicit `null`, and an empty array are
    // all ordinary shapes and must keep completing the turn.
    for (const candidate of [
      { finishReason: "STOP" },
      { content: null, finishReason: "STOP" },
      { content: [], finishReason: "STOP" },
      { content: {}, finishReason: "STOP" },
      { content: { parts: null }, finishReason: "STOP" },
      { content: { parts: [] }, finishReason: "STOP" },
    ]) {
      const streamEvents = await collect(createGoogleAdapter(provider()).parseStream(
        sseResponse([{ candidates: [candidate] }]),
      ));
      const responseEvents = await createGoogleAdapter(provider()).parseResponse!(
        new Response(JSON.stringify({ candidates: [candidate] }), { status: 200 }),
      );

      expect(streamEvents.some(event => event.type === "error")).toBe(false);
      expect(streamEvents.at(-1)?.type).toBe("done");
      expect(responseEvents).toEqual([{ type: "done", usage: undefined }]);
    }
  });

  test("an absent candidates list is still reported as absent, not malformed", async () => {
    for (const body of [{}, { candidates: null }, { candidates: [] }]) {
      const events = await createGoogleAdapter(provider()).parseResponse!(
        new Response(JSON.stringify(body), { status: 200 }),
      );

      expect(events).toEqual([{ type: "error", message: "google response contained no candidates" }]);
    }
  });

  test("well-formed parts still stream and buffer unchanged", async () => {
    const payload = {
      candidates: [{
        content: { parts: [{ text: "visible" }, { functionCall: { name: "lookup", args: { q: 1 } } }] },
        finishReason: "STOP",
      }],
    };

    const streamEvents = await collect(createGoogleAdapter(provider()).parseStream(sseResponse([payload])));
    const responseEvents = await createGoogleAdapter(provider()).parseResponse!(
      new Response(JSON.stringify(payload), { status: 200 }),
    );

    for (const events of [streamEvents, responseEvents]) {
      expect(events).toContainEqual({ type: "text_delta", text: "visible" });
      expect(events.some(event => event.type === "tool_call_start" && event.name === "lookup")).toBe(true);
      expect(events).toContainEqual({ type: "tool_call_delta", arguments: JSON.stringify({ q: 1 }) });
      expect(events.at(-1)?.type).toBe("done");
      expect(events.some(event => event.type === "error")).toBe(false);
    }
  });

  test("EOF residual data frame without a trailing newline is parsed", async () => {
    const events = await collect(createGoogleAdapter(provider()).parseStream(
      new Response('data:{"candidates":[{"content":{"parts":[{"text":"final"}]},"finishReason":"STOP"}]}', {
        headers: { "content-type": "text/event-stream" },
      }),
    ));

    expect(events).toContainEqual({ type: "text_delta", text: "final" });
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some(event => event.type === "error")).toBe(false);
  });

  test("comment and blank keepalives emit at most one heartbeat per read batch", async () => {
    const encoder = new TextEncoder();
    const events = await collect(createGoogleAdapter(provider()).parseStream(
      byteStreamResponse([
        encoder.encode(": keepalive\n\n"),
        encoder.encode("\n"),
      ]),
    ));

    expect(events.filter(event => event.type === "heartbeat")).toEqual([
      { type: "heartbeat" },
      { type: "heartbeat" },
    ]);
  });

  test("keepalives do not add a heartbeat to a batch that emitted content", async () => {
    const events = await collect(createGoogleAdapter(provider()).parseStream(
      new Response([
        ": keepalive",
        'data: {"candidates":[{"content":{"parts":[{"text":"final"}]},"finishReason":"STOP"}]}',
        "",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } }),
    ));

    expect(events.filter(event => event.type === "heartbeat")).toEqual([]);
    expect(events).toContainEqual({ type: "text_delta", text: "final" });
  });

  test("garbage stays debug-dropped while comment keepalives are excluded", async () => {
    resetDebugLogBufferForTests();
    setDebugSettings({ debug: true });
    try {
      const events = await collect(createGoogleAdapter(provider()).parseStream(
        new Response([
          ": keepalive",
          "garbage",
          'data: {"candidates":[{"finishReason":"STOP"}]}',
          "",
          "",
        ].join("\n"), { headers: { "content-type": "text/event-stream" } }),
      ));

      expect(events).toContainEqual({ type: "heartbeat" });
      const dropped = getDebugLogEntries().filter(entry => entry.line.includes("[ocx:frame-drop] google"));
      expect(dropped).toHaveLength(1);
      expect(dropped[0]?.line).toContain("bytes=7");
    } finally {
      resetDebugSettingsForTests();
      resetDebugLogBufferForTests();
    }
  });

  test("EOF comment residual is liveness instead of a truncation error", async () => {
    const events = await collect(createGoogleAdapter(provider()).parseStream(
      new Response([
        'data: {"candidates":[{"content":{"parts":[{"text":"final"}]},"finishReason":"STOP"}]}',
        "",
        ": trailing keepalive",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } }),
    ));

    expect(events).toContainEqual({ type: "heartbeat" });
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some(event => event.type === "error")).toBe(false);
  });

  test("EOF after content without a terminal signal fails closed", async () => {
    const events = await collect(createGoogleAdapter(provider()).parseStream(
      new Response('data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
    ));

    expect(events.at(-1)).toEqual({
      type: "error",
      message: "upstream stream ended without a terminal signal — possible truncation",
    });
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  test("partial UTF-8 bytes after a valid STOP terminal fail closed", async () => {
    const encoder = new TextEncoder();
    const terminal = encoder.encode('data: {"candidates":[{"finishReason":"STOP"}]}\n\n');
    const events = await collect(createGoogleAdapter(provider()).parseStream(
      byteStreamResponse([terminal, new Uint8Array([0xe2, 0x82])]),
    ));

    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  test("non-frame garbage after a valid STOP terminal fails closed", async () => {
    const events = await collect(createGoogleAdapter(provider()).parseStream(
      new Response('data: {"candidates":[{"finishReason":"STOP"}]}\n\ngarbage', {
        headers: { "content-type": "text/event-stream" },
      }),
    ));

    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  test("non-streaming responses surface the upstream error message", async () => {
    const adapter = createGoogleAdapter(provider());
    const response = new Response(
      JSON.stringify({ error: { message: "RESOURCE_EXHAUSTED" } }),
      { status: 200 },
    );

    expect(await adapter.parseResponse!(response)).toEqual([
      { type: "error", message: "RESOURCE_EXHAUSTED" },
    ]);
  });

  test("non-streaming responses reject absent or empty candidates", async () => {
    const adapter = createGoogleAdapter(provider());

    for (const body of [{}, { candidates: [] }]) {
      const events = await adapter.parseResponse!(
        new Response(JSON.stringify(body), { status: 200 }),
      );
      expect(events).toEqual([
        { type: "error", message: "google response contained no candidates" },
      ]);
    }
  });

  test("non-streaming responses reject oversized Content-Length before buffering", async () => {
    const adapter = createGoogleAdapter(provider());
    const oversized = new Response("{}", {
      status: 200,
      headers: { "content-length": String(101 * 1024 * 1024) },
    });

    const events = await adapter.parseResponse!(oversized);

    expect(events).toEqual([{ type: "error", message: expect.stringContaining("google response too large") }]);
    expect(events[0].type).toBe("error");
  });

  test("non-streaming responses accept Content-Length under the cap", async () => {
    const adapter = createGoogleAdapter(provider());
    const body = { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] };
    const response = new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-length": String(JSON.stringify(body).length) },
    });

    const events = await adapter.parseResponse!(response);
    expect(events.some(e => e.type === "done")).toBe(true);
    expect(events.some(e => e.type === "error")).toBe(false);
  });

  test("thought text stays hidden reasoning in streaming and non-streaming responses", async () => {
    const body = {
      candidates: [{
        content: { parts: [{ thought: true, text: "private analysis" }] },
        finishReason: "STOP",
      }],
    };

    const streamEvents = await collect(createGoogleAdapter(provider()).parseStream(sseResponse([body])));
    const responseEvents = await createGoogleAdapter(provider()).parseResponse!(
      new Response(JSON.stringify(body), { status: 200 }),
    );

    for (const events of [streamEvents, responseEvents]) {
      expect(events).toContainEqual({ type: "reasoning_raw_delta", text: "private analysis" });
      expect(events).not.toContainEqual({ type: "text_delta", text: "private analysis" });
    }
  });

  test("thought text preserves ordering before function calls in both response modes", async () => {
    const body = {
      candidates: [{
        content: {
          parts: [
            { thought: true, text: "choose the tool" },
            { functionCall: { name: "lookup", args: { id: 7 } } },
          ],
        },
        finishReason: "STOP",
      }],
    };

    const streamEvents = await collect(createGoogleAdapter(provider()).parseStream(sseResponse([body])));
    const responseEvents = await createGoogleAdapter(provider()).parseResponse!(
      new Response(JSON.stringify(body), { status: 200 }),
    );

    for (const events of [streamEvents, responseEvents]) {
      expect(events.slice(0, 4)).toEqual([
        { type: "reasoning_raw_delta", text: "choose the tool" },
        { type: "tool_call_start", id: expect.stringMatching(/^call_/), name: "lookup" },
        { type: "tool_call_delta", arguments: '{"id":7}' },
        { type: "tool_call_end" },
      ]);
      expect(events).not.toContainEqual({ type: "text_delta", text: "choose the tool" });
    }
  });

  test("ordinary Google text remains visible in both response modes", async () => {
    const body = {
      candidates: [{ content: { parts: [{ text: "visible answer" }] }, finishReason: "STOP" }],
    };

    const streamEvents = await collect(createGoogleAdapter(provider()).parseStream(sseResponse([body])));
    const responseEvents = await createGoogleAdapter(provider()).parseResponse!(
      new Response(JSON.stringify(body), { status: 200 }),
    );

    for (const events of [streamEvents, responseEvents]) {
      expect(events).toContainEqual({ type: "text_delta", text: "visible answer" });
      expect(events).not.toContainEqual({ type: "reasoning_raw_delta", text: "visible answer" });
    }
  });

  // `emittedContentEvent` decides `"content"` vs `"continue"`, and its only consumer is the
  // synthetic-heartbeat suppression in the read loop. A thought delta is real upstream
  // activity, so it must count as content: emitting a heartbeat alongside it would claim the
  // stream was idle while the model was demonstrably working. Pinning that here keeps the
  // classification a decision rather than a side effect of routing thought text elsewhere.
  test("a thought-only frame counts as content, so no synthetic heartbeat is emitted", async () => {
    const thoughtOnly = {
      candidates: [{ content: { parts: [{ thought: true, text: "private analysis" }] } }],
    };
    const events = await collect(createGoogleAdapter(provider()).parseStream(sseResponse([thoughtOnly])));

    expect(events).toContainEqual({ type: "reasoning_raw_delta", text: "private analysis" });
    expect(events.some(e => e.type === "heartbeat")).toBe(false);
  });

  // The visible-text control for the assertion above: an ordinary text frame has always
  // suppressed the heartbeat, so a divergence here would mean thought parts are classified
  // differently from the text they replaced.
  test("a visible-text frame also suppresses the synthetic heartbeat", async () => {
    const textOnly = {
      candidates: [{ content: { parts: [{ text: "visible answer" }] } }],
    };
    const events = await collect(createGoogleAdapter(provider()).parseStream(sseResponse([textOnly])));

    expect(events).toContainEqual({ type: "text_delta", text: "visible answer" });
    expect(events.some(e => e.type === "heartbeat")).toBe(false);
  });
  test("sends Gemini Flash thinkingLevel only for direct AI Studio requests", async () => {
    const direct = createGoogleAdapter(provider({
      modelReasoningEfforts: {
        "gemini-3.5-flash": ["minimal", "low", "medium", "high"],
        "gemini-3.6-flash": ["minimal", "low", "medium", "high"],
      },
    }));
    const high = await direct.buildRequest({
      ...parsed(),
      modelId: "gemini-3.6-flash",
      options: { reasoning: "high" },
    });
    const unset = await direct.buildRequest({
      ...parsed(),
      modelId: "gemini-3.6-flash",
    });
    const legacy = await direct.buildRequest({
      ...parsed(),
      modelId: "gemini-3.5-flash",
      options: { reasoning: "medium" },
    });
    const antigravity = await createGoogleAdapter(antigravityProvider()).buildRequest({
      ...parsed(),
      modelId: "gemini-3.6-flash-high",
      options: { reasoning: "high" },
    });

    expect(JSON.parse(high.body).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "high" });
    expect(JSON.parse(unset.body).generationConfig).toBeUndefined();
    expect(JSON.parse(legacy.body).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "medium" });
    // Antigravity used to encode the tier in the wire id, so it sent no thinkingConfig.
    // Now that Google has retired the suffixed 3.6 ids, that tier has nowhere to live
    // except an explicit thinkingLevel on the current model.
    expect(JSON.parse(antigravity.body).model).toBe("gemini-3.7-flash-tiered");
    expect(JSON.parse(antigravity.body).request.generationConfig.thinkingConfig)
      .toEqual({ thinkingLevel: "high" });
  });

  test("provider-wide effort ladder drives thinkingLevel for a non-image model", async () => {
    const direct = createGoogleAdapter(provider({
      reasoningEfforts: ["low", "medium", "high"],
    }));
    const request = await direct.buildRequest({
      ...parsed(),
      modelId: "gemini-3.1-pro-preview",
      options: { reasoning: "high" },
    });

    expect(JSON.parse(request.body).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "high" });
  });

  test("effort ladder drives thinkingLevel beyond the flash slice", async () => {
    const direct = createGoogleAdapter(provider({
      modelReasoningEfforts: { "gemini-3.1-pro-preview": ["low", "medium", "high"] },
    }));
    const proHigh = await direct.buildRequest({
      ...parsed(),
      modelId: "gemini-3.1-pro-preview",
      options: { reasoning: "high" },
    });
    const proMinimal = await direct.buildRequest({
      ...parsed(),
      modelId: "gemini-3.1-pro-preview",
      options: { reasoning: "minimal" },
    });
    const proUnset = await direct.buildRequest({
      ...parsed(),
      modelId: "gemini-3.1-pro-preview",
    });
    const unladdered = await direct.buildRequest({
      ...parsed(),
      modelId: "gemini-3.5-flash-lite",
      options: { reasoning: "high" },
    });

    expect(JSON.parse(proHigh.body).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "high" });
    // minimal is not on the pro-preview ladder; the clamp lands on the nearest supported tier.
    expect(JSON.parse(proMinimal.body).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(JSON.parse(proUnset.body).generationConfig).toBeUndefined();
    expect(JSON.parse(unladdered.body).generationConfig).toBeUndefined();
  });

  test("Vertex sends thinkingLevel only when a ladder is explicitly configured", async () => {
    const frozen = createGoogleAdapter(provider({ googleMode: "vertex" }));
    const opted = createGoogleAdapter(provider({
      googleMode: "vertex",
      modelReasoningEfforts: { "gemini-3-pro": ["low", "medium", "high"] },
    }));
    const withoutLadder = await frozen.buildRequest({
      ...parsed(),
      modelId: "gemini-3.5-flash",
      options: { reasoning: "high" },
    });
    const withLadder = await opted.buildRequest({
      ...parsed(),
      modelId: "gemini-3-pro",
      options: { reasoning: "high" },
    });

    expect(JSON.parse(withoutLadder.body).generationConfig).toBeUndefined();
    expect(JSON.parse(withLadder.body).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "high" });
  });

  test("unladdered direct flash keeps its hardcoded thinking slice", async () => {
    const bare = createGoogleAdapter(provider());
    const flash = await bare.buildRequest({
      ...parsed(),
      modelId: "gemini-3.6-flash",
      options: { reasoning: "medium" },
    });

    expect(JSON.parse(flash.body).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "medium" });
  });

  test("image models keep responseModalities even with a provider-wide effort ladder", async () => {
    const direct = createGoogleAdapter(provider({ reasoningEfforts: ["low", "high"] }));
    const image = await direct.buildRequest({
      ...parsed(),
      modelId: "gemini-3.1-flash-image",
      options: { reasoning: "high" },
    });

    const generationConfig = JSON.parse(image.body).generationConfig;
    expect(generationConfig.thinkingConfig).toBeUndefined();
    expect(generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
  });

  test("publishes audited AI Studio metadata while Vertex stays frozen", () => {
    const google = PROVIDER_REGISTRY.find(entry => entry.id === "google");
    const vertex = PROVIDER_REGISTRY.find(entry => entry.id === "google-vertex");

    expect(google?.defaultModel).toBe("gemini-3.5-flash");
    expect(google?.models).toEqual(["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview", "gemini-3.7-flash"]);
    expect(google?.modelContextWindows?.["gemini-3.6-flash"]).toBe(1_048_576);
    expect(google?.modelContextWindows?.["gemini-3.5-flash"]).toBe(1_000_000);
    expect(google?.modelContextWindows?.["gemini-3.7-flash"]).toBe(1_048_576);
    expect(google?.modelContextWindows?.["gemini-3.1-pro-preview"]).toBeUndefined();
    expect(google?.modelInputModalities?.["gemini-3.6-flash"]).toEqual(["text", "image"]);
    expect(google?.modelInputModalities?.["gemini-3.7-flash"]).toEqual(["text", "image"]);
    expect(google?.modelReasoningEfforts?.["gemini-3.6-flash"]).toEqual([
      "minimal", "low", "medium", "high",
    ]);
    expect(google?.modelReasoningEfforts?.["gemini-3.5-flash"]).toEqual([
      "minimal", "low", "medium", "high",
    ]);
    expect(google?.modelReasoningEfforts?.["gemini-3.7-flash"]).toEqual([
      "minimal", "low", "medium", "high",
    ]);
    expect(google?.modelReasoningEfforts?.["gemini-3.1-pro-preview"]).toEqual([
      "low", "medium", "high",
    ]);
    expect(vertex?.defaultModel).toBe("gemini-3-pro");
  });

  test("registers gemini-3.5-flash-lite with its multimodal context metadata", () => {
    const google = PROVIDER_REGISTRY.find(entry => entry.id === "google");

    expect(google?.models).toContain("gemini-3.5-flash-lite");
    expect(google?.modelContextWindows?.["gemini-3.5-flash-lite"]).toBe(1_048_576);
    expect(google?.modelInputModalities?.["gemini-3.5-flash-lite"]).toEqual(["text", "image"]);
  });
});
