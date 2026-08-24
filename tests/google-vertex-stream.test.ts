import { describe, expect, test } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../src/adapters/google";
import { isVertexTruncatedTurn, isVertexTruncationReason, vertexTruncationErrorMessage } from "../src/adapters/google-truncation";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

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
const aiStudioProvider = { adapter: "google", baseUrl: "https://x", apiKey: "test-key" } as OcxProviderConfig;
const ccaProvider = {
  adapter: "google",
  baseUrl: "https://x",
  apiKey: "test-token",
  googleMode: "cloud-code-assist",
  project: "test-project",
} as OcxProviderConfig;

function ccaResponse(payload: unknown): unknown {
  return { response: payload };
}

const googleModes: [string, OcxProviderConfig, (payload: unknown) => unknown][] = [
  ["AI Studio", aiStudioProvider, payload => payload],
  ["Vertex", vertexProvider, payload => payload],
  ["CCA", ccaProvider, ccaResponse],
];

describe("vertex truncation helpers", () => {
  test("classifies cut-off finish reasons", () => {
    expect(isVertexTruncationReason("MAX_TOKENS")).toBe(true);
    expect(isVertexTruncationReason("MALFORMED_FUNCTION_CALL")).toBe(true);
    expect(isVertexTruncationReason("STOP")).toBe(false);
    expect(isVertexTruncationReason(undefined)).toBe(false);
    expect(vertexTruncationErrorMessage("MAX_TOKENS")).toContain("truncated upstream");
  });

  test("MALFORMED_FUNCTION_CALL fails closed with zero started calls; MAX_TOKENS does not", () => {
    expect(isVertexTruncatedTurn("MALFORMED_FUNCTION_CALL", 0)).toBe(true);
    expect(isVertexTruncatedTurn("MAX_TOKENS", 0)).toBe(false);
    expect(isVertexTruncatedTurn("MAX_TOKENS", 1)).toBe(true);
    expect(isVertexTruncatedTurn("STOP", 5)).toBe(false);
    expect(isVertexTruncatedTurn(undefined, 5)).toBe(false);
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
    const chunks = [
      { candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }] },
    ];
    const events = await collect(vertexProvider, chunks);
    const done = events.find(e => e.type === "done");
    expect(done).toMatchObject({ type: "done", stopReason: "max_tokens" });
    expect(events.some(e => e.type === "error")).toBe(false);

    const bridged = bridgeToResponsesSSE(
      createGoogleAdapter(vertexProvider).parseStream(sseResponse(chunks)),
      "google-vertex/gemini-3-pro",
    );
    const text = await new Response(bridged).text();
    expect(text).toContain("event: response.incomplete");
    expect(text).toContain('"incomplete_details":{"reason":"max_output_tokens"}');
  });

  test("MALFORMED_FUNCTION_CALL with NO emitted call part yields a terminal error, not done", async () => {
    // The malformed call is dropped upstream, so the final chunk usually carries only the
    // finishReason. Without the guard this surfaced as a clean empty completion.
    const events = await collect(vertexProvider, [
      { candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 } },
    ]);
    const last = events[events.length - 1];
    expect(last.type).toBe("error");
    expect(events.some(e => e.type === "done")).toBe(false);
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

  test("MALFORMED_FUNCTION_CALL with no call part yields a terminal error, not done", async () => {
    const adapter = createGoogleAdapter(vertexProvider);
    const body = JSON.stringify({ candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 } });
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

describe("all Google GenerateContent modes fail closed consistently", () => {
  for (const [label, provider, wrap] of googleModes) {
    test(`${label} MALFORMED_FUNCTION_CALL is an error in stream and buffered paths`, async () => {
      const payload = wrap({
        candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 },
      });
      const streamEvents = await collect(provider, [payload]);
      const adapter = createGoogleAdapter(provider);
      const responseEvents = await adapter.parseResponse!(
        provider.googleMode === "cloud-code-assist"
          ? sseResponse([payload])
          : new Response(JSON.stringify(payload), { status: 200 }),
      );
      for (const events of [streamEvents, responseEvents]) {
        expect(events.at(-1)?.type).toBe("error");
        expect(events.some(event => event.type === "done")).toBe(false);
        const error = events.at(-1) as Extract<AdapterEvent, { type: "error" }>;
        expect(error.message).toContain(label === "AI Studio" ? "Google AI Studio" : "Vertex AI");
      }
    });

    test(`${label} MAX_TOKENS without a call remains a successful incomplete stop`, async () => {
      const payload = wrap({
        candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }],
      });
      const streamEvents = await collect(provider, [payload]);
      const adapter = createGoogleAdapter(provider);
      const responseEvents = await adapter.parseResponse!(
        provider.googleMode === "cloud-code-assist"
          ? sseResponse([payload])
          : new Response(JSON.stringify(payload), { status: 200 }),
      );
      for (const events of [streamEvents, responseEvents]) {
        expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "max_tokens" });
        expect(events.some(event => event.type === "error")).toBe(false);
      }
    });

    test(`${label} MAX_TOKENS after a call is an error in stream and buffered paths`, async () => {
      const payloads = [
        wrap({ candidates: [{ content: { parts: [{ functionCall: { name: "get_x", args: {} } }] } }] }),
        wrap({ candidates: [{ finishReason: "MAX_TOKENS" }] }),
      ];
      const streamEvents = await collect(provider, payloads);
      const adapter = createGoogleAdapter(provider);
      const responsePayload = wrap({
        candidates: [{ content: { parts: [{ functionCall: { name: "get_x", args: {} } }] }, finishReason: "MAX_TOKENS" }],
      });
      const responseEvents = await adapter.parseResponse!(
        provider.googleMode === "cloud-code-assist"
          ? sseResponse([responsePayload])
          : new Response(JSON.stringify(responsePayload), { status: 200 }),
      );
      for (const events of [streamEvents, responseEvents]) {
        expect(events.at(-1)?.type).toBe("error");
        expect(events.some(event => event.type === "done")).toBe(false);
      }
    });
  }
});

