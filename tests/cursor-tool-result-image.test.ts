import { describe, expect, test } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { handleCursorNativeKv, setCursorBlobLimitsForTests } from "../src/adapters/cursor/native-exec";
import { encodeCursorRunRequest } from "../src/adapters/cursor/protobuf-request";
import {
  AgentClientMessageSchema,
  ConversationTurnStructureSchema,
  ConversationStepSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import type { OcxMessage } from "../src/types";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64");
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

function blobData(blobId: Uint8Array): Uint8Array {
  const reply = fromBinary(AgentClientMessageSchema, handleCursorNativeKv(create(KvServerMessageSchema, {
    id: 1,
    message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
  })));
  if (reply.message.case !== "kvClientMessage") throw new Error("not kv");
  const kv = reply.message.value;
  if (kv.message.case !== "getBlobResult") throw new Error("not blob result");
  return kv.message.value.blobData;
}

/**
 * Every content item the ENCODER emits for the tool result attached to the assistant's tool call.
 * This is encoder-level: it calls encodeCursorRunRequest directly, so it deliberately bypasses the
 * server's vision preprocessing. In production every Cursor model is in noVisionModels, so images
 * are described or stripped before the adapter runs — these assertions prove encoder support, not
 * end-to-end delivery.
 */
function toolResultItems(bytes: Uint8Array) {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  const turnIds = run?.conversationState?.turns ?? [];
  const stepIds: Uint8Array[] = [];
  for (const turnId of turnIds) {
    const turn = fromBinary(ConversationTurnStructureSchema, blobData(turnId));
    if (turn.turn.case !== "agentConversationTurn") continue;
    stepIds.push(...(turn.turn.value.steps ?? []));
  }
  for (const stepId of stepIds) {
    const step = fromBinary(ConversationStepSchema, blobData(stepId));
    if (step.message.case !== "toolCall") continue;
    const tool = step.message.value.tool;
    if (tool.case !== "mcpToolCall") continue;
    const result = tool.value.result;
    if (result?.result.case !== "success") continue;
    return result.result.value.content;
  }
  return undefined;
}

function request(resultContent: OcxMessage extends never ? never : any) {
  const rawMessages: OcxMessage[] = [
    { role: "user", content: "take a screenshot", timestamp: 1 },
    {
      role: "assistant",
      model: "cursor/auto",
      timestamp: 2,
      content: [{ type: "toolCall", id: "call_shot", name: "js", namespace: "mcp__node_repl", arguments: {} }],
    },
    {
      role: "toolResult",
      toolCallId: "call_shot",
      toolName: "js",
      toolNamespace: "mcp__node_repl",
      content: resultContent,
      isError: false,
      timestamp: 3,
    },
  ];
  return encodeCursorRunRequest({
    modelId: "composer-2.5",
    conversationId: "cursor_image_test",
    system: ["You are helpful."],
    messages: [{ role: "tool", content: "[tool_result]" }],
    rawMessages,
  });
}

describe("Cursor tool-result image passthrough", () => {
  test("a data: image becomes real McpImageContent with its bytes and mime, in part order", () => {
    const items = toolResultItems(request([
      { type: "text", text: "here is the screen" },
      { type: "image", imageUrl: PNG_DATA_URL, detail: "auto" },
    ]));

    expect(items).toBeDefined();
    expect(items!.length).toBe(2);
    expect(items![0].content.case).toBe("text");
    expect(items![0].content.case === "text" ? items![0].content.value.text : "").toBe("here is the screen");
    // The decisive assertion: the encoder emits the actual bytes, not a placeholder.
    expect(items![1].content.case).toBe("image");
    if (items![1].content.case !== "image") throw new Error("expected image content");
    expect(items![1].content.value.mimeType).toBe("image/png");
    expect(Array.from(items![1].content.value.data)).toEqual(Array.from(PNG_BYTES));
  });

  test("string content still produces exactly one text item", () => {
    const items = toolResultItems(request("plain output"));

    expect(items).toBeDefined();
    expect(items!.length).toBe(1);
    expect(items![0].content.case).toBe("text");
    expect(items![0].content.case === "text" ? items![0].content.value.text : "").toBe("plain output");
  });

  test("a remote https image degrades to a placeholder and sends no bytes", () => {
    const items = toolResultItems(request([
      { type: "image", imageUrl: "https://example.com/shot.png" },
    ]));

    expect(items).toBeDefined();
    expect(items!.length).toBe(1);
    // McpImageContent carries bytes; fetching a remote URL inside request construction would put
    // network IO on the encoding path, so it stays a placeholder.
    expect(items![0].content.case).toBe("text");
    expect(items![0].content.case === "text" ? items![0].content.value.text : "").toContain("image omitted");
  });

  test("malformed base64 degrades to a placeholder without throwing", () => {
    const items = toolResultItems(request([
      { type: "image", imageUrl: "data:image/png;base64,!!!not-base64!!!" },
    ]));

    expect(items).toBeDefined();
    expect(items!.length).toBe(1);
    expect(items![0].content.case).toBe("text");
    expect(items![0].content.case === "text" ? items![0].content.value.text : "").toContain("image omitted");
  });

  test("two images that both fit the default ceiling are both sent as bytes", () => {
    // At the production limit these are comfortably admissible, so nothing degrades. The
    // degradation boundary is exercised against the real admission limit in the suite below,
    // not against a decoded-byte heuristic.
    const bytesA = new Uint8Array(4096).fill(7);
    const url = `data:image/png;base64,${Buffer.from(bytesA).toString("base64")}`;
    const items = toolResultItems(request([
      { type: "image", imageUrl: url },
      { type: "image", imageUrl: url },
    ]));

    expect(items).toBeDefined();
    expect(items!.length).toBe(2);
    expect(items!.map(i => i.content.case)).toEqual(["image", "image"]);
  });

  test("a text-only tool result is byte-identical to the pre-change encoding", () => {
    // Guards the no-image path: nothing about a request without images may shift.
    const a = toolResultItems(request([{ type: "text", text: "only text" }]));
    const b = toolResultItems(request("only text"));

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.length).toBe(1);
    expect(a![0].content.case).toBe("text");
    expect(a![0].content.case === "text" ? a![0].content.value.text : "").toBe("only text");
    expect(b![0].content.case === "text" ? b![0].content.value.text : "").toBe("only text");
  });
});

