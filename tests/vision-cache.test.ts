import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as oauthModule from "../src/oauth";

mock.module("../src/oauth", () => ({ ...oauthModule, getValidAccessToken: async () => "vision-cache-token" }));

import { parseRequest } from "../src/responses/parser";
import type { OcxConfig, OcxContentPart, OcxProviderConfig } from "../src/types";
import {
  describeImagesInPlace,
  resetVisionDescriptionCache,
  resolveMaxDescriptionsPerTurn,
  setVisionDescriptionCache,
  shouldResolveOpenAiVisionSidecar,
  type VisionPlan,
} from "../src/vision";

const DATA_A = "data:image/png;base64,YQ==";
const DATA_B = "data:image/png;base64,Yg==";
const DATA_C = "data:image/png;base64,Yw==";
const openaiProvider: OcxProviderConfig = {
  adapter: "openai-responses",
  authMode: "forward",
  baseUrl: "https://openai-vision.test/v1",
};
const anthropicProvider: OcxProviderConfig = {
  adapter: "anthropic",
  authMode: "oauth",
  baseUrl: "https://anthropic-vision.test",
};

const textOnlyProvider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://routed.test/v1",
  apiKey: "routed",
  noVisionModels: ["text-model"],
};

function plan(overrides: Partial<VisionPlan> = {}): VisionPlan {
  return {
    backend: "openai",
    forwardSidecar: {
      providerName: "openai",
      provider: openaiProvider,
      accountMode: "direct",
      authContext: { kind: "main", accountId: null },
      headers: new Headers({ Authorization: "Bearer test" }),
    },
    settings: { model: "vision-model-a", timeoutMs: 5000 },
    maxDescriptionsPerTurn: 8,
    ...overrides,
  };
}

test("vision sidecar auth stays lazy for no-image and disabled branches", () => {
  const cfg: OcxConfig = { port: 10100, defaultProvider: "routed", providers: { routed: textOnlyProvider } };
  const noImage = parseRequest({ model: "routed/text-model", input: "text only" });
  const withImage = parseRequest({
    model: "routed/text-model",
    input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: DATA_A }] }],
  });
  expect(shouldResolveOpenAiVisionSidecar(cfg, textOnlyProvider, "text-model", noImage)).toBe(false);
  expect(shouldResolveOpenAiVisionSidecar(
    { ...cfg, visionSidecar: { enabled: false } },
    textOnlyProvider,
    "text-model",
    withImage,
  )).toBe(false);
  expect(shouldResolveOpenAiVisionSidecar(cfg, textOnlyProvider, "text-model", withImage)).toBe(true);
});

function parsed(parts: Array<Record<string, unknown>>) {
  return parseRequest({
    model: "routed/blind",
    input: [{ type: "message", role: "user", content: parts }],
  });
}

function parsedMessages(messages: Array<Array<Record<string, unknown>>>) {
  return parseRequest({
    model: "routed/blind",
    input: messages.map(content => ({ type: "message", role: "user", content })),
  });
}

