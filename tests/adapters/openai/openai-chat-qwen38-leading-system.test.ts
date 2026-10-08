import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { fixturePath } from "../../helpers/repo-root";

const contract = JSON.parse(readFileSync(fixturePath("qwen38-27b-chat-template-contract.json"), "utf8")) as {
  acceptedRoles: string[];
  systemMustBeFirst: boolean;
  lateSystemError: string;
  unsupportedRoleError: string;
};

const provider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://qwen.example.invalid/v1",
  apiKey: "test",
};

function serialize(modelId: string, target = provider): Array<{ role: string; content: string }> {
  const request = createOpenAIChatAdapter(target).buildRequest({
    modelId,
    context: {
      systemPrompt: ["Base instructions."],
      messages: [
        { role: "user", content: "First turn.", timestamp: 0 },
        { role: "developer", content: "Answer in one sentence.", timestamp: 0 },
        { role: "user", content: "Second turn.", timestamp: 0 },
      ],
    },
    stream: false,
    options: {},
  } as OcxParsedRequest);
  return (JSON.parse(request.body) as { messages: Array<{ role: string; content: string }> }).messages;
}

// Both pinned Jinja templates raise on a non-leading system or an unrecognized developer role.
// A later user is rendered as its own turn. Keep this oracle separate from the adapter selector.
function assertTemplateAccepts(messages: Array<{ role: string }>): void {
  messages.forEach((message, index) => {
    if (contract.systemMustBeFirst && message.role === "system" && index > 0) {
      throw new Error(contract.lateSystemError);
    }
    if (!contract.acceptedRoles.includes(message.role)) throw new Error(contract.unsupportedRoleError);
  });
}

describe("leading-system chat templates (Qwen3.8-27B, OrcaSAQ-2-Cyber-27B)", () => {
  test.each([
    "Qwen3.8-27B",
    "Qwen/Qwen3.8-27B",
    // Internal Eliza serves the same pinned template under dashed checkpoint ids.
    "qwen3-8-27b-fp8",
    "qwen3-8-27b-lora",
    // Gateways prefix the served id with their own namespace (LiteLLM, #6674).
    "openai/Qwen3.8-27B",
    "hosted_vllm/Qwen/Qwen3.8-27B",
    // Orca GGUF ids can carry namespaces and an optional quant tag.
    "orcarouter/OrcaSAQ-2-Cyber-27B-Uncensored-GGUF:UNKNOWN",
    "OrcaSAQ-2-Cyber-27B-Uncensored-GGUF:Q8_0",
    "OrcaSAQ-2-Cyber-27B-GGUF",
    "hosted_vllm/orcarouter/OrcaSAQ-2-Cyber-27B-Uncensored-GGUF:Q8_0",
  ])("keeps a late reminder after the first user without an invalid system role: %s", modelId => {
    const messages = serialize(modelId);
    expect(messages).toEqual([
      { role: "system", content: "Base instructions." },
      { role: "user", content: "First turn." },
      { role: "user", content: "Answer in one sentence." },
      { role: "user", content: "Second turn." },
    ]);
    expect(() => assertTemplateAccepts(messages)).not.toThrow();
  });

  test.each(["Qwen3.8-27B", "OrcaSAQ-2-Cyber-27B-Uncensored-GGUF:Q8_0"])(
    "does not send a developer role even if a gateway declaration says it accepts one: %s", modelId => {
      const messages = serialize(modelId, { ...provider, foldDeveloperRoleToSystem: false });
      expect(messages[2]).toEqual({ role: "user", content: "Answer in one sentence." });
      expect(() => assertTemplateAccepts(messages)).not.toThrow();
    },
  );

  test.each([
    "OrcaSAQ-2-Cyber-27B",
    "orcarouter/OrcaSAQ-2-Cyber-27B-Uncensored",
    "OrcaSAQ-2-Cyber-27B-Uncensored:Q8_0",
    "OrcaSAQ-2-Cyber-27B-Uncensored:GGUF",
  ])("non-GGUF Orca ids keep their configured developer role: %s", modelId => {
    expect(serialize(modelId)[2]).toEqual({ role: "system", content: "Answer in one sentence." });
    expect(serialize(modelId, { ...provider, foldDeveloperRoleToSystem: false })[2])
      .toEqual({ role: "developer", content: "Answer in one sentence." });
  });

  test("other models keep their recorded role and chronological position", () => {
    expect(serialize("other-model")[2]).toEqual({ role: "system", content: "Answer in one sentence." });
    expect(serialize("other-model", { ...provider, foldDeveloperRoleToSystem: false })[2])
      .toEqual({ role: "developer", content: "Answer in one sentence." });
    expect(serialize("Qwen3.8-27B-FP8")[2]).toEqual({ role: "system", content: "Answer in one sentence." });
    expect(serialize("openai/Qwen3.8-27B-FP8")[2]).toEqual({ role: "system", content: "Answer in one sentence." });
    expect(serialize("openai/Qwen3.8-27B-Instruct")[2]).toEqual({ role: "system", content: "Answer in one sentence." });
    expect(serialize("openai/Qwen3.8-27B", { ...provider, baseUrl: "https://api.openai.com/v1" })[2])
      .toEqual({ role: "system", content: "Answer in one sentence." });
    expect(serialize("Qwen3.8-27B", { ...provider, baseUrl: "https://api.openai.com/v1" })[2])
      .toEqual({ role: "system", content: "Answer in one sentence." });
  });
});
