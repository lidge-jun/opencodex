import { describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { createGoogleAdapter } from "../src/adapters/google";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import type { OcxProviderConfig } from "../src/types";

// A message item whose content blocks do not match their strict schema fails
// `userMessageItemSchema` / `assistantMessageItemSchema` and falls through to
// `inputItemSchema`'s permissive catch-all (`z.object({ type: z.string() }).loose()`),
// which passes the raw content through untouched. The parser then has to validate
// it itself — otherwise a malformed block reaches an adapter, or crashes parseRequest.

function inputOf(role: string, content: unknown) {
  return { model: "gemini-3-pro", input: [{ type: "message", role, content }] };
}

function userContent(content: unknown): unknown {
  const parsed = parseRequest(inputOf("user", content));
  return (parsed.context.messages[0] as { content?: unknown } | undefined)?.content;
}

describe("responses parser — malformed content blocks", () => {
  test("a user text block with no text key is dropped, not turned into undefined content", () => {
    expect(userContent([{ type: "input_text" }])).toEqual([]);
  });

  test("a user text block with a non-string text is dropped, not leaked as an object", () => {
    // Previously collapsed to `parts[0].text`, making the whole message content
    // the raw object (`{a: 1}`), which is neither a string nor an array.
    expect(userContent([{ type: "input_text", text: { a: 1 } }])).toEqual([]);
  });

  test("a null content block does not crash the parser", () => {
    expect(() => userContent([null])).not.toThrow();
    expect(userContent([null])).toEqual([]);
  });

  test("a system message with a malformed block does not crash the parser", () => {
    // parseRequest flattens system content inline, so an undefined return threw here.
    expect(() => parseRequest(inputOf("system", [{ type: "input_text" }]))).not.toThrow();
    const parsed = parseRequest(inputOf("system", [{ type: "input_text" }]));
    expect(parsed.context.systemPrompt ?? []).toEqual([]);
  });

  test("a non-array content container does not crash the parser", () => {
    // The catch-all can also retain a `content` that is not an array at all; the block loop
    // would throw ("{} is not iterable") before any per-block guard runs.
    for (const container of [{ type: "input_text", text: "x" }, 42, true]) {
      expect(() => userContent(container)).not.toThrow();
      expect(userContent(container)).toEqual([]);
    }
  });

  test("a non-array container on system and assistant roles is also safe", () => {
    const container = { type: "input_text", text: "x" };
    expect(() => parseRequest(inputOf("system", container))).not.toThrow();
    expect(() => parseRequest(inputOf("assistant", container))).not.toThrow();

    const assistant = parseRequest(inputOf("assistant", container));
    const msg = assistant.context.messages[0] as { content: unknown[] };
    expect(msg.content).toEqual([]);
  });

  test("valid blocks alongside malformed ones survive", () => {
    expect(userContent([{ type: "input_text" }, { type: "input_text", text: "real" }])).toBe("real");
    expect(userContent([{ type: "input_text", text: "a" }, { type: "input_text", text: "b" }]))
      .toEqual([{ type: "text", text: "a" }, { type: "text", text: "b" }]);
  });

  test("an assistant output_text with no text key does not become a bare text part", () => {
    const parsed = parseRequest(inputOf("assistant", [{ type: "output_text" }, { type: "output_text", text: "kept" }]));
    const msg = parsed.context.messages[0] as { content: Array<{ type: string; text?: string }> };
    expect(msg.content).toEqual([{ type: "text", text: "kept" }]);
  });

  test("a refusal block with a non-string refusal is dropped", () => {
    const parsed = parseRequest(inputOf("assistant", [{ type: "refusal", refusal: { nope: true } }]));
    const msg = parsed.context.messages[0] as { content: unknown[] };
    expect(msg.content).toEqual([]);
  });

  test("an input_image with a non-string image_url degrades to a file marker instead of crashing", () => {
    expect(userContent([{ type: "input_image", image_url: { bad: true }, file_id: "file_1" }]))
      .toBe("[image: file_1]");
  });

  test("a valid image block is still preserved structurally", () => {
    expect(userContent([{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "high" }]))
      .toEqual([{ type: "image", imageUrl: "data:image/png;base64,aGVsbG8=", detail: "high" }]);
  });

  test("adapters build a request from malformed input instead of throwing", async () => {
    const parsed = parseRequest(inputOf("user", [{ type: "input_text" }]));
    const google = { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "k" } as unknown as OcxProviderConfig;
    const anthropic = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x" } as unknown as OcxProviderConfig;

    await expect(createGoogleAdapter(google).buildRequest(parsed)).resolves.toBeDefined();
    await expect(createAnthropicAdapter(anthropic).buildRequest(parsed)).resolves.toBeDefined();
  });
});
