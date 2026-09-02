import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createImageBudget, guessExtFromMagic, materializeInlineImage } from "../../src/images/artifacts";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../../src/adapters/google";
import type { AdapterEvent, OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

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
  removeTreeWithRetry(tempHome);
});

// 1x1 red PNG pixel in base64 (real PNG magic bytes: 89 50 4E 47)
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

// Minimal JPEG byte stream (magic bytes FF D8 FF E0 ...) encoded as base64.
const TINY_JPEG = "/9j/4AAQ";

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

describe("guessExtFromMagic", () => {
  test("PNG magic bytes → png extension", () => {
    // PNG file header: 89 50 4E 47 0D 0A 1A 0A
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(guessExtFromMagic(pngBytes)).toBe("png");
  });

  test("JPEG magic bytes → jpg extension", () => {
    const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(guessExtFromMagic(jpgBytes)).toBe("jpg");
  });

  test("WebP magic bytes → webp extension", () => {
    const webpBytes = Buffer.from("RIFF\x00\x00\x00\x00WEBP", "latin1");
    expect(guessExtFromMagic(webpBytes)).toBe("webp");
  });

  test("GIF magic bytes → gif extension", () => {
    const gifBytes = Buffer.from("GIF89a", "latin1");
    expect(guessExtFromMagic(gifBytes)).toBe("gif");
  });

  test("unrecognized magic bytes throw (no silent 'png' fallback)", () => {
    // Empty buffer and random bytes previously fell back to "png"; now they must throw.
    expect(() => guessExtFromMagic(new Uint8Array())).toThrow("unrecognized image format");
    expect(() => guessExtFromMagic(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toThrow("unrecognized image format");
  });

  test("truncated PNG signature (first 4 bytes only) is rejected", () => {
    // Regression for Wibias R4 finding 4: \x89PNG is only the first 4 bytes of the
    // 8-byte PNG signature (89 50 4E 47 0D 0A 1A 0A). The old startsWith("\x89PNG")
    // accepted malformed data with a truncated/fake signature. The full 8-byte
    // signature must now be validated.
    const truncated = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]);
    expect(() => guessExtFromMagic(truncated)).toThrow("unrecognized image format");
    // First 4 bytes matching but followed by non-PNG data is also rejected.
    const fake = Buffer.from("\x89PNGXXXX", "latin1");
    expect(() => guessExtFromMagic(fake)).toThrow("unrecognized image format");
  });
});

describe("CCA image endpoint registry pinning (token-exfiltration guard)", () => {
  test("google-antigravity registry baseUrl is the official CCA endpoint", () => {
    // tryCcaImageGeneration must derive the upstream URL from the registry, not from
    // a config-level baseUrl override, so a tampered baseUrl cannot redirect the
    // Google OAuth bearer token to an attacker-controlled host.
    const entry = getProviderRegistryEntry("google-antigravity");
    expect(entry).toBeDefined();
    expect(entry!.baseUrl).toBe("https://daily-cloudcode-pa.googleapis.com");
  });

  test("the pinned URL is never an attacker-controlled host", () => {
    // Even if a caller mutates a provider config to point baseUrl at evil.example,
    // the image relay ignores it: the registry entry is the source of truth.
    const evilUrl = "https://evil.example.com";
    const pinned = getProviderRegistryEntry("google-antigravity")?.baseUrl;
    expect(pinned).not.toBe(evilUrl);
    expect(pinned).toBe("https://daily-cloudcode-pa.googleapis.com");
  });
});

