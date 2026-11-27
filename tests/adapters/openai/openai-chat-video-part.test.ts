/**
 * Audit F9 (2026-09-14) and the video-input contract (2026-11-25).
 *
 * F9: in the image-bearing branch every non-image part was mapped through
 * `(p as OcxTextContent).text`, which is `undefined` for a video part — yielding
 * `{type:"text", text: undefined}`. In the text-only branch the same join produced "", so a
 * video-only message was dropped silently. The fix then was an omission marker.
 *
 * The marker still went upstream and came back as an ordinary answer about a video the model
 * never saw. The translated Chat wire now emits the Chat Completions `video_url` part that
 * OpenRouter, Qwen (DashScope) and Kimi document, and the input media guard refuses video for
 * any model that does not declare video input, before this builder runs
 * (tests/adapters/video-input-guard.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const provider = { adapter: "openai-chat", baseUrl: "https://gateway.example/v1", authMode: "key", apiKey: "k" } as unknown as OcxProviderConfig;

const VIDEO = { type: "video", videoUrl: "data:video/mp4;base64,AAAA" };
const IMAGE = { type: "image", imageUrl: "data:image/png;base64,TkVX" };

async function messagesOf(content: unknown[], role = "user"): Promise<Array<Record<string, unknown>>> {
  const parsed = {
    modelId: "some-model",
    stream: false,
    options: {},
    context: { messages: [{ role, content, timestamp: 0 }] },
  } as unknown as OcxParsedRequest;
  const { body } = await createOpenAIChatAdapter(provider).buildRequest(parsed);
  return JSON.parse(typeof body === "string" ? body : JSON.stringify(body)).messages;
}

describe("video parts become Chat video_url parts", () => {
  test("a video beside an image keeps both as structured parts", async () => {
    const parts = (await messagesOf([{ type: "text", text: "see" }, IMAGE, VIDEO]))
      .flatMap(m => (Array.isArray(m.content) ? m.content : [])) as Array<Record<string, unknown>>;

    for (const part of parts.filter(p => p.type === "text")) expect(typeof part.text).toBe("string");
    expect(parts).toContainEqual({ type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } });
    expect(parts.some(p => p.type === "image_url")).toBe(true);
  });

  test("a video-only message is not dropped", async () => {
    const messages = await messagesOf([VIDEO]);

    expect(messages).toEqual([{ role: "user", content: [{ type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } }] }]);
  });

  test("text plus video keeps the text and the video in order", async () => {
    const messages = await messagesOf([{ type: "text", text: "describe this" }, VIDEO]);

    expect(messages[0]!.content).toEqual([
      { type: "text", text: "describe this" },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } },
    ]);
  });

  test("the caller's processing mode rides on the part only when it was sent", async () => {
    const messages = await messagesOf([{ ...VIDEO, processing: "agentic" }]);

    expect(messages[0]!.content).toEqual([
      { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA", processing: "agentic" } },
    ]);
  });

  test("no omission marker is ever written", async () => {
    const messages = await messagesOf([{ type: "text", text: "x" }, VIDEO]);

    expect(JSON.stringify(messages)).not.toContain("video omitted");
  });

  test("no video means byte-identical behavior", async () => {
    const messages = await messagesOf([{ type: "text", text: "plain" }]);

    expect(messages[0]!.content).toBe("plain");
  });
});
