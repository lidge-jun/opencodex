import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { create, fromBinary } from "@bufbuild/protobuf";
import { expect, test } from "bun:test";
import { handleCursorNativeExec } from "../src/adapters/cursor/native-exec";
import { createCursorRequest } from "../src/adapters/cursor/request-builder";
import {
  cursorRequestAdvertisesApplyPatch,
  isCursorSyntheticStructuredEditTool,
} from "../src/adapters/cursor/tool-definitions";
import {
  AgentClientMessageSchema,
  ExecServerMessageSchema,
  WriteArgsSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import type { OcxParsedRequest, OcxToolChoice } from "../src/types";

const liveTransportPath = fileURLToPath(new URL("../src/adapters/cursor/live-transport.ts", import.meta.url));

function parsedRequest(toolChoice?: OcxToolChoice): OcxParsedRequest {
  return {
    modelId: "cursor/auto",
    context: {
      messages: [{ role: "user", content: "Edit the requested file.", timestamp: 0 }],
      tools: [
        { name: "exec", description: "Run JavaScript", parameters: {} },
        { name: "apply_patch", description: "Apply a Codex patch", parameters: {}, freeform: true },
      ],
    },
    stream: false,
    options: toolChoice ? { toolChoice } : {},
  };
}

function writeExec(path: string, text: string) {
  return create(ExecServerMessageSchema, {
    id: 7,
    execId: "apply-patch-policy",
    message: {
      case: "writeArgs",
      value: create(WriteArgsSchema, { path, fileText: text }),
    },
  });
}

function decode(bytes: Uint8Array) {
  const message = fromBinary(AgentClientMessageSchema, bytes);
  expect(message.message.case).toBe("execClientMessage");
  if (message.message.case !== "execClientMessage") throw new Error("Expected execClientMessage");
  return message.message.value;
}

test("Cursor live transport wires native mutation rejection to the final apply_patch catalog", async () => {
  const source = await readFile(liveTransportPath, "utf8");

  expect(source).toMatch(
    /rejectNativeFileMutations:\s*cursorRequestAdvertisesApplyPatch\(\s*request\.tools,\s*request\.toolChoice\s*\)/,
  );
});

test("Cursor rejects native writes when the final request advertises freeform apply_patch", async () => {
  const request = createCursorRequest(parsedRequest());
  const rejectNativeFileMutations = cursorRequestAdvertisesApplyPatch(request.tools, request.toolChoice);
  const structuredEditAvailable = request.tools?.some(isCursorSyntheticStructuredEditTool) ?? false;

  expect(request.tools?.some(tool => tool.name === "apply_patch" && tool.freeform === true)).toBe(true);
  expect(rejectNativeFileMutations).toBe(true);

  const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-patch-policy-"));
  const path = join(dir, "blocked.txt");
  const result = decode((await handleCursorNativeExec(writeExec(path, "must not be written"), {
    unsafeAllowNativeLocalExec: true,
    rejectNativeFileMutations,
    structuredEditAvailable,
  }))[0]!);

  expect(result.message.case).toBe("writeResult");
  expect(result.message.value.result.case).toBe("rejected");
  if (result.message.value.result.case === "rejected") {
    expect(result.message.value.result.value.reason).toContain("apply_patch");
    expect(result.message.value.result.value.reason).toContain("No file was changed.");
  }
  expect(existsSync(path)).toBe(false);
});

test("Cursor leaves native write fallback available when tool_choice removes apply_patch", async () => {
  const request = createCursorRequest(parsedRequest({ name: "exec" }));
  const rejectNativeFileMutations = cursorRequestAdvertisesApplyPatch(request.tools, request.toolChoice);

  expect(request.tools?.map(tool => tool.name)).toEqual(["exec"]);
  expect(rejectNativeFileMutations).toBe(false);

  const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-native-fallback-"));
  const path = join(dir, "allowed.txt");
  const result = decode((await handleCursorNativeExec(writeExec(path, "native fallback"), {
    unsafeAllowNativeLocalExec: true,
    rejectNativeFileMutations,
  }))[0]!);

  expect(result.message.case).toBe("writeResult");
  expect(result.message.value.result.case).toBe("success");
  expect(readFileSync(path, "utf8")).toBe("native fallback");
});
