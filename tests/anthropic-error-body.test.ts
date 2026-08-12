import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { createAnthropicAdapter, formatAnthropicErrorBody } from "../src/adapters/anthropic";
import { parseRequest } from "../src/responses/parser";
import { responseWithDeferredRequestLog, type RequestLogEntry } from "../src/server";
import { runWithWebSearch as runWithWebSearchProduction, type WebSearchLoopDeps } from "../src/web-search/loop";
import type { OcxProviderConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("formatAnthropicErrorBody", () => {
  const headers = new Headers();

  test("renders the Anthropic envelope as type: message", () => {
    const body = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "messages.0: broken" },
    });
    expect(formatAnthropicErrorBody(400, headers, body))
      .toBe("invalid_request_error: messages.0: broken");
  });

  test("tolerates a bare error.message without a type", () => {
    const body = JSON.stringify({ error: { message: "plain failure" } });
    expect(formatAnthropicErrorBody(400, headers, body)).toBe("plain failure");
  });

  test("tolerates a string error field and a JSON string body", () => {
    expect(formatAnthropicErrorBody(500, headers, JSON.stringify({ error: "boom" }))).toBe("boom");
    expect(formatAnthropicErrorBody(500, headers, JSON.stringify("raw string"))).toBe("raw string");
  });

  test("HTML and non-JSON bodies yield empty so markup is never echoed", () => {
    expect(formatAnthropicErrorBody(400, headers, "<html><body>Bad</body></html>")).toBe("");
    expect(formatAnthropicErrorBody(400, headers, "not json at all")).toBe("");
    expect(formatAnthropicErrorBody(400, headers, JSON.stringify({ unrelated: true }))).toBe("");
  });

  test("secret-shaped content inside the message is redacted", () => {
    const body = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "bad key sk-redact-me-please" },
    });
    const out = formatAnthropicErrorBody(400, headers, body);
    expect(out).not.toContain("sk-redact-me-please");
    expect(out).toContain("[REDACTED]");
  });
});

const anthropicProvider: OcxProviderConfig = {
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.com",
  authMode: "key",
  apiKey: "test-key",
} as OcxProviderConfig;

const forwardProvider: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/v1",
  authMode: "forward",
} as OcxProviderConfig;

function parsed() {
  return parseRequest({
    model: "routed/claude-opus-5",
    input: "Search current docs",
    stream: true,
    tools: [{ type: "web_search" }],
  });
}

function deps(adapter: ProviderAdapter, overrides: Record<string, unknown> = {}) {
  return {
    parsed: parsed(),
    adapter,
    forwardProvider,
    hostedTool: { type: "web_search" },
    selectedForwardHeaders: new Headers({ authorization: "Bearer forwarded" }),
    settings: { model: "gpt-5.6-luna", reasoning: "low" as const, timeoutMs: 1_000 },
    maxSearches: 1,
    ...overrides,
  };
}

function runWithWebSearch(
  d: Omit<WebSearchLoopDeps, "incomingMeta"> & { incomingMeta?: WebSearchLoopDeps["incomingMeta"] },
): Promise<Response> {
  return runWithWebSearchProduction({
    ...d,
    incomingMeta: d.incomingMeta ?? {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
    },
  });
}

describe("anthropic adapter through the web-search bridge", () => {
  test("a JSON 400 envelope reaches the client message instead of the bare status", async () => {
    const envelope = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "tools.0.custom.name: pattern mismatch" },
    });
    globalThis.fetch = (async () => new Response(envelope, {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

    const adapter = createAnthropicAdapter(anthropicProvider);
    const response = await runWithWebSearch(deps(adapter));
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toBe(
      "Provider error 400: invalid_request_error: tools.0.custom.name: pattern mismatch",
    );
  });

  test("the formatted message flows into the persisted request log upstreamError", async () => {
    const envelope = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "prompt shape rejected" },
    });
    globalThis.fetch = (async () => new Response(envelope, {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

    const adapter = createAnthropicAdapter(anthropicProvider);
    const response = await runWithWebSearch(deps(adapter));
    const entries: RequestLogEntry[] = [];
    const logged = responseWithDeferredRequestLog(
      response,
      "ocx-test-anthropic-400-fidelity",
      Date.now(),
      { model: "claude-opus-5", provider: "anthropic" },
      entry => entries.push(entry),
    );
    await logged.text();
    expect(entries).toHaveLength(1);
    expect(entries[0].upstreamError).toBe("Provider error 400: invalid_request_error: prompt shape rejected");
    expect(entries[0].status).toBe(400);
  });

  test("a body-read failure still falls back to the bare status (no formatter, no leak)", async () => {
    const errorBody = new ReadableStream<Uint8Array>();
    Object.defineProperty(errorBody, "getReader", {
      value: () => { throw new Error("reader-secret"); },
    });
    const adapter = createAnthropicAdapter(anthropicProvider);
    adapter.fetchResponse = async () => new Response(errorBody, { status: 400 });

    const response = await runWithWebSearch(deps(adapter));
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toBe("Provider error 400");
    expect(JSON.stringify(body)).not.toContain("reader-secret");
  });
});
