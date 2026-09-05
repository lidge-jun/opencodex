import { create, fromBinary } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import {
  AgentClientMessageSchema,
  ComputerUseArgsSchema,
  ExecServerMessageSchema,
  RecordScreenArgsSchema,
} from "../../../src/adapters/cursor/gen/agent_pb";
import { handleCursorNativeExec } from "../../../src/adapters/cursor/native-exec";
import {
  desktopDepsFromConfig,
  type DesktopExecutorConfig as DesktopExecutorConfigViaImplementation,
} from "../../../src/adapters/cursor/native-exec-desktop";
import type { DesktopExecutorConfig } from "../../../src/adapters/cursor/desktop-executor-contract";
import { shellInvocation } from "../../../src/lib/win-exec";
import { readFileSync } from "node:fs";
import { repoPath } from "../../helpers/repo-root";

function execMessage(message: Parameters<typeof create<typeof ExecServerMessageSchema>>[1]["message"]) {
  return create(ExecServerMessageSchema, { id: 3, execId: "exec-test", message });
}

function decode(bytes: Uint8Array) {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  expect(msg.message.case).toBe("execClientMessage");
  return msg.message.value;
}

// A tiny platform-shell command that drains stdin and prints a fixed JSON payload.
function echoJson(json: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return `more >nul & echo ${json}`;
  return `cat >/dev/null; printf '%s' '${json}'`;
}

