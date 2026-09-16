import { beforeEach, describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { createMimoFreeAdapter, resetMimoJwtCache } from "../../../src/adapters/mimo-free";
import {
  hasShrinkableOpenAIChatImages,
  normalizeOpenAIChatImages,
  OPENAI_CHAT_IMAGE_BASE64_BUDGET,
} from "../../../src/adapters/openai-chat-images";
import {
  getNormalizeStatsForTests,
  resetNormalizeStateForTests,
  TIER_SPECS,
  type EncodeFn,
} from "../../../src/adapters/anthropic-image-normalize";
import type { OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

// Issue #4112 follow-up: chat-completions providers such as GitHub Copilot reject a body
// over roughly 5.2MB with a bare 413 and no diagnostic content. Nothing downstream of the
// adapter can shrink a built request, so inline image bytes are normalized here. Images are
// never dropped on this wire: there is no downstream guard that would re-attach them.

const provider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://api.githubcopilot.com",
  apiKey: "sk-test",
  authMode: "key",
};

const ONE_PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A real, decodable PNG of the requested size, upscaled from a 1px source. */
async function realPngB64(width: number, height: number): Promise<string> {
  const buf = await new Bun.Image(Buffer.from(ONE_PX_PNG, "base64")).resize(width, height).png().toBuffer();
  return Buffer.from(buf).toString("base64");
}

/**
 * A flat-colour PNG compresses to almost nothing, so budget behaviour needs incompressible
 * pixels. Deterministic noise is written as an uncompressed BMP and converted, which keeps
 * the fixture in-repo and the encoded size realistic.
 */
async function noisyPngB64(width: number, height: number): Promise<string> {
  const rowSize = width * 3 + ((4 - ((width * 3) % 4)) % 4);
  const pixelBytes = rowSize * height;
  const bmp = Buffer.alloc(54 + pixelBytes);
  bmp.write("BM", 0);
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(pixelBytes, 34);
  let seed = 0x2545f491;
  for (let y = 0; y < height; y++) {
    let offset = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
      bmp[offset++] = seed & 0xff;
      bmp[offset++] = (seed >>> 8) & 0xff;
      bmp[offset++] = (seed >>> 16) & 0xff;
    }
  }
  const png = await new Bun.Image(bmp).png().toBuffer();
  return Buffer.from(png).toString("base64");
}


/** Wrap raw base64 as a data URL, the only image form this wire normalizes. */
function dataUrl(b64: string, mediaType = "image/png"): string {
  return `data:${mediaType};base64,${b64}`;
}

interface ChatPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

interface ChatMsg {
  role: string;
  content?: string | ChatPart[];
}

/** Minimal parsed request carrying just the messages an adapter build needs. */
function parsedWith(messages: OcxMessage[]): OcxParsedRequest {
  return {
    modelId: "claude-opus-5",
    context: { messages },
    stream: false,
    options: {},
  } as unknown as OcxParsedRequest;
}

/** A user turn holding `text` plus one image per URL, in canonical (pre-wire) form. */
function imageMessage(urls: string[], text = "what is this"): OcxMessage {
  return {
    role: "user",
    content: [
      { type: "text", text },
      ...urls.map(url => ({ type: "image" as const, imageUrl: url })),
    ],
    timestamp: 0,
  } as unknown as OcxMessage;
}

/** Read the messages back out of a built request body. */
function wireMessages(body: string): ChatMsg[] {
  return (JSON.parse(body) as { messages: ChatMsg[] }).messages;
}

/** Every image part across the given messages, flattened. */
function imageParts(messages: ChatMsg[]): ChatPart[] {
  return messages.flatMap(m => (Array.isArray(m.content) ? m.content : [])).filter(p => p.type === "image_url");
}

/** Deterministic encoder: output size is a function of the tier's max edge. */
const sizedEncoder = (sizeFor: (maxEdge: number) => number): EncodeFn =>
  (_input, spec) => Promise.resolve({
    data: "A".repeat(sizeFor(spec.maxEdge)),
    mediaType: "image/jpeg",
  });

