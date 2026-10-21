import { describe, expect, test } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../../../src/adapters/google";
import { geminiProgressLead } from "../../../src/adapters/google-progress-history";
import { ANTIGRAVITY_MODEL_EFFORTS } from "../../../src/providers/antigravity-models";
import { parseRequest } from "../../../src/responses/parser";
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

function history(phase?: "commentary" | "final_answer"): OcxParsedRequest["context"]["messages"] {
  return [
    { role: "user", content: "google.ts를 읽어줘" },
    { role: "assistant", ...(phase ? { phase } : {}), content: [
      { type: "text", text: LEAKED },
      { type: "text", text: "Maybe the classifier is wrong." },
      { type: "toolCall", id: "call_1", name: "exec", arguments: { cmd: "cat google.ts" } },
      { type: "text", text: "After the call. Kept whole." },
    ] },
    { role: "toolResult", toolCallId: "call_1", toolName: "exec", content: [{ type: "text", text: "ok" }] },
    { role: "assistant", content: [{ type: "text", text: "Final answer. It keeps every sentence." }] },
    { role: "user", content: "계속" },
  ] as unknown as OcxParsedRequest["context"]["messages"];
}

async function modelTexts(provider: OcxProviderConfig, modelId: string, phase?: "commentary" | "final_answer"): Promise<string[][]> {
  const parsed = {
    modelId, stream: false, options: {},
    context: { messages: history(phase), systemPrompt: [], tools: [] },
  } as unknown as OcxParsedRequest;
  const req = await withTestTranslatorBudget(createGoogleAdapterProduction(provider)).buildRequest(parsed);
  const body = JSON.parse(req.body);
  const contents = (body.request ?? body).contents as Array<{ role: string; parts: Array<{ text?: string }> }>;
  return contents.filter(c => c.role === "model")
    .map(c => c.parts.filter(p => typeof p.text === "string").map(p => p.text!));
}

