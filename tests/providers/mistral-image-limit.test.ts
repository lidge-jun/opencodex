import { describe, expect, test } from "bun:test";
import { limitMistralChatImages, mistralMaxImages, MISTRAL_DEFAULT_MAX_IMAGES } from "../../src/adapters/openai-chat/mistral-image-limit";
import { buildOpenAIChatPassthroughRequest } from "../../src/adapters/openai-chat/passthrough";
import { handleResponses } from "../../src/server/responses/core";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const mistral = (overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig =>
  ({ ...providerConfigSeed(getProviderRegistryEntry("mistral")!), apiKey: "test-mistral-images", ...overrides });
const image = (n: number) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(`image-${n}`).toString("base64")}` } });
/** Image numbers left in Chat messages, oldest first. */
function kept(messages: unknown): number[] {
  return (messages as Array<{ content: unknown }>).flatMap(message => Array.isArray(message.content)
    ? message.content.filter(part => part.type === "image_url")
      .map(part => Number(Buffer.from(part.image_url.url.split(",")[1], "base64").toString().slice(6)))
    : []);
}
/** Chat messages whose images are numbered 0..count-1 from oldest to newest, split across turns. */
function messages(count: number): unknown[] {
  const out: unknown[] = [{ role: "system", content: "be brief" }];
  for (let n = 0; n < count; n += 2) {
    out.push({ role: "user", content: [{ type: "text", text: `turn ${n}` }, image(n), ...(n + 1 < count ? [image(n + 1)] : [])] });
    out.push({ role: "assistant", content: `seen ${n}` });
  }
  return out;
}

describe("Mistral image count limit", () => {
  test("messages at or under the cap, other destinations and malformed shapes are returned as they are", () => {
    const atCap = messages(8);
    expect(limitMistralChatImages(atCap, mistral(), "mistral-medium-latest")).toBe(atCap);
    const many = messages(21);
    expect(limitMistralChatImages(many, mistral({ baseUrl: "https://gateway.example/v1" }), "mistral-medium-latest")).toBe(many);
    expect(limitMistralChatImages("not messages", mistral(), "mistral-medium-latest")).toBe("not messages");
    const malformed = [null, "text", { role: "user", content: "plain" }, { role: "user", content: [null, { type: "image_url" }] }];
    expect(limitMistralChatImages(malformed, mistral(), "mistral-medium-latest")).toBe(malformed);
  });

  test("keeps the newest images across turns, names the cap and leaves the history untouched", () => {
    const history = messages(21);
    const before = structuredClone(history);
    const out = limitMistralChatImages(history, mistral(), "mistral-medium-latest") as Array<{ content: unknown }>;
    expect(kept(out)).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);
    expect((out[1].content as unknown[])[0]).toEqual({ type: "text", text: "turn 0" });
    expect((out[1].content as unknown[])[1]).toEqual({
      type: "text", text: "[image omitted: Mistral accepts at most 8 images per request for this model; older images were dropped]",
    });
    expect(history).toEqual(before);
    expect(out[out.length - 1]).toBe(history[history.length - 1]);
  });

  test("counts images promoted from tool results like any other message", () => {
    const history = messages(8);
    history.push({ role: "tool", tool_call_id: "c1", content: "see below" });
    history.push({ role: "user", content: [{ type: "text", text: "[ocx] image output from the preceding tool result(s):" }, image(8)] });
    expect(kept(limitMistralChatImages(history, mistral(), "mistral-medium-latest"))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("declared caps outrank the registry's measured ones, which outrank the documented default", () => {
    expect(mistralMaxImages(mistral(), "deepseek-v4-1-flash-1017")).toBe(20);
    expect(mistralMaxImages(mistral(), "mistral-large-4")).toBe(100);
    expect(mistralMaxImages(mistral(), "mistral-medium-2604")).toBe(MISTRAL_DEFAULT_MAX_IMAGES);
    expect(mistralMaxImages(mistral({ modelCapabilities: { "deepseek-v4-1-flash-1017": { mistralMaxImages: 4 } } }), "deepseek-v4-1-flash-1017")).toBe(4);
    expect(mistralMaxImages(mistral(), "constructor")).toBe(MISTRAL_DEFAULT_MAX_IMAGES);
  });

  test("native Chat Completions bodies are capped the same way", () => {
    const history = messages(21);
    const request = buildOpenAIChatPassthroughRequest(mistral(), { messages: history }, "deepseek-v4-1-flash-1017", false);
    expect(kept(JSON.parse(request.body).messages)).toEqual(Array.from({ length: 20 }, (_, n) => n + 1));
    const elsewhere = buildOpenAIChatPassthroughRequest(mistral({ baseUrl: "https://gateway.example/v1" }), { messages: history },
      "deepseek-v4-1-flash-1017", false);
    expect(kept(JSON.parse(elsewhere.body).messages)).toHaveLength(21);
  });

  test("the outbound request honors measured, declared and default caps, also under a custom provider name", async () => {
    const restoreFetch = globalThis.fetch;
    const releaseSpend = acquireOwnedSpendHome();
    const sent: string[] = [];
    globalThis.fetch = (async (url, init) => {
      if (String(url) === "https://api.mistral.ai/v1/chat/completions") sent.push(String(init?.body));
      return Response.json({ object: "error", message: "stop here" }, { status: 400 });
    }) as typeof fetch;
    const send = async (name: string, provider: OcxProviderConfig, model: string) => {
      const content = Array.from({ length: 21 }, (_, n) => ({ type: "input_image", image_url: image(n).image_url.url }));
      const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `${name}/${model}`, input: [{ type: "message", role: "user", content }] }) }),
        { providers: { [name]: provider } } as OcxConfig, { model: "", provider: "" });
      await response.text();
      return kept(JSON.parse(sent.at(-1)!).messages);
    };
    const declared = mistral({ modelCapabilities: { "mistral-small-2603": { mistralMaxImages: 3 } } });
    const custom: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://api.mistral.ai/v1", apiKey: "test-mistral-images" };
    try {
      expect(await send("mistral", mistral(), "deepseek-v4-1-flash-1017")).toEqual(Array.from({ length: 20 }, (_, n) => n + 1));
      expect(await send("mistral", mistral(), "mistral-medium-latest")).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);
      expect(await send("mistral", declared, "mistral-small-2603")).toEqual([18, 19, 20]);
      expect(await send("my-mistral", custom, "deepseek-v4-1-flash-1017")).toEqual(Array.from({ length: 20 }, (_, n) => n + 1));
    } finally { globalThis.fetch = restoreFetch; resetProviderRequestPacingForTest(); releaseSpend(); }
  });
});
