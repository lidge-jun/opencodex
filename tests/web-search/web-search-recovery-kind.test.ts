import { afterEach, expect, test } from "bun:test";
import type { AdapterEvent, OcxProviderConfig } from "../../src/types";
import type { AdapterRequest, ProviderAdapter } from "../../src/adapters/base";
import type { AttemptRecoveryKind } from "../../src/usage/log";
import { parseRequest } from "../../src/responses/parser";
import { runWithWebSearch } from "../../src/web-search/loop";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

// Moved out of web-search.test.ts, which sits at its file-size ratchet cap.

const forwardProvider: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/v1",
  authMode: "forward",
};

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<{ event?: string; data: Record<string, unknown> }[]> {
  const text = await new Response(stream).text();
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(line => line.startsWith("data: "));
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    });
}

// An account rotation and a key rotation are different operator-facing events, and the
// rotated fetch's recovery kind is the only place the attempt row records which happened.
// The loop used to hardcode `key-429` for both.
test("429 rotation reports the rotator's recovery kind", async () => {
  globalThis.fetch = (() => Promise.resolve(new Response(
    'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    { headers: { "Content-Type": "text/event-stream" } },
  ))) as typeof fetch;

  const recoveryKindsFor = async (
    rotation: (next: ProviderAdapter) => { adapter: ProviderAdapter; recoveryKind: AttemptRecoveryKind },
  ): Promise<(AttemptRecoveryKind | undefined)[]> => {
    const sends: (AttemptRecoveryKind | undefined)[] = [];
    const buildRequest = (): AdapterRequest =>
      ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" });
    const firstAdapter: ProviderAdapter = {
      name: "mock-429",
      buildRequest,
      fetchResponse: async () => new Response("rate limited", { status: 429, headers: { "retry-after": "30" } }),
      async *parseStream() { /* unused */ },
      async parseResponse() { return [{ type: "done" }] as AdapterEvent[]; },
    };
    const rotatedAdapter: ProviderAdapter = {
      name: "mock-rotated",
      buildRequest,
      fetchResponse: async () => new Response("{}", { status: 200 }),
      async *parseStream() {
        yield { type: "text_delta", text: "answer from rotated account" };
        yield { type: "done" };
      },
      async parseResponse() { throw new Error("parseResponse must be unreachable"); },
    };
    const response = await runWithWebSearch({
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: firstAdapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      onAttemptSend: recovery => { sends.push(recovery); },
      on429: () => rotation(rotatedAdapter),
    });
    expect(response.status).toBe(200);
    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as { type: string; content?: { text?: string }[] }[];
    expect(output.find(o => o.type === "message")?.content?.[0]?.text).toBe("answer from rotated account");
    return sends;
  };

  // A rotator that crossed accounts says so, and the rotated send carries that kind.
  expect(await recoveryKindsFor(next => ({ adapter: next, recoveryKind: "oauth-account-429" })))
    .toEqual([undefined, "oauth-account-429"]);
  expect(await recoveryKindsFor(next => ({ adapter: next, recoveryKind: "anthropic-oauth-429" })))
    .toEqual([undefined, "anthropic-oauth-429"]);
  expect(await recoveryKindsFor(next => ({ adapter: next, recoveryKind: "key-429" })))
    .toEqual([undefined, "key-429"]);
});

test("web-search does not replay a verification refusal after routed output was committed", async () => {
  globalThis.fetch = (async () => Response.json({
    results: [{ title: "Fixture", url: "https://example.test/result", content: "synthetic result" }],
  })) as typeof fetch;
  let routedSends = 0;
  let rotations = 0;
  const adapter: ProviderAdapter = {
    name: "mock-antigravity",
    buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
    fetchResponse: async () => {
      routedSends++;
      if (routedSends === 1) return new Response("ok", { status: 200 });
      return new Response(JSON.stringify({ error: {
        status: "PERMISSION_DENIED", message: "validate", details: [{ reason: "VALIDATION_REQUIRED" }],
      } }), { status: 403 });
    },
    async *parseStream() {
      yield { type: "text_delta", text: "I will check. " } satisfies AdapterEvent;
      yield { type: "tool_call_start", id: "search-1", name: "web_search" } satisfies AdapterEvent;
      yield { type: "tool_call_delta", arguments: JSON.stringify({ query: "fixture query" }) } satisfies AdapterEvent;
      yield { type: "tool_call_end" } satisfies AdapterEvent;
      yield { type: "done" } satisfies AdapterEvent;
    },
    async parseResponse() { throw new Error("parseResponse must be unreachable"); },
  };

  const response = await runWithWebSearch({
    parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
    adapter,
    incomingMeta: { headers: new Headers(), providerName: "google-antigravity", translatorBudget: createTestTranslatorBudget() },
    backend: "exa",
    exaApiKey: "synthetic-exa-key",
    hostedTool: { type: "web_search" },
    selectedForwardHeaders: new Headers(),
    settings: { model: "exa-fixture-model", reasoning: "low", timeoutMs: 30_000 },
    maxSearches: 1,
    streamRoutedModelOutput: true,
    on429: () => { rotations++; return null; },
  });
  const frames = await collectSse(response.body!);
  const text = frames
    .filter(frame => frame.data.type === "response.output_text.delta")
    .map(frame => String(frame.data.delta ?? ""))
    .join("");
  expect(text).toContain("I will check.");
  expect(routedSends).toBe(2);
  expect(rotations).toBe(0);
  expect(frames.some(frame => frame.event === "response.failed")).toBe(true);
});
