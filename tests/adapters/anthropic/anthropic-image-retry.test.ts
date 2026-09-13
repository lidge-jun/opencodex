import { beforeEach, describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import { resetNormalizeStateForTests } from "../../../src/adapters/anthropic-image-normalize";
import { AnthropicImageLimitError, collectImageRefs } from "../../../src/adapters/anthropic-image-guard";
import { parseRequest } from "../../../src/responses/parser";
import type { OcxProviderConfig } from "../../../src/types";

const ONE_PX_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const provider: OcxProviderConfig = {
  adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "fixture-key",
};

beforeEach(() => resetNormalizeStateForTests());

describe("Anthropic request replay preserves historical images", () => {
  test("append, nested tool results, concurrent rebuild and cold cache keep the same wire sources", async () => {
    const images: string[] = [];
    for (let i = 0; i < 21; i++) {
      const png = await new Bun.Image(Buffer.from(ONE_PX_PNG, "base64")).resize(2400 + i, 1600).png().toBuffer();
      images.push(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
    }
    const adapter = createAnthropicAdapter(provider);
    const build = async (count: number) => {
      const parsed = parseRequest({
        model: "claude-fable-5", stream: false,
        input: [
          { type: "function_call", call_id: "call_screenshot", name: "screenshot", arguments: "{}" },
          { type: "function_call_output", call_id: "call_screenshot", output: [
            { type: "input_image", image_url: images[0] },
          ] },
          ...images.slice(1, count).map(image_url => ({
            role: "user", content: [{ type: "input_image", image_url }],
          })),
        ],
      });
      const before = JSON.stringify(parsed);
      const request = await adapter.buildRequest(parsed);
      expect(JSON.stringify(parsed)).toBe(before);
      const body = JSON.parse(request.body);
      const refs = collectImageRefs(body.messages);
      expect(refs).toHaveLength(count);
      return refs.map(ref => {
        const block = ref.container[ref.index];
        if (!block || typeof block !== "object" || !("source" in block)) {
          throw new Error("Expected an image source after request normalization");
        }
        return block.source;
      });
    };
    let previous: unknown[] = [];
    for (const count of [5, 6, 7, 8, 9, 20, 21]) {
      const current = await build(count);
      expect(current.slice(0, previous.length)).toEqual(previous);
      previous = current;
    }
    resetNormalizeStateForTests();
    const concurrent = await Promise.all([build(21), build(21)]);
    expect(concurrent[0]).toEqual(previous);
    expect(concurrent[1]).toEqual(previous);
  });

  test("101 images fail request construction rather than silently dropping history", async () => {
    const adapter = createAnthropicAdapter(provider);
    const parsed = parseRequest({
      model: "claude-fable-5", stream: false,
      input: [{ role: "user", content: Array.from({ length: 101 }, () => ({
        type: "input_image", image_url: `data:image/png;base64,${ONE_PX_PNG}`,
      })) }],
    });
    await expect(adapter.buildRequest(parsed)).rejects.toMatchObject({
      status: 413, code: "anthropic_image_count_exceeded",
    });
  });

  test("large UTF-8 text is counted even without images", async () => {
    const parsed = parseRequest({ model: "claude-fable-5", stream: false, input: "界".repeat(10_666_667) });
    await expect(createAnthropicAdapter(provider).buildRequest(parsed)).rejects.toBeInstanceOf(AnthropicImageLimitError);
  });
});
