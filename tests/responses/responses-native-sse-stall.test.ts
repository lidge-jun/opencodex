import { afterEach, expect, spyOn, test } from "bun:test";
import { handleResponses } from "../../src/server/responses";
import { explicitStallTimeoutMs } from "../../src/stall-timeout";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

// #8206: native Responses SSE honors stallTimeoutSec only when the operator set it explicitly.
const originalFetch = globalThis.fetch;
let release: (() => void) | undefined;
afterEach(() => { globalThis.fetch = originalFetch; release?.(); release = undefined; });

const prelude = `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_fixture", object: "response", status: "in_progress", output: [] } })}\n\n`;
const completed = `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_fixture", object: "response", status: "completed", model: "probe",
  output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "FIXTURE_OK", annotations: [] }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`;

function nativeConfig(baseUrl: string, stallTimeoutSec?: number): OcxConfig {
  return {
    port: 0, defaultProvider: "fixture-native",
    ...(stallTimeoutSec === undefined ? {} : { stallTimeoutSec }),
    providers: { "fixture-native": {
      adapter: "openai-responses", authMode: "key", apiKey: "fixture-key", baseUrl,
      models: ["probe"], allowPrivateNetwork: true,
    } },
  } as unknown as OcxConfig;
}

test("explicit budget policy: unset and non-positive arm nothing, a positive value applies to every destination", () => {
  expect(explicitStallTimeoutMs(undefined)).toBe(0);
  expect(explicitStallTimeoutMs(0)).toBe(0);
  expect(explicitStallTimeoutMs(-3)).toBe(0);
  expect(explicitStallTimeoutMs(Number.NaN)).toBe(0);
  expect(explicitStallTimeoutMs(1)).toBe(1_000);
  expect(explicitStallTimeoutMs(2.2)).toBe(3_000);
});

test.each(["http://127.0.0.1:8000/v1", "https://gateway.example/v1"])(
  "explicit stallTimeoutSec cuts a silent native Responses SSE body (%s)", async baseUrl => {
    release = acquireOwnedSpendHome();
    let cancelled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(prelude)); },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture-native/probe", input: "Synthetic test", stream: true, store: false }),
    }), nativeConfig(baseUrl, 1), { model: "", provider: "" });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"type":"response.created"');
    const failure = text.split("\n").find(line => line.startsWith("data: ") && line.includes('"type":"response.failed"'));
    expect(failure).toBeDefined();
    expect(JSON.parse(failure!.slice(6)).response.error).toMatchObject({ code: "upstream_stall_timeout", message: "Upstream response body stalled for 1000ms" });
    expect(cancelled).toBe(true);
  });
test.each([undefined, 0])("stallTimeoutSec %p leaves a public native Responses SSE body without a silence clock", async stallTimeoutSec => {
  release = acquireOwnedSpendHome();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { source = controller; controller.enqueue(new TextEncoder().encode(prelude)); },
  }), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
  // The default public budget (300 s) would be the only delay an unset guard could arm.
  const delays: number[] = [];
  const original = globalThis.setTimeout;
  const spy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (typeof delay === "number" && delay > 250_000) delays.push(delay);
    return original(callback, delay, ...args);
  }) as typeof setTimeout);
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture-native/probe", input: "Synthetic test", stream: true, store: false }),
    }), nativeConfig("https://gateway.example/v1", stallTimeoutSec), { model: "", provider: "" });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    source.enqueue(new TextEncoder().encode(completed));
    source.close();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) text += decoder.decode(chunk.value);
    expect(text).toContain("FIXTURE_OK");
    expect(text).not.toContain('"type":"response.failed"');
    expect(delays).toEqual([]);
  } finally { spy.mockRestore(); }
});