describe("openai-chat inline image normalization", () => {
  beforeEach(() => resetNormalizeStateForTests());

  test("a text-only turn builds synchronously and is unchanged", () => {
    const request = createOpenAIChatAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hello", timestamp: 0 } as unknown as OcxMessage]),
    );
    expect(request).not.toBeInstanceOf(Promise);
    const messages = wireMessages((request as { body: string }).body);
    expect(messages.at(-1)?.content).toBe("hello");
  });

  test("an image turn under the budget stays synchronous and keeps its exact bytes", async () => {
    const small = await realPngB64(8, 8);
    expect(hasShrinkableOpenAIChatImages([
      { role: "user", content: [{ type: "image_url", image_url: { url: dataUrl(small) } }] },
    ])).toBe(false);

    const request = createOpenAIChatAdapter(provider).buildRequest(parsedWith([imageMessage([dataUrl(small)])]));
    expect(request).not.toBeInstanceOf(Promise);
    const parts = imageParts(wireMessages((request as { body: string }).body));
    expect(parts).toHaveLength(1);
    expect(parts[0]?.image_url?.url).toBe(dataUrl(small));
  });

  test("an oversized turn is re-encoded through the adapter and keeps every image", async () => {
    const big = await noisyPngB64(1000, 1000);
    const urls = Array.from({ length: 4 }, () => dataUrl(big));
    expect(hasShrinkableOpenAIChatImages([
      { role: "user", content: urls.map(url => ({ type: "image_url", image_url: { url } })) },
    ])).toBe(true);

    const built = createOpenAIChatAdapter(provider).buildRequest(parsedWith([imageMessage(urls)]));
    expect(built).toBeInstanceOf(Promise);
    const { body } = await (built as Promise<{ body: string }>);
    const messages = wireMessages(body);
    const parts = imageParts(messages);

    expect(parts).toHaveLength(4);
    const total = parts.reduce((sum, p) => sum + (p.image_url?.url.split(",")[1]?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(OPENAI_CHAT_IMAGE_BASE64_BUDGET);
    for (const part of parts) expect(part.image_url?.url.startsWith("data:image/")).toBe(true);
    // The caption survives alongside the images.
    expect(JSON.stringify(messages)).toContain("what is this");
  });

  test("terminal overflow keeps images attached instead of dropping the oldest", async () => {
    // The input has to miss every tier's dimension and byte caps, otherwise processAt
    // passes it through before the injected encoder is ever consulted and the ladder is
    // never walked. A 1000x1000 noise PNG misses them; a small one does not.
    const big = await noisyPngB64(1000, 1000);
    const messages = [{
      role: "user",
      content: Array.from({ length: 6 }, () => ({
        type: "image_url",
        image_url: { url: dataUrl(big) },
      })),
    }];
    const tiersReached: number[] = [];
    // Every tier, including the floor, still exceeds the budget on its own.
    await normalizeOpenAIChatImages(messages, {
      encode: (input, spec, quality) => {
        tiersReached.push(spec.maxEdge);
        return sizedEncoder(() => OPENAI_CHAT_IMAGE_BASE64_BUDGET)(input, spec, quality);
      },
      validate: () => Promise.resolve(),
    });

    // The ladder actually ran and bottomed out at the terminal tier.
    const terminalEdge = TIER_SPECS[TIER_SPECS.length - 1]?.maxEdge;
    expect(getNormalizeStatsForTests().encodeCalls).toBeGreaterThan(0);
    expect(tiersReached).toContain(terminalEdge);

    const parts = imageParts(messages as ChatMsg[]);
    // Still over budget at the floor, and every image survives regardless.
    const total = parts.reduce((sum, p) => sum + (p.image_url?.url.split(",")[1]?.length ?? 0), 0);
    expect(total).toBeGreaterThan(OPENAI_CHAT_IMAGE_BASE64_BUDGET);
    expect(parts).toHaveLength(6);
    for (const part of parts) expect(part.image_url?.url).toContain("base64,");
  });

  test("an image processing failure preserves the original image without encoding", async () => {
    const big = await noisyPngB64(1000, 1000);
    const original = dataUrl(big);
    const parsed = parsedWith([imageMessage([original])]);
    const built = createOpenAIChatAdapter(provider).buildRequest(parsed, {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
      imageTierBias: Number.NaN,
    });
    const request = await (built as Promise<{ body: string }>);
    const parts = imageParts(wireMessages(request.body));
    expect(parts).toHaveLength(1);
    // NaN bypasses processing tiers; this exercises failed processing, not Promise rejection.
    expect(parts[0]?.image_url?.url).toBe(original);
    expect(getNormalizeStatsForTests().encodeCalls).toBe(0);
  });

  test("a remote https image is left untouched", async () => {
    const messages = [{
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://example.com/cat.png" } }],
    }];
    expect(hasShrinkableOpenAIChatImages(messages)).toBe(false);
    await normalizeOpenAIChatImages(messages);
    expect(imageParts(messages as ChatMsg[])[0]?.image_url?.url).toBe("https://example.com/cat.png");
  });

  test("an image this wire cannot drop keeps counting toward the budget", async () => {
    // The drop callback here is a no-op, so an undecodable image stays on the wire. The
    // shared core normally stops counting a dropped target, which is only correct when
    // the bytes actually leave. If those bytes stopped counting, the demotion loop would
    // stop early and still ship an oversized body — the exact failure this file exists
    // to prevent.
    const big = await noisyPngB64(1000, 1000);
    // Truncated PNG: sniffs as an image, so it reaches the ladder, but cannot decode.
    const corrupt = big.slice(0, 3_000_000);
    const messages = [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: dataUrl(corrupt) } },
        ...Array.from({ length: 3 }, () => ({ type: "image_url", image_url: { url: dataUrl(big) } })),
      ],
    }];

    resetNormalizeStateForTests();
    await normalizeOpenAIChatImages(messages);

    const parts = imageParts(messages as ChatMsg[]);
    const total = parts.reduce((sum, p) => sum + (p.image_url?.url.split(",")[1]?.length ?? 0), 0);
    expect(parts).toHaveLength(4);
    // The undecodable image is retained, unchanged.
    expect(parts[0]?.image_url?.url).toBe(dataUrl(corrupt));
    // And the turn as a whole still lands under budget.
    expect(total).toBeLessThanOrEqual(OPENAI_CHAT_IMAGE_BASE64_BUDGET);
  });

  test("an undecodable image keeps its original url rather than being dropped", async () => {
    const corrupt = dataUrl("!!!!not-base64-image!!!!");
    const messages = [{
      role: "user",
      content: [{ type: "image_url", image_url: { url: corrupt } }],
    }];
    await normalizeOpenAIChatImages(messages, {
      encode: () => Promise.reject(new Error("undecodable")),
      validate: () => Promise.reject(new Error("undecodable")),
    });
    expect(imageParts(messages as ChatMsg[])[0]?.image_url?.url).toBe(corrupt);
  });

  test("malformed message shapes neither throw nor lose parts", async () => {
    const messages: unknown[] = [
      null,
      "not-a-message",
      { role: "user" },
      { role: "user", content: "plain text" },
      { role: "user", content: [{ type: "image_url" }, { type: "image_url", image_url: {} }] },
    ];
    const before = JSON.stringify(messages);
    expect(hasShrinkableOpenAIChatImages(messages)).toBe(false);
    await normalizeOpenAIChatImages(messages);
    expect(JSON.stringify(messages)).toBe(before);
    await normalizeOpenAIChatImages(undefined);
    await normalizeOpenAIChatImages("nonsense");
  });

  test("a delegating adapter awaits the built request instead of reading an undefined body", async () => {
    // mimo-free wraps this adapter and reads baseReq.body. When an image turn makes
    // buildRequest return a promise, a synchronous cast there yields undefined and the
    // JSON.parse of the delegated body throws.
    // mimo-free's buildRequest bootstraps a JWT over the network, so the stub below is
    // what keeps this suite hermetic. Both cache resets matter: the first stops a JWT
    // cached by an earlier test from bypassing the stub, the second stops this test's
    // synthetic token from escaping into a later one.
    const originalFetch = globalThis.fetch;
    const bootstrapUrl = "https://api.xiaomimimo.com/api/free-ai/bootstrap";
    const fetched: string[] = [];
    resetMimoJwtCache();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      if (url !== bootstrapUrl) throw new Error(`unexpected external request: ${url}`);
      return Response.json({ jwt: "test-jwt" });
    }) as typeof fetch;
    try {
      const big = await noisyPngB64(1000, 1000);
      const parsed = parsedWith([imageMessage([dataUrl(big)])]);
      const adapter = createMimoFreeAdapter({
        ...provider,
        adapter: "mimo-free",
        baseUrl: "https://api.xiaomimimo.com/api/free-ai/openai/chat",
      });
      const built = await adapter.buildRequest(parsed, {
        headers: new Headers(),
        translatorBudget: createTestTranslatorBudget(),
      });
      expect(fetched).toEqual([bootstrapUrl]);
      expect(typeof built.body).toBe("string");
      expect(imageParts(wireMessages(built.body as string))).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
      resetMimoJwtCache();
    }
  });

  test("imageTierBias from incoming meta reaches the normalizer", async () => {
    const big = await noisyPngB64(1000, 1000);
    const urls = Array.from({ length: 4 }, () => dataUrl(big));
    const adapter = createOpenAIChatAdapter(provider);

    const build = async (imageTierBias?: number) => {
      resetNormalizeStateForTests();
      const built = adapter.buildRequest(parsedWith([imageMessage(urls)]), {
        headers: new Headers(),
        translatorBudget: createTestTranslatorBudget(),
        ...(imageTierBias !== undefined ? { imageTierBias } : {}),
      });
      const request = await (built as Promise<{ body: string }>);
      return imageParts(wireMessages(request.body))
        .reduce((sum, part) => sum + (part.image_url?.url.length ?? 0), 0);
    };

    expect(await build(3)).toBeLessThan(await build());
  });

});


test("oversized image async construction preserves current JSON schema downgrade", async () => {
  resetNormalizeStateForTests();
  const big = await noisyPngB64(1000, 1000);
  const parsed = parsedWith([imageMessage([dataUrl(big)])]);
  parsed.options.textFormat = { type: "json_schema", name: "result", schema: { type: "object" } };
  const built = createOpenAIChatAdapter({ ...provider, noJsonSchemaModels: [parsed.modelId] }).buildRequest(parsed);
  expect(built instanceof Promise).toBe(true);
  const request = await built;
  expect(JSON.parse(request.body as string).response_format).toEqual({ type: "json_object" });
});
