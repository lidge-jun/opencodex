import { beforeEach, describe, expect, test } from "bun:test";
import { parsedHasInlineImage, shouldAttemptImageTierRetry } from "../../../src/server/image-retry";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import { resetNormalizeStateForTests } from "../../../src/adapters/anthropic-image-normalize";
import { sniffImageDimensions } from "../../../src/adapters/anthropic-image-guard";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const ONE_PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function realPngDataUrl(width: number, height: number): Promise<string> {
  const buf = await new Bun.Image(Buffer.from(ONE_PX_PNG, "base64")).resize(width, height).png().toBuffer();
  return `data:image/png;base64,${Buffer.from(buf).toString("base64")}`;
}

function parsedWithImages(imageUrls: string[]): OcxParsedRequest {
  return {
    modelId: "claude-fable-5",
    stream: false,
    options: {},
    context: {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at these" },
            ...imageUrls.map(imageUrl => ({ type: "image", imageUrl, detail: "high" })),
          ],
          timestamp: 0,
        },
      ],
    },
  } as unknown as OcxParsedRequest;
}

const provider: OcxProviderConfig = {
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-test-not-real",
} as OcxProviderConfig;

beforeEach(() => resetNormalizeStateForTests());

describe("image-retry gate (030 R3)", () => {
  const withImage = parsedWithImages(["data:image/png;base64," + ONE_PX_PNG]);

  test("fires only for anthropic + 413 + inline images + first attempt", () => {
    expect(shouldAttemptImageTierRetry({ status: 413, adapterName: "anthropic", parsed: withImage, alreadyAttempted: false })).toBe(true);
  });

  test("does not fire for non-anthropic adapters", () => {
    expect(shouldAttemptImageTierRetry({ status: 413, adapterName: "openai-chat", parsed: withImage, alreadyAttempted: false })).toBe(false);
  });

  test("does not fire twice (spiral guard, 030 R2)", () => {
    expect(shouldAttemptImageTierRetry({ status: 413, adapterName: "anthropic", parsed: withImage, alreadyAttempted: true })).toBe(false);
  });

  test("does not fire without inline images or on other statuses", () => {
    const noImages = parsedWithImages([]);
    expect(shouldAttemptImageTierRetry({ status: 413, adapterName: "anthropic", parsed: noImages, alreadyAttempted: false })).toBe(false);
    expect(shouldAttemptImageTierRetry({ status: 429, adapterName: "anthropic", parsed: withImage, alreadyAttempted: false })).toBe(false);
  });

  test("parsedHasInlineImage ignores remote URLs and malformed content", () => {
    expect(parsedHasInlineImage(parsedWithImages(["https://example.com/a.png"]))).toBe(false);
    expect(parsedHasInlineImage({ modelId: "m", stream: false, options: {}, context: { messages: [{ role: "user", content: "plain" }] } } as unknown as OcxParsedRequest)).toBe(false);
  });
});

describe("imageTierBias plumbing (030 R1 — bias activation through the real adapter)", () => {
  test("bias 0 passes a tier-0-sized image through; bias 1 re-encodes it at the tier-1 edge", async () => {
    const dataUrl = await realPngDataUrl(1500, 1000);
    const adapter = createAnthropicAdapter(provider);

    const unbiased = await adapter.buildRequest(parsedWithImages([dataUrl]), { headers: new Headers() });
    const unbiasedBody = JSON.parse(unbiased.body as string) as { messages: Array<{ content: Array<{ type: string; source?: { media_type?: string; data?: string } }> }> };
    const unbiasedImg = unbiasedBody.messages[0].content.find(b => b.type === "image");
    expect(unbiasedImg?.source?.media_type).toBe("image/png"); // tier 0: 1500px fits 2000 — pass-through

    const biased = await adapter.buildRequest(parsedWithImages([dataUrl]), { headers: new Headers(), imageTierBias: 1 });
    const biasedBody = JSON.parse(biased.body as string) as { messages: Array<{ content: Array<{ type: string; source?: { media_type?: string; data?: string } }> }> };
    const biasedImg = biasedBody.messages[0].content.find(b => b.type === "image");
    expect(biasedImg?.source?.media_type).toBe("image/jpeg"); // tier 1: 1500px > 1024 — re-encoded
    const dims = sniffImageDimensions(biasedImg?.source?.data ?? "");
    expect(Math.max(dims!.width, dims!.height)).toBeLessThanOrEqual(1024);
  });
});