describe("Cursor desktop executor hooks", () => {
  test("DesktopExecutorConfig is one contract reachable from both paths, and provider types no longer import the implementation", () => {
    // Type-level parity: the historical export and the contract leaf must be the same shape.
    const viaContract: DesktopExecutorConfig = { computerUseCommand: "x", timeoutMs: 1 };
    const viaImplementation: DesktopExecutorConfigViaImplementation = viaContract;
    expect(desktopDepsFromConfig(viaImplementation)).toHaveProperty("computerUse");

    // Graph guard: the contract is dependency-free and src/types/provider.ts points at it,
    // not at native-exec-desktop.ts (that edge closed a type cycle through tool-definitions).
    const contract = readFileSync(repoPath("src", "adapters", "cursor", "desktop-executor-contract.ts"), "utf8");
    expect(contract).not.toMatch(/^\s*import\s/m);
    expect(contract).toMatch(/^export interface DesktopExecutorConfig \{/m);
    const provider = readFileSync(repoPath("src", "types", "provider.ts"), "utf8");
    expect(provider).toContain('import("../adapters/cursor/desktop-executor-contract").DesktopExecutorConfig');
    expect(provider).not.toContain("native-exec-desktop");
  });

  test("desktopDepsFromConfig returns empty deps when nothing configured", () => {
    expect(desktopDepsFromConfig(undefined)).toEqual({});
    expect(desktopDepsFromConfig({})).toEqual({});
  });

  test("computer-use success through external executor", async () => {
    const deps = desktopDepsFromConfig({ computerUseCommand: echoJson('{"durationMs":42}') });
    const reply = decode((await handleCursorNativeExec(execMessage({
      case: "computerUseArgs",
      value: create(ComputerUseArgsSchema, { actions: [], toolCallId: "cu1" }),
    }), deps))[0]);
    expect(reply.message.case).toBe("computerUseResult");
    expect(reply.message.value.result.case).toBe("success");
    if (reply.message.value.result.case === "success") {
      expect(reply.message.value.result.value.durationMs).toBe(42);
      expect(reply.message.value.result.value.actionCount).toBe(0);
    }
  });

  test("computer-use executor error payload maps to ComputerUseError", async () => {
    const deps = desktopDepsFromConfig({ computerUseCommand: echoJson('{"error":"no display"}') });
    const reply = decode((await handleCursorNativeExec(execMessage({
      case: "computerUseArgs",
      value: create(ComputerUseArgsSchema, { actions: [], toolCallId: "cu2" }),
    }), deps))[0]);
    expect(reply.message.value.result.case).toBe("error");
    if (reply.message.value.result.case === "error") {
      expect(reply.message.value.result.value.error).toBe("no display");
    }
  });

  test("computer-use non-zero exit / bad JSON maps to error without throwing", async () => {
    const deps = desktopDepsFromConfig({ computerUseCommand: "exit 3" });
    const reply = decode((await handleCursorNativeExec(execMessage({
      case: "computerUseArgs",
      value: create(ComputerUseArgsSchema, { actions: [], toolCallId: "cu3" }),
    }), deps))[0]);
    expect(reply.message.value.result.case).toBe("error");
  });

  test("record-screen startSuccess through external executor", async () => {
    const deps = desktopDepsFromConfig({ recordScreenCommand: echoJson('{"startSuccess":{"wasPriorRecordingCancelled":true}}') });
    const reply = decode((await handleCursorNativeExec(execMessage({
      case: "recordScreenArgs",
      value: create(RecordScreenArgsSchema, { mode: 1, toolCallId: "rs1" }),
    }), deps))[0]);
    expect(reply.message.case).toBe("recordScreenResult");
    expect(reply.message.value.result.case).toBe("startSuccess");
    if (reply.message.value.result.case === "startSuccess") {
      expect(reply.message.value.result.value.wasPriorRecordingCancelled).toBe(true);
    }
  });

  test("record-screen bad output maps to failure without throwing", async () => {
    const deps = desktopDepsFromConfig({ recordScreenCommand: "echo not-json" });
    const reply = decode((await handleCursorNativeExec(execMessage({
      case: "recordScreenArgs",
      value: create(RecordScreenArgsSchema, { mode: 1, toolCallId: "rs2" }),
    }), deps))[0]);
    expect(reply.message.value.result.case).toBe("failure");
  });

  // BUG-R7: a command that never reads stdin broke the pipe mid-write.
  //
  // The test above already used such a command (echo reads nothing), and it passed on
  // macOS because the small payload usually lands in the pipe buffer before the child
  // exits. On Linux the child won the race, the write failed with EPIPE, and because
  // that arrives as an asynchronous 'error' EVENT rather than a throw, the try/catch
  // around the write never saw it - the rejection escaped as an unhandled stream error
  // and killed the shard. Shard 1 of 4 has been red on dev since.
  //
  // This forces the race on every platform: a payload far larger than any pipe buffer
  // cannot be written before a non-reading child exits, so the EPIPE path is taken
  // rather than raced for. saveAsFilename is the only caller-shaped field big enough
  // to carry it.
  test("a command that never reads stdin still yields a failure, not a stream error", async () => {
    const deps = desktopDepsFromConfig({ recordScreenCommand: "echo not-json" });
    const reply = decode((await handleCursorNativeExec(execMessage({
      case: "recordScreenArgs",
      value: create(RecordScreenArgsSchema, {
        mode: 1,
        toolCallId: "rs-epipe",
        // 2 MiB: well past the 64 KiB pipe buffer on both platforms.
        saveAsFilename: "y".repeat(2 * 1024 * 1024),
      }),
    }), deps))[0]);
    // The contract is unchanged: the child's exit code and stdout decide the outcome,
    // and a broken input pipe is not itself a contract failure.
    expect(reply.message.case).toBe("recordScreenResult");
    expect(reply.message.value.result.case).toBe("failure");
  });

  // BUG-R7: a command that never reads stdin broke the pipe mid-write.
  //
  // The bad-output test above already uses such a command (echo reads nothing) and
  // passes on macOS, where a write after the child exits is simply discarded. On Linux
  // the same write fails with EPIPE, and because that arrives as an asynchronous
  // 'error' EVENT rather than a throw, the try/catch around the write never saw it: the
  // rejection escaped as an unhandled stream error and killed the shard. Test shard 1
  // of 4 has been red on dev since.
  //
  // This cannot be reproduced on macOS - measured: a 4 MiB write to a pipe whose child
  // has already exited yields neither an async error nor a throw there. So the platform
  // race is what this drives, as closely as a portable test can: a command that exits
  // BEFORE reading anything, plus a payload far past any pipe buffer. On Linux that is
  // the EPIPE path. On macOS the write is discarded instead, so here it proves the
  // weaker but still useful property - a non-reading child never turns into a rejection.
  //
  // Both platforms must agree on the OUTCOME, which is the contract that matters: the
  // child's exit code and stdout decide the result, and a broken input pipe does not.
  test("a command that exits before reading stdin yields a failure, not a rejection", async () => {
    // `exit 0` never reads and never prints, so stdout is empty: invalid JSON, which is
    // a failure by the same rule as `echo not-json`.
    const deps = desktopDepsFromConfig({ recordScreenCommand: "exit 0" });
    const reply = decode((await handleCursorNativeExec(execMessage({
      case: "recordScreenArgs",
      value: create(RecordScreenArgsSchema, {
        mode: 1,
        toolCallId: "rs-epipe",
        // 4 MiB, well past the 64 KiB pipe buffer, so the write cannot complete first.
        saveAsFilename: "y".repeat(4 * 1024 * 1024),
      }),
    }), deps))[0]);
    expect(reply.message.case).toBe("recordScreenResult");
    expect(reply.message.value.result.case).toBe("failure");
  });

  test("a throwing recordScreen dep is contained as RecordScreenFailure (dispatcher boundary)", async () => {
    const reply = decode((await handleCursorNativeExec(execMessage({
      case: "recordScreenArgs",
      value: create(RecordScreenArgsSchema, { mode: 1, toolCallId: "rs-throw" }),
    }), {
      recordScreen: () => { throw new Error("executor exploded"); },
    }))[0]);
    expect(reply.message.case).toBe("recordScreenResult");
    expect(reply.message.value.result.case).toBe("failure");
    if (reply.message.value.result.case === "failure") {
      expect(reply.message.value.result.value.error).toBe("executor exploded");
    }
  });

  test("honest not-supported defaults when no executor configured", async () => {
    const computer = decode((await handleCursorNativeExec(execMessage({
      case: "computerUseArgs",
      value: create(ComputerUseArgsSchema, { actions: [], toolCallId: "cu0" }),
    }), {}))[0]);
    expect(computer.message.value.result.case).toBe("error");
    if (computer.message.value.result.case === "error") {
      expect(computer.message.value.result.value.error).toContain("headless opencodex proxy");
    }

    const record = decode((await handleCursorNativeExec(execMessage({
      case: "recordScreenArgs",
      value: create(RecordScreenArgsSchema, { mode: 1, toolCallId: "rs0" }),
    }), {}))[0]);
    expect(record.message.value.result.case).toBe("failure");
    if (record.message.value.result.case === "failure") {
      expect(record.message.value.result.value.error).toContain("headless opencodex proxy");
    }
  });
});

describe("desktop executor platform shell (devlog 260715_cross_platform_audit/020)", () => {
  test("behavior fixture uses CMD built-ins on win32", () => {
    expect(echoJson('{"durationMs":42}', "win32")).toBe('more >nul & echo {"durationMs":42}');
  });

  test("POSIX invocation stays byte-identical to sh -c for both configured commands", () => {
    const computerUse = "cat >/dev/null; printf '%s' '{\"durationMs\":42}'";
    const recordScreen = "cat >/dev/null; printf '%s' '{\"startSuccess\":{}}'";
    expect(shellInvocation(computerUse, "linux")).toEqual({ file: "sh", args: ["-c", computerUse], options: {} });
    expect(shellInvocation(recordScreen, "darwin")).toEqual({ file: "sh", args: ["-c", recordScreen], options: {} });
  });

  test("win32 computer-use command with quoted exe path gets the /s outer-quote wrapper", () => {
    const cmd = '"C:\\Program Files\\executor.exe" --computer-use --json';
    const inv = shellInvocation(cmd, "win32", { ComSpec: "C:\\WINDOWS\\system32\\cmd.exe" });
    expect(inv).toEqual({
      file: "C:\\WINDOWS\\system32\\cmd.exe",
      args: ["/d", "/s", "/c", `"${cmd}"`],
      options: { windowsVerbatimArguments: true },
    });
  });

  test("win32 record-screen command with CMD metacharacters is passed verbatim (CMD-native contract)", () => {
    const cmd = "recorder.exe --start & echo %ERRORLEVEL%";
    const inv = shellInvocation(cmd, "win32", {});
    expect(inv.file).toBe("cmd.exe");
    expect(inv.args).toEqual(["/d", "/s", "/c", `"${cmd}"`]);
  });
});
