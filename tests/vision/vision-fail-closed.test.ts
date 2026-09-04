import { describe, expect, test } from "bun:test";
import { stripImagesInPlace } from "../../src/vision";
import { parseRequest } from "../../src/responses/parser";

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
});
