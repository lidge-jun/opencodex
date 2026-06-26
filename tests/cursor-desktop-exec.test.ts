import { create, fromBinary } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import {
  AgentClientMessageSchema,
  ComputerUseArgsSchema,
  ExecServerMessageSchema,
  RecordScreenArgsSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { handleCursorNativeExec } from "../src/adapters/cursor/native-exec";
import { desktopDepsFromConfig } from "../src/adapters/cursor/native-exec-desktop";

function execMessage(message: Parameters<typeof create<typeof ExecServerMessageSchema>>[1]["message"]) {
  return create(ExecServerMessageSchema, { id: 3, execId: "exec-test", message });
}

function decode(bytes: Uint8Array) {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  expect(msg.message.case).toBe("execClientMessage");
  return msg.message.value;
}

// A tiny shell command that prints a fixed JSON payload, ignoring stdin.
function echoJson(json: string): string {
  return `cat >/dev/null; printf '%s' '${json}'`;
}

describe("Cursor desktop executor hooks", () => {
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
