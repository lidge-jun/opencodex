import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  DiagnosticsArgsSchema,
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
  test("fails closed if synthetic Responses client tools arrive on native MCP exec channel", async () => {
    let called = false;
    const reply = decode((await handleCursorNativeExec(execMessage({
      case: "mcpArgs",
      value: create(McpArgsSchema, {
        name: "mcp__fs__read_file",
        toolName: "mcp__fs__read_file",
        providerIdentifier: "opencodex-responses",
      }),
    }), {
      mcp: () => {
        called = true;
        return create(McpResultSchema, { result: { case: "success", value: create(McpSuccessSchema, { isError: false, content: [] }) } });
      },
    }))[0]);

    expect(called).toBe(false);
    expect(reply.message.case).toBe("mcpResult");
    expect(reply.message.value.result.case).toBe("error");
    if (reply.message.value.result.case === "error") {
      expect(reply.message.value.result.value.error).toContain("native exec channel");
    }
  });

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


  test("blocks built-in local fs, shell, and fetch execution by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-exec-"));
    const path = join(dir, "note.txt");

    const deniedRead = decode((await handleCursorNativeExec(execMessage({
      case: "readArgs",
      value: create(ReadArgsSchema, { path }),
    })))[0]);
    expect(deniedRead.message.case).toBe("readResult");
    expect(deniedRead.message.value.result.case).toBe("error");
    if (deniedRead.message.value.result.case === "error") {
      expect(deniedRead.message.value.result.value.error).toContain("disabled by OpenCodex policy");
      expect(deniedRead.message.value.result.value.error).toContain("not a Codex sandbox denial");
    }

    const deniedShell = decode((await handleCursorNativeExec(execMessage({
      case: "shellArgs",
      value: create(ShellArgsSchema, { command: "printf blocked", workingDirectory: dir }),
    })))[0]);
    expect(deniedShell.message.case).toBe("shellResult");
    expect(deniedShell.message.value.result.case).toBe("failure");
    if (deniedShell.message.value.result.case === "failure") {
      expect(deniedShell.message.value.result.value.stderr).toContain("shell_command");
      expect(deniedShell.message.value.result.value.stderr).toContain("not a Codex sandbox denial");
    }

    const deniedStream = await handleCursorNativeExec(execMessage({
      case: "shellStreamArgs",
      value: create(ShellArgsSchema, { command: "printf blocked", workingDirectory: dir }),
    }));
    const streamText = deniedStream
      .map(reply => fromBinary(AgentClientMessageSchema, reply))
      .flatMap(msg => (msg.message.case === "execClientMessage" ? [msg.message.value] : []))
      .flatMap(frame => (frame.message.case === "shellStream" && frame.message.value.event.case === "stderr" ? [frame.message.value.event.value.data] : []))
      .join("\n");
    expect(streamText).toContain("shell_command");
    expect(streamText).toContain("not a Codex sandbox denial");

    const deniedBackground = decode((await handleCursorNativeExec(execMessage({
      case: "backgroundShellSpawnArgs",
      value: create(BackgroundShellSpawnArgsSchema, { command: "printf blocked", workingDirectory: dir }),
    })))[0]);
    expect(deniedBackground.message.case).toBe("backgroundShellSpawnResult");
    expect(deniedBackground.message.value.result.case).toBe("error");
    if (deniedBackground.message.value.result.case === "error") {
      expect(deniedBackground.message.value.result.value.error).toContain("shell_command");
    }

    const deniedStdin = decode((await handleCursorNativeExec(execMessage({
      case: "writeShellStdinArgs",
      value: create(WriteShellStdinArgsSchema, { shellId: 123, chars: "blocked\n" }),
    })))[0]);
    expect(deniedStdin.message.case).toBe("writeShellStdinResult");
    expect(deniedStdin.message.value.result.case).toBe("error");
    if (deniedStdin.message.value.result.case === "error") {
      expect(deniedStdin.message.value.result.value.error).toContain("shell_command");
    }

    const deniedFetch = decode((await handleCursorNativeExec(execMessage({
      case: "fetchArgs",
      value: create(FetchArgsSchema, { url: "https://example.test/doc" }),
    })))[0]);
    expect(deniedFetch.message.case).toBe("fetchResult");
    expect(deniedFetch.message.value.result.case).toBe("error");
    if (deniedFetch.message.value.result.case === "error") {
      expect(deniedFetch.message.value.result.value.error).toContain("disabled by OpenCodex policy");
    }
  });

  test("writes and reads files in a temp directory with unsafe opt-in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-exec-"));
    const path = join(dir, "note.txt");

    const write = decode((await handleCursorNativeExec(execMessage({
      case: "writeArgs",
      value: create(WriteArgsSchema, { path, fileText: "hello\ncursor", returnFileContentAfterWrite: true }),
    }), { unsafeAllowNativeLocalExec: true }))[0]);
    expect(write.message.case).toBe("writeResult");
    expect(readFileSync(path, "utf8")).toBe("hello\ncursor");

    const read = decode((await handleCursorNativeExec(execMessage({
      case: "readArgs",
      value: create(ReadArgsSchema, { path }),
    }), { unsafeAllowNativeLocalExec: true }))[0]);
    expect(read.message.case).toBe("readResult");
    expect(read.message.value.result.case).toBe("success");
    if (read.message.value.result.case === "success") {
      expect(read.message.value.result.value.output.case).toBe("content");
      expect(read.message.value.result.value.totalLines).toBe(2);
    }
  });

  test("keeps the removed allowNativeLocalExec key inert", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-alias-"));
    const shell = decode((await handleCursorNativeExec(execMessage({
      case: "shellArgs",
      value: create(ShellArgsSchema, { command: "printf alias-ok", workingDirectory: dir }),
    }), { allowNativeLocalExec: true } as unknown as NonNullable<Parameters<typeof handleCursorNativeExec>[1]>))[0]);

    expect(shell.message.case).toBe("shellResult");
    expect(shell.message.value.result.case).toBe("failure");
    if (shell.message.value.result.case === "failure") {
      expect(shell.message.value.result.value.stdout).toBe("");
      expect(shell.message.value.result.value.stderr).toContain("shell_command");
    }
  });

  test("returns a typed error for unsupported diagnostics", async () => {
    const diagnostics = decode((await handleCursorNativeExec(execMessage({
      case: "diagnosticsArgs",
      value: create(DiagnosticsArgsSchema, { path: "/tmp/example.ts" }),
    })))[0]);

    expect(diagnostics.message.case).toBe("diagnosticsResult");
    expect(diagnostics.message.value.result.case).toBe("error");
    if (diagnostics.message.value.result.case === "error") {
      expect(diagnostics.message.value.result.value.path).toBe("/tmp/example.ts");
      expect(diagnostics.message.value.result.value.error).toContain("not supported");
    }
  });

  test("unknown exec cases return empty reply instead of throwing (#116 hardening)", async () => {
    const result = await handleCursorNativeExec(execMessage({
      case: undefined,
      value: undefined,
    }));
    expect(result).toEqual([]);
  });

  test("rejects native write and delete when apply_patch is available", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-patch-policy-"));
    const newPath = join(dir, "new.txt");
    const existingPath = join(dir, "existing.txt");
    writeFileSync(existingPath, "keep");

    const write = decode((await handleCursorNativeExec(execMessage({
      case: "writeArgs",
      value: create(WriteArgsSchema, { path: newPath, fileText: "blocked" }),
    }), {
      unsafeAllowNativeLocalExec: true,
      rejectNativeFileMutations: true,
    }))[0]);

    expect(write.message.case).toBe("writeResult");
    expect(write.message.value.result.case).toBe("rejected");
    if (write.message.value.result.case === "rejected") {
      expect(write.message.value.result.value.reason).toContain("apply_patch");
      expect(write.message.value.result.value.reason).toContain("No file was changed.");
    }
    expect(existsSync(newPath)).toBe(false);

    const read = decode((await handleCursorNativeExec(execMessage({
      case: "readArgs",
      value: create(ReadArgsSchema, { path: existingPath }),
    }), {
      unsafeAllowNativeLocalExec: true,
      rejectNativeFileMutations: true,
    }))[0]);

    expect(read.message.case).toBe("readResult");
    expect(read.message.value.result.case).toBe("success");

    const deleted = decode((await handleCursorNativeExec(execMessage({
      case: "deleteArgs",
      value: create(DeleteArgsSchema, { path: existingPath }),
    }), {
      unsafeAllowNativeLocalExec: true,
      rejectNativeFileMutations: true,
    }))[0]);

    expect(deleted.message.case).toBe("deleteResult");
    expect(deleted.message.value.result.case).toBe("rejected");
    if (deleted.message.value.result.case === "rejected") {
      expect(deleted.message.value.result.value.reason).toContain("apply_patch");
      expect(deleted.message.value.result.value.reason).toContain("No file was changed.");
    }
    expect(readFileSync(existingPath, "utf8")).toBe("keep");
  });

  test("deletes only the requested temp file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-delete-"));
    const path = join(dir, "delete-me.txt");
    writeFileSync(path, "temporary");

    const deleted = decode((await handleCursorNativeExec(execMessage({
      case: "deleteArgs",
      value: create(DeleteArgsSchema, { path }),
    }), { unsafeAllowNativeLocalExec: true }))[0]);

    expect(deleted.message.case).toBe("deleteResult");
    expect(deleted.message.value.result.case).toBe("success");
  });

  test("runs harmless shell commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-shell-"));
    const shell = decode((await handleCursorNativeExec(execMessage({
      case: "shellArgs",
      value: create(ShellArgsSchema, { command: "printf cursor-ok", workingDirectory: dir }),
    }), { unsafeAllowNativeLocalExec: true }))[0]);

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
    }), { unsafeAllowNativeLocalExec: true });
    const decodedAll = replies.map(reply => fromBinary(AgentClientMessageSchema, reply));
    const execFrames = decodedAll
      .flatMap(msg => (msg.message.case === "execClientMessage" ? [msg.message.value] : []));
    const cases = execFrames.map(frame => frame.message.case);

    expect(cases[0]).toBe("shellStream");
    const events = execFrames
      .flatMap(frame => (frame.message.case === "shellStream" ? [frame.message.value.event.case] : []));
    expect(events).toEqual(expect.arrayContaining(["start", "stdout", "exit"]));
    // Completion acknowledgement: structured shellResult then exec streamClose — without these
    // Cursor keeps the turn pending forever (heartbeat-only stall). See native-exec-shell.ts.
    expect(cases).toContain("shellResult");
    expect(decodedAll.at(-1)?.message.case).toBe("execClientControlMessage");
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
    }), { unsafeAllowNativeLocalExec: true }))[0]);
    expect(spawned.message.case).toBe("backgroundShellSpawnResult");
    expect(spawned.message.value.result.case).toBe("success");

    if (spawned.message.value.result.case === "success") {
      const stdin = decode((await handleCursorNativeExec(execMessage({
        case: "writeShellStdinArgs",
        value: create(WriteShellStdinArgsSchema, { shellId: spawned.message.value.result.value.shellId, chars: "hello\n" }),
      }), { unsafeAllowNativeLocalExec: true }))[0]);
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
      }), { unsafeAllowNativeLocalExec: true }))[0]);
      expect(grep.message.case).toBe("grepResult");
      expect(grep.message.value.result.case).toBe("success");
    }
  });

  test("fetches through an injected fetch implementation", async () => {
    const fetched = decode((await handleCursorNativeExec(execMessage({
      case: "fetchArgs",
      value: create(FetchArgsSchema, { url: "https://example.test/doc" }),
    }), {
      unsafeAllowNativeLocalExec: true,
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