describe("Gemini progress-text history", () => {
  test("repeated abbreviation boundaries inspect only a linear amount of text", () => {
    const text = "e.g. E.G. i.e. I.E. etc. ETC. vs. VS.\u2003\n \n".repeat(1024) + "Ready. Tail.";
    const slice = String.prototype.slice;
    const trim = String.prototype.trim;
    const testRegex = RegExp.prototype.test;
    let inspected = 0;
    let lead: string | undefined;
    try {
      String.prototype.slice = function (start = 0, end = this.length) {
        const result = slice.call(this, start, end);
        inspected += result.length;
        return result;
      };
      String.prototype.trim = function () {
        inspected += this.length;
        return trim.call(this);
      };
      RegExp.prototype.test = function (value) {
        inspected += String(value).length;
        return testRegex.call(this, value);
      };
      lead = geminiProgressLead(text);
    } finally {
      String.prototype.slice = slice;
      String.prototype.trim = trim;
      RegExp.prototype.test = testRegex;
    }
    expect(lead).toBe(text.slice(0, -" Tail.".length));
    expect(inspected).toBeLessThan(text.length * 16);
  });

  test("keeps abbreviation, marker, whitespace and closing-character semantics", () => {
    for (const marker of ["1.", "999.", "a.", "Z."]) {
      expect(geminiProgressLead(`${marker}\u2003\n\tRead now. Tail.`)).toBe(`${marker}\u2003\n\tRead now.`);
    }
    for (const abbreviation of ["e.g.", "E.G.", "i.e.", "I.E.", "etc.", "ETC.", "vs.", "VS."]) {
      expect(geminiProgressLead(`\uFEFF ${abbreviation}\u00A0\n \nRead now. Tail. \u3000`))
        .toBe(`${abbreviation}\u00A0\n \nRead now.`);
      expect(geminiProgressLead(`See ${abbreviation}\" Tail.`)).toBe(`See ${abbreviation}\"`);
    }
    for (const lead of ["1000.", "worda.", "Xe.g.", "Ready!\"", "Ready?)**", "確認。\u300D", "完了！\u300F"]) {
      expect(geminiProgressLead(`${lead} Tail.`)).toBe(lead);
    }
    expect(geminiProgressLead("e.g.\n\n")).toBe("e.g.");
    expect(geminiProgressLead("\u200B e.g.\nRead now. Tail.")).toBe("\u200B e.g.\nRead now.");
    expect(geminiProgressLead("```ts\nReady. Tail.\n```")).toBeUndefined();
    expect(geminiProgressLead("e.g.\n" + " \n".repeat(2048) + " ".repeat(8192) + "Ready. Tail."))
      .toBe("e.g.\n" + " \n".repeat(2048) + " ".repeat(8192) + "Ready.");
  });

  test("Responses parser keeps history intact until the Gemini adapter projects progress", async () => {
    const progress = "e.g. E.G.\u2003\n \n".repeat(256) + "Ready. Tail.";
    for (const phase of ["commentary", "final_answer"] as const) {
      const parsed = parseRequest({ model: "gemini-4-argon", input: [
        { role: "user", content: "Continue" },
        { role: "assistant", phase, content: [{ type: "output_text", text: progress }] },
        { type: "function_call", call_id: "call_1", name: "exec", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
        { role: "assistant", phase: "final_answer", content: "Final answer. Kept whole." },
      ] });
      const original = JSON.stringify(parsed.context.messages);
      expect(original).toContain(JSON.stringify(progress).slice(1, -1));
      const request = await withTestTranslatorBudget(createGoogleAdapterProduction(aiStudio)).buildRequest(parsed);
      const contents = JSON.parse(request.body).contents;
      expect(contents.filter((turn: { role: string }) => turn.role === "model")
        .map((turn: { parts: Array<{ text?: string }> }) => turn.parts.flatMap(part => part.text ?? [])))
        .toEqual([[phase === "commentary" ? progress.slice(0, -" Tail.".length) : progress], ["Final answer. Kept whole."]]);
      expect(JSON.stringify(parsed.context.messages)).toBe(original);
    }
  });

  test("Argon tool turns replay only the lead sentence before the call; final answers stay whole", async () => {
    expect(await modelTexts(antigravity, "gemini-4-argon")).toEqual([
      [LEAD, "After the call. Kept whole."], ["Final answer. It keeps every sentence."],
    ]);
    expect(await modelTexts(antigravity, "gemini-4-argon", "commentary")).toEqual([
      [LEAD, "After the call. Kept whole."], ["Final answer. It keeps every sentence."],
    ]);
  });

  test("a turn Codex marks final_answer is replayed whole", async () => {
    expect(await modelTexts(antigravity, "gemini-4-argon", "final_answer")).toEqual([
      [LEAKED, "Maybe the classifier is wrong.", "After the call. Kept whole."], ["Final answer. It keeps every sentence."],
    ]);
  });

  test("AI Studio Gemini gets the same history", async () => {
    expect(await modelTexts(aiStudio, "gemini-3.5-flash")).toEqual([
      [LEAD, "After the call. Kept whole."], ["Final answer. It keeps every sentence."],
    ]);
  });

  test("Claude on Antigravity keeps its full progress text", async () => {
    expect(await modelTexts(antigravity, "claude-sonnet-5-5")).toEqual([
      [LEAKED, "Maybe the classifier is wrong.", "After the call. Kept whole."], ["Final answer. It keeps every sentence."],
    ]);
  });

  test("the lead split is punctuation-based and language-neutral", () => {
    expect(geminiProgressLead("Reading the adapter now! Wait, maybe the encoder too.")).toBe("Reading the adapter now!");
    expect(geminiProgressLead("1. Read google.ts next.\n2. Then the encoder.")).toBe("1. Read google.ts next.");
    expect(geminiProgressLead("google.ts와 chat.ts를 읽겠습니다")).toBe("google.ts와 chat.ts를 읽겠습니다");
    expect(geminiProgressLead("次に google.ts を読みます。Let's go.")).toBe("次に google.ts を読みます。");
    expect(geminiProgressLead("Done. Let's read google.ts next.")).toBe("Done.");
    expect(geminiProgressLead("確認します。Let's inspect the encoder next.")).toBe("確認します。");
    expect(geminiProgressLead("मैं फ़ाइल पढ़ूँगा। Let's read google.ts next.")).toBe("मैं फ़ाइल पढ़ूँगा।");
    expect(geminiProgressLead("سأقرأ الملف۔ Let's read google.ts next.")).toBe("سأقرأ الملف۔");
    expect(geminiProgressLead("Reading **the docs.** Let's inspect the encoder next.")).toBe("Reading **the docs.**");
    expect(geminiProgressLead("Check e.g. the 3.5 encoder first. Then more.")).toBe("Check e.g. the 3.5 encoder first.");
    expect(geminiProgressLead("  \n ")).toBeUndefined();
    expect(geminiProgressLead("```js\nconst x = 1;\n```")).toBeUndefined();
  });
});
