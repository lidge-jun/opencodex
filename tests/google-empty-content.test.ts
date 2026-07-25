import { describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../src/adapters/google";
import type { OcxParsedRequest } from "../src/types";

// Antigravity translates these Gemini `contents` into Anthropic `messages` for Claude models, and
// Anthropic rejects empty/absent text and empty content arrays. An empty Gemini text part reaches
// that upstream as `{"type":"text"}` (a proto3 empty string is omitted from JSON), producing
// `messages.0.content.N.text.text: Field required` (issue #420). Gemini itself tolerates the same
// parts, which is why this only ever surfaced on Claude-on-Antigravity.

const provider = { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "key" };

function parsedWith(messages: unknown[]): OcxParsedRequest {
  return { modelId: "gemini-3-pro", stream: false, options: {}, context: { messages } } as unknown as OcxParsedRequest;
}

async function geminiContents(parsed: OcxParsedRequest): Promise<{ role: string; parts: Record<string, unknown>[] }[]> {
  const { body } = await createGoogleAdapter(provider).buildRequest(parsed);
  return JSON.parse(body).contents;
}

/** Every emitted text part must survive a JSON round-trip with a non-empty string `text`. */
function assertNoEmptyTextParts(contents: { role: string; parts: Record<string, unknown>[] }[]): void {
  for (const turn of contents) {
    expect(Array.isArray(turn.parts)).toBe(true);
    expect(turn.parts.length).toBeGreaterThan(0);
    for (const part of turn.parts) {
      if (!("text" in part)) continue;
      expect(typeof part.text).toBe("string");
      expect((part.text as string).length).toBeGreaterThan(0);
    }
  }
}

describe("google adapter — empty content part guard (#420)", () => {
  test("user message with empty string content emits a placeholder, not an empty text part", async () => {
    const contents = await geminiContents(parsedWith([
      { role: "user", content: "", timestamp: 0 },
    ]));

    expect(contents[0].parts).toEqual([{ text: "(empty)" }]);
    assertNoEmptyTextParts(contents);
  });

  test("developer message with empty string content emits the same non-empty placeholder", async () => {
    const contents = await geminiContents(parsedWith([
      { role: "developer", content: "", timestamp: 0 },
    ]));

    expect(contents).toEqual([{ role: "user", parts: [{ text: "(empty)" }] }]);
    assertNoEmptyTextParts(contents);
  });

  test("empty text parts are dropped from a user message", async () => {
    const contents = await geminiContents(parsedWith([
      { role: "user", content: [{ type: "text", text: "" }, { type: "text", text: "hello" }], timestamp: 0 },
    ]));

    expect(contents[0].parts).toEqual([{ text: "hello" }]);
    assertNoEmptyTextParts(contents);
  });

  test("a user message whose parts are all empty falls back to a placeholder", async () => {
    const contents = await geminiContents(parsedWith([
      { role: "user", content: [{ type: "text", text: "" }], timestamp: 0 },
    ]));

    expect(contents[0].parts).toEqual([{ text: "(empty)" }]);
    assertNoEmptyTextParts(contents);
  });

  test("a malformed part with a missing text field never becomes a bare {} part", async () => {
    // A Responses `input_text` block with no `text` key parses into this shape
    // (src/responses/parser.ts casts without validating), and `{ text: undefined }`
    // serializes to `{}` — exactly the block Anthropic reports as `Field required`.
    const contents = await geminiContents(parsedWith([
      { role: "user", content: [{ type: "text" }, { type: "text", text: "real" }], timestamp: 0 },
    ]));

    expect(contents[0].parts).toEqual([{ text: "real" }]);
    assertNoEmptyTextParts(contents);
  });

  test("a non-string text value is dropped rather than sent as an object", async () => {
    const contents = await geminiContents(parsedWith([
      { role: "user", content: [{ type: "text", text: { nested: "object" } }, { type: "text", text: "real" }], timestamp: 0 },
    ]));

    expect(contents[0].parts).toEqual([{ text: "real" }]);
    assertNoEmptyTextParts(contents);
  });

  test("empty assistant text parts are dropped", async () => {
    const contents = await geminiContents(parsedWith([
      { role: "user", content: "start", timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "" }, { type: "text", text: "visible" }], timestamp: 0 },
    ]));

    const model = contents.find(c => c.role === "model");
    expect(model!.parts).toEqual([{ text: "visible" }]);
    assertNoEmptyTextParts(contents);
  });

  test("an assistant text array whose parts are all empty is skipped", async () => {
    const contents = await geminiContents(parsedWith([
      { role: "user", content: "start", timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "text", text: "" }, { type: "text", text: "" }],
        timestamp: 0,
      },
    ]));

    expect(contents.find(c => c.role === "model")).toBeUndefined();
    assertNoEmptyTextParts(contents);
  });

  test("an assistant turn with no emittable parts is skipped, not sent with parts: []", async () => {
    // Thinking-only assistant turns carry no Gemini-representable part: the loop handles
    // text and toolCall only, so the turn would otherwise serialize as `parts: []`.
    const contents = await geminiContents(parsedWith([
      { role: "user", content: "start", timestamp: 0 },
      { role: "assistant", content: [{ type: "thinking", thinking: "internal", signature: "sig" }], timestamp: 0 },
    ]));

    expect(contents.find(c => c.role === "model")).toBeUndefined();
    assertNoEmptyTextParts(contents);
  });

  test("an empty tool result emits a placeholder result string", async () => {
    const contents = await geminiContents(parsedWith([
      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }], timestamp: 0 },
      { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: "", isError: false, timestamp: 0 },
    ]));

    const toolTurn = contents.find(c => c.parts.some(p => "functionResponse" in p));
    expect(toolTurn!.parts[0]).toEqual({
      functionResponse: { name: "bash", response: { result: "(empty tool output)" }, id: "call_1" },
    });
  });

  test("a tool result with an empty parts array does not claim a phantom image", async () => {
    // contentPartsToText([]) collapses to its "[image]" marker, but toolResultImageParts()
    // contributes no image part — the result would assert an image the turn does not carry.
    const contents = await geminiContents(parsedWith([
      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }], timestamp: 0 },
      { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [], isError: false, timestamp: 0 },
    ]));

    const toolTurn = contents.find(c => c.parts.some(p => "functionResponse" in p));
    expect(toolTurn!.parts).toEqual([
      { functionResponse: { name: "bash", response: { result: "(empty tool output)" }, id: "call_1" } },
    ]);
  });

  test("a tool result holding only empty text parts uses the placeholder", async () => {
    const contents = await geminiContents(parsedWith([
      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }], timestamp: 0 },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "" }, { type: "text", text: "" }],
        isError: false,
        timestamp: 0,
      },
    ]));

    const toolTurn = contents.find(c => c.parts.some(p => "functionResponse" in p));
    const fr = toolTurn!.parts[0] as { functionResponse: { response: { result: string } } };
    expect(fr.functionResponse.response.result).toBe("(empty tool output)");
  });

  test("a genuine image-only tool result still reports [image]", async () => {
    const contents = await geminiContents(parsedWith([
      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "snap", arguments: {} }], timestamp: 0 },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "snap",
        content: [{ type: "image", imageUrl: "data:image/png;base64,aGVsbG8=" }],
        isError: false,
        timestamp: 0,
      },
    ]));

    const toolTurn = contents.find(c => c.parts.some(p => "functionResponse" in p));
    const fr = toolTurn!.parts[0] as { functionResponse: { response: { result: string } } };
    expect(fr.functionResponse.response.result).toBe("[image]");
    expect(toolTurn!.parts[1]).toEqual({ inline_data: { mime_type: "image/png", data: "aGVsbG8=" } });
  });

  test("non-empty content is unchanged", async () => {
    const contents = await geminiContents(parsedWith([
      { role: "user", content: "hello", timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 0 },
      { role: "user", content: [{ type: "text", text: "again" }], timestamp: 0 },
    ]));

    expect(contents).toEqual([
      { role: "user", parts: [{ text: "hello" }] },
      { role: "model", parts: [{ text: "hi" }] },
      { role: "user", parts: [{ text: "again" }] },
    ]);
  });
});
