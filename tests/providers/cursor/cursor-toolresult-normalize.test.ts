import { describe, expect, test } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { handleCursorNativeKv } from "../../../src/adapters/cursor/native-exec";
import { encodeCursorRunRequest } from "../../../src/adapters/cursor/protobuf-request";
import { normalizeCursorToolResultText } from "../../../src/adapters/cursor/tool-result-normalize";
import {
  AgentClientMessageSchema,
  ConversationTurnStructureSchema,
  ConversationStepSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../../../src/adapters/cursor/gen/agent_pb";
import type { CursorRunRequest } from "../../../src/adapters/cursor/types";
import type { OcxMessage, OcxToolResultMessage } from "../../../src/types";

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

/** Decode the native-wire McpToolResult attached to the first tool call step. */
function decodedToolResult(bytes: Uint8Array) {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  const turnIds = run?.conversationState?.turns ?? [];
  for (const turnId of turnIds) {
    const turn = fromBinary(ConversationTurnStructureSchema, blobData(turnId));
    if (turn.turn.case !== "agentConversationTurn") continue;
    for (const stepId of turn.turn.value.steps ?? []) {
      const step = fromBinary(ConversationStepSchema, blobData(stepId));
      if (step.message.case !== "toolCall") continue;
      const tool = step.message.value.tool;
      if (tool.case !== "mcpToolCall") continue;
      const result = tool.value.result;
      if (result?.result.case !== "success") continue;
      return result.result.value;
    }
  }
  return undefined;
}

function requestWith(
  resultContent: OcxToolResultMessage["content"],
  toolOverrides: Partial<{
    toolName: string;
    toolNamespace?: string;
    isError: boolean;
    containsEncryptedContent: boolean;
  }> = {},
  requestOverrides: Partial<CursorRunRequest> = {},
) {
  const rawMessages: OcxMessage[] = [
    { role: "user", content: "run it", timestamp: 1 },
    {
      role: "assistant",
      model: "cursor/auto",
      timestamp: 2,
      content: [{ type: "toolCall", id: "call_1", name: toolOverrides.toolName ?? "js", namespace: "toolNamespace" in toolOverrides ? toolOverrides.toolNamespace : "mcp__node_repl", arguments: {} }],
    },
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: toolOverrides.toolName ?? "js",
      toolNamespace: "toolNamespace" in toolOverrides ? toolOverrides.toolNamespace : "mcp__node_repl",
      content: resultContent,
      isError: toolOverrides.isError ?? false,
      containsEncryptedContent: toolOverrides.containsEncryptedContent,
      timestamp: 3,
    },
  ];
  return encodeCursorRunRequest({
    modelId: "composer-2.5",
    conversationId: "cursor_normalize_test",
    system: ["You are helpful."],
    messages: [{ role: "tool", content: "[tool_result]" }],
    rawMessages,
    ...requestOverrides,
  });
}

