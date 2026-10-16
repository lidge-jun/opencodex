import { describe, expect, test } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../../../src/adapters/google";
import { geminiProgressLead } from "../../../src/adapters/google-progress-history";
import { ANTIGRAVITY_MODEL_EFFORTS } from "../../../src/providers/antigravity-models";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

// Shape of a live Gemini 4 Argon tool turn (2026-10-17): a progress line in the user's language
// with the model's planning appended as ordinary, unmarked text. Replayed whole, later turns
// copied the tail; replayed as the lead sentence, they did not.
const LEAKED = "앞선 배치에서 잘린 google.ts를 마저 읽겠습니다. Let's read google.ts 580-1700 first.";
const LEAD = "앞선 배치에서 잘린 google.ts를 마저 읽겠습니다.";

const antigravity = {
  adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", googleMode: "cloud-code-assist",
  project: "proj-123", apiKey: "ya29.token", modelReasoningEfforts: ANTIGRAVITY_MODEL_EFFORTS,
} as OcxProviderConfig;
const aiStudio = { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "k" } as OcxProviderConfig;

function history(): OcxParsedRequest["context"]["messages"] {
  return [
    { role: "user", content: "google.ts를 읽어줘" },
    { role: "assistant", content: [
      { type: "text", text: LEAKED },
      { type: "text", text: "Maybe the classifier is wrong." },
      { type: "toolCall", id: "call_1", name: "exec", arguments: { cmd: "cat google.ts" } },
    ] },
    { role: "toolResult", toolCallId: "call_1", toolName: "exec", content: [{ type: "text", text: "ok" }] },
    { role: "assistant", content: [{ type: "text", text: "Final answer. It keeps every sentence." }] },
    { role: "user", content: "계속" },
  ] as unknown as OcxParsedRequest["context"]["messages"];
}

async function modelTexts(provider: OcxProviderConfig, modelId: string): Promise<string[][]> {
  const parsed = {
    modelId, stream: false, options: {},
    context: { messages: history(), systemPrompt: [], tools: [] },
  } as unknown as OcxParsedRequest;
  const req = await withTestTranslatorBudget(createGoogleAdapterProduction(provider)).buildRequest(parsed);
  const body = JSON.parse(req.body);
  const contents = (body.request ?? body).contents as Array<{ role: string; parts: Array<{ text?: string }> }>;
  return contents.filter(c => c.role === "model")
    .map(c => c.parts.filter(p => typeof p.text === "string").map(p => p.text!));
}

describe("Gemini progress-text history", () => {
  test("Argon tool turns replay only the lead sentence; final answers stay whole", async () => {
    expect(await modelTexts(antigravity, "gemini-4-argon")).toEqual([[LEAD], ["Final answer. It keeps every sentence."]]);
  });

  test("AI Studio Gemini gets the same history", async () => {
    expect(await modelTexts(aiStudio, "gemini-3.5-flash")).toEqual([[LEAD], ["Final answer. It keeps every sentence."]]);
  });

  test("Claude on Antigravity keeps its full progress text", async () => {
    expect(await modelTexts(antigravity, "claude-sonnet-5-5")).toEqual([
      [LEAKED, "Maybe the classifier is wrong."], ["Final answer. It keeps every sentence."],
    ]);
  });

  test("the lead split is punctuation-based and language-neutral", () => {
    expect(geminiProgressLead("Reading the adapter now! Wait, maybe the encoder too.")).toBe("Reading the adapter now!");
    expect(geminiProgressLead("1. Read google.ts next.\n2. Then the encoder.")).toBe("1. Read google.ts next.");
    expect(geminiProgressLead("google.ts와 chat.ts를 읽겠습니다")).toBe("google.ts와 chat.ts를 읽겠습니다");
    expect(geminiProgressLead("次に google.ts を読みます。Let's go.")).toBe("次に google.ts を読みます。");
    expect(geminiProgressLead("  \n ")).toBeUndefined();
    expect(geminiProgressLead("```js\nconst x = 1;\n```")).toBeUndefined();
  });
});
