import { afterEach, describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http2 from "node:http2";
import { CursorForegroundShellOwner } from "../../../src/adapters/cursor/native-foreground-shell";
import { shellStreamExec } from "../../../src/adapters/cursor/native-exec-shell";
import { handleCursorNativeExec } from "../../../src/adapters/cursor/native-exec";
import { createLiveCursorTransport } from "../../../src/adapters/cursor/live-transport";
import { decodeAvailableConnectFrames, encodeConnectFrame } from "../../../src/adapters/cursor/framing";
import {
  AgentClientMessageSchema, AgentServerMessageSchema, ExecServerMessageSchema, ShellArgsSchema,
} from "../../../src/adapters/cursor/gen/agent_pb";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";
import type { CursorRunRequest } from "../../../src/adapters/cursor/types";

const dirs: string[] = [];
function marker() {
  const dir = mkdtempSync(join(tmpdir(), "cursor-foreground-"));
  dirs.push(dir);
  return join(dir, "must-not-exist");
}
function message(command: string) {
  return create(ExecServerMessageSchema, {
    id: 73, execId: "foreground-fixture",
    message: { case: "shellStreamArgs", value: create(ShellArgsSchema, { command, hardTimeout: 1000 }) },
  });
}
function failure(frames: Uint8Array[], text: string) {
  const replies = frames.map(bytes => fromBinary(AgentClientMessageSchema, bytes));
  const messages = replies.flatMap(reply => reply.message.case === "execClientMessage" ? [reply.message.value] : []);
  expect(messages.map(value => value.message.case)).toEqual(["shellStream", "shellStream", "shellResult"]);
  expect(messages.every(value => value.id === 73 && value.execId === "foreground-fixture")).toBe(true);
  const start = messages[0]!.message;
  const exit = messages[1]!.message;
  expect(start.case === "shellStream" && start.value.event.case).toBe("start");
  expect(exit.case === "shellStream" && exit.value.event.case).toBe("exit");
  if (exit.case === "shellStream" && exit.value.event.case === "exit") {
    expect(exit.value.event.value).toMatchObject({ code: 1, aborted: true });
  }
  const result = messages[2]!.message;
  if (result.case !== "shellResult" || result.value.result.case !== "failure") throw new Error("missing typed failure");
  expect(result.value.result.value).toMatchObject({ aborted: true, stdout: "", exitCode: 1 });
  expect(result.value.result.value.stderr).toContain(text);
  const control = replies.at(-1)!.message;
  expect(control.case === "execClientControlMessage" && control.value.message.case).toBe("streamClose");
  expect(frames).toHaveLength(4);
  return result.value.result.value;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("fixture did not become ready");
    await Bun.sleep(10);
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Cursor foreground shell admission", () => {
  test(`${process.platform} refuses even an ordinary command before spawn`, async () => {
    const path = marker();
    const owner = new CursorForegroundShellOwner();
    failure(await shellStreamExec(message(`echo unexpected > "${path}"`), owner), "kernel-backed descendant ownership");
    expect(existsSync(path)).toBe(false);
    expect(owner.activeCount).toBe(0);
    expect(owner.isClosed).toBe(false);
  });

  test.skipIf(process.platform === "win32")("rejects a command that would detach a new session", async () => {
    const path = marker();
    // Without admission denial this exits its shell group and creates the marker.
    failure(await shellStreamExec(message(`setsid sh -c 'echo detached > "${path}"'`)), "kernel-backed descendant ownership");
    expect(existsSync(path)).toBe(false);
  });

  test("trusted-local dispatcher opt-in cannot bypass foreground admission", async () => {
    const path = marker();
    const owner = new CursorForegroundShellOwner();
    failure(await handleCursorNativeExec(message(`echo unexpected > "${path}"`), {
      unsafeAllowNativeLocalExec: true, foregroundShellOwner: owner,
    }), "kernel-backed descendant ownership");
    expect(existsSync(path)).toBe(false);
    expect(owner.activeCount).toBe(0);
  });

  test("synchronous shellArgs cannot bypass foreground admission", async () => {
    const path = marker();
    const input = message(`echo unexpected > "${path}"`);
    if (input.message.case !== "shellStreamArgs") throw new Error("missing shell args");
    input.message = { case: "shellArgs", value: input.message.value };
    const frames = await handleCursorNativeExec(input, { unsafeAllowNativeLocalExec: true });
    expect(frames).toHaveLength(1);
    const reply = fromBinary(AgentClientMessageSchema, frames[0]!);
    if (reply.message.case !== "execClientMessage" || reply.message.value.message.case !== "shellResult") throw new Error("missing shellResult");
    const result = reply.message.value.message.value.result;
    expect(result.case).toBe("failure");
    if (result.case !== "failure") throw new Error("missing typed failure");
    expect(result.value).toMatchObject({ aborted: true, stdout: "", exitCode: 1 });
    expect(result.value.stderr).toContain("kernel-backed descendant ownership");
    // No catalog hint here, so the default bridge redirect (#604) must follow the reason.
    expect(result.value.stderr).toContain("shell_command");
    expect(existsSync(path)).toBe(false);
  });

  test("foreground denial preserves the request's catalog-specific redirect", async () => {
    for (const execCase of ["shellArgs", "shellStreamArgs"] as const) {
      const input = message("echo unused");
      if (input.message.case !== "shellStreamArgs") throw new Error("missing shell args");
      input.message = { case: execCase, value: input.message.value };
      const frames = await handleCursorNativeExec(input, {
        unsafeAllowNativeLocalExec: true, nativeExecRedirectHint: "Use `client_task`.",
      });
      const replies = frames.map(bytes => fromBinary(AgentClientMessageSchema, bytes));
      const completion = replies.flatMap(reply => reply.message.case === "execClientMessage"
        && reply.message.value.message.case === "shellResult" ? [reply.message.value.message.value.result] : [])[0];
      if (completion?.case !== "failure") throw new Error("expected foreground denial");
      expect(completion.value.stderr).toContain("Use `client_task`.");
      expect(completion.value.stderr).not.toContain("exec_command");
    }
  });

  test("pre-aborted requests and sealed owners retain cancellation semantics", async () => {
    const owner = new CursorForegroundShellOwner();
    const controller = new AbortController();
    controller.abort();
    failure(await shellStreamExec(message("echo unused"), owner, controller.signal), "cancelled");
    await Promise.all([owner.close(), owner.close()]);
    failure(await shellStreamExec(message("echo unused"), owner), "cancelled");
    expect(owner.isClosed).toBe(true);
    expect(owner.activeCount).toBe(0);
  });
});

