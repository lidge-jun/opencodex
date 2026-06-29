import { describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../src/adapters/google";
import { isVertexTruncationReason, vertexTruncationErrorMessage } from "../src/adapters/google-truncation";
import type { AdapterEvent, OcxProviderConfig } from "../src/types";

function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n`).join("\n") + "\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(provider: OcxProviderConfig, chunks: unknown[]): Promise<AdapterEvent[]> {
  const adapter = createGoogleAdapter(provider);
  const events: AdapterEvent[] = [];
  for await (const ev of adapter.parseStream(sseResponse(chunks))) events.push(ev);
  return events;
}

const vertexProvider = { adapter: "google", baseUrl: "https://x", googleMode: "vertex" } as OcxProviderConfig;

describe("vertex truncation helpers", () => {
  test("classifies cut-off finish reasons", () => {
    expect(isVertexTruncationReason("MAX_TOKENS")).toBe(true);
    expect(isVertexTruncationReason("MALFORMED_FUNCTION_CALL")).toBe(true);
    expect(isVertexTruncationReason("STOP")).toBe(false);
    expect(isVertexTruncationReason(undefined)).toBe(false);
    expect(vertexTruncationErrorMessage("MAX_TOKENS")).toContain("truncated upstream");
  });
});

describe("vertex parseStream fail-closed truncation", () => {
  test("MAX_TOKENS after a tool call yields a terminal error, not done", async () => {
    const events = await collect(vertexProvider, [
      { candidates: [{ content: { parts: [{ functionCall: { name: "get_x", args: { a: 1 } } }] } }] },
      { candidates: [{ finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } },
    ]);
    expect(events.some(e => e.type === "tool_call_start")).toBe(true);
    const last = events[events.length - 1];
    expect(last.type).toBe("error");
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("clean STOP stream yields done with reported usage", async () => {
    const events = await collect(vertexProvider, [
      { candidates: [{ content: { parts: [{ text: "hello" }] } }] },
      { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 1, cachedContentTokenCount: 3 } },
    ]);
    const done = events.find(e => e.type === "done");
    expect(done).toBeDefined();
    const usage = (done as Extract<AdapterEvent, { type: "done" }>).usage;
    expect(usage?.inputTokens).toBe(5);
    expect(usage?.outputTokens).toBe(2);
    expect(usage?.reasoningOutputTokens).toBe(1);
    expect(usage?.cachedInputTokens).toBe(3);
    expect(usage?.estimated).toBeUndefined();
  });

  test("MAX_TOKENS with NO tool call still completes (text truncation is not fail-closed)", async () => {
    const events = await collect(vertexProvider, [
      { candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }] },
    ]);
    expect(events.some(e => e.type === "done")).toBe(true);
    expect(events.some(e => e.type === "error")).toBe(false);
  });

  test("usage-only final chunk (no candidates) is not dropped", async () => {
    const events = await collect(vertexProvider, [
      { candidates: [{ content: { parts: [{ text: "hi" }] } }] },
      { usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } },
    ]);
    const done = events.find(e => e.type === "done");
    const usage = (done as Extract<AdapterEvent, { type: "done" }>).usage;
    expect(usage?.inputTokens).toBe(7);
    expect(usage?.outputTokens).toBe(3);
  });
});

describe("vertex parseResponse fail-closed truncation (non-streaming)", () => {
  test("MAX_TOKENS with a tool call yields a terminal error, not done", async () => {
    const adapter = createGoogleAdapter(vertexProvider);
    const body = JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "get_x", args: {} } }] }, finishReason: "MAX_TOKENS" }] });
    const events = await adapter.parseResponse!(new Response(body, { status: 200 }));
    expect(events[events.length - 1].type).toBe("error");
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("clean STOP non-stream response yields done", async () => {
    const adapter = createGoogleAdapter(vertexProvider);
    const body = JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 } });
    const events = await adapter.parseResponse!(new Response(body, { status: 200 }));
    expect(events.some(e => e.type === "done")).toBe(true);
    expect(events.some(e => e.type === "error")).toBe(false);
  });
});

describe("usage status for google-vertex stays reported", () => {
  test("usageForFinalLog does not force-estimate google-vertex (but does for kiro)", async () => {
    const { usageForFinalLog, usageStatusForFinalLog } = await import("../src/usage-log");
    const usage = { inputTokens: 5, outputTokens: 2 };
    const vertex = usageForFinalLog("google-vertex", usage);
    expect(vertex?.estimated).toBeUndefined();
    expect(usageStatusForFinalLog(vertex)).toBe("reported");
    expect(usageForFinalLog("kiro", usage)?.estimated).toBe(true);
  });
});
