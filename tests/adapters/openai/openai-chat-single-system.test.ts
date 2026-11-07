import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter, buildOpenAIChatPassthroughRequest } from "../../../src/adapters/openai-chat";
import { parseRequest } from "../../../src/responses/parser";
import { getProviderRegistryEntry, PROVIDER_REGISTRY } from "../../../src/providers/registry";
import { enrichProviderFromRegistry, providerConfigSeed } from "../../../src/providers/derive";
import type { OcxProviderConfig } from "../../../src/types";

const model = "qwen3.8-27b-uncensored@q4_k_m";
const enabled = { adapter: "openai-chat", baseUrl: "http://localhost:1234/v1", singleLeadingSystemMessage: true } as OcxProviderConfig;
const input = {
  model,
  instructions: "Base instructions",
  input: [
    { role: "system", content: "Additional system instructions" },
    { role: "developer", content: [{ type: "input_text", text: "First developer" }] },
    { role: "user", content: "First user" },
    { role: "developer", content: "Late developer" },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "tool result" },
    { role: "user", content: "Continue" },
  ],
};
function translated(provider: OcxProviderConfig, modelId = model) {
  const parsed = parseRequest({ ...input, model: modelId });
  const before = structuredClone(parsed);
  const wire = JSON.parse(createOpenAIChatAdapter(provider).buildRequest(parsed).body);
  expect(parsed).toEqual(before);
  return wire.messages as Record<string, unknown>[];
}
function native(messages: unknown[], provider = enabled) {
  const raw = { messages };
  const before = structuredClone(raw);
  const wire = JSON.parse(buildOpenAIChatPassthroughRequest(provider, raw, model, false).body);
  expect(raw).toEqual(before);
  return wire.messages as Record<string, unknown>[];
}

describe("single leading Chat system message (#7761)", () => {
  test("LM Studio seed works after renaming the provider and changing to a LAN endpoint", () => {
    const provider = { ...providerConfigSeed(getProviderRegistryEntry("lm-studio")!), baseUrl: "http://192.168.1.42:4321/v1" };
    enrichProviderFromRegistry("renamed-lan", provider);
    const messages = translated(provider);
    expect(messages.map(m => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(messages[0].content).toBe("Base instructions\n\nAdditional system instructions\n\nFirst developer\n\nLate developer");
    expect(messages[1].content).toBe("First user");
    expect(messages[2].tool_calls).toEqual([{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }]);
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "tool result" });
    expect(messages[4].content).toBe("Continue");
  });

  test.each([model, "Qwen3.8-27B", "unrelated-custom-model"])("explicit policy wins over the model selector: %s", modelId => {
    const messages = translated({ ...enabled, foldDeveloperRoleToSystem: false }, modelId);
    expect(messages.filter(m => m.role === "system")).toHaveLength(1);
    expect(messages.some(m => m.role === "developer")).toBe(false);
    expect(messages[0].content).toBe("Base instructions\n\nAdditional system instructions\n\nFirst developer\n\nLate developer");
    expect(messages[1].content).toBe("First user");
  });

  test("other presets and unflagged endpoints retain chronological messages", () => {
    for (const entry of PROVIDER_REGISTRY) {
      if (entry.id !== "lm-studio") expect((entry as unknown as Record<string, unknown>).singleLeadingSystemMessage).toBeUndefined();
    }
    const messages = translated({ adapter: "openai-chat", baseUrl: enabled.baseUrl });
    expect(messages.map(m => m.role)).toEqual(["system", "system", "user", "system", "assistant", "tool", "user"]);
    expect(messages[1].content).toBe("First developer");
    expect(messages[3].content).toBe("Late developer");
  });

  test("false overrides the LM Studio default and survives enrichment", () => {
    const provider = { ...providerConfigSeed(getProviderRegistryEntry("lm-studio")!), singleLeadingSystemMessage: false } as OcxProviderConfig;
    enrichProviderFromRegistry("lm-studio", provider);
    expect(translated(provider).map(m => m.role)).toEqual(["system", "system", "user", "system", "assistant", "tool", "user"]);
  });

  test("native Chat preserves instruction order, text-part boundaries, and every non-instruction message", () => {
    const messages = [
      { role: "developer", content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] },
      { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/image.png" } }] },
      { role: "system", content: "C" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "result" },
      { role: "developer", content: "D" },
    ];
    expect(native(messages)).toEqual([{ role: "system", content: "AB\n\nC\n\nD" }, messages[1], messages[3], messages[4]]);
  });

  test("no instructions does not invent an empty system message", () => {
    const messages = [{ role: "user", content: "Hello" }];
    expect(native(messages)).toEqual(messages);
  });

  test("a late instruction becomes the first message without trimming whitespace", () => {
    expect(native([{ role: "user", content: "Hello" }, { role: "developer", content: "  Keep spaces\n" }]))
      .toEqual([{ role: "system", content: "  Keep spaces\n" }, { role: "user", content: "Hello" }]);
  });

  test("unsupported instruction content fails explicitly rather than losing it", () => {
    expect(() => native([{ role: "system", content: [{ type: "image_url", image_url: { url: "https://example.invalid/image.png" } }] }]))
      .toThrow("singleLeadingSystemMessage requires text-only system/developer content");
    expect(() => native([{ role: "developer", content: [{ type: "file", file: { file_data: "data:application/pdf;base64,JVBERi0xLjQ=" } }] }]))
      .toThrow("singleLeadingSystemMessage requires text-only system/developer content");
  });

  test.each([true, false])("translated developer documents retain bytes and merge text (fold=%s)", fold => {
    const file = { type: "input_file", filename: "spec.pdf", file_data: "data:application/pdf;base64,JVBERi0xLjQ=" };
    const parsed = parseRequest({ model, instructions: "Base", input: [
      { role: "user", content: "First" },
      { type: "function_call", call_id: "call_doc", name: "lookup", arguments: "{}" },
      { role: "developer", content: [{ type: "input_text", text: "Read " }, file, { type: "input_text", text: "carefully" }] },
      { role: "developer", content: "Later" },
      { type: "function_call_output", call_id: "call_doc", output: "result" },
      { role: "developer", content: [file] },
      { role: "user", content: "Continue" },
    ] });
    const before = structuredClone(parsed);
    const messages = JSON.parse(createOpenAIChatAdapter({ ...enabled, foldDeveloperRoleToSystem: fold }).buildRequest(parsed).body).messages;
    expect(parsed).toEqual(before);
    expect(messages).toEqual([
      { role: "system", content: "Base\n\nRead carefully\n\nLater" },
      { role: "user", content: "First" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_doc", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_doc", content: "result" },
      { role: "user", content: [{ type: "file", file: { filename: file.filename, file_data: file.file_data } }] },
      { role: "user", content: [{ type: "file", file: { filename: file.filename, file_data: file.file_data } }] },
      { role: "user", content: "Continue" },
    ]);
  });
});
