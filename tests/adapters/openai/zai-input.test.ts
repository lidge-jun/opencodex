import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../../src/adapters/openai-responses";
import { normalizeZaiResponsesInput } from "../../../src/adapters/openai-responses/zai-input";
import { enrichProviderFromRegistry, providerConfigSeed } from "../../../src/providers/derive";
import { getProviderRegistryEntry } from "../../../src/providers/registry";
import type { OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const url = "https://api.z.ai/api/v1/responses";
const image = (id: string, detail?: string) => ({
  type: "input_image",
  image_url: `data:image/png;base64,${id}`,
  ...(detail === undefined ? {} : { detail }),
});

function project(input: unknown[], destination = url): unknown[] {
  const body = { model: "glm-5.3-flash", input };
  const snapshot = JSON.stringify(body);
  const normalized = normalizeZaiResponsesInput(body, destination) as { input: unknown[] };
  expect(JSON.stringify(body)).toBe(snapshot);
  return normalized.input;
}

async function serialize(provider: OcxProviderConfig, input: unknown[]) {
  const request = await createResponsesPassthroughAdapter(provider).buildRequest({
    modelId: "glm-5.3-flash",
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: { model: "glm-5.3-flash", input },
  }, { headers: new Headers() });
  return { url: request.url, body: JSON.parse(request.body) as { input: Array<Record<string, unknown>> } };
}

describe("Z.AI Responses image detail", () => {
  test("user message images degrade original detail to high without touching bytes or order", () => {
    const input = project([
      { type: "message", role: "user", content: [{ type: "input_text", text: "look" }, image("AAA", "original"), image("BBB", "low")] },
    ]);
    expect(input[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "look" }, image("AAA", "high"), image("BBB", "low")],
    });
  });

  test("custom and function tool outputs degrade original detail and keep their call ids", () => {
    const input = project([
      { type: "custom_tool_call", call_id: "call_a", name: "exec", input: "view_image()" },
      { type: "custom_tool_call_output", call_id: "call_a", output: [{ type: "input_text", text: "Script completed" }, image("AAA", "original")] },
      { type: "function_call", call_id: "call_b", name: "screenshot", arguments: "{}" },
      { type: "function_call_output", call_id: "call_b", output: [image("BBB", "original")] },
    ]);
    expect(input[0]).toEqual({ type: "custom_tool_call", call_id: "call_a", name: "exec", input: "view_image()" });
    expect(input[1]).toEqual({
      type: "custom_tool_call_output",
      call_id: "call_a",
      output: [{ type: "input_text", text: "Script completed" }, image("AAA", "high")],
    });
    expect(input[3]).toEqual({ type: "function_call_output", call_id: "call_b", output: [image("BBB", "high")] });
  });

  test("bodies without original detail keep their identity", () => {
    const body = {
      model: "glm-5.3-flash",
      input: [
        { type: "message", role: "user", content: [image("AAA", "high"), image("BBB")] },
        { type: "function_call_output", call_id: "call_a", output: "plain text" },
      ],
    };
    expect(normalizeZaiResponsesInput(body, url)).toBe(body);
  });

  test("other destinations, including query-routed variants, keep original detail", () => {
    const body = { input: [{ type: "message", role: "user", content: [image("AAA", "original")] }] };
    expect(normalizeZaiResponsesInput(body, `${url}?route=custom`)).toBe(body);
    expect(normalizeZaiResponsesInput(body, "https://api.openai.com/v1/responses")).toBe(body);
    expect(normalizeZaiResponsesInput(body, "https://api.z.ai.example.com/api/v1/responses")).toBe(body);
  });

  test("the registry zai row serializes high detail on the wire", async () => {
    const provider = { ...providerConfigSeed(getProviderRegistryEntry("zai")!), apiKey: "test-key" };
    enrichProviderFromRegistry("zai", provider);
    const { url: sent, body } = await serialize(provider, [
      { type: "message", role: "user", content: [{ type: "input_text", text: "look" }, image("AAA", "original")] },
      { type: "custom_tool_call", call_id: "call_a", name: "exec", input: "view_image()" },
      { type: "custom_tool_call_output", call_id: "call_a", output: [{ type: "input_text", text: "done" }, image("BBB", "original")] },
    ]);
    expect(sent).toBe(url);
    expect(JSON.stringify(body)).not.toContain("\"original\"");
    expect(body.input[0]).toMatchObject({ content: [{ type: "input_text", text: "look" }, image("AAA", "high")] });
    expect(body.input.find(item => item.type === "custom_tool_call_output")).toMatchObject({
      call_id: "call_a",
      output: [{ type: "input_text", text: "done" }, image("BBB", "high")],
    });
  });

  test("a custom-named provider at the same destination gets the same projection", async () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.z.ai",
      responsesPath: "/api/v1/responses",
      authMode: "key",
      apiKey: "test-key",
    };
    const { url: sent, body } = await serialize(provider, [
      { type: "message", role: "user", content: [image("AAA", "original")] },
    ]);
    expect(sent).toBe(url);
    expect(body.input[0]).toMatchObject({ content: [image("AAA", "high")] });
  });

  test("a different Responses destination keeps original detail on the wire", async () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://relay.example.com/v1",
      authMode: "key",
      apiKey: "test-key",
    };
    const { body } = await serialize(provider, [
      { type: "message", role: "user", content: [image("AAA", "original")] },
    ]);
    expect(body.input[0]).toMatchObject({ content: [image("AAA", "original")] });
  });
});