describe("Google prompt feedback", () => {
  for (const [label, provider, wrap] of googleModes) {
    test(`${label} reports a bounded prompt block reason with no candidates`, async () => {
      const reason = "SAFETY: bearer secret=super-secret-token " + "x".repeat(600);
      const payload = wrap({ promptFeedback: { blockReason: reason } });
      const streamEvents = await collect(provider, [payload]);
      const adapter = createGoogleAdapter(provider);
      const responseEvents = await adapter.parseResponse!(
        provider.googleMode === "cloud-code-assist"
          ? sseResponse([payload])
          : new Response(JSON.stringify(payload), { status: 200 }),
      );
      for (const events of [streamEvents, responseEvents]) {
        expect(events.at(-1)?.type).toBe("error");
        expect(events.some(event => event.type === "done")).toBe(false);
        const message = (events.at(-1) as Extract<AdapterEvent, { type: "error" }>).message;
        expect(message).toContain("SAFETY");
        expect(message).not.toContain("super-secret-token");
        expect(message.length).toBeLessThan(300);
      }
    });

    test(`${label} candidate takes precedence over prompt feedback`, async () => {
      const payload = wrap({
        candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }],
        promptFeedback: { blockReason: "SAFETY" },
      });
      const streamEvents = await collect(provider, [payload]);
      const adapter = createGoogleAdapter(provider);
      const responseEvents = await adapter.parseResponse!(
        provider.googleMode === "cloud-code-assist"
          ? sseResponse([payload])
          : new Response(JSON.stringify(payload), { status: 200 }),
      );
      for (const events of [streamEvents, responseEvents]) {
        expect(events.some(event => event.type === "text_delta" && event.text === "answer")).toBe(true);
        expect(events.at(-1)?.type).toBe("done");
        expect(events.some(event => event.type === "error")).toBe(false);
      }
    });
  }

  test("no candidates without feedback retains the generic stream and buffered errors", async () => {
    const streamEvents = await collect(aiStudioProvider, [{}]);
    const responseEvents = await createGoogleAdapter(aiStudioProvider).parseResponse!(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    expect(streamEvents.at(-1)).toEqual({
      type: "error",
      message: "upstream stream ended without a terminal signal — possible truncation",
    });
    expect(responseEvents).toEqual([{ type: "error", message: "google response contained no candidates" }]);
  });
});

describe("usage status for google-vertex stays reported", () => {
  test("usageForFinalLog does not force-estimate google-vertex (but does for kiro)", async () => {
    const { usageForFinalLog, usageStatusForFinalLog } = await import("../src/usage/log");
    const usage = { inputTokens: 5, outputTokens: 2 };
    const vertex = usageForFinalLog("google-vertex", usage);
    expect(vertex?.estimated).toBeUndefined();
    expect(usageStatusForFinalLog(vertex)).toBe("reported");
    expect(usageForFinalLog("kiro", usage)?.estimated).toBe(true);
  });
});
