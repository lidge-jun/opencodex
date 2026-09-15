import { afterEach, describe, expect, test } from "bun:test";
import {
  describeImagesInPlace,
  setVisionDescriptionCache,
  stripImagesInPlace,
  type VisionDescriptionCache,
  type VisionPlan,
} from "../../src/vision";
import { parseRequest } from "../../src/responses/parser";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setVisionDescriptionCache();
});

function parsedWithImage() {
  return parseRequest({
    model: "opencode-go/glm-5.2",
    input: [
      { type: "message", role: "user", content: [
        { type: "input_text", text: "what is in this picture?" },
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
      ]},
    ],
  });
}

describe("vision fail-closed strip", () => {
  test("replaces image parts with an explicit omission marker", () => {
    const parsed = parsedWithImage();
    expect(stripImagesInPlace(parsed)).toBe(true);
    const user = parsed.context.messages.find(m => m.role === "user");
    const parts = user?.content as { type: string; text?: string }[];
    expect(parts.some(p => p.type === "image")).toBe(false);
    expect(parts.some(p => p.type === "text" && p.text?.includes("[image omitted"))).toBe(true);
    // the original question text survives
    expect(parts.some(p => p.type === "text" && p.text?.includes("what is in this picture"))).toBe(true);
  });

  test("returns false and leaves text-only turns untouched", () => {
    const parsed = parseRequest({
      model: "opencode-go/glm-5.2",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    const before = JSON.stringify(parsed.context.messages);
    expect(stripImagesInPlace(parsed)).toBe(false);
    expect(JSON.stringify(parsed.context.messages)).toBe(before);
  });

  test("does not render or cache an incomplete sidecar description", async () => {
    const writes: Array<[string, string]> = [];
    const cache: VisionDescriptionCache = {
      get: () => undefined,
      set: (key, value) => { writes.push([key, value]); },
      clear: () => undefined,
    };
    setVisionDescriptionCache(cache);
    globalThis.fetch = (async () => new Response(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial caption" })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
    const parsed = parsedWithImage();
    const plan: VisionPlan = {
      backend: "openai",
      forwardSidecar: {
        providerName: "openai",
        provider: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://vision.test/v1" },
        accountMode: "direct",
        authContext: { kind: "main", accountId: null },
        headers: new Headers({ Authorization: "Bearer test" }),
      },
      settings: { model: "vision-model", reasoning: "low", timeoutMs: 5_000 },
      maxDescriptionsPerTurn: 8,
    };

    await describeImagesInPlace(parsed, plan, new Headers({ Authorization: "Bearer test" }));

    const user = parsed.context.messages.find(message => message.role === "user");
    const rendered = (user?.content as { type: string; text?: string }[])
      .filter(part => part.type === "text")
      .map(part => part.text ?? "")
      .join("\n");
    expect(rendered).toContain("could not be processed");
    expect(rendered).toContain("before terminal event");
    expect(rendered).not.toContain("partial caption");
    expect(writes).toEqual([]);
  });
});