function openaiSse(text: string): Response {
  return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function anthropicSse(text: string): Response {
  return new Response(`data: ${JSON.stringify({
    type: "content_block_delta",
    delta: { type: "text_delta", text },
  })}\n\n`, { headers: { "content-type": "text/event-stream" } });
}

function imageCaption(body: Record<string, unknown>): string {
  const input = body.input as Array<{ content: Array<{ image_url?: string }> }> | undefined;
  const imageUrl = input?.[0]?.content.find(part => part.image_url)?.image_url ?? "";
  if (imageUrl === DATA_A) return "caption-a";
  if (imageUrl === DATA_B) return "caption-b";
  if (imageUrl === DATA_C) return "caption-c";
  return "caption-unknown";
}

function textParts(request: ReturnType<typeof parsed>, messageIndex = 0): string[] {
  const content = request.context.messages.filter(message => message.role === "user")[messageIndex]?.content;
  return (content as OcxContentPart[]).filter(part => part.type === "text").map(part => part.text);
}

describe("vision description cache and per-turn cap", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setVisionDescriptionCache();
    resetVisionDescriptionCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setVisionDescriptionCache();
  });

  test("normalizes maxDescriptionsPerTurn while preserving an explicit zero", () => {
    expect(resolveMaxDescriptionsPerTurn(0)).toBe(0);
    expect(resolveMaxDescriptionsPerTurn(3)).toBe(3);
    expect(resolveMaxDescriptionsPerTurn(-1)).toBe(8);
    expect(resolveMaxDescriptionsPerTurn(1.5)).toBe(8);
    expect(resolveMaxDescriptionsPerTurn(Number.NaN)).toBe(8);
  });

  test("maxDescriptionsPerTurn=0 emits a cap marker without calling an executor", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return openaiSse("unexpected"); }) as typeof fetch;
    const request = parsed([
      { type: "input_text", text: "look" },
      { type: "input_image", image_url: DATA_A },
    ]);

    await describeImagesInPlace(request, plan({ maxDescriptionsPerTurn: 0 }), new Headers({ authorization: "Bearer test" }));

    expect(calls).toBe(0);
    expect(textParts(request).join("\n")).toContain("description cap reached");
  });

  test("duplicate data images are single-flight and later turns hit the process cache", async () => {
    let calls = 0;
    globalThis.fetch = (async (_url, init) => {
      calls += 1;
      await Promise.resolve();
      return openaiSse(imageCaption(JSON.parse(String(init?.body))));
    }) as typeof fetch;
    const duplicate = parsed([
      { type: "input_text", text: "same context" },
      { type: "input_image", image_url: DATA_A },
      { type: "input_image", image_url: DATA_A },
    ]);

    await describeImagesInPlace(duplicate, plan(), new Headers({ authorization: "Bearer test" }));
    expect(calls).toBe(1);
    expect(textParts(duplicate).filter(text => text.includes("caption-a"))).toHaveLength(2);

    const nextTurn = parsed([
      { type: "input_text", text: "same context" },
      { type: "input_image", image_url: DATA_A },
    ]);
    await describeImagesInPlace(nextTurn, plan(), new Headers({ authorization: "Bearer test" }));
    expect(calls).toBe(1);
    expect(textParts(nextTurn).join("\n")).toContain("caption-a");
  });

  test("failed and empty outcomes are not cached", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls <= 2) return new Response("failed", { status: 500 });
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    for (let i = 0; i < 2; i++) {
      await describeImagesInPlace(parsed([{ type: "input_image", image_url: DATA_A }]), plan(), new Headers({ authorization: "Bearer test" }));
    }
    for (let i = 0; i < 2; i++) {
      await describeImagesInPlace(parsed([{ type: "input_image", image_url: DATA_B }]), plan(), new Headers({ authorization: "Bearer test" }));
    }
    expect(calls).toBe(4);
  });

  test("interleaves hits, misses, and over-cap markers without changing message or part order", async () => {
    globalThis.fetch = (async (_url, init) => openaiSse(imageCaption(JSON.parse(String(init?.body))))) as typeof fetch;
    const headers = new Headers({ authorization: "Bearer test" });

    await describeImagesInPlace(parsed([
      { type: "input_text", text: "same" },
      { type: "input_image", image_url: DATA_A },
    ]), plan(), headers);

    let calls = 0;
    globalThis.fetch = (async (_url, init) => {
      calls += 1;
      return openaiSse(imageCaption(JSON.parse(String(init?.body))));
    }) as typeof fetch;
    const request = parsedMessages([
      [
        { type: "input_text", text: "same" },
        { type: "input_image", image_url: DATA_A },
        { type: "input_image", image_url: DATA_B },
        { type: "input_image", image_url: DATA_C },
      ],
      [
        { type: "input_text", text: "same" },
        { type: "input_image", image_url: DATA_A },
      ],
    ]);

    await describeImagesInPlace(request, plan({ maxDescriptionsPerTurn: 1 }), headers);

    expect(calls).toBe(1);
    const first = textParts(request, 0).join("\n");
    expect(first.indexOf("caption-a")).toBeLessThan(first.indexOf("caption-b"));
    expect(first.indexOf("caption-b")).toBeLessThan(first.indexOf("description cap reached"));
    expect(textParts(request, 1).join("\n")).toContain("caption-a");
  });

  test("separates cache keys by backend, model, detail, and normalized context", async () => {
    let calls = 0;
    globalThis.fetch = (async (url, init) => {
      calls += 1;
      return String(url).includes("anthropic") ? anthropicSse(`anthropic-${calls}`) : openaiSse(`openai-${calls}`);
    }) as typeof fetch;
    const headers = new Headers({ authorization: "Bearer test" });
    const run = async (visionPlan: VisionPlan, context: string, detail = "high") => {
      await describeImagesInPlace(parsed([
        { type: "input_text", text: context },
        { type: "input_image", image_url: DATA_A, detail },
      ]), visionPlan, headers);
    };

    await run(plan(), "hello   world");
    await run(plan(), "hello world"); // normalized-context hit
    await run(plan(), "hello world", "low");
    await run(plan({ settings: { model: "vision-model-b", timeoutMs: 5000 } }), "hello world");
    await run(plan(), "different context");
    await run(plan({
      backend: "anthropic",
      forwardProvider: undefined,
      anthropicSidecar: { providerName: "anthropic-cache-test", provider: anthropicProvider },
    }), "hello world");

    expect(calls).toBe(5);
  });
});
