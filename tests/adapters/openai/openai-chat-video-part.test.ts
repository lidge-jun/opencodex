/**
 * Audit F9 (2026-09-14): a video content part either vanished or produced a malformed
 * Chat part.
 *
 * In the image-bearing branch every non-image part was mapped through
 * `(p as OcxTextContent).text`, which is `undefined` for a video part — yielding
 * `{type:"text", text: undefined}`, worse than a drop because it can fail upstream
 * schema validation. In the text-only branch the same join produced "", so a
 * video-only or text-plus-video message was dropped entirely and silently.
 *
 * OpenAI's Chat Completions wire has no video content part, so both branches now state
 * the omission. That statement is scoped to this adapter's wire; native Chat
 * passthrough and Google inline video are unaffected.
 */
import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const provider = { adapter: "openai-chat", baseUrl: "https://gateway.example/v1", authMode: "key", apiKey: "k" } as unknown as OcxProviderConfig;

const VIDEO = { type: "video", videoUrl: "data:video/mp4;base64,AAAA" };
const IMAGE = { type: "image", imageUrl: "data:image/png;base64,TkVX" };

async function messagesOf(content: unknown[]): Promise<Array<Record<string, unknown>>> {
  const parsed = {
    modelId: "some-model",
    stream: false,
    options: {},
    context: { messages: [{ role: "user", content, timestamp: 0 }] },
  } as unknown as OcxParsedRequest;
  const { body } = await createOpenAIChatAdapter(provider).buildRequest(parsed);
  return JSON.parse(typeof body === "string" ? body : JSON.stringify(body)).messages;
}

describe("F9 video parts never produce a malformed or vanished message", () => {
  test("a video beside an image yields a well-formed text part", async () => {
    const parts = (await messagesOf([{ type: "text", text: "see" }, IMAGE, VIDEO]))
      .flatMap(m => (Array.isArray(m.content) ? m.content : [])) as Array<Record<string, unknown>>;
    const textParts = parts.filter(p => p.type === "text");

    // The old code emitted { type: "text", text: undefined } here.
    for (const part of textParts) expect(typeof part.text).toBe("string");
    expect(textParts.some(p => String(p.text).includes("[video omitted"))).toBe(true);
    expect(parts.some(p => p.type === "image_url")).toBe(true);
  });

  test("a video-only message is not dropped", async () => {
    const messages = await messagesOf([VIDEO]);

    expect(messages).toHaveLength(1);
    expect(String(messages[0]!.content)).toContain("[video omitted");
  });

  test("text plus video keeps the text and states the omission", async () => {
    const messages = await messagesOf([{ type: "text", text: "describe this" }, VIDEO]);

    expect(String(messages[0]!.content)).toContain("describe this");
    expect(String(messages[0]!.content)).toContain("[video omitted");
  });

  test("no video means byte-identical behavior", async () => {
    const messages = await messagesOf([{ type: "text", text: "plain" }]);

    expect(messages[0]!.content).toBe("plain");
  });

  test("the marker never echoes the payload", async () => {
    const messages = await messagesOf([{ type: "text", text: "x" }, VIDEO]);

    expect(JSON.stringify(messages)).not.toContain("AAAA");
  });
});
