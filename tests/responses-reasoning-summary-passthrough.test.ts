import { afterEach, describe, expect, test } from "bun:test";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { handleResponses } from "../src/server/responses/core";
import type { OcxConfig } from "../src/types";

/**
 * The passthrough relay for DeepSeek's native /responses endpoint emits
 * content-channel reasoning (reasoning_text.delta + content items). The
 * summary-channel rewrite must engage only when the client did NOT ask for
 * hidden thinking (hideThinkingSummary) - otherwise a client that asked to
 * hide reasoning would get it surfaced as visible summary output.
 */

function deepseekSeed() {
  return { ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "sk-test" };
}

const SSE_UPSTREAM_FRAMES = [
  `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } })}\n\n`,
  `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", status: "in_progress", content: [], summary: [] } })}\n\n`,
  `data: ${JSON.stringify({ type: "response.reasoning_text.delta", content_index: 0, delta: "think", item_id: "rs_1", output_index: 0 })}\n\n`,
  `data: ${JSON.stringify({ type: "response.reasoning_text.done", content_index: 0, text: "think", item_id: "rs_1", output_index: 0 })}\n\n`,
  `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", status: "completed", content: [{ type: "reasoning_text", text: "think" }], summary: [] } })}\n\n`,
  `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [{ type: "reasoning", id: "rs_1", status: "completed", content: [{ type: "reasoning_text", text: "think" }], summary: [] }] } })}\n\n`,
];

const JSON_UPSTREAM = {
  id: "resp_1",
  status: "completed",
  output: [
    {
      type: "reasoning",
      id: "rs_1",
      status: "completed",
      content: [{ type: "reasoning_text", text: "think" }],
      summary: [],
    },
    { type: "message", id: "msg_1", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] },
  ],
};

async function runHandleResponses(body: Record<string, unknown>, upstreamBody: unknown, contentType: string) {
  const encoder = new TextEncoder();
  const payload = typeof upstreamBody === "string"
    ? upstreamBody
    : JSON.stringify(upstreamBody);
  globalThis.fetch = (async () => new Response(
    contentType.includes("event-stream")
      ? new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(payload));
          controller.close();
        },
      })
      : payload,
    { status: 200, headers: { "content-type": contentType } },
  )) as typeof fetch;
  const config = { providers: { deepseek: deepseekSeed() } } as unknown as OcxConfig;
  return handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    config,
    { model: "", provider: "" },
    { abortSignal: AbortSignal.timeout(5_000) },
  );
}

describe("passthrough reasoning summary rewrite honors hideThinkingSummary", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("SSE: hidden thinking stays on the content channel", async () => {
    // No reasoning.summary in the request -> parseRequest sets hideThinkingSummary.
    const response = await runHandleResponses(
      { model: "deepseek-v4-flash", input: "ping", stream: true },
      SSE_UPSTREAM_FRAMES.join(""),
      "text/event-stream",
    );
    const text = await response.text();
    expect(text).toContain("response.reasoning_text.delta");
    expect(text).not.toContain("response.reasoning_summary_text.delta");
    expect(text).toContain('"content":[{"type":"reasoning_text","text":"think"}]');
  });

  test("SSE: requested summary routes raw reasoning through the summary channel", async () => {
    const response = await runHandleResponses(
      { model: "deepseek-v4-flash", input: "ping", stream: true, reasoning: { effort: "max", summary: "detailed" } },
      SSE_UPSTREAM_FRAMES.join(""),
      "text/event-stream",
    );
    const text = await response.text();
    expect(text).toContain("response.reasoning_summary_text.delta");
    expect(text).toContain('"summary":[{"type":"summary_text","text":"think"}]');
  });

  test("bounded JSON: hidden thinking keeps the content shape", async () => {
    const response = await runHandleResponses(
      { model: "deepseek-v4-flash", input: "ping", stream: false },
      JSON_UPSTREAM,
      "application/json",
    );
    const text = await response.text();
    expect(text).toContain('"content":[{"type":"reasoning_text","text":"think"}]');
    expect(text).not.toContain('"summary":[{"type":"summary_text"');
  });

  test("bounded JSON: requested summary moves item content into summary", async () => {
    const response = await runHandleResponses(
      { model: "deepseek-v4-flash", input: "ping", stream: false, reasoning: { effort: "max", summary: "detailed" } },
      JSON_UPSTREAM,
      "application/json",
    );
    const text = await response.text();
    expect(text).toContain('"summary":[{"type":"summary_text","text":"think"}]');
    expect(text).not.toContain('"content":[{"type":"reasoning_text","text":"think"}]');
  });
});