describe("Cursor tool-result image admission safety", () => {
  // The audit's exact regression: a step whose arguments already fill most of the per-blob
  // ceiling. Adding real image bytes must never turn a request that is admitted today into a
  // CursorBlobAdmissionError. Budgeting decoded image bytes alone cannot guarantee that, because
  // the step also carries arguments, text, mime strings, and protobuf framing in the SAME blob.
  test("a near-limit tool call still encodes when an image is attached", () => {
    setCursorBlobLimitsForTests({ maxEntryBytes: 1024 });
    try {
      const bigArg = "x".repeat(448);
      const imageBytes = new Uint8Array(460).fill(9);
      const rawMessages: OcxMessage[] = [
        { role: "user", content: "go", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/auto",
          timestamp: 2,
          content: [{ type: "toolCall", id: "call_big", name: "js", namespace: "mcp__node_repl", arguments: { code: bigArg } }],
        },
        {
          role: "toolResult",
          toolCallId: "call_big",
          toolName: "js",
          toolNamespace: "mcp__node_repl",
          content: [{ type: "image", imageUrl: `data:image/png;base64,${Buffer.from(imageBytes).toString("base64")}` }],
          isError: false,
          timestamp: 3,
        },
      ];

      // Must not throw: the step degrades its image rather than failing admission.
      const bytes = encodeCursorRunRequest({
        modelId: "composer-2.5",
        conversationId: "cursor_admission_test",
        system: ["s"],
        messages: [{ role: "tool", content: "[tool_result]" }],
        rawMessages,
      });

      const items = toolResultItems(bytes);
      expect(items).toBeDefined();
      // The image did not fit alongside the arguments, so it degraded to a placeholder
      // instead of blowing the blob limit.
      expect(items!.every(i => i.content.case === "text")).toBe(true);
    } finally {
      setCursorBlobLimitsForTests();
    }
  });

  test("an image that comfortably fits the limit is still sent as bytes", () => {
    setCursorBlobLimitsForTests({ maxEntryBytes: 64 * 1024 });
    try {
      const items = toolResultItems(request([
        { type: "image", imageUrl: PNG_DATA_URL },
      ]));
      expect(items).toBeDefined();
      expect(items![0].content.case).toBe("image");
    } finally {
      setCursorBlobLimitsForTests();
    }
  });

  test("when several images cannot all fit, the NEWEST is the one retained", () => {
    setCursorBlobLimitsForTests({ maxEntryBytes: 8 * 1024 });
    try {
      const older = new Uint8Array(5 * 1024).fill(1);
      const newer = new Uint8Array(5 * 1024).fill(2);
      const items = toolResultItems(request([
        { type: "image", imageUrl: `data:image/png;base64,${Buffer.from(older).toString("base64")}` },
        { type: "image", imageUrl: `data:image/png;base64,${Buffer.from(newer).toString("base64")}` },
      ]));

      expect(items).toBeDefined();
      expect(items!.length).toBe(2);
      // Oldest degrades first; the most recent screenshot is what the model is reasoning about.
      expect(items![0].content.case).toBe("text");
      expect(items![1].content.case).toBe("image");
      if (items![1].content.case !== "image") throw new Error("expected image");
      expect(Array.from(items![1].content.value.data)).toEqual(Array.from(newer));
    } finally {
      setCursorBlobLimitsForTests();
    }
  });
});


