import { describe, expect, test } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../src/adapters/google";
import type { OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

const provider = {
  adapter: "google",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  googleMode: "cloud-code-assist",
  project: "proj-123",
  apiKey: "ya29.token",
} as OcxProviderConfig;

function parsed(messages: OcxMessage[], modelId = "claude-opus-4-6-thinking"): OcxParsedRequest {
  return {
    modelId,
    stream: false,
    options: {},
    context: { messages, systemPrompt: [], tools: [] },
  } as unknown as OcxParsedRequest;
}

async function envelopeContents(p: OcxParsedRequest): Promise<{ role: string; parts: unknown[] }[]> {
  const { body } = await createGoogleAdapter(provider).buildRequest(p);
  const envelope = JSON.parse(body);
  return envelope.request.contents;
}

describe("google claude prefill guard", () => {
  test("appends a user continue nudge when CCA Claude context ends with model turn", async () => {
    const contents = await envelopeContents(parsed([
      { role: "user", content: "start", timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "partial answer" }], model: "claude", timestamp: 0 },
    ]));

    expect(contents.at(-1)).toEqual({ role: "user", parts: [{ text: "(continue)" }] });
  });

  test("leaves context ending with user unchanged", async () => {
    const contents = await envelopeContents(parsed([
      { role: "assistant", content: [{ type: "text", text: "answer" }], model: "claude", timestamp: 0 },
      { role: "user", content: "follow up", timestamp: 0 },
    ]));

    expect(contents.at(-1)!.role).toBe("user");
    expect(JSON.stringify(contents.at(-1))).not.toContain("(continue)");
  });

  test("appends nudge when CCA Claude context is empty", async () => {
    const contents = await envelopeContents(parsed([]));

    expect(contents.at(-1)).toEqual({ role: "user", parts: [{ text: "(continue)" }] });
  });

  test("does not append nudge after tool result (tool result maps to user role)", async () => {
    const contents = await envelopeContents(parsed([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "README.md" } }],
        model: "claude",
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read_file",
        content: "contents",
        isError: false,
        timestamp: 0,
      },
    ] as OcxMessage[]));

    // toolResult maps to role:"user" in Gemini format, so no nudge needed
    expect(contents.at(-1)!.role).toBe("user");
    expect(JSON.stringify(contents.at(-1))).not.toContain("(continue)");
  });

  test("does not append nudge for non-Claude models on Antigravity", async () => {
    const contents = await envelopeContents(parsed([
      { role: "user", content: "start", timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "answer" }], model: "gemini", timestamp: 0 },
    ], "gemini-3.7-flash"));

    // Gemini natively accepts model-tail; no nudge
    expect(contents.at(-1)!.role).toBe("model");
    expect(JSON.stringify(contents)).not.toContain("(continue)");
  });
});