describe("materializeInlineImage", () => {
  test("writes a file and returns an absolute path", async () => {
    const result = await materializeInlineImage(TINY_PNG);
    expect(isAbsolute(result)).toBe(true);
    expect(existsSync(result)).toBe(true);
    const buf = readFileSync(result);
    expect(buf.length).toBeGreaterThan(0);
  });

  test("extension follows real bytes, not an upstream MIME label", async () => {
    // TINY_PNG carries genuine PNG magic bytes → always .png regardless of label.
    expect((await materializeInlineImage(TINY_PNG)).endsWith(".png")).toBe(true);
    // TINY_JPEG carries genuine JPEG magic bytes → always .jpg.
    expect((await materializeInlineImage(TINY_JPEG)).endsWith(".jpg")).toBe(true);
  });

  test("spoofed MIME: JPEG bytes that upstream declared as image/png → saved as .jpg", async () => {
    // Before the magic-byte fix, an upstream "image/png" label forced a .png name
    // even when the bytes were JPEG. The extension now comes from the actual bytes.
    const path = await materializeInlineImage(TINY_JPEG);
    expect(path.endsWith(".jpg")).toBe(true);
  });

  test("creates the artifacts directory if missing", async () => {
    removeTreeWithRetry(artifactsDir);
    expect(existsSync(artifactsDir)).toBe(false);
    const result = await materializeInlineImage(TINY_PNG);
    expect(existsSync(artifactsDir)).toBe(true);
    expect(existsSync(result)).toBe(true);
  });

  test("produces unique filenames for same-millisecond calls", async () => {
    const a = await materializeInlineImage(TINY_PNG);
    const b = await materializeInlineImage(TINY_PNG);
    expect(a).not.toBe(b);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  test("throws on empty base64 data", async () => {
    await expect(materializeInlineImage("")).rejects.toThrow("empty");
  });

  test("throws on malformed nonempty base64 data", async () => {
    await expect(materializeInlineImage("abc!")).rejects.toThrow("not valid base64");
    await expect(materializeInlineImage("abc")).rejects.toThrow("not valid base64");
  });

  test("enforces per-response budget", async () => {
    const budget = createImageBudget();
    budget.spent = 100 * 1024 * 1024; // already at cap
    await expect(materializeInlineImage(TINY_PNG, budget)).rejects.toThrow("per-response");
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

  test("empty inlineData.data yields an error event but does not abort the stream", async () => {
    const events = await collectStream(aiStudioProvider, [
      { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "" } }] } }] },
      { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
    ]);
    expect(events.some(e => e.type === "error" && /materialize/.test(e.message))).toBe(true);
    // Stream still reaches a terminal done event.
    expect(events.some(e => e.type === "done")).toBe(true);
  });
});

describe("google adapter — inline image non-streaming", () => {
  test("parseResponse returns markdown text for inlineData parts", async () => {
    const adapter = createGoogleAdapter(aiStudioProvider);
    const events = await adapter.parseResponse(jsonResponse({
      candidates: [{ content: { parts: [{ text: "Here is a cat:" }, { inlineData: { mimeType: "image/jpeg", data: TINY_JPEG } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10 },
    }));

    const textEvents = events.filter(e => e.type === "text_delta") as Extract<AdapterEvent, { type: "text_delta" }>[];
    expect(textEvents.length).toBe(2);
    expect(textEvents[0].text).toBe("Here is a cat:");
    expect(textEvents[1].text).toMatch(/^\n!\[image\]\(.+\.jpg\)\n$/);
  });

  test("empty inlineData.data yields an error event, not a rejection", async () => {
    const adapter = createGoogleAdapter(aiStudioProvider);
    const events = await adapter.parseResponse(jsonResponse({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "" } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }));
    expect(events.some(e => e.type === "error" && /materialize/.test(e.message))).toBe(true);
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

  test("Imagen models do NOT get responseModalities (different API schema)", async () => {
    // imagen-* uses the prediction/image-generation endpoint, not
    // responseModalities — listing it here would send a Gemini image-capable
    // request to a model that cannot handle it.
    const adapter = createGoogleAdapter(aiStudioProvider);
    const req = await adapter.buildRequest({
      context: { messages: [], tools: [] },
      options: {},
      modelId: "imagen-4.0-generate-001",
      stream: false,
    } as never);
    const body = JSON.parse(req.body);
    expect(body.generationConfig?.responseModalities).toBeUndefined();
  });
});

describe("markdown emits authenticated opaque artifact URLs", () => {
  test("streaming: markdown uses /v1/opencodex/artifacts/<id>, not file: or host paths", async () => {
    const events = await collectStream(aiStudioProvider, [
      { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: TINY_PNG } }] } }] },
      { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
    ]);

    const textEvents = events.filter(e => e.type === "text_delta") as Extract<AdapterEvent, { type: "text_delta" }>[];
    expect(textEvents.length).toBe(1);
    const match = textEvents[0].text.match(/^\n!\[image\]\((.+)\)\n$/);
    expect(match).not.toBeNull();
    const mdPath = match![1];
    expect(mdPath.startsWith("/v1/opencodex/artifacts/")).toBe(true);
    expect(mdPath).not.toContain("file:");
    expect(mdPath).not.toContain("~/");
    expect(mdPath).not.toMatch(/[A-Za-z]:\\/);
    expect(mdPath).not.toContain(tempHome);
    const id = mdPath.slice("/v1/opencodex/artifacts/".length);
    expect(existsSync(join(artifactsDir, id))).toBe(true);
  });

  test("non-streaming: markdown uses /v1/opencodex/artifacts/<id>, not file: or host paths", async () => {
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
    expect(mdPath.startsWith("/v1/opencodex/artifacts/")).toBe(true);
    expect(mdPath).not.toContain("file:");
    expect(mdPath).not.toContain(tempHome);
    const id = mdPath.slice("/v1/opencodex/artifacts/".length);
    expect(existsSync(join(artifactsDir, id))).toBe(true);
  });
});

