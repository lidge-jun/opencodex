/**
 * Audit F8 (2026-09-14): the shared coding-agent projection (CodeBuddy, Qoder) kept a
 * user message's images as real image blocks but flattened a tool result's images to
 * the literal text "[image]", discarding the carrier entirely.
 *
 * Image blocks are also ordered chronologically now. Current-turn images used to be
 * appended before the history loop ran, so the attachment order contradicted the
 * prose the model reads beside them ("Prior conversation context" then "Current user
 * request").
 *
 * Vendor tool execution stays off for these adapters; this is a projection fix only.
 */
import { describe, expect, test } from "bun:test";
import { buildConversationInput } from "../../src/adapters/coding-agent/protocol";
import type { OcxParsedRequest } from "../../src/types";

// Distinguishable payloads so ordering is provable, not merely counted.
const OLD_IMAGE = "data:image/png;base64,T0xE";
const NEW_IMAGE = "data:image/png;base64,TkVX";

function projected(messages: unknown[]): { text: string; images: Array<{ source: { data?: string; url?: string } }> } {
  const parsed = { modelId: "codebuddy/model", stream: false, options: {}, context: { messages } } as unknown as OcxParsedRequest;
  const [line] = buildConversationInput(parsed);
  const content = JSON.parse(line!).message.content as Array<Record<string, unknown>>;
  return {
    text: content.filter(p => p.type === "text").map(p => p.text as string).join(""),
    images: content.filter(p => p.type === "image") as unknown as Array<{ source: { data?: string; url?: string } }>,
  };
}

const ASSISTANT_CALL = {
  role: "assistant",
  content: [{ type: "toolCall", id: "call1", name: "screenshot", arguments: {} }],
  timestamp: 1,
};

describe("F8 tool-result images are carried, not flattened", () => {
  test("a current tool result's image reaches the wire as an image block", () => {
    const out = projected([
      { role: "user", content: "inspect", timestamp: 0 },
      ASSISTANT_CALL,
      { role: "toolResult", toolCallId: "call1", content: [{ type: "image", imageUrl: NEW_IMAGE }], isError: false, timestamp: 2 },
    ]);

    expect(out.images).toHaveLength(1);
    expect(out.images[0]!.source.data).toBe("TkVX");
    // The bare "[image]" flattening is gone; a provenance note takes its place.
    expect(out.text).not.toContain("\n[image]");
    expect(out.text).toContain("[image attached below]");
  });

  test("a remote https tool-result image becomes a url source", () => {
    const out = projected([
      { role: "user", content: "inspect", timestamp: 0 },
      ASSISTANT_CALL,
      { role: "toolResult", toolCallId: "call1", content: [{ type: "image", imageUrl: "https://example.test/a.png" }], isError: false, timestamp: 2 },
    ]);

    expect(out.images[0]!.source.url).toBe("https://example.test/a.png");
  });

  test("the error label survives beside a carried image", () => {
    const out = projected([
      { role: "user", content: "inspect", timestamp: 0 },
      ASSISTANT_CALL,
      { role: "toolResult", toolCallId: "call1", content: [{ type: "image", imageUrl: NEW_IMAGE }], isError: true, timestamp: 2 },
    ]);

    expect(out.text).toContain("(error)");
    expect(out.images).toHaveLength(1);
  });

  test("text order inside a mixed tool result is preserved", () => {
    const out = projected([
      { role: "user", content: "inspect", timestamp: 0 },
      ASSISTANT_CALL,
      {
        role: "toolResult",
        toolCallId: "call1",
        content: [{ type: "text", text: "before" }, { type: "image", imageUrl: NEW_IMAGE }, { type: "text", text: "after" }],
        isError: false,
        timestamp: 2,
      },
    ]);

    expect(out.text).toContain("before[image attached below]after");
  });

  test("an unsupported image reference is labelled rather than dropped silently", () => {
    const out = projected([
      { role: "user", content: "inspect", timestamp: 0 },
      ASSISTANT_CALL,
      { role: "toolResult", toolCallId: "call1", content: [{ type: "image", imageUrl: "ftp://nope/a.png" }], isError: false, timestamp: 2 },
    ]);

    expect(out.images).toHaveLength(0);
    expect(out.text).toContain("[image omitted: unsupported reference]");
  });
});

describe("F8 image blocks follow conversation order", () => {
  test("a historical image precedes a current-turn image", () => {
    const out = projected([
      { role: "user", content: [{ type: "text", text: "first" }, { type: "image", imageUrl: OLD_IMAGE }], timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 1 },
      { role: "user", content: [{ type: "text", text: "second" }, { type: "image", imageUrl: NEW_IMAGE }], timestamp: 2 },
    ]);

    expect(out.images.map(i => i.source.data)).toEqual(["T0xE", "TkVX"]);
  });

  test("a historical tool-result image is carried too", () => {
    const out = projected([
      { role: "user", content: "inspect", timestamp: 0 },
      ASSISTANT_CALL,
      { role: "toolResult", toolCallId: "call1", content: [{ type: "image", imageUrl: OLD_IMAGE }], isError: false, timestamp: 2 },
      { role: "user", content: [{ type: "text", text: "now" }, { type: "image", imageUrl: NEW_IMAGE }], timestamp: 3 },
    ]);

    expect(out.images.map(i => i.source.data)).toEqual(["T0xE", "TkVX"]);
  });

  test("no images means no image blocks", () => {
    const out = projected([
      { role: "user", content: "a", timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "b" }], timestamp: 1 },
      { role: "user", content: "c", timestamp: 2 },
    ]);

    expect(out.images).toHaveLength(0);
  });
});
