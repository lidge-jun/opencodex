import { afterEach, describe, expect, test } from "bun:test";
import { handleChatCompletions } from "../../src/server/chat-completions";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

// Native /v1/chat/completions passthrough to canonical Mistral. Reasoning models answer with typed
// `thinking`/`text` content blocks; the relay must hand Chat clients plain strings.
const MISTRAL = "https://api.mistral.ai/v1";
const ANSWER = '{"outcome":"deny"}';
const USAGE = { prompt_tokens: 10, completion_tokens: 5 };
const thinking = (text: string) => ({ type: "thinking", thinking: [{ type: "text", text }], closed: true });
const text = (value: string) => ({ type: "text", text: value });
const delta = (value: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ id: "synthetic", choices: [{ index: 0, delta: value, finish_reason: null }], ...extra });
const terminal = { id: "synthetic", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: USAGE };

type Chunk = { choices: { delta: Record<string, unknown>; finish_reason: string | null }[]; usage?: unknown };

const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;

afterEach(() => {
  globalThis.fetch = originalFetch;
  releaseSpendHome?.();
  releaseSpendHome = undefined;
});

function sse(chunks: unknown[]): Response {
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

function completion(content: unknown) {
  return { id: "synthetic", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: USAGE };
}

async function chat(upstream: Response, stream: boolean, baseUrl = MISTRAL): Promise<Response> {
  globalThis.fetch = (async () => upstream) as unknown as typeof fetch;
  releaseSpendHome ??= acquireOwnedSpendHome();
  return handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/zai-glm-5-3", messages: [{ role: "user", content: "Synthetic fixture" }], stream }),
  }), { port: 0, defaultProvider: "fixture", providers: { fixture: {
    adapter: "openai-chat", baseUrl, authMode: "key", apiKey: "synthetic-native-chat-key",
  } } } as OcxConfig, { model: "", provider: "" });
}

async function frames(response: Response): Promise<{ chunks: Chunk[]; raw: string }> {
  const raw = await response.text();
  const chunks = raw.split("\n\n")
    .map(block => block.split("\n").find(line => line.startsWith("data: "))?.slice(6))
    .filter((data): data is string => data !== undefined && data !== "[DONE]")
    .map(data => JSON.parse(data) as Chunk);
  return { chunks, raw };
}

/** Client-visible string runs in arrival order, adjacent runs of one field merged. */
function runs(chunks: Chunk[]): [string, string][] {
  const out: [string, string][] = [];
  for (const chunk of chunks) {
    for (const field of ["reasoning_content", "content"] as const) {
      const value = chunk.choices?.[0]?.delta?.[field];
      if (typeof value !== "string" || value.length === 0) continue;
      if (out.at(-1)?.[0] === field) out.at(-1)![1] += value;
      else out.push([field, value]);
    }
  }
  return out;
}

describe("native Chat passthrough of Mistral typed content", () => {
  test("streamed thinking and text arrive as Chat strings in source order", async () => {
    const response = await chat(sse([
      delta({ role: "assistant", content: "" }),
      delta({ content: [thinking("Synthetic reasoning.")] }),
      delta({ content: [thinking(" More."), text('{"outcome')] }),
      delta({ content: '":"deny"}' }),
      terminal,
    ]), true);
    expect(response.status).toBe(200);
    const { chunks } = await frames(response);
    for (const chunk of chunks) {
      const content = chunk.choices?.[0]?.delta?.content;
      expect(content === undefined || typeof content === "string").toBe(true);
    }
    expect(runs(chunks)).toEqual([["reasoning_content", "Synthetic reasoning. More."], ["content", ANSWER]]);
    expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: "stop" }], usage: USAGE });
  });

  test("interleaved blocks in one chunk keep their order; role leads, finish_reason and usage trail", async () => {
    const response = await chat(sse([{
      id: "synthetic", usage: USAGE,
      choices: [{ index: 0, delta: { role: "assistant", content: [text("A"), thinking("first"), text("B")] }, finish_reason: "stop" }],
    }]), true);
    const { chunks } = await frames(response);
    expect(runs(chunks)).toEqual([["content", "A"], ["reasoning_content", "first"], ["content", "B"]]);
    expect(chunks.map(chunk => chunk.choices[0]!.delta.role)).toEqual(["assistant", undefined, undefined]);
    expect(chunks.map(chunk => chunk.choices[0]!.finish_reason)).toEqual([null, null, "stop"]);
    expect(chunks.map(chunk => chunk.usage === undefined)).toEqual([true, true, false]);
  });

  test("a typed-only stream cut before its terminal frame still counts as output and closes cleanly", async () => {
    const response = await chat(new Response(`data: ${JSON.stringify(delta({ content: [thinking("t"), text("partial")] }))}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    }), true);
    const { chunks, raw } = await frames(response);
    expect(runs(chunks)).toEqual([["reasoning_content", "t"], ["content", "partial"]]);
    expect(raw).toContain("data: [DONE]");
    expect(raw).not.toContain("upstream_sse_truncated");
  });

  test("a buffered reply joins thinking into reasoning_content and text into content", async () => {
    const response = await chat(Response.json(completion([thinking("Synthetic reasoning."), text(ANSWER)])), false);
    expect(response.status).toBe(200);
    const body = await response.json() as { choices: { message: Record<string, unknown> }[] };
    expect(body.choices[0]!.message).toMatchObject({ content: ANSWER, reasoning_content: "Synthetic reasoning." });
  });

  test("a buffered thinking-only reply has null content, like the streamed collector", async () => {
    const response = await chat(Response.json(completion([thinking("Synthetic reasoning.")])), false);
    const body = await response.json() as { choices: { message: Record<string, unknown> }[] };
    expect(body.choices[0]!.message).toMatchObject({ content: null, reasoning_content: "Synthetic reasoning." });
  });

  test("a buffered upstream reply to a streaming client is synthesized from the converted strings", async () => {
    const response = await chat(Response.json(completion([thinking("Synthetic reasoning."), text(ANSWER)])), true);
    const { chunks } = await frames(response);
    expect(runs(chunks)).toEqual([["reasoning_content", "Synthetic reasoning."], ["content", ANSWER]]);
  });

  test("a streamed upstream reply to a non-streaming client collects the converted strings", async () => {
    const response = await chat(sse([delta({ content: [thinking("Synthetic reasoning."), text(ANSWER)] }), terminal]), false);
    expect(response.status).toBe(200);
    const body = await response.json() as { choices: { message: Record<string, unknown> }[] };
    expect(body.choices[0]!.message).toMatchObject({ content: ANSWER, reasoning_content: "Synthetic reasoning." });
  });

  test("an unsupported block fails closed in both delivery shapes", async () => {
    const streamed = await frames(await chat(sse([delta({ content: [{ type: "image_url", image_url: "x" }] }), terminal]), true));
    expect(streamed.raw).toContain("upstream_sse_invalid");
    expect(runs(streamed.chunks)).toEqual([]);
    const buffered = await chat(Response.json(completion([{ type: "audio" }])), false);
    expect(buffered.status).toBe(502);
    expect(await buffered.json()).toMatchObject({ error: { type: "upstream_error" } });
  });

  test("other destinations keep relaying their content unchanged", async () => {
    const content = [thinking("kept"), text("as-is")];
    const response = await chat(sse([delta({ content }), terminal]), true, "https://chat.example.test/v1");
    const { chunks } = await frames(response);
    expect(chunks[0]!.choices[0]!.delta.content).toEqual(content);
  });
});