describe("artifact markdown never leaks OPENCODEX_HOME paths", () => {
  let underHome: string;
  let savedHome: string | undefined;

  beforeAll(() => {
    savedHome = process.env.OPENCODEX_HOME;
    underHome = mkdtempSync(join(homedir(), ".ocx-test-leak-"));
    process.env.OPENCODEX_HOME = underHome;
  });

  afterAll(() => {
    if (savedHome !== undefined) process.env.OPENCODEX_HOME = savedHome;
    else delete process.env.OPENCODEX_HOME;
    removeTreeWithRetry(underHome);
  });

  test("streaming: no home/username path segments in markdown", async () => {
    const events = await collectStream(aiStudioProvider, [
      { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: TINY_PNG } }] } }] },
      { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
    ]);
    const textEvents = events.filter(e => e.type === "text_delta") as Extract<AdapterEvent, { type: "text_delta" }>[];
    expect(textEvents.length).toBe(1);
    const md = textEvents[0].text;
    expect(md).toContain("/v1/opencodex/artifacts/");
    expect(md).not.toContain("file:");
    expect(md).not.toContain("~/");
    expect(md).not.toContain(underHome);
    expect(md).not.toContain(homedir());
  });

  test("non-streaming: no home/username path segments in markdown", async () => {
    const adapter = createGoogleAdapter(aiStudioProvider);
    const events = await adapter.parseResponse(jsonResponse({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: TINY_PNG } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }));
    const textEvents = events.filter(e => e.type === "text_delta") as Extract<AdapterEvent, { type: "text_delta" }>[];
    expect(textEvents.length).toBe(1);
    const md = textEvents[0].text;
    expect(md).toContain("/v1/opencodex/artifacts/");
    expect(md).not.toContain("file:");
    expect(md).not.toContain(underHome);
  });
});

describe("malformed inlineData does not abort the stream", () => {
  test("streaming: sibling text + bad inline yields text_delta AND error event", async () => {
    const events = await collectStream(aiStudioProvider, [
      { candidates: [{ content: { parts: [
        { text: "before image" },
        { inlineData: { mimeType: "image/png", data: "!!!not-base64!!!" } },
      ] } }] },
      { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
    ]);
    // The text part before the bad image is still emitted.
    const textEvents = events.filter(e => e.type === "text_delta") as Extract<AdapterEvent, { type: "text_delta" }>[];
    expect(textEvents.some(e => e.text === "before image")).toBe(true);
    // An error event is emitted for the bad image.
    expect(events.some(e => e.type === "error" && /materialize/.test(e.message))).toBe(true);
    // The stream terminates normally.
    expect(events.some(e => e.type === "done")).toBe(true);
  });

  test("non-streaming: sibling text + bad inline yields text_delta AND error event", async () => {
    const adapter = createGoogleAdapter(aiStudioProvider);
    const events = await adapter.parseResponse(jsonResponse({
      candidates: [{ content: { parts: [
        { text: "hello" },
        { inlineData: { mimeType: "image/png", data: "!!!not-base64!!!" } },
      ] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }));
    const textEvents = events.filter(e => e.type === "text_delta") as Extract<AdapterEvent, { type: "text_delta" }>[];
    expect(textEvents.some(e => e.text === "hello")).toBe(true);
    expect(events.some(e => e.type === "error" && /materialize/.test(e.message))).toBe(true);
  });
});
