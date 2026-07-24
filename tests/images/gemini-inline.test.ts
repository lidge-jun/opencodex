import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createImageBudget, materializeInlineImage } from "../../src/images/artifacts";
import { createGoogleAdapter } from "../../src/adapters/google";
import type { AdapterEvent, OcxProviderConfig } from "../../src/types";

let tempHome: string;
let artifactsDir: string;
let savedHome: string | undefined;

beforeAll(() => {
  savedHome = process.env.OPENCODEX_HOME;
  tempHome = mkdtempSync(join(tmpdir(), "ocx-test-"));
  process.env.OPENCODEX_HOME = tempHome;
  artifactsDir = join(tempHome, "artifacts");
});

afterAll(() => {
  if (savedHome !== undefined) process.env.OPENCODEX_HOME = savedHome;
  else delete process.env.OPENCODEX_HOME;
  rmSync(tempHome, { recursive: true, force: true });
});

// 1x1 red PNG pixel in base64
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n`).join("\n") + "\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
}

async function collectStream(provider: OcxProviderConfig, chunks: unknown[]): Promise<AdapterEvent[]> {
  const adapter = createGoogleAdapter(provider);
  const events: AdapterEvent[] = [];
  for await (const ev of adapter.parseStream(sseResponse(chunks))) events.push(ev);
  return events;
}

const aiStudioProvider = { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "key" } as OcxProviderConfig;

describe("materializeInlineImage", () => {
  test("writes a file and returns an absolute path", async () => {
    const result = await materializeInlineImage("image/png", TINY_PNG);
    expect(isAbsolute(result)).toBe(true);
    expect(existsSync(result)).toBe(true);
    const buf = readFileSync(result);
    expect(buf.length).toBeGreaterThan(0);
  });

  test("maps mimeType to correct extension", async () => {
    expect((await materializeInlineImage("image/png", TINY_PNG)).endsWith(".png")).toBe(true);
    expect((await materializeInlineImage("image/jpeg", TINY_PNG)).endsWith(".jpg")).toBe(true);
    expect((await materializeInlineImage("image/webp", TINY_PNG)).endsWith(".webp")).toBe(true);
    expect((await materializeInlineImage("image/gif", TINY_PNG)).endsWith(".gif")).toBe(true);
    expect((await materializeInlineImage("image/bmp", TINY_PNG)).endsWith(".png")).toBe(true);
  });

  test("creates the artifacts directory if missing", async () => {
    rmSync(artifactsDir, { recursive: true, force: true });
    expect(existsSync(artifactsDir)).toBe(false);
    const result = await materializeInlineImage("image/png", TINY_PNG);
    expect(existsSync(artifactsDir)).toBe(true);
    expect(existsSync(result)).toBe(true);
  });

  test("produces unique filenames for same-millisecond calls", async () => {
    const a = await materializeInlineImage("image/png", TINY_PNG);
    const b = await materializeInlineImage("image/png", TINY_PNG);
    expect(a).not.toBe(b);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  test("throws on empty base64 data", async () => {
    await expect(materializeInlineImage("image/png", "")).rejects.toThrow("empty");
  });

  test("throws on malformed nonempty base64 data", async () => {
    await expect(materializeInlineImage("image/png", "abc!")).rejects.toThrow("not valid base64");
    await expect(materializeInlineImage("image/png", "abc")).rejects.toThrow("not valid base64");
  });

  test("enforces per-response budget", async () => {
    const budget = createImageBudget();
    budget.spent = 100 * 1024 * 1024; // already at cap
    await expect(materializeInlineImage("image/png", TINY_PNG, budget)).rejects.toThrow("per-response");
  });
});

describe("google adapter — inline image streaming", () => {
  test("yields markdown text_delta when a chunk contains inlineData", async () => {
    const events = await collectStream(aiStudioProvider, [
      { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: TINY_PNG } }] } }] },
      { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
    ]);

    const textEvents = events.filter(e => e.type === "text_delta") as Extract<AdapterEvent, { type: "text_delta" }>[];
    expect(textEvents.length).toBe(1);
    expect(textEvents[0].text).toMatch(/^\n!\[image\]\(.+\.png\)\n$/);
    expect(events.some(e => e.type === "done")).toBe(true);
  });

  test("behaves unchanged when no inlineData is present (regression)", async () => {
    const events = await collectStream(aiStudioProvider, [
      { candidates: [{ content: { parts: [{ text: "hello world" }] } }] },
      { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } },
    ]);

    const textEvents = events.filter(e => e.type === "text_delta") as Extract<AdapterEvent, { type: "text_delta" }>[];
    expect(textEvents.length).toBe(1);
    expect(textEvents[0].text).toBe("hello world");
    const done = events.find(e => e.type === "done") as Extract<AdapterEvent, { type: "done" }>;
    expect(done.usage?.inputTokens).toBe(3);
    expect(done.usage?.outputTokens).toBe(2);
  });

  test("empty inlineData.data is rejected in streaming mode", async () => {
    await expect(collectStream(aiStudioProvider, [
      { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "" } }] } }] },
      { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
    ])).rejects.toThrow("empty");
  });
});

describe("google adapter — inline image non-streaming", () => {
  test("parseResponse returns markdown text for inlineData parts", async () => {
    const adapter = createGoogleAdapter(aiStudioProvider);
    const events = await adapter.parseResponse(jsonResponse({
      candidates: [{ content: { parts: [{ text: "Here is a cat:" }, { inlineData: { mimeType: "image/jpeg", data: TINY_PNG } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10 },
    }));

    const textEvents = events.filter(e => e.type === "text_delta") as Extract<AdapterEvent, { type: "text_delta" }>[];
    expect(textEvents.length).toBe(2);
    expect(textEvents[0].text).toBe("Here is a cat:");
    expect(textEvents[1].text).toMatch(/^\n!\[image\]\(.+\.jpg\)\n$/);
  });

  test("empty inlineData.data is rejected, not silently skipped", async () => {
    const adapter = createGoogleAdapter(aiStudioProvider);
    // In the non-streaming path, materializeInlineImage throws and propagates out of parseResponse.
    await expect(adapter.parseResponse(jsonResponse({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "" } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }))).rejects.toThrow("empty");
  });
});

describe("responseModalities gating", () => {
  test("image-capable model gets responseModalities in compiled wire body", async () => {
    const adapter = createGoogleAdapter(aiStudioProvider);
    const req = await adapter.buildRequest({
      context: { messages: [], tools: [] },
      options: {},
      modelId: "gemini-3.1-flash-image",
      stream: false,
    } as never);
    const body = JSON.parse(req.body);
    expect(body.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
  });

  test("non-image model does NOT get responseModalities", async () => {
    const adapter = createGoogleAdapter(aiStudioProvider);
    const req = await adapter.buildRequest({
      context: { messages: [], tools: [] },
      options: {},
      modelId: "gemini-3.6-flash",
      stream: false,
    } as never);
    const body = JSON.parse(req.body);
    expect(body.generationConfig).toBeUndefined();
  });
});

describe("markdown path escaping with special characters", () => {
  let specialHome: string;
  let savedHome: string | undefined;

  beforeAll(() => {
    savedHome = process.env.OPENCODEX_HOME;
    specialHome = mkdtempSync(join(tmpdir(), "ocx test (dir) "));
    process.env.OPENCODEX_HOME = specialHome;
  });

  afterAll(() => {
    if (savedHome !== undefined) process.env.OPENCODEX_HOME = savedHome;
    else delete process.env.OPENCODEX_HOME;
    rmSync(specialHome, { recursive: true, force: true });
  });

  test("streaming: escapes spaces and parentheses in emitted markdown path", async () => {
    const events = await collectStream(aiStudioProvider, [
      { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: TINY_PNG } }] } }] },
      { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
    ]);

    const textEvents = events.filter(e => e.type === "text_delta") as Extract<AdapterEvent, { type: "text_delta" }>[];
    expect(textEvents.length).toBe(1);
    const match = textEvents[0].text.match(/^\n!\[image\]\((.+)\)\n$/);
    expect(match).not.toBeNull();
    const mdPath = match![1];
    expect(mdPath).toContain("ocx\\ test\\ \\(dir\\)\\ ");
    expect(mdPath).not.toMatch(/(?<!\\)[ ()]/);
    const unescaped = mdPath.replace(/\\([() ])/g, "$1");
    expect(existsSync(unescaped)).toBe(true);
  });

  test("non-streaming: escapes spaces and parentheses in emitted markdown path", async () => {
    const adapter = createGoogleAdapter(aiStudioProvider);
    const events = await adapter.parseResponse(jsonResponse({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/webp", data: TINY_PNG } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 },
    }));

    const textEvents = events.filter(e => e.type === "text_delta") as Extract<AdapterEvent, { type: "text_delta" }>[];
    expect(textEvents.length).toBe(1);
    const match = textEvents[0].text.match(/^\n!\[image\]\((.+)\)\n$/);
    expect(match).not.toBeNull();
    const mdPath = match![1];
    expect(mdPath).toContain("ocx\\ test\\ \\(dir\\)\\ ");
    const unescaped = mdPath.replace(/\\([() ])/g, "$1");
    expect(existsSync(unescaped)).toBe(true);
  });
});