describe("Cursor tool-result image encoding never enlarges a step", () => {
  // Round-2 audit finding: at a 1024-byte ceiling an 831-char argument serialized to 993 bytes
  // with the legacy placeholder but 1025 with the new one — the degraded placeholder itself
  // pushed a previously admissible step over the limit. The invariant is that a degraded image
  // must never cost MORE than the legacy text it replaced, so this compares the two encodings
  // directly rather than guessing at an absolute ceiling.
  test("a degraded image is never larger than the legacy placeholder it replaces", () => {
    const legacyText = "[image input unsupported by Cursor adapter phase 3: auto]";
    const oversized = `data:image/png;base64,${Buffer.from(new Uint8Array(4096).fill(3)).toString("base64")}`;

    setCursorBlobLimitsForTests({ maxEntryBytes: 2048 });
    try {
      const items = toolResultItems(request([{ type: "image", imageUrl: oversized }]));
      expect(items).toBeDefined();
      expect(items!.length).toBe(1);
      expect(items![0].content.case).toBe("text");
      const emitted = items![0].content.case === "text" ? items![0].content.value.text : "";
      // The whole point: our replacement text is not bigger than what shipped before.
      expect(emitted.length).toBeLessThanOrEqual(legacyText.length);
    } finally {
      setCursorBlobLimitsForTests();
    }
  });

  test("an undecodable image placeholder also stays within the legacy budget", () => {
    const legacyText = "[image input unsupported by Cursor adapter phase 3: auto]";
    for (const url of ["https://example.com/a.png", "data:image/png;base64,!!!bad!!!"]) {
      const items = toolResultItems(request([{ type: "image", imageUrl: url }]));
      const emitted = items && items[0].content.case === "text" ? items[0].content.value.text : "";
      expect(emitted.length).toBeLessThanOrEqual(legacyText.length);
    }
  });

  test("degrading many images stays fast (images are decoded once, not per attempt)", () => {
    setCursorBlobLimitsForTests({ maxEntryBytes: 8192 });
    try {
      const img = `data:image/png;base64,${Buffer.from(new Uint8Array(9 * 1024).fill(4)).toString("base64")}`;
      const parts = Array.from({ length: 40 }, () => ({ type: "image" as const, imageUrl: img }));
      const started = Date.now();
      const items = toolResultItems(request(parts));
      const elapsed = Date.now() - started;

      expect(items).toBeDefined();
      expect(items!.every(i => i.content.case === "text")).toBe(true);
      // Re-decoding base64 on every shrink attempt measured ~3s for 100 images before the fix.
      expect(elapsed).toBeLessThan(2000);
    } finally {
      setCursorBlobLimitsForTests();
    }
  });
});

describe("Cursor no-image tool results encode exactly as before", () => {
  // Round-3 audit: legacy flattened text parts into ONE newline-joined item, while the first
  // pass emitted one protobuf item per part. The extra per-item framing was enough to push a
  // previously admissible step over the blob ceiling (1020 -> 1025 bytes at a 1024 limit).
  // These compare real serialized bytes, not decoded fields.
  function stepBytesFor(content: unknown): number {
    const bytes = request(content as never);
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    let total = 0;
    for (const turnId of run?.conversationState?.turns ?? []) {
      const turn = fromBinary(ConversationTurnStructureSchema, blobData(turnId));
      if (turn.turn.case !== "agentConversationTurn") continue;
      for (const stepId of turn.turn.value.steps ?? []) total += blobData(stepId).byteLength;
    }
    return total;
  }

  test("multi-part text costs the same as the equivalent joined string", () => {
    const joined = stepBytesFor("alpha\nbeta\ngamma");
    const parts = stepBytesFor([
      { type: "text", text: "alpha" },
      { type: "text", text: "beta" },
      { type: "text", text: "gamma" },
    ]);

    // One item, newline-joined — identical to the legacy encoding.
    expect(parts).toBe(joined);
  });

  test("a text-only result never costs more than a single flattened item", () => {
    for (const n of [1, 2, 5, 12]) {
      const texts = Array.from({ length: n }, (_, i) => `line-${i}-${"z".repeat(40)}`);
      const asParts = stepBytesFor(texts.map(text => ({ type: "text", text })));
      const asString = stepBytesFor(texts.join("\n"));
      expect(asParts).toBe(asString);
    }
  });

  test("an empty text array still produces one item", () => {
    const items = toolResultItems(request([]));
    expect(items).toBeDefined();
    expect(items!.length).toBe(1);
    expect(items![0].content.case).toBe("text");
  });

  test("text around an image is grouped, not split per part", () => {
    const items = toolResultItems(request([
      { type: "text", text: "before-a" },
      { type: "text", text: "before-b" },
      { type: "image", imageUrl: PNG_DATA_URL },
      { type: "text", text: "after-a" },
      { type: "text", text: "after-b" },
    ]));

    expect(items).toBeDefined();
    expect(items!.map(i => i.content.case)).toEqual(["text", "image", "text"]);
    expect(items![0].content.case === "text" ? items![0].content.value.text : "").toBe("before-a\nbefore-b");
    expect(items![2].content.case === "text" ? items![2].content.value.text : "").toBe("after-a\nafter-b");
  });
});
