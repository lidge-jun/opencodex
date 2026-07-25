/**
 * Issue #422: a Responses-shaped wire does not imply support for Codex's private
 * `compaction_trigger` item. Only the canonical ChatGPT backend speaks that
 * contract; every other gateway has to be driven as a plain summarizer, or Codex
 * fatals on a compaction turn that came back as an ordinary message.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { handleResponses } from "../src/server/responses";
import { supportsNativeResponsesCompactEndpoint } from "../src/providers/openai-tiers";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function keyProviderConfig(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    defaultProvider: "gw",
    providers: {
      gw: {
        adapter: "openai-responses",
        baseUrl: "https://gateway.example/v1",
        authMode: "key",
        apiKey: "test-key",
        ...overrides,
      },
    },
  } as unknown as OcxConfig;
}

function compactionRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function baseCompactionBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "gw/some-model",
    stream: false,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "earlier turn" }] },
      { type: "compaction_trigger" },
    ],
    tools: [{ type: "function", name: "shell" }],
    tool_choice: "auto",
    parallel_tool_calls: true,
    ...extra,
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function completedPayload(text: string): Record<string, unknown> {
  return {
    id: "resp_1",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const body = events.map(e => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("supportsNativeResponsesCompactEndpoint (#422)", () => {
  const canonicalForward = {
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authMode: "forward",
  } as OcxProviderConfig;
  const officialApi = {
    adapter: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    authMode: "key",
  } as OcxProviderConfig;

  test("accepts the canonical ChatGPT backend and the official OpenAI API", () => {
    expect(supportsNativeResponsesCompactEndpoint("openai", canonicalForward)).toBe(true);
    expect(supportsNativeResponsesCompactEndpoint("openai-apikey", officialApi)).toBe(true);
    expect(supportsNativeResponsesCompactEndpoint("openai-apikey", {
      ...officialApi,
      baseUrl: "https://api.openai.com/v1/",
    })).toBe(true);
  });

  test("rejects any other Responses-shaped gateway", () => {
    expect(supportsNativeResponsesCompactEndpoint("gw", {
      adapter: "openai-responses",
      baseUrl: "https://gateway.example/v1",
      authMode: "key",
    } as OcxProviderConfig)).toBe(false);
    // Right provider id, wrong destination.
    expect(supportsNativeResponsesCompactEndpoint("openai-apikey", {
      ...officialApi,
      baseUrl: "https://gateway.example/v1",
    })).toBe(false);
  });
});

describe("routed compaction for key-mode openai-responses (#422)", () => {
  test("rewrites the wire: no trigger, no tools, summarizer prompt present", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return jsonResponse(completedPayload("handoff summary"));
    }) as typeof fetch;

    const res = await handleResponses(
      compactionRequest(baseCompactionBody()),
      keyProviderConfig(),
      { model: "", provider: "" },
    );

    expect(bodies.length).toBe(1);
    const sent = bodies[0]!;
    const input = sent.input as Array<Record<string, unknown>>;
    // The adapter builds from _rawBody, so checking parsed.context would miss this.
    expect(input.some(item => item.type === "compaction_trigger")).toBe(false);
    expect(sent.tools).toBeUndefined();
    expect(sent.tool_choice).toBeUndefined();
    expect(sent.parallel_tool_calls).toBeUndefined();
    expect(JSON.stringify(input)).toContain("CONTEXT CHECKPOINT COMPACTION");

    const json = await res.json() as { output?: Array<{ type?: string }> };
    const compactionItems = (json.output ?? []).filter(item => item.type === "compaction");
    expect(compactionItems.length).toBe(1);
  });

  test("strips additional_tools even when top-level tools are absent", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return jsonResponse(completedPayload("summary"));
    }) as typeof fetch;

    const body = baseCompactionBody();
    delete body.tools;
    (body.input as unknown[]).splice(1, 0, { type: "additional_tools", tools: [{ name: "shell" }] });

    await handleResponses(compactionRequest(body), keyProviderConfig(), { model: "", provider: "" });

    const input = bodies[0]!.input as Array<Record<string, unknown>>;
    expect(input.some(item => item.type === "additional_tools")).toBe(false);
  });

  test("raw input_image never reaches the upstream", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return jsonResponse(completedPayload("summary"));
    }) as typeof fetch;

    const body = baseCompactionBody();
    (body.input as unknown[]).unshift({
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
    });
    // Also nested inside a tool result, which the recursive strip must reach.
    (body.input as unknown[]).unshift({
      type: "function_call_output",
      output: { content: [{ type: "input_image", image_url: "data:image/png;base64,BBBB" }] },
    });

    await handleResponses(compactionRequest(body), keyProviderConfig(), { model: "", provider: "" });

    expect(JSON.stringify(bodies[0]!.input)).not.toContain("input_image");
    expect(JSON.stringify(bodies[0]!.input)).not.toContain("base64,AAAA");
  });

  test("noncanonical forward providers still get the rewrite", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return jsonResponse(completedPayload("summary"));
    }) as typeof fetch;

    // authMode "forward" on a non-ChatGPT base URL: an authMode check would skip the
    // rewrite here while the server still routes it as a summarizer turn.
    await handleResponses(
      compactionRequest(baseCompactionBody()),
      keyProviderConfig({ authMode: "forward" }),
      { model: "", provider: "" },
    );

    const input = bodies[0]!.input as Array<Record<string, unknown>>;
    expect(input.some(item => item.type === "compaction_trigger")).toBe(false);
    expect(bodies[0]!.tools).toBeUndefined();
  });
});

describe("compaction terminal handling (#422)", () => {
  test("an upstream failure does not become an empty compaction", async () => {
    globalThis.fetch = (async () => jsonResponse({
      id: "resp_1",
      status: "failed",
      error: { message: "upstream exploded" },
      output: [],
    })) as typeof fetch;

    const res = await handleResponses(
      compactionRequest(baseCompactionBody()),
      keyProviderConfig(),
      { model: "", provider: "" },
    );

    const json = await res.json() as { status?: string; output?: Array<{ type?: string }> };
    expect((json.output ?? []).some(item => item.type === "compaction")).toBe(false);
  });

  test("an incomplete turn produces no compaction item", async () => {
    globalThis.fetch = (async () => jsonResponse({
      id: "resp_1",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }] }],
    })) as typeof fetch;

    const res = await handleResponses(
      compactionRequest(baseCompactionBody()),
      keyProviderConfig(),
      { model: "", provider: "" },
    );

    const json = await res.json() as { output?: Array<{ type?: string }> };
    // A truncated summary must not be installed as replacement history.
    expect((json.output ?? []).some(item => item.type === "compaction")).toBe(false);
  });

  test("streamed text is recovered from output_text.done without deltas", async () => {
    globalThis.fetch = (async () => sseResponse([
      { type: "response.output_text.done", text: "summary from done" },
      { type: "response.completed", response: { id: "r", status: "completed", output: [] } },
    ])) as typeof fetch;

    const res = await handleResponses(
      compactionRequest(baseCompactionBody({ stream: true })),
      keyProviderConfig(),
      { model: "", provider: "" },
    );
    const text = await res.text();

    // A delta-only parser would emit an empty compaction and silently drop the context.
    expect(text).toContain("\"type\":\"compaction\"");
  });

  test("streamed text is recovered from the completed snapshot", async () => {
    globalThis.fetch = (async () => sseResponse([
      {
        type: "response.completed",
        response: completedPayload("summary from snapshot"),
      },
    ])) as typeof fetch;

    const res = await handleResponses(
      compactionRequest(baseCompactionBody({ stream: true })),
      keyProviderConfig(),
      { model: "", provider: "" },
    );

    expect(await res.text()).toContain("\"type\":\"compaction\"");
  });
});
