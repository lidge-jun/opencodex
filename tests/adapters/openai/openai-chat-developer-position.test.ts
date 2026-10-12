import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

/**
 * #5213. A `developer` message used to keep its slot only when the provider base URL host was
 * exactly `api.openai.com`. Everywhere else its text was appended to the system prompt and the
 * message itself was skipped, so an instruction written to apply from the second turn onward
 * arrived ahead of the first one. Both shapes return a normal completion, which is why these
 * assertions read the serialized request body rather than the response.
 */

const gateway: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://gateway.example.internal/v1",
  apiKey: "k",
};

function wireMessages(provider: OcxProviderConfig): Array<Record<string, unknown>> {
  const parsed = {
    modelId: "local-model",
    context: {
      systemPrompt: ["base instructions"],
      messages: [
        { role: "user", content: "First turn.", timestamp: 0 },
        { role: "developer", content: "Answer in exactly one sentence.", timestamp: 0 },
        { role: "user", content: "Second turn.", timestamp: 0 },
      ],
    },
    stream: false,
    options: {},
  } as unknown as OcxParsedRequest;
  const request = createOpenAIChatAdapter(provider).buildRequest(parsed);
  return (JSON.parse(request.body) as { messages: Array<Record<string, unknown>> }).messages;
}

describe("developer message placement on the Chat wire", () => {
  test("a non-OpenAI gateway keeps the instruction between the two turns", () => {
    const messages = wireMessages(gateway);
    expect(messages[0]).toEqual({ role: "system", content: "base instructions" });
    expect(messages[1]).toEqual({ role: "user", content: "First turn." });
    expect(messages[2].content).toBe("Answer in exactly one sentence.");
    expect(messages[3]).toEqual({ role: "user", content: "Second turn." });
  });

  test("the leading system block no longer absorbs the instruction", () => {
    expect(String(wireMessages(gateway)[0].content)).not.toContain("Answer in exactly one sentence.");
  });

  test("placement does not depend on the destination host", () => {
    const hosts = [
      "https://openrouter.ai/api/v1",
      "http://localhost:1234/v1",
      "https://api.openai.com/v1",
    ];
    // Placement is asserted for both role states, because the role is decided separately and
    // must never be able to move the message.
    for (const baseUrl of hosts) {
      for (const declared of [{}, { foldDeveloperRoleToSystem: false }, { foldDeveloperRoleToSystem: true }]) {
        const messages = wireMessages({ ...gateway, baseUrl, ...declared });
        expect(messages).toHaveLength(4);
        expect(messages[2].content).toBe("Answer in exactly one sentence.");
        expect(messages[3]).toEqual({ role: "user", content: "Second turn." });
      }
    }
  });
});

describe("developer role on the Chat wire", () => {
  test("an undeclared destination folds the role rather than gambling on it", () => {
    // The reason this is the default: a gateway that rejects the role answers
    // `400 role 'developer' is not allowed` and the turn never starts. Forwarding by default
    // put that failure outside the repository, where no test could reach it.
    for (const baseUrl of ["https://openrouter.ai/api/v1", "http://localhost:1234/v1", "https://api.openai.com/v1"]) {
      expect(wireMessages({ ...gateway, baseUrl })[2]).toEqual({
        role: "system",
        content: "Answer in exactly one sentence.",
      });
    }
  });

  test("the role still never depends on the destination hostname", () => {
    const declared = { ...gateway, foldDeveloperRoleToSystem: false };
    for (const baseUrl of ["https://openrouter.ai/api/v1", "https://api.openai.com/v1"]) {
      expect(wireMessages({ ...declared, baseUrl })[2].role).toBe("developer");
    }
    for (const baseUrl of ["https://openrouter.ai/api/v1", "https://api.openai.com/v1"]) {
      expect(wireMessages({ ...gateway, baseUrl })[2].role).toBe("system");
    }
  });

  test("a destination that rejects the role converts it without moving the message", () => {
    const messages = wireMessages({ ...gateway, foldDeveloperRoleToSystem: true });
    expect(messages.map(message => message.role)).toEqual(["system", "user", "system", "user"]);
    expect(messages[2]).toEqual({ role: "system", content: "Answer in exactly one sentence." });
    expect(String(messages[0].content)).not.toContain("Answer in exactly one sentence.");
  });

  test("a destination known to accept the role forwards it in the same slot", () => {
    const messages = wireMessages({ ...gateway, foldDeveloperRoleToSystem: false });
    expect(messages.map(message => message.role)).toEqual(["system", "user", "developer", "user"]);
    expect(messages[2]).toEqual({ role: "developer", content: "Answer in exactly one sentence." });
  });
});
