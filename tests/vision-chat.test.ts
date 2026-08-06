import { afterEach, describe, expect, test } from "bun:test";
import { describeImageChat } from "../src/vision/describe-chat";
import type { OcxProviderConfig } from "../src/types";

const originalFetch = globalThis.fetch;
const image = "data:image/png;base64,aGVsbG8=";
const settings = { model: "vision-test", timeoutMs: 5000 };

afterEach(() => { globalThis.fetch = originalFetch; });

function chatSse(text: string): Response {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function geminiSse(text: string): Response {
  const body = [
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}`,
    "",
    `data: ${JSON.stringify({ candidates: [{ finishReason: "STOP" }] })}`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("chat vision sidecar", () => {
  test("sends an image_url through an OpenAI-compatible provider", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, any> | undefined;
    globalThis.fetch = (async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      return chatSse("Mimo description");
    }) as typeof fetch;
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://vision.example/v1",
      authMode: "key",
      apiKey: "test-key",
    };

    const result = await describeImageChat(image, "high", "describe this", provider, "mimo", settings);

    expect(result).toEqual({ text: "Mimo description" });
    expect(capturedUrl).toBe("https://vision.example/v1/chat/completions");
    expect(capturedBody?.model).toBe("vision-test");
    expect(capturedBody?.messages[0].content).toEqual([
      { type: "text", text: "describe this" },
      { type: "image_url", image_url: { url: image, detail: "high" } },
    ]);
  });

  test("uses the native Google adapter wire format", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, any> | undefined;
    globalThis.fetch = (async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      return geminiSse("Gemini description");
    }) as typeof fetch;
    const provider: OcxProviderConfig = {
      adapter: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      authMode: "key",
      apiKey: "test-key",
    };

    const result = await describeImageChat(image, "high", "describe this", provider, "gemini", { model: "gemini-test", timeoutMs: 5000 });

    expect(result).toEqual({ text: "Gemini description" });
    expect(capturedUrl).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse");
    expect(capturedBody?.contents?.[0]?.parts).toEqual([
      { text: "describe this" },
      { inline_data: { mime_type: "image/png", data: "aGVsbG8=" } },
    ]);
  });
});
