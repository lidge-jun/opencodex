import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKiroAdapter } from "../src/adapters/kiro";
import { normalizeKiroImages, KIRO_IMAGE_BASE64_BUDGET, KIRO_MAX_IMAGES_PER_MESSAGE, type KiroImage } from "../src/adapters/kiro-images";
import { resetNormalizeStateForTests, TIER_SPECS, type EncodeFn } from "../src/adapters/anthropic-image-normalize";
import { sniffImageDimensions } from "../src/adapters/anthropic-image-guard";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const origHome = process.env.HOME;
const origRegion = process.env.KIRO_REGION;
const origArn = process.env.KIRO_PROFILE_ARN;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kiro-images-"));
  process.env.HOME = tmp;
  process.env.KIRO_REGION = "us-east-1";
  delete process.env.KIRO_PROFILE_ARN;
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origRegion === undefined) delete process.env.KIRO_REGION; else process.env.KIRO_REGION = origRegion;
  if (origArn === undefined) delete process.env.KIRO_PROFILE_ARN; else process.env.KIRO_PROFILE_ARN = origArn;
  removeTreeWithRetry(tmp);
});

const provider = { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", apiKey: "tok-123" } as unknown as OcxProviderConfig;

function parsedWith(messages: unknown[]): OcxParsedRequest {
  return { modelId: "claude-sonnet-4.5", stream: true, options: {}, context: { messages } } as unknown as OcxParsedRequest;
}

function currentUim(body: string): Record<string, unknown> {
  return JSON.parse(body).conversationState.currentMessage.userInputMessage as Record<string, unknown>;
}

describe("kiro adapter — native images", () => {
  test("data URL image attaches to userInputMessage.images", async () => {
    const messages = [{
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image", imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
      ],
    }];
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith(messages));
    const uim = currentUim(body);
    expect(uim.images).toEqual([{ format: "png", source: { bytes: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" } }]);
    // text still extracted, image NOT inlined as text
    expect(uim.content).toContain("what is this");
    expect(String(uim.content)).not.toContain("AAAA");
  });

  test("jpeg data URL prefix stripped, format derived", async () => {
    const messages = [{
      role: "user",
      content: [{ type: "image", imageUrl: "data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }],
    }];
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith(messages));
    expect(currentUim(body).images).toEqual([{ format: "jpeg", source: { bytes: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" } }]);
  });

  test("remote https image is skipped (no images field, no throw)", async () => {
    const messages = [{
      role: "user",
      content: [
        { type: "text", text: "see this" },
        { type: "image", imageUrl: "https://example.com/cat.png" },
      ],
    }];
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith(messages));
    expect(currentUim(body).images).toBeUndefined();
  });

  test("text-only message has no images field (back-compat)", async () => {
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "hi" }]));
    expect(currentUim(body).images).toBeUndefined();
  });

  test("multiple images preserved in order", async () => {
    const messages = [{
      role: "user",
      content: [
        { type: "image", imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
        { type: "image", imageUrl: "data:image/webp;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
      ],
    }];
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith(messages));
    expect(currentUim(body).images).toEqual([
      { format: "png", source: { bytes: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" } },
      { format: "webp", source: { bytes: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" } },
    ]);
  });
});

// --- Generous image pipeline on the kiro wire (devlog 260714 .../050, K1-K4) ---

const ONE_PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function realPngB64(width: number, height: number): Promise<string> {
  const buf = await new Bun.Image(Buffer.from(ONE_PX_PNG, "base64")).resize(width, height).png().toBuffer();
  return Buffer.from(buf).toString("base64");
}

function u32be(n: number): number[] { return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]; }

/** Sniffable-header PNG padded to an exact decoded size (not fully decodable). */
function fakePngB64(width: number, height: number, decodedBytes = 0): string {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), 0x49, 0x48, 0x44, 0x52, ...u32be(width), ...u32be(height), 8, 6, 0, 0, 0];
  const buf = Buffer.alloc(Math.max(header.length, decodedBytes));
  Buffer.from(Uint8Array.from(header)).copy(buf);
  return buf.toString("base64");
}

function kiroPayload(carriers: Array<{ content: string; images?: KiroImage[] }>): Record<string, unknown> {
  const entries = carriers.map(c => ({ userInputMessage: { content: c.content, ...(c.images ? { images: c.images } : {}) } }));
  const current = entries.pop()!;
  return { conversationState: { chatTriggerType: "MANUAL", conversationId: "c", currentMessage: current, ...(entries.length ? { history: entries } : {}) } };
}

function img(bytes: string, format = "png"): KiroImage {
  return { format, source: { bytes } };
}

const sizedEncoder = (sizeFor: (maxEdge: number) => number): EncodeFn =>
  (_input, spec) => {
    const b64len = sizeFor(spec.maxEdge);
    const decoded = (b64len / 4) * 3;
    return Promise.resolve({ data: fakePngB64(Math.min(spec.maxEdge, 500), Math.min(spec.maxEdge, 500), decoded), mediaType: "image/jpeg" });
  };

describe("kiro generous image pipeline", () => {
  beforeEach(() => resetNormalizeStateForTests());

  test("K1: oversized-dimension image is re-encoded through the real adapter wiring", async () => {
    const big = await realPngB64(4000, 3000);
    const { body } = await createKiroAdapter(provider).buildRequest(parsedWith([
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", imageUrl: `data:image/png;base64,${big}` }], timestamp: 0 },
    ]));
    const uim = currentUim(body as string);
    const images = uim.images as KiroImage[];
    expect(images).toHaveLength(1);
    expect(images[0].format).toBe("jpeg");
    const d = sniffImageDimensions(images[0].source.bytes);
    expect(Math.max(d!.width, d!.height)).toBeLessThanOrEqual(2000);
  });

  test("K2: 21 images in one message — oldest dropped by the per-message cap with the count note", async () => {
    const payload = kiroPayload([{ content: "look", images: Array.from({ length: 21 }, () => img(ONE_PX_PNG)) }]);
    await normalizeKiroImages(payload);
    const uim = (payload.conversationState as Record<string, any>).currentMessage.userInputMessage;
    expect(uim.images).toHaveLength(KIRO_MAX_IMAGES_PER_MESSAGE);
    expect(uim.content).toContain("per-message cap");
  });

  test("K2c: a message whose sole image is undecodable loses the images field entirely", async () => {
    const payload = kiroPayload([
      { content: "old", images: [img(Buffer.from("not an image").toString("base64"))] },
      { content: "current" },
    ]);
    await normalizeKiroImages(payload);
    const hist = (payload.conversationState as Record<string, any>).history[0].userInputMessage;
    expect(hist.images).toBeUndefined();
    expect(hist.content).toContain("undecodable");
  });

  test("K3 (regression): in-cap image passes through byte-identical — no needless re-encode", async () => {
    const small = await realPngB64(400, 300);
    const payload = kiroPayload([{ content: "look", images: [img(small)] }]);
    await normalizeKiroImages(payload);
    const uim = (payload.conversationState as Record<string, any>).currentMessage.userInputMessage;
    expect(uim.images[0]).toEqual({ format: "png", source: { bytes: small } });
  });

  test("K4: over-budget totals demote the OLDEST entry first through normalizeKiroImages, sum within budget", async () => {
    const capFitting = sizedEncoder(edge => {
      const spec = TIER_SPECS.find(s => s.maxEdge === edge)!;
      return Number.isFinite(spec.hardCap) ? spec.hardCap : 100 * 1024;
    });
    // 30 carriers × 1 image each, all over-dimension so every one is encoded.
    const payload = kiroPayload(Array.from({ length: 30 }, (_, i) => ({ content: `m${i}`, images: [img(fakePngB64(3000, 2000))] })));
    await normalizeKiroImages(payload, { encode: capFitting });
    const state = payload.conversationState as Record<string, any>;
    const carriers = [...(state.history ?? []).map((h: any) => h.userInputMessage), state.currentMessage.userInputMessage];
    let sum = 0;
    for (const c of carriers) for (const im of c.images ?? []) sum += im.source.bytes.length;
    expect(sum).toBeLessThanOrEqual(KIRO_IMAGE_BASE64_BUDGET);
    // Oldest carrier's image was demoted below tier 2 (100KiB floor), newest kept tier-0 size.
    expect(carriers[0].images[0].source.bytes.length).toBe(100 * 1024);
    expect(carriers[29].images[0].source.bytes.length).toBe(TIER_SPECS[0].hardCap);
  });

  test("K4b: all-terminal overflow DROPS oldest images (kiro has no downstream guard)", async () => {
    const stubborn = sizedEncoder(() => 3 * 1024 * 1024);
    const payload = kiroPayload(Array.from({ length: 10 }, (_, i) => ({ content: `m${i}`, images: [img(fakePngB64(3000, 2000))] })));
    await normalizeKiroImages(payload, { encode: stubborn });
    const state = payload.conversationState as Record<string, any>;
    const carriers = [...(state.history ?? []).map((h: any) => h.userInputMessage), state.currentMessage.userInputMessage];
    let sum = 0;
    let dropped = 0;
    for (const c of carriers) {
      if (!c.images) { dropped++; expect(c.content).toContain("older images were dropped"); }
      else for (const im of c.images) sum += im.source.bytes.length;
    }
    expect(dropped).toBeGreaterThan(0);
    expect(sum).toBeLessThanOrEqual(KIRO_IMAGE_BASE64_BUDGET);
  });
});

test("K2b: tool-result image rides its carrier and is normalized through the real wiring", async () => {
  resetNormalizeStateForTests();
  const big = await realPngB64(4000, 3000);
  // Declared tool makes the tool result STRUCTURED (pendingImages path, kiro.ts:293),
  // not the fallback text carrier — C-gate round 1 blocker.
  const req = parsedWith([
    { role: "user", content: "run it", timestamp: 0 },
    { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "shot", arguments: {} }], model: "m", timestamp: 0 },
    { role: "toolResult", toolCallId: "t1", toolName: "shot", isError: false, timestamp: 0,
      content: [{ type: "text", text: "captured" }, { type: "image", imageUrl: `data:image/png;base64,${big}` }] },
  ]);
  (req.context as { tools?: unknown[] }).tools = [{ name: "shot", description: "screenshot", parameters: { type: "object" } }];
  const { body } = await createKiroAdapter(provider).buildRequest(req);
  const parsed = JSON.parse(body as string).conversationState as Record<string, any>;
  const carriers = [...(parsed.history ?? []).map((h: any) => h.userInputMessage).filter(Boolean), parsed.currentMessage.userInputMessage];
  // Structured path proof: the image's carrier also carries toolResults context.
  expect(carriers.some((c: any) => c?.userInputMessageContext?.toolResults && (c.images?.length ?? 0) > 0)).toBe(true);
  const allImages = carriers.flatMap((c: any) => c.images ?? []);
  expect(allImages).toHaveLength(1);
  expect(allImages[0].format).toBe("jpeg");
  const d = sniffImageDimensions(allImages[0].source.bytes);
  expect(Math.max(d!.width, d!.height)).toBeLessThanOrEqual(2000);
});
