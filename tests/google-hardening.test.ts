import { describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../src/adapters/google";
import { getDebugLogEntries, resetDebugLogBufferForTests } from "../src/lib/debug-log-buffer";
import { resetDebugSettingsForTests, setDebugSettings } from "../src/lib/debug-settings";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";

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

  test("Antigravity rejects flat Gemini payloads without the response wrapper", async () => {
    const adapter = createGoogleAdapter(antigravityProvider());
    const flatPayload = { candidates: [{ content: { parts: [{ text: "unexpected" }] } }] };

    const streamEvents = await collect(adapter.parseStream(sseResponse([flatPayload])));
    const responseEvents = await adapter.parseResponse!(
      new Response(JSON.stringify(flatPayload), { status: 200 }),
    );

    const expected = [{
      type: "error",
      message: "google-antigravity response missing response wrapper",
    }];
    expect(streamEvents).toEqual(expected);
    expect(responseEvents).toEqual(expected);
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
    expect(JSON.parse(antigravity.body).request.generationConfig).toBeUndefined();
  });

  test("publishes audited AI Studio metadata while Vertex stays frozen", () => {
    const google = PROVIDER_REGISTRY.find(entry => entry.id === "google");
    const vertex = PROVIDER_REGISTRY.find(entry => entry.id === "google-vertex");

    expect(google?.defaultModel).toBe("gemini-3.5-flash");
    expect(google?.models).toEqual(["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"]);
    expect(google?.modelContextWindows?.["gemini-3.6-flash"]).toBe(1_048_576);
    expect(google?.modelContextWindows?.["gemini-3.5-flash"]).toBe(1_000_000);
    expect(google?.modelContextWindows?.["gemini-3.1-pro-preview"]).toBeUndefined();
    expect(google?.modelInputModalities?.["gemini-3.6-flash"]).toEqual(["text", "image"]);
    expect(google?.modelReasoningEfforts?.["gemini-3.6-flash"]).toEqual([
      "minimal", "low", "medium", "high",
    ]);
    expect(google?.modelReasoningEfforts?.["gemini-3.5-flash"]).toEqual([
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
