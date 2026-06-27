import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import { handleCursorNativeExec } from "../src/adapters/cursor/native-exec";
import {
  AgentClientMessageSchema,
  BackgroundShellSpawnArgsSchema,
  ComputerUseArgsSchema,
  ComputerUseResultSchema,
  ComputerUseSuccessSchema,
  DeleteArgsSchema,
  ExecServerMessageSchema,
  FetchArgsSchema,
  GrepArgsSchema,
  McpToolDefinitionSchema,
  McpArgsSchema,
  McpResultSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolResultContentItemSchema,
  ReadArgsSchema,
  ReadMcpResourceExecArgsSchema,
  RecordScreenArgsSchema,
  RequestContextArgsSchema,
  ShellArgsSchema,
  WriteShellStdinArgsSchema,
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
  test("advertises client tool definitions in request context", async () => {
    const clientTool = create(McpToolDefinitionSchema, {
      name: "mcp__fs__read_file",
      toolName: "mcp__fs__read_file",
      providerIdentifier: "opencodex-responses",
      description: "Read a file",
      inputSchema: new TextEncoder().encode("{}"),
    });

    const context = decode((await handleCursorNativeExec(execMessage({
      case: "requestContextArgs",
      value: create(RequestContextArgsSchema, {}),
    }), {
      clientToolDefs: [clientTool],
    }))[0]);

    expect(context.message.case).toBe("requestContextResult");
    expect(context.message.value.result.case).toBe("success");
    if (context.message.value.result.case === "success") {
      expect(context.message.value.result.value.requestContext?.tools.map(tool => tool.toolName)).toEqual(["mcp__fs__read_file"]);
    }
  });

  test("writes and reads files in a temp directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-exec-"));
    const path = join(dir, "note.txt");

    const write = decode((await handleCursorNativeExec(execMessage({
      case: "writeArgs",
      value: create(WriteArgsSchema, { path, fileText: "hello\ncursor", returnFileContentAfterWrite: true }),
    })))[0]);
    expect(write.message.case).toBe("writeResult");
    expect(readFileSync(path, "utf8")).toBe("hello\ncursor");

    const read = decode((await handleCursorNativeExec(execMessage({
      case: "readArgs",
      value: create(ReadArgsSchema, { path }),
    })))[0]);
    expect(read.message.case).toBe("readResult");
    expect(read.message.value.result.case).toBe("success");
    if (read.message.value.result.case === "success") {
      expect(read.message.value.result.value.output.case).toBe("content");
      expect(read.message.value.result.value.totalLines).toBe(2);
    }
  });

  test("deletes only the requested temp file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-delete-"));
    const path = join(dir, "delete-me.txt");
    writeFileSync(path, "temporary");

    const deleted = decode((await handleCursorNativeExec(execMessage({
      case: "deleteArgs",
      value: create(DeleteArgsSchema, { path }),
    })))[0]);

    expect(deleted.message.case).toBe("deleteResult");
    expect(deleted.message.value.result.case).toBe("success");
  });

  test("runs harmless shell commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-shell-"));
    const shell = decode((await handleCursorNativeExec(execMessage({
      case: "shellArgs",
      value: create(ShellArgsSchema, { command: "printf cursor-ok", workingDirectory: dir }),
    })))[0]);

    expect(shell.message.case).toBe("shellResult");
    expect(shell.message.value.result.case).toBe("success");
    if (shell.message.value.result.case === "success") {
      expect(shell.message.value.result.value.stdout).toBe("cursor-ok");
    }
  });

  test("returns shell stream events for shellStreamArgs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-stream-"));
    const replies = await handleCursorNativeExec(execMessage({
      case: "shellStreamArgs",
      value: create(ShellArgsSchema, { command: "printf stream-ok", workingDirectory: dir }),
    }));
    const cases = replies.map(reply => decode(reply).message.case);

    expect(cases[0]).toBe("shellStream");
    expect(cases).toContain("shellStream");
    const events = replies.map(reply => decode(reply).message.value.event.case);
    expect(events).toEqual(expect.arrayContaining(["start", "stdout", "exit"]));
  });

  test("supports background shell spawn and stdin writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-bg-"));
    const spawned = decode((await handleCursorNativeExec(execMessage({
      case: "backgroundShellSpawnArgs",
      value: create(BackgroundShellSpawnArgsSchema, {
        command: "node -e \"setTimeout(() => process.exit(0), 300); process.stdin.resume()\"",
        workingDirectory: dir,
        enableWriteShellStdinTool: true,
      }),
    })))[0]);
    expect(spawned.message.case).toBe("backgroundShellSpawnResult");
    expect(spawned.message.value.result.case).toBe("success");

    if (spawned.message.value.result.case === "success") {
      const stdin = decode((await handleCursorNativeExec(execMessage({
        case: "writeShellStdinArgs",
        value: create(WriteShellStdinArgsSchema, { shellId: spawned.message.value.result.value.shellId, chars: "hello\n" }),
      })))[0]);
      expect(stdin.message.case).toBe("writeShellStdinResult");
      expect(stdin.message.value.result.case).toBe("success");
    }
  });

  test("greps temp files with content, file, and count output modes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-grep-"));
    writeFileSync(join(dir, "a.txt"), "alpha\ncursor\ncursor");
    writeFileSync(join(dir, "b.txt"), "beta");

    for (const outputMode of ["content", "files_with_matches", "count"]) {
      const grep = decode((await handleCursorNativeExec(execMessage({
        case: "grepArgs",
        value: create(GrepArgsSchema, { pattern: "cursor", path: dir, glob: "*.txt", outputMode }),
      })))[0]);
      expect(grep.message.case).toBe("grepResult");
      expect(grep.message.value.result.case).toBe("success");
    }
  });

  test("fetches through an injected fetch implementation", async () => {
    const fetched = decode((await handleCursorNativeExec(execMessage({
      case: "fetchArgs",
      value: create(FetchArgsSchema, { url: "https://example.test/doc" }),
    }), {
      fetch: async () => new Response("ok", { status: 203, headers: { "content-type": "text/plain" } }),
    }))[0]);

    expect(fetched.message.case).toBe("fetchResult");
    expect(fetched.message.value.result.case).toBe("success");
    if (fetched.message.value.result.case === "success") {
      expect(fetched.message.value.result.value.content).toBe("ok");
      expect(fetched.message.value.result.value.statusCode).toBe(203);
    }
  });

  test("opens MCP and computer-use through executor hooks", async () => {
    const synthetic = decode((await handleCursorNativeExec(execMessage({
      case: "mcpArgs",
      value: create(McpArgsSchema, { name: "read_file", toolName: "read_file", providerIdentifier: "opencodex-responses" }),
    }), {
      mcp: async () => {
        throw new Error("synthetic Responses tools must not execute through local MCP");
      },
    }))[0]);
    expect(synthetic.message.case).toBe("mcpResult");
    expect(synthetic.message.value.result.case).toBe("error");

    const mcp = decode((await handleCursorNativeExec(execMessage({
      case: "mcpArgs",
      value: create(McpArgsSchema, { name: "demo", toolName: "demo", providerIdentifier: "local" }),
    }), {
      mcp: async () => create(McpResultSchema, {
        result: {
          case: "success",
          value: create(McpSuccessSchema, {
            isError: false,
            content: [create(McpToolResultContentItemSchema, {
              content: { case: "text", value: create(McpTextContentSchema, { text: "mcp-ok" }) },
            })],
          }),
        },
      }),
    }))[0]);
    expect(mcp.message.case).toBe("mcpResult");
    expect(mcp.message.value.result.case).toBe("success");

    const computer = decode((await handleCursorNativeExec(execMessage({
      case: "computerUseArgs",
      value: create(ComputerUseArgsSchema, { actions: [], toolCallId: "cu" }),
    }), {
      computerUse: async args => create(ComputerUseResultSchema, {
        result: { case: "success", value: create(ComputerUseSuccessSchema, { actionCount: args.actions.length, durationMs: 1 }) },
      }),
    }))[0]);
    expect(computer.message.case).toBe("computerUseResult");
    expect(computer.message.value.result.case).toBe("success");
  });

  test("returns typed defaults for MCP resource and record screen without executors", async () => {
    const resource = decode((await handleCursorNativeExec(execMessage({
      case: "readMcpResourceExecArgs",
      value: create(ReadMcpResourceExecArgsSchema, { server: "local", uri: "memory://missing" }),
    })))[0]);
    expect(resource.message.case).toBe("readMcpResourceExecResult");
    expect(resource.message.value.result.case).toBe("error");

    const record = decode((await handleCursorNativeExec(execMessage({
      case: "recordScreenArgs",
      value: create(RecordScreenArgsSchema, { mode: 1 }),
    })))[0]);
    expect(record.message.case).toBe("recordScreenResult");
    expect(record.message.value.result.case).toBe("failure");
  });
});
