import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { createLiveCursorTransport } from "../src/adapters/cursor/live-transport";
import {
  advertisedBareCodexShellBridgeName,
  planNativeExecBridge,
} from "../src/adapters/cursor/native-exec-bridge";
import { nativeShellDisabledMessage } from "../src/adapters/cursor/native-exec-shell";
import { createCursorProtobufEventState } from "../src/adapters/cursor/protobuf-events";
import type { CursorServerMessage } from "../src/adapters/cursor/types";
import type { OcxProviderConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import {
  AgentServerMessageSchema,
  BackgroundShellSpawnArgsSchema,
  DeleteArgsSchema,
  ExecServerMessageSchema,
  FetchArgsSchema,
  GrepArgsSchema,
  LsArgsSchema,
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

describe("planNativeExecBridge", () => {
  test("shellArgs bridges to advertised shell_command with workdir", () => {
    const plan = planNativeExecBridge(execMessage({
      case: "shellArgs",
      value: create(ShellArgsSchema, {
        command: "echo hi",
        workingDirectory: "/tmp",
        toolCallId: "call_shell",
      }),
    }), {
      nativeLocalExecEnabled: false,
      advertisedShellBridgeName: "shell_command",
    });
    expect(plan).toEqual({
      bridge: true,
      toolName: "shell_command",
      toolCallId: "call_shell",
      args: { command: "echo hi", workdir: "/tmp" },
    });
  });

  test("selector prefers exec_command regardless of catalog order", () => {
    for (const clientToolNames of [
      ["other_tool", "shell_command", "exec_command"],
      ["exec_command", "shell_command", "other_tool"],
    ]) {
      const advertisedShellBridgeName = advertisedBareCodexShellBridgeName(clientToolNames);
      expect(advertisedShellBridgeName).toBe("exec_command");
      const plan = planNativeExecBridge(execMessage({
        case: "shellArgs",
        value: create(ShellArgsSchema, { command: "pwd", toolCallId: "call_exec" }),
      }), {
        nativeLocalExecEnabled: false,
        advertisedShellBridgeName,
      });
      expect(plan.bridge).toBe(true);
      if (plan.bridge) expect(plan.toolName).toBe("exec_command");
    }
  });

  test("does not invent cmd on native shell proto", () => {
    const plan = planNativeExecBridge(execMessage({
      case: "shellArgs",
      value: create(ShellArgsSchema, { command: "echo hi", toolCallId: "call_shell" }),
    }), {
      nativeLocalExecEnabled: false,
      advertisedShellBridgeName: "shell_command",
    });
    expect(plan.bridge).toBe(true);
    if (plan.bridge) {
      expect(plan.args).toEqual({ command: "echo hi" });
      expect(Object.keys(plan.args)).not.toContain("cmd");
    }
  });

  test("shellStreamArgs collapses to one-shot command", () => {
    const plan = planNativeExecBridge(execMessage({
      case: "shellStreamArgs",
      value: create(ShellArgsSchema, {
        command: "echo stream",
        workingDirectory: "/work",
        toolCallId: "call_stream",
      }),
    }), {
      nativeLocalExecEnabled: false,
      advertisedShellBridgeName: "shell_command",
    });
    expect(plan).toEqual({
      bridge: true,
      toolName: "shell_command",
      toolCallId: "call_stream",
      args: { command: "echo stream", workdir: "/work" },
    });
  });

  test("backgroundShellSpawnArgs collapses to one-shot command", () => {
    const plan = planNativeExecBridge(execMessage({
      case: "backgroundShellSpawnArgs",
      value: create(BackgroundShellSpawnArgsSchema, {
        command: "sleep 1",
        workingDirectory: "/bg",
        toolCallId: "call_bg",
      }),
    }), {
      nativeLocalExecEnabled: false,
      advertisedShellBridgeName: "shell_command",
    });
    expect(plan).toEqual({
      bridge: true,
      toolName: "shell_command",
      toolCallId: "call_bg",
      args: { command: "sleep 1", workdir: "/bg" },
    });
  });

  test("readArgs maps to cat with quoted path", () => {
    const plan = planNativeExecBridge(execMessage({
      case: "readArgs",
      value: create(ReadArgsSchema, { path: "foo/bar.txt", toolCallId: "call_read" }),
    }), {
      nativeLocalExecEnabled: false,
      advertisedShellBridgeName: "shell_command",
    });
    expect(plan.bridge).toBe(true);
    if (plan.bridge) expect(plan.args.command).toBe("cat -- 'foo/bar.txt'");
  });

  test("readArgs quotes embedded single quotes", () => {
    const plan = planNativeExecBridge(execMessage({
      case: "readArgs",
      value: create(ReadArgsSchema, { path: "it's", toolCallId: "call_read" }),
    }), {
      nativeLocalExecEnabled: false,
      advertisedShellBridgeName: "shell_command",
    });
    expect(plan.bridge).toBe(true);
    if (plan.bridge) expect(plan.args.command).toBe("cat -- 'it'\\''s'");
  });

  test("lsArgs maps to ls -la", () => {
    const plan = planNativeExecBridge(execMessage({
      case: "lsArgs",
      value: create(LsArgsSchema, { path: "/tmp", ignore: [], toolCallId: "call_ls" }),
    }), {
      nativeLocalExecEnabled: false,
      advertisedShellBridgeName: "shell_command",
    });
    expect(plan.bridge).toBe(true);
    if (plan.bridge) expect(plan.args.command).toBe("ls -la -- '/tmp'");
  });

  test("grepArgs with path maps to rg with pattern and path", () => {
    const plan = planNativeExecBridge(execMessage({
      case: "grepArgs",
      value: create(GrepArgsSchema, { pattern: "pattern", path: "src", toolCallId: "call_grep" }),
    }), {
      nativeLocalExecEnabled: false,
      advertisedShellBridgeName: "shell_command",
    });
    expect(plan.bridge).toBe(true);
    if (plan.bridge) expect(plan.args.command).toBe("rg -n -- 'pattern' 'src'");
  });

  test("grepArgs without path maps to rg pattern only", () => {
    const plan = planNativeExecBridge(execMessage({
      case: "grepArgs",
      value: create(GrepArgsSchema, { pattern: "pattern", toolCallId: "call_grep" }),
    }), {
      nativeLocalExecEnabled: false,
      advertisedShellBridgeName: "shell_command",
    });
    expect(plan.bridge).toBe(true);
    if (plan.bridge) expect(plan.args.command).toBe("rg -n -- 'pattern'");
  });

  test("fetchArgs maps to curl", () => {
    const plan = planNativeExecBridge(execMessage({
      case: "fetchArgs",
      value: create(FetchArgsSchema, { url: "https://example.com", toolCallId: "call_fetch" }),
    }), {
      nativeLocalExecEnabled: false,
      advertisedShellBridgeName: "shell_command",
    });
    expect(plan.bridge).toBe(true);
    if (plan.bridge) expect(plan.args.command).toBe("curl -fsSL -- 'https://example.com'");
  });

  test("writeArgs does not bridge", () => {
    expect(planNativeExecBridge(execMessage({
      case: "writeArgs",
      value: create(WriteArgsSchema, { path: "x.txt", fileText: "data" }),
    }), {
      nativeLocalExecEnabled: false,
      advertisedShellBridgeName: "shell_command",
    })).toEqual({ bridge: false });
  });

  test("deleteArgs does not bridge", () => {
    expect(planNativeExecBridge(execMessage({
      case: "deleteArgs",
      value: create(DeleteArgsSchema, { path: "x.txt" }),
    }), {
      nativeLocalExecEnabled: false,
      advertisedShellBridgeName: "shell_command",
    })).toEqual({ bridge: false });
  });

  test("nativeLocalExecEnabled blocks bridging", () => {
    expect(planNativeExecBridge(execMessage({
      case: "shellArgs",
      value: create(ShellArgsSchema, { command: "echo hi", toolCallId: "call_shell" }),
    }), {
      nativeLocalExecEnabled: true,
      advertisedShellBridgeName: "shell_command",
    })).toEqual({ bridge: false });
  });

  test("missing advertised shell bridge name blocks bridging", () => {
    expect(planNativeExecBridge(execMessage({
      case: "shellArgs",
      value: create(ShellArgsSchema, { command: "echo hi", toolCallId: "call_shell" }),
    }), {
      nativeLocalExecEnabled: false,
      advertisedShellBridgeName: undefined,
    })).toEqual({ bridge: false });
  });

  test("empty shell command does not bridge", () => {
    expect(planNativeExecBridge(execMessage({
      case: "shellArgs",
      value: create(ShellArgsSchema, { command: "   ", toolCallId: "call_shell" }),
    }), {
      nativeLocalExecEnabled: false,
      advertisedShellBridgeName: "shell_command",
    })).toEqual({ bridge: false });
  });

  test("empty read path does not bridge", () => {
    expect(planNativeExecBridge(execMessage({
      case: "readArgs",
      value: create(ReadArgsSchema, { path: "  ", toolCallId: "call_read" }),
    }), {
      nativeLocalExecEnabled: false,
      advertisedShellBridgeName: "shell_command",
    })).toEqual({ bridge: false });
  });

  test("empty fetch url does not bridge", () => {
    expect(planNativeExecBridge(execMessage({
      case: "fetchArgs",
      value: create(FetchArgsSchema, { url: "  ", toolCallId: "call_fetch" }),
    }), {
      nativeLocalExecEnabled: false,
      advertisedShellBridgeName: "shell_command",
    })).toEqual({ bridge: false });
  });
});

const NGHTTP2_CANCEL = 8;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function nativeExecFrame(
  execCase: "shellArgs" | "writeArgs",
  value: ReturnType<typeof create<typeof ShellArgsSchema>> | ReturnType<typeof create<typeof WriteArgsSchema>>,
) {
  return create(AgentServerMessageSchema, {
    message: {
      case: "execServerMessage",
      value: create(ExecServerMessageSchema, {
        id: 42,
        execId: "exec-native",
        message: { case: execCase, value },
      }),
    },
  });
}

interface BridgeHarness {
  feed(frame: ReturnType<typeof nativeExecFrame>): Promise<void>;
  events: CursorServerMessage[];
  writeCalls: unknown[];
  closeCodes: number[];
}

function makeBridgeHarness(opts: {
  graceMs?: number;
  clientToolNames: string[];
  provider?: Partial<OcxProviderConfig>;
}): BridgeHarness {
  const writeCalls: unknown[] = [];
  const closeCodes: number[] = [];
  const transport = createLiveCursorTransport({
    provider: {
      adapter: "cursor",
      baseUrl: "https://api2.cursor.sh",
      apiKey: "test-token",
      ...opts.provider,
    },
    translatorBudget: createTestTranslatorBudget(),
    headers: new Headers(),
    clientToolFinalizeGraceMs: opts.graceMs ?? 20,
  }) as unknown as {
    stream: unknown;
    handleServerMessage: (m: unknown, s: unknown, p: (e: CursorServerMessage) => void) => Promise<void>;
  };
  const events: CursorServerMessage[] = [];
  transport.stream = {
    close: (code?: number) => { closeCodes.push(code ?? 0); },
    destroy: () => {},
    write: (chunk: unknown) => { writeCalls.push(chunk); return true; },
    closed: false,
    destroyed: false,
  };
  const state = createCursorProtobufEventState({ clientToolNames: opts.clientToolNames });
  const push = (e: CursorServerMessage) => { events.push(e); };
  return {
    feed: (frame) => transport.handleServerMessage(frame, state, push),
    events,
    writeCalls,
    closeCodes,
  };
}

describe("live transport native exec bridge", () => {
  test("native shellArgs bridges to shell_command tool_call without Connect writes", async () => {
    const h = makeBridgeHarness({ clientToolNames: ["shell_command"] });
    await h.feed(nativeExecFrame("shellArgs", create(ShellArgsSchema, {
      command: "echo hi",
      workingDirectory: "/tmp",
      toolCallId: "call_shell",
    })));

    const types = h.events.map(e => e.type);
    expect(types).toContain("tool_call_start");
    expect(types).toContain("tool_call_delta");
    expect(types).toContain("tool_call_end");
    expect(h.events.find(e => e.type === "tool_call_start")).toMatchObject({ name: "shell_command", id: "call_shell" });
    expect(h.events.find(e => e.type === "tool_call_delta")?.arguments).toContain("command");
    expect(h.writeCalls).toHaveLength(0);
    expect(JSON.stringify(h.events)).not.toContain(nativeShellDisabledMessage());

    await sleep(60);
    expect(h.events.filter(e => e.type === "done")).toHaveLength(1);
    expect(h.closeCodes).toEqual([NGHTTP2_CANCEL]);
  });

  test("nativeLocalExec on does not plan a Codex tool_call bridge", () => {
    expect(planNativeExecBridge(execMessage({
      case: "shellArgs",
      value: create(ShellArgsSchema, { command: "echo hi", toolCallId: "call_shell" }),
    }), {
      nativeLocalExecEnabled: true,
      advertisedShellBridgeName: "shell_command",
    })).toEqual({ bridge: false });
  });

  test("writeArgs with shell in catalog stays on native policy path", async () => {
    const h = makeBridgeHarness({ clientToolNames: ["shell_command"] });
    await h.feed(nativeExecFrame("writeArgs", create(WriteArgsSchema, {
      path: "blocked.txt",
      fileText: "secret",
    })));

    expect(h.events.map(e => e.type)).not.toContain("tool_call_start");
    expect(h.writeCalls.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(h.events);
    expect(serialized).not.toContain("rm ");
    expect(serialized).not.toContain("cat >");
  });
});