const request: CursorRunRequest = {
  modelId: "test-model", conversationId: "shell-transport-fixture",
  system: [], messages: [{ role: "user", content: "test" }], tools: [],
};

describe("Cursor live foreground admission", () => {
  for (const teardown of ["close", "abort", "eof", "reset", "session-error"] as const) {
    test(`${teardown} seals the owner after a denied native frame`, async () => {
      const path = marker();
      const server = http2.createServer();
      let stream!: http2.ServerHttp2Stream;
      const replies: Uint8Array[] = [];
      server.on("stream", value => {
        stream = value;
        stream.on("error", () => {});
        let pending: Uint8Array = new Uint8Array();
        stream.on("data", (chunk: Buffer) => {
          const decoded = decodeAvailableConnectFrames(Buffer.concat([pending, chunk]));
          pending = decoded.remainder;
          for (const frame of decoded.frames) {
            if (frame.endStream) continue;
            const reply = fromBinary(AgentClientMessageSchema, frame.payload);
            if (reply.message.case === "execClientMessage" || reply.message.case === "execClientControlMessage") replies.push(frame.payload);
          }
        });
        stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
        stream.write(encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
          message: { case: "execServerMessage", value: message(`echo unexpected > "${path}"`) },
        }))));
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture address missing");
      const transport = createLiveCursorTransport({
        provider: { adapter: "cursor", baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test-token", nativeLocalExec: "on" },
        translatorBudget: createTestTranslatorBudget(), headers: new Headers(),
      });
      const owner = (transport as unknown as { foregroundShellOwner: CursorForegroundShellOwner }).foregroundShellOwner;
      const controller = new AbortController();
      const consume = (async () => { try { for await (const _event of transport.run(request, controller.signal)) { /* drain */ } } catch { /* expected transport failure */ } })();
      try {
        await until(() => replies.length === 4);
        failure(replies, "kernel-backed descendant ownership");
        expect(owner.activeCount).toBe(0);
        expect(existsSync(path)).toBe(false);
        if (teardown === "close") void transport.close?.();
        else if (teardown === "abort") controller.abort();
        else if (teardown === "eof") stream.end();
        else if (teardown === "reset") stream.close(http2.constants.NGHTTP2_CANCEL);
        else stream.session!.destroy(new Error("fixture session failure"));
        await until(() => owner.isClosed);
      } finally {
        await transport.close?.();
        await consume;
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  }
});
