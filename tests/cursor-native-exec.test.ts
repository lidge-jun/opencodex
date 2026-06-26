import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import { handleCursorNativeExec } from "../src/adapters/cursor/native-exec";
import {
  AgentClientMessageSchema,
  DeleteArgsSchema,
  ExecServerMessageSchema,
  ReadArgsSchema,
  ShellArgsSchema,
  WriteArgsSchema,
} from "../src/adapters/cursor/gen/agent_pb";

function execMessage(message: Parameters<typeof create<typeof ExecServerMessageSchema>>[1]["message"]) {
  return create(ExecServerMessageSchema, {
    id: 7,
    execId: "exec-test",
    message,
  });
}

function decode(bytes: Uint8Array) {
  const message = fromBinary(AgentClientMessageSchema, bytes);
  expect(message.message.case).toBe("execClientMessage");
  return message.message.value;
}

describe("Cursor native exec bridge", () => {
  test("writes and reads files in a temp directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-exec-"));
    const path = join(dir, "note.txt");

    const write = decode(handleCursorNativeExec(execMessage({
      case: "writeArgs",
      value: create(WriteArgsSchema, { path, fileText: "hello\ncursor", returnFileContentAfterWrite: true }),
    }))[0]);
    expect(write.message.case).toBe("writeResult");
    expect(readFileSync(path, "utf8")).toBe("hello\ncursor");

    const read = decode(handleCursorNativeExec(execMessage({
      case: "readArgs",
      value: create(ReadArgsSchema, { path }),
    }))[0]);
    expect(read.message.case).toBe("readResult");
    expect(read.message.value.result.case).toBe("success");
    if (read.message.value.result.case === "success") {
      expect(read.message.value.result.value.output.case).toBe("content");
      expect(read.message.value.result.value.totalLines).toBe(2);
    }
  });

  test("deletes only the requested temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-delete-"));
    const path = join(dir, "delete-me.txt");
    writeFileSync(path, "temporary");

    const deleted = decode(handleCursorNativeExec(execMessage({
      case: "deleteArgs",
      value: create(DeleteArgsSchema, { path }),
    }))[0]);

    expect(deleted.message.case).toBe("deleteResult");
    expect(deleted.message.value.result.case).toBe("success");
  });

  test("runs harmless shell commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-shell-"));
    const shell = decode(handleCursorNativeExec(execMessage({
      case: "shellArgs",
      value: create(ShellArgsSchema, { command: "printf cursor-ok", workingDirectory: dir }),
    }))[0]);

    expect(shell.message.case).toBe("shellResult");
    expect(shell.message.value.result.case).toBe("success");
    if (shell.message.value.result.case === "success") {
      expect(shell.message.value.result.value.stdout).toBe("cursor-ok");
    }
  });
});
