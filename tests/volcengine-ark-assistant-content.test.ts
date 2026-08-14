import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import type { OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../src/types";

/**
 * #796: Volcengine Ark validates an assistant message's text as a REQUIRED parameter and treats
 * "" as absent, so any history containing a tool-call-only assistant 400s with
 * `MissingParameter: input.content.text`. Single-turn requests are fine; the failure needs the
 * tool-call turn.
 *
 * This cannot be fixed globally. xAI rejects the opposite way -- "Each message must have at least
 * one content element" -- and the existing "" is what satisfies it. Ark's Coding Plan endpoint
 * also rejects the structured placeholder while accepting "" (#1571). The contracts therefore
 * diverge by endpoint family, so these tests pin both the exact host and the exact Ark path.
 *
 * Scope of these tests: they verify the WIRE SHAPE we emit and that the host gate is real. They
 * cannot verify that Ark accepts it -- no request here reaches Volcengine. The array form is
 * inferred from the error's nested parameter path and is still unconfirmed; see #796.
 */

function providerFor(baseUrl: string): OcxProviderConfig {
  return { adapter: "openai-chat", baseUrl, apiKey: "sk-test", authMode: "key" };
}

const ark = providerFor("https://ark.cn-beijing.volces.com/api/v3");
const arkCodingPlan = providerFor("https://ark.cn-beijing.volces.com/api/coding/v3");
const generic = providerFor("https://example.test/v1");

interface ChatMsg {
  role: string;
  content?: unknown;
  reasoning_content?: unknown;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function wire(provider: OcxProviderConfig, messages: OcxMessage[]): ChatMsg[] {
  const parsed: OcxParsedRequest = {
    modelId: "kimi-k3",
    context: { messages },
    stream: false,
    options: {},
  };
  const req = createOpenAIChatAdapter(provider).buildRequest(parsed) as { body: string };
  return (JSON.parse(req.body) as { messages: ChatMsg[] }).messages;
}

function assistantToolCall(): OcxMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall" as const, id: "call_1", name: "shell", arguments: { cmd: "ls" } }],
    timestamp: 0,
  };
}

function assistantsOf(messages: ChatMsg[]): ChatMsg[] {
  return messages.filter(m => m.role === "assistant");
}

describe("Volcengine Ark empty assistant content (#796)", () => {
  const history: OcxMessage[] = [
    { role: "user", content: "list dir", timestamp: 0 },
    assistantToolCall(),
    { role: "toolResult", toolCallId: "call_1", toolName: "shell", content: "file1.txt", isError: false, timestamp: 0 },
  ];

  test("a tool-call-only assistant uses the structured content form for Ark", () => {
    const [assistant] = assistantsOf(wire(ark, history));
    expect(assistant.tool_calls).toHaveLength(1);
    // Ark's error names `input.content.text`, a nested path, which is why the array form is the
    // working hypothesis -- no bare string exposes a `content.text` path. UNVERIFIED against a
    // live endpoint: this test pins what we send, not that Ark accepts it.
    expect(assistant.content).toEqual([{ type: "text", text: "" }]);
  });

  test("the same history still uses \"\" for every other provider", () => {
    // The control. Without it the Ark assertion would also pass if the placeholder were applied
    // globally -- which would break xAI, whose validator requires the empty-string element.
    const [assistant] = assistantsOf(wire(generic, history));
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.content).toBe("");
  });

  test("Ark Coding Plan keeps the accepted empty-string continuation", () => {
    const [assistant] = assistantsOf(wire(arkCodingPlan, history));
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.content).toBe("");
  });

  test("a synthesized orphan tool-call assistant follows the same rule", () => {
    // A tool result with no matching call: the adapter fabricates the assistant turn, and that
    // fabricated message hits the same Ark validator.
    const orphan: OcxMessage[] = [
      { role: "user", content: "hi", timestamp: 0 },
      { role: "toolResult", toolCallId: "call_missing", toolName: "shell", content: "out", isError: false, timestamp: 0 },
    ];
    const arkOrphan = assistantsOf(wire(ark, orphan)).find(m => m.tool_calls?.length);
    const genericOrphan = assistantsOf(wire(generic, orphan)).find(m => m.tool_calls?.length);
    expect(arkOrphan?.content).toEqual([{ type: "text", text: "" }]);
    expect(genericOrphan?.content).toBe("");
  });

  test("the gate matches the host and pay-as-you-go path, not a substring", () => {
    // A lookalike host must not inherit the quirk: a provider merely mentioning the Ark hostname
    // in its path stays on the default contract.
    const lookalike = providerFor("https://example.test/ark.cn-beijing.volces.com/v1");
    const [assistant] = assistantsOf(wire(lookalike, history));
    expect(assistant.content).toBe("");
  });

  test("an unrelated path on the real Ark host does not inherit the pay-as-you-go quirk", () => {
    const unrelatedArkPath = providerFor("https://ark.cn-beijing.volces.com/api/custom/v3");
    const [assistant] = assistantsOf(wire(unrelatedArkPath, history));
    expect(assistant.content).toBe("");
  });

  test("Ark's regional sibling endpoint gets the same treatment", () => {
    const sea = providerFor("https://ark.ap-southeast.volces.com/api/v3");
    const [assistant] = assistantsOf(wire(sea, history));
    expect(assistant.content).toEqual([{ type: "text", text: "" }]);
  });

  test("a reasoning-only assistant takes the same path", () => {
    // The third placeholder site, reachable whenever an Ark model is listed in
    // preserveReasoningContentModels -- public config, so it is not a theoretical branch.
    const arkReasoning = providerFor("https://ark.cn-beijing.volces.com/api/v3");
    arkReasoning.preserveReasoningContentModels = ["kimi-k3"];
    const reasoningHistory: OcxMessage[] = [
      { role: "user", content: "hi", timestamp: 0 },
      { role: "assistant", content: [{ type: "thinking" as const, thinking: "deliberating" }], timestamp: 0 },
    ];
    const arkAssistant = assistantsOf(wire(arkReasoning, reasoningHistory))[0];
    expect(arkAssistant.reasoning_content).toBe("deliberating");
    expect(arkAssistant.content).toEqual([{ type: "text", text: "" }]);

    const genericReasoning = providerFor("https://example.test/v1");
    genericReasoning.preserveReasoningContentModels = ["kimi-k3"];
    expect(assistantsOf(wire(genericReasoning, reasoningHistory))[0].content).toBe("");
  });
});