describe("normalizeCursorToolResultText (#1920/#1866 unit rows)", () => {
  test("blank node_repl output becomes an actionable error", () => {
    const out = normalizeCursorToolResultText("", { toolName: "js", toolNamespace: "mcp__node_repl" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("get_app_state");
  });

  test("empty exec wrapper (Script completed + <empty>) normalizes for node_repl", () => {
    const out = normalizeCursorToolResultText("Script completed\nOutput:\n<empty>", { toolName: "node_repl" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("[empty output");
  });

  test.each([
    ["SkyComputerUseError: focus lost", "get_app_state"],
    ["ReferenceError: sky is not defined", "privileged node_repl"],
    ["SyntaxError: Identifier 'x' has already been declared", "redeclaring"],
    ["unsupported import in exec", "injected globals"],
  ])("runtime failure %p is marked as error with guidance", (payload, hint) => {
    const out = normalizeCursorToolResultText(payload, { toolName: "js", toolNamespace: "mcp__node_repl" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(payload);
    expect(out.text).toContain(hint);
  });

  test.each(["Unsupported import in exec: node:fs", "unsupported import in exec: node:fs"])(
    "a code-mode exec result carrying %p gains the shared hint, keeps its isError, and is not re-annotated on replay",
    (payload) => {
      const out = normalizeCursorToolResultText(payload, { toolName: "exec", codeMode: true });
      expect(out.changed).toBe(true);
      expect(out.isError).toBe(false);
      expect(out.text).toBe(`${payload}\n[recovery: Imports are not available in this exec context; use the injected globals (tools, text, notify, store, load, ALL_TOOLS) instead.]`);
      // Replay through Responses history arrives with isError=false; the legacy lowercase marker
      // row must not get a second look at it.
      const replay = normalizeCursorToolResultText(out.text, { toolName: "exec", isError: false, codeMode: true });
      expect(replay).toEqual({ text: out.text, isError: false, changed: false });
    },
  );

  test("the legacy node_repl import row keeps its own isError policy", () => {
    const out = normalizeCursorToolResultText("unsupported import in exec", { toolName: "js", toolNamespace: "mcp__node_repl" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("injected globals");
  });

  test("a non-exec tool whose successful output merely mentions a host phrase stays byte-identical", () => {
    const doc = "The docs say apply_patch expects a string input.";
    const out = normalizeCursorToolResultText(doc, { toolName: "read_file" });
    expect(out.changed).toBe(false);
    expect(out.isError).toBe(false);
    expect(out.text).toBe(doc);
  });

  test("a non-computer-use tool with empty output stays byte-identical", () => {
    const out = normalizeCursorToolResultText("", { toolName: "read_file" });
    expect(out.changed).toBe(false);
    expect(out.text).toBe("");
    expect(out.isError).toBe(false);
  });

  test("ordinary non-empty output on node_repl stays byte-identical", () => {
    const out = normalizeCursorToolResultText("42", { toolName: "js", toolNamespace: "mcp__node_repl" });
    expect(out.changed).toBe(false);
    expect(out.text).toBe("42");
  });

  test("an already-error result is not double-annotated", () => {
    const out = normalizeCursorToolResultText("SkyComputerUseError: x", { toolName: "js", toolNamespace: "mcp__node_repl", isError: true });
    expect(out.changed).toBe(false);
    expect(out.isError).toBe(true);
  });
});

describe("native wire decode (#1920 disposition: formatted text at toolResultPart)", () => {
  test("an empty node_repl result decodes as normalized error text with isError=true on the wire", () => {
    const result = decodedToolResult(requestWith(""));
    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
    const first = result!.content[0];
    expect(first.content.case).toBe("text");
    expect(first.content.case === "text" ? first.content.value.text : "").toContain("[empty output");
  });

  test("a failure-state node_repl result decodes with recovery guidance and isError=true", () => {
    const result = decodedToolResult(requestWith("ReferenceError: sky is not defined"));
    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
    const first = result!.content[0];
    expect(first.content.case === "text" ? first.content.value.text : "").toContain("recovery");
  });

  test("an empty text-part result receives the same normalization as an empty string", () => {
    const result = decodedToolResult(requestWith([{ type: "text", text: "" }]));
    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
    const first = result!.content[0];
    expect(first.content.case === "text" ? first.content.value.text : "").toContain("[empty output");
  });

  test("a failure-state text-part result receives recovery guidance and isError=true", () => {
    const result = decodedToolResult(requestWith([{ type: "text", text: "ReferenceError: sky is not defined" }]));
    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
    const first = result!.content[0];
    expect(first.content.case === "text" ? first.content.value.text : "").toContain("recovery");
  });

  test("image-bearing results keep their text and image parts without failure normalization", () => {
    const failureText = "ReferenceError: sky is not defined";
    const result = decodedToolResult(requestWith([
      { type: "text", text: failureText },
      { type: "image", imageUrl: "data:image/png;base64,iVBORw0KGgo=" },
    ]));
    expect(result).toBeDefined();
    expect(result!.isError).toBe(false);
    expect(result!.content).toHaveLength(2);
    expect(result!.content[0]?.content.case === "text" ? result!.content[0].content.value.text : "").toBe(failureText);
    expect(result!.content[1]?.content.case).toBe("image");
  });

  test("encrypted text-part results remain unmodified", () => {
    const failureText = "ReferenceError: sky is not defined";
    const result = decodedToolResult(requestWith(
      [{ type: "text", text: failureText }],
      { containsEncryptedContent: true },
    ));
    expect(result).toBeDefined();
    expect(result!.isError).toBe(false);
    const first = result!.content[0];
    expect(first.content.case === "text" ? first.content.value.text : "").toBe(failureText);
  });

  test("a normal tool result decodes byte-identical (no normalization side effects)", () => {
    const result = decodedToolResult(requestWith("plain output", { toolName: "read_file", toolNamespace: undefined }));
    expect(result).toBeDefined();
    expect(result!.isError).toBe(false);
    const first = result!.content[0];
    expect(first.content.case === "text" ? first.content.value.text : "").toBe("plain output");
  });
});

/** Read both model-visible roots and external-model assistant steps from stored wire blobs. */
function decodedReplay(bytes: Uint8Array) {
  const message = fromBinary(AgentClientMessageSchema, bytes);
  if (message.message.case !== "runRequest") throw new Error("expected run request");
  const state = message.message.value.conversationState;
  const roots = (state?.rootPromptMessagesJson ?? []).map(id => {
    const root = JSON.parse(new TextDecoder().decode(blobData(id)));
    return typeof root.content === "string" ? root.content : root.content?.[0]?.text ?? "";
  }).filter((text: string) => /^\[Tool (?:Result|Error)\]/.test(text));
  const steps: string[] = [];
  for (const id of state?.turns ?? []) {
    const turn = fromBinary(ConversationTurnStructureSchema, blobData(id));
    if (turn.turn.case !== "agentConversationTurn") continue;
    for (const stepId of turn.turn.value.steps) {
      const step = fromBinary(ConversationStepSchema, blobData(stepId));
      if (step.message.case === "assistantMessage") steps.push(step.message.value.text);
    }
  }
  return { roots, steps };
}

const codeModeTools = [{ name: "exec", freeform: true, description: "Run JavaScript in a V8 isolate.", parameters: {} }];
const execResult = { toolName: "exec", toolNamespace: undefined };
const importFailure = "unsupported import in exec: node:fs";
const importRecovery = "[recovery: Imports are not available in this exec context; use the injected globals (tools, text, notify, store, load, ALL_TOOLS) instead.]";
const successfulSource = "Script completed\nWall time 0.1 seconds\nOutput:\nREADME.md:8: unsupported import in exec\nexit_code: 0";

function expectResultOutput(bytes: Uint8Array, modelId: string, output: string, isError = false) {
  const { roots, steps } = decodedReplay(bytes);
  expect(roots).toHaveLength(1);
  expect(roots[0]).toContain(`is_error: ${isError}\noutput:\n${output}`);
  expect(roots[0].endsWith(output)).toBe(true);
  expect(roots[0].startsWith(isError ? "[Tool Error]" : "[Tool Result]")).toBe(true);
  if (modelId === "composer-2.5") {
    const result = decodedToolResult(bytes);
    expect(result).toBeDefined();
    expect(result!.isError).toBe(isError);
    const first = result!.content[0];
    expect(first?.content.case === "text" ? first.content.value.text : undefined).toBe(output);
  } else {
    expect(steps).toHaveLength(1);
    expect(steps[0].startsWith(isError ? "[Tool Error]" : "[Tool Result]")).toBe(true);
    expect(steps[0].endsWith(`\n${output}`)).toBe(true);
    expect(steps[0].split("[recovery:").length).toBe(output.split("[recovery:").length);
  }
}

describe("Cursor host failure provenance and successful-output regression", () => {
  for (const modelId of ["composer-2.5", "grok-4.6"]) {
    test.each([
      ["structured exec", { tools: [{ ...codeModeTools[0], freeform: false }] }],
      ["no catalog", {}],
      ["shell bridge present", { tools: [...codeModeTools, { name: "exec_command", parameters: {} }] }],
      ["tool choice none", { tools: codeModeTools, toolChoice: "none" }],
      ["foreign exec namespace", { tools: [{ ...codeModeTools[0], namespace: "mcp__docker" }] }],
    ] satisfies [string, Partial<CursorRunRequest>][])(`${modelId}: %s has no code-mode host annotation`, (_label, catalog) => {
      for (const output of ["Script error:\ntool `apply_patch` expects a string input", importFailure]) {
        expectResultOutput(requestWith(output, execResult, { modelId, ...catalog }), modelId, output);
      }
    });

    test(`${modelId}: a genuine code-mode failure keeps error status and is idempotent`, () => {
      const output = `${importFailure}\n${importRecovery}`;
      for (const isError of [false, true]) {
        const options = { modelId, tools: codeModeTools };
        expectResultOutput(requestWith([{ type: "text", text: importFailure }], { ...execResult, isError }, options), modelId, output, isError);
        expectResultOutput(requestWith(output, { ...execResult, isError }, options), modelId, output, isError);
      }
    });

    test(`${modelId}: successful source output bypasses legacy import fallback`, () => {
      expectResultOutput(requestWith(successfulSource, execResult, { modelId, tools: codeModeTools }), modelId, successfulSource);
    });

    test(`${modelId}: node_repl keeps its legacy error guidance on replay`, () => {
      const failure = "ReferenceError: sky is not defined";
      const output = `${failure}\n[recovery: The sky binding is unavailable in this context; Computer Use calls only work inside the privileged node_repl session.]`;
      expectResultOutput(requestWith(failure, {}, { modelId, tools: codeModeTools }), modelId, output, true);
      expectResultOutput(requestWith(output, { isError: true }, { modelId, tools: codeModeTools }), modelId, output, true);
    });

    test(`${modelId}: encrypted code-mode output is untouched`, () => {
      expectResultOutput(requestWith(importFailure, { ...execResult, containsEncryptedContent: true }, { modelId, tools: codeModeTools }), modelId, importFailure);
    });

    test(`${modelId}: image-bearing replay does not infer a host failure from its text`, () => {
      const bytes = requestWith([
        { type: "text", text: importFailure },
        { type: "image", imageUrl: "data:image/png;base64,iVBORw0KGgo=" },
      ], execResult, { modelId, tools: codeModeTools });
      const { roots, steps } = decodedReplay(bytes);
      expect(roots).toHaveLength(1);
      for (const text of [...roots, ...steps]) {
        expect(text).toContain(importFailure);
        expect(text).not.toContain("[recovery:");
        expect(text).not.toContain("[Tool Error]");
      }
      if (modelId === "composer-2.5") {
        const result = decodedToolResult(bytes)!;
        expect(result.isError).toBe(false);
        expect(result.content.map(part => part.content.case)).toEqual(["text", "image"]);
      }
    });
  }

  test("unit annotation requires explicit code-mode provenance", () => {
    for (const codeMode of [undefined, false]) {
      expect(normalizeCursorToolResultText(importFailure, { toolName: "exec", codeMode })).toEqual({ text: importFailure, isError: false, changed: false });
    }
  });

  test("successful node_repl wrappers also bypass legacy substring guidance", () => {
    expect(normalizeCursorToolResultText(successfulSource, { toolName: "node_repl" })).toEqual({ text: successfulSource, isError: false, changed: false });
  });
});
