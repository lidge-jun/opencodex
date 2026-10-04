import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter, formatOpenAIChatErrorBody } from "../../../src/adapters/openai-chat";
import { parseRequest } from "../../../src/responses/parser";
import { responseWithDeferredRequestLog } from "../../../src/server/relay";
import type { RequestLogEntry } from "../../../src/server/request-log";
import { runWithWebSearch } from "../../../src/web-search/loop";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const headers = new Headers({ "content-type": "text/event-stream; charset=utf-8" });
const message = "Input text data may contain inappropriate content.";
const envelope = { error: { message, code: "data_inspection_failed", type: "data_inspection_failed" } };
const sse = `data: ${JSON.stringify(envelope)}\n\n`;

function format(body: string, contentType = "text/event-stream; charset=utf-8") {
  return formatOpenAIChatErrorBody(400, new Headers({ "content-type": contentType }), body);
}

describe("OpenAI-compatible SSE HTTP error details", () => {
  test("surfaces the error message from an SSE HTTP 400", () => {
    expect(format(sse)).toBe(message);
  });

  test.each(["\n", "\r\n", "\r"])("handles SSE line ending %j and multiline data", newline => {
    const body = [": keepalive", "event: error", 'data:{"error":',
      `data:${JSON.stringify(envelope.error)}}`, "", "data: [DONE]", ""].join(newline);
    expect(format(body)).toBe(message);
  });

  test("handles an error event without an envelope or trailing newline", () => {
    expect(format('event:error\ndata:{"message":"bad request"}')).toBe("bad request");
  });

  test("accepts a case-insensitive event-stream media type", () => {
    expect(format(sse, "Text/Event-Stream; charset=UTF-8")).toBe(message);
  });

  test("ignores malformed, comment, done and successful frames before an error", () => {
    const prefix = ': data: {"error":"comment"}\n\ndata: invalid\n\n'
      + 'data: {"message":"assistant content"}\n\ndata: [DONE]\n\n';
    expect(format(prefix + sse)).toBe(message);
  });

  test("does not treat ordinary stream content as an error", () => {
    expect(format('data: {"message":"assistant content"}\n\n')).toBe("");
    expect(format('event: message\ndata: "assistant content"\n\n')).toBe("");
    expect(format('data: null\n\ndata: []\n\ndata: [DONE]\n\n')).toBe("");
  });

  test("does not carry event names across blank records", () => {
    expect(format('event: error\n\ndata: {"message":"not an error"}\n\n')).toBe("");
  });

  test("only uses SSE parsing for the declared media type", () => {
    expect(format(sse, "text/plain")).toBe("");
    expect(format(sse, "application/json")).toBe("");
    expect(format(sse, "text/event-stream-invalid")).toBe("");
  });

  test("retains JSON fallback, redaction and the existing output limit", () => {
    expect(format(JSON.stringify(envelope))).toBe(message);
    const secret = "sk-" + "synthetic-test-secret123456789";
    const body = `data: ${JSON.stringify({ error: { message: secret + "x".repeat(1000) } })}\n\n`;
    const detail = format(body);
    expect(detail).not.toContain(secret);
    expect(detail).toContain("[REDACTED]");
    expect(detail.length).toBeLessThanOrEqual(400);
  });

  test("leaves empty, HTML and malformed SSE bodies without a detail", () => {
    for (const body of ["", "<html>Bad gateway</html>", "data: {broken\n\n", "data: [DONE]\n\n"]) {
      expect(format(body)).toBe("");
    }
  });
});

async function bridge(upstream: Response): Promise<Response> {
  const adapter = createOpenAIChatAdapter({
    adapter: "openai-chat", baseUrl: "https://provider.test/v1", authMode: "key", apiKey: "test-key",
  });
  adapter.fetchResponse = async () => upstream;
  return runWithWebSearch({
    parsed: parseRequest({ model: "routed/test-model", input: "Synthetic input", stream: true,
      tools: [{ type: "web_search" }] }),
    adapter,
    forwardProvider: { adapter: "openai-responses", baseUrl: "https://forward.test/v1", authMode: "forward" },
    hostedTool: { type: "web_search" },
    selectedForwardHeaders: new Headers(),
    settings: { model: "test-model", reasoning: "low", timeoutMs: 1000 },
    maxSearches: 1,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
  });
}

describe("SSE HTTP errors through the web-search bridge", () => {
  test("preserves HTTP 400 and the detail in both the client message and request log", async () => {
    const response = await bridge(new Response(sse, { status: 400, headers }));
    const entries: RequestLogEntry[] = [];
    const logged = responseWithDeferredRequestLog(response, "ocx-test-sse-error", Date.now(),
      { model: "test-model", provider: "test-provider" }, entry => entries.push(entry));
    expect(logged.status).toBe(400);
    expect((await logged.json()).error.message).toBe(`Provider error 400: ${message}`);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe(400);
    expect(entries[0].upstreamError).toBe(`Provider error 400: ${message}`);
  });

  test("does not expose a prefix when the error body exceeds the existing read limit", async () => {
    const response = await bridge(new Response(sse + " ".repeat(65_536), { status: 400, headers }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("Provider error 400");
  });

  test("body read failures retain the status-only fallback", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("synthetic-reader-detail-must-not-leak")); },
    });
    const response = await bridge(new Response(stream, { status: 400, headers }));
    expect((await response.json()).error.message).toBe("Provider error 400");
  });
});
