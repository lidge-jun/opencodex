import { describe, expect, test } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";
import { encodeCursorRunRequest } from "../src/adapters/cursor/protobuf-request";
import { CURSOR_VISION_IMAGE_HISTORY_MARKER } from "../src/adapters/cursor/images";
import {
  AgentClientMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { handleCursorNativeKv, resetCursorBlobStateForTests } from "../src/adapters/cursor/native-exec";
import { GetBlobArgsSchema, KvServerMessageSchema } from "../src/adapters/cursor/gen/agent_pb";
import { create } from "@bufbuild/protobuf";

function blobData(blobId: Uint8Array): Uint8Array {
  const reply = fromBinary(AgentClientMessageSchema, handleCursorNativeKv(create(KvServerMessageSchema, {
    id: 1,
    message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
  })));
  const kv = reply.message.case === "kvClientMessage" ? reply.message.value : undefined;
  const result = kv?.message.case === "getBlobResult" ? kv.message.value.blobData : undefined;
  if (!result) throw new Error("missing blob data");
  return result;
}

function activeSelectedImageBytes(bytes: Uint8Array): Uint8Array | undefined {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  const action = run?.action?.action;
  const image = action?.case === "userMessageAction"
    ? action.value.userMessage?.selectedContext?.selectedImages[0]
    : undefined;
  if (!image) return undefined;
  if (image.dataOrBlobId.case === "data") return image.dataOrBlobId.value;
  if (image.dataOrBlobId.case === "blobId") return blobData(image.dataOrBlobId.value);
  if (image.dataOrBlobId.case === "blobIdWithData") return image.dataOrBlobId.value.data;
  return undefined;
}

function anyMcpImageContent(bytes: Uint8Array): boolean {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  for (const turnId of run?.conversationState?.turns ?? []) {
    const turn = fromBinary(ConversationTurnStructureSchema, blobData(turnId));
    if (turn.turn.case !== "agentConversationTurn") continue;
    for (const stepId of turn.turn.value.steps) {
      const step = fromBinary(ConversationStepSchema, blobData(stepId));
      if (step.message.case !== "toolCall") continue;
      const tool = step.message.value.tool;
      if (tool.case !== "mcpToolCall") continue;
      const result = tool.value.result?.result;
      if (result?.case !== "success") continue;
      for (const item of result.value.content) {
        if (item.content.case === "image") return true;
      }
    }
  }
  return false;
}

describe("Cursor vision wire harness", () => {
  test("grok attach keeps non-empty PNG bytes on the wire; tool-result images stay text-only", () => {
    resetCursorBlobStateForTests();
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
    const imageUrl = `data:image/png;base64,${Buffer.from(imageBytes).toString("base64")}`;

    const attachBytes = encodeCursorRunRequest({
      modelId: "grok-4.5",
      conversationId: "c1",
      system: [],
      messages: [{ role: "user", content: "see this" }],
      selectedImages: [{ uuid: "img-uuid-1", mimeType: "image/png", data: imageBytes }],
    });
    const attachWireBytes = activeSelectedImageBytes(attachBytes);
    expect(attachWireBytes).toBeDefined();
    expect(attachWireBytes!.byteLength).toBeGreaterThan(0);
    expect(Array.from(attachWireBytes!.slice(0, 4))).toEqual([137, 80, 78, 71]);

    const viewBytes = encodeCursorRunRequest({
      modelId: "grok-4.5",
      conversationId: "c1",
      system: ["You are helpful."],
      messages: [{ role: "tool", content: "[tool_result]\ncall_id: call_view\nname: view_image\nis_error: false\noutput:" }],
      rawMessages: [
        { role: "user", content: "describe the image", timestamp: 1 },
        {
          role: "assistant",
          model: "cursor/grok-4.5",
          timestamp: 2,
          content: [{ type: "toolCall", id: "call_view", name: "view_image", arguments: { path: "/tmp/x.png" } }],
        },
        {
          role: "toolResult",
          toolCallId: "call_view",
          toolName: "view_image",
          content: [{ type: "image", imageUrl, detail: "auto" }],
          isError: false,
          timestamp: 3,
        },
      ],
    });
    // Tool-result image promotion is out of scope in this slice: no McpImageContent on the wire.
    expect(anyMcpImageContent(viewBytes)).toBe(false);
    // Image bytes must never be serialized into text. Scan the whole encoded frame.
    const base64Payload = imageUrl.slice(imageUrl.indexOf(",") + 1);
    expect(new TextDecoder().decode(viewBytes)).not.toContain(base64Payload);
    expect(new TextDecoder().decode(viewBytes)).not.toContain("data:image/png;base64,");
    const blobText = hydratedTurnText(viewBytes);
    expect(blobText).not.toContain(base64Payload);
    expect(blobText).not.toContain("data:image/png;base64,");
    expect(blobText).toContain(CURSOR_VISION_IMAGE_HISTORY_MARKER);
  });
});

function hydratedTurnText(bytes: Uint8Array): string {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  const parts: string[] = [];
  for (const turnId of run?.conversationState?.turns ?? []) {
    const turn = fromBinary(ConversationTurnStructureSchema, blobData(turnId));
    if (turn.turn.case !== "agentConversationTurn") continue;
    parts.push(new TextDecoder().decode(blobData(turn.turn.value.userMessage)));
    for (const stepId of turn.turn.value.steps) {
      parts.push(new TextDecoder().decode(blobData(stepId)));
    }
  }
  return parts.join("\n");
}
