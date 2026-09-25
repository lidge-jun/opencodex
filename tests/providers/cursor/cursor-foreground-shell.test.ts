import { afterEach, describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http2 from "node:http2";
import {
  CURSOR_FOREGROUND_SHELL_MAX_BYTES as LIMIT,
  CURSOR_FOREGROUND_SHELL_TERM_GRACE_MS as TERM_GRACE,
  CursorForegroundShellOwner,
} from "../../../src/adapters/cursor/native-foreground-shell";
import { shellStreamExec } from "../../../src/adapters/cursor/native-exec-shell";
import { handleCursorNativeExec } from "../../../src/adapters/cursor/native-exec";
import { createLiveCursorTransport } from "../../../src/adapters/cursor/live-transport";
import { encodeConnectFrame } from "../../../src/adapters/cursor/framing";
import {
  AgentClientMessageSchema, AgentServerMessageSchema, ExecServerMessageSchema, ShellArgsSchema,
} from "../../../src/adapters/cursor/gen/agent_pb";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";
import type { CursorRunRequest } from "../../../src/adapters/cursor/types";

const owners: CursorForegroundShellOwner[] = [];
const dirs: string[] = [];
const fixturePids: number[] = [];
function owner() { const value = new CursorForegroundShellOwner(); owners.push(value); return value; }
function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
function command(script: string) { return `${quote(process.execPath)} -e ${quote(script)}`; }
function message(cmd: string, hardTimeout = 10_000, workingDirectory = process.cwd()) {
  return create(ExecServerMessageSchema, {
    id: 73, execId: "foreground-fixture",
    message: { case: "shellStreamArgs", value: create(ShellArgsSchema, { command: cmd, hardTimeout, workingDirectory }) },
  });
}
function result(frames: Uint8Array[]) {
  const replies = frames.map(bytes => fromBinary(AgentClientMessageSchema, bytes));
  const results = replies.flatMap(reply => reply.message.case === "execClientMessage"
    && reply.message.value.message.case === "shellResult" ? [reply.message.value.message.value.result] : []);
  expect(results).toHaveLength(1);
  expect(replies.filter(reply => reply.message.case === "execClientControlMessage")).toHaveLength(1);
  expect(replies.at(-1)?.message.case).toBe("execClientControlMessage");
  const exits = replies.filter(reply => reply.message.case === "execClientMessage"
    && reply.message.value.message.case === "shellStream" && reply.message.value.message.value.event.case === "exit");
  expect(exits).toHaveLength(1);
  const value = results[0]!;
  if (value.case !== "success" && value.case !== "failure") throw new Error("missing typed result");
  return value;
}
function failure(frames: Uint8Array[], text: string) {
  const value = result(frames);
  expect(value.case).toBe("failure");
  if (value.case !== "failure") throw new Error("expected failure");
  expect(value.value.aborted).toBe(true);
  expect(value.value.stdout).toBe("");
  expect(value.value.stderr).toContain(text);
  // No output replay in stream deltas on abort: one diagnostic in the typed result.
  expect(frames).toHaveLength(4);
  expect(frames.reduce((sum, frame) => sum + frame.byteLength, 0)).toBeLessThan(4096);
  return value.value;
}
async function until(check: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("fixture did not become ready");
    await Bun.sleep(10);
  }
}
function alive(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
    } catch { return false; }
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function fixture(resistant = false, child = false, inheritPipes = true) {
  const dir = mkdtempSync(join(tmpdir(), "cursor-foreground-"));
  dirs.push(dir);
  const ready = join(dir, "ready");
  const childReady = join(dir, "child-ready");
  const body = (path: string) => `
    ${resistant ? 'process.on("SIGTERM", () => {});' : ""}
    require("node:fs").writeFileSync(${JSON.stringify(path)}, String(process.pid));
    setInterval(() => {}, 1000);
  `;
  const script = `${body(ready)}\n${child ? `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(body(childReady))}], { stdio: ${JSON.stringify(inheritPipes ? "inherit" : "ignore")} });` : ""}`;
  const path = join(dir, "run.cjs");
  writeFileSync(path, script);
  return {
    command: `${quote(process.execPath)} ${quote(path)}`,
    ready: async () => {
      const paths = child ? [ready, childReady] : [ready];
      const pids: number[] = [];
      for (const path of paths) {
        let pid = 0;
        await until(() => { try { pid = Number(readFileSync(path, "utf8")); return pid > 0; } catch { return false; } });
        pids.push(pid); fixturePids.push(pid);
      }
      return pids;
    },
  };
}

afterEach(async () => {
  await Promise.all(owners.splice(0).map(value => value.close()));
  for (const pid of fixturePids.splice(0)) {
    if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* exited */ } }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("Cursor foreground shell ownership", () => {
  for (const channel of ["stdout", "stderr"] as const) {
    test(`${channel} overflow is bounded during ingestion and stops its producer`, async () => {
      const owned = owner();
      const cmd = command(`const fs = require("node:fs"); for (;;) fs.writeSync(${channel === "stdout" ? 1 : 2}, Buffer.alloc(65536, 120));`);
      failure(await shellStreamExec(message(cmd), owned), "combined stdout/stderr limit");
      expect(owned.activeCount).toBe(0);
    });
  }

  test("stdout and stderr share an inclusive byte ceiling", async () => {
    const owned = owner();
    const cmd = command(`const fs = require("node:fs"); fs.writeSync(1, Buffer.alloc(${LIMIT / 2}, 97)); fs.writeSync(2, Buffer.alloc(${LIMIT / 2}, 98));`);
    const value = result(await shellStreamExec(message(cmd), owned));
    expect(value.case).toBe("success");
    expect(value.value.stdout.length + value.value.stderr.length).toBe(LIMIT);
    const overflow = command(`const fs = require("node:fs"); fs.writeSync(1, Buffer.alloc(${LIMIT / 2}, 97)); fs.writeSync(2, Buffer.alloc(${LIMIT / 2 + 1}, 98));`);
    failure(await shellStreamExec(message(overflow), owned), "combined stdout/stderr limit");
    expect(owned.activeCount).toBe(0);
  });

  test("decodes split UTF-8 only after accounting raw bytes", async () => {
    const cmd = command('const fs = require("node:fs"); fs.writeSync(1, Buffer.from([0xf0, 0x9f])); setTimeout(() => fs.writeSync(1, Buffer.from([0x98, 0x80])), 20);');
    expect(result(await shellStreamExec(message(cmd), owner())).value.stdout).toBe("😀");
  });

  test("pre-aborted requests and closed owners never spawn", async () => {
    const owned = owner();
    const controller = new AbortController(); controller.abort();
    failure(await shellStreamExec(message("exit 0"), owned, controller.signal), "cancelled");
    await owned.close();
    failure(await shellStreamExec(message("exit 0"), owned), "cancelled");
    expect(owned.activeCount).toBe(0);
  });

  test("request cancellation propagates through the native dispatcher to a child tree", async () => {
    const owned = owner();
    const controller = new AbortController();
    const f = fixture(false, true);
    const pending = handleCursorNativeExec(message(f.command), {
      unsafeAllowNativeLocalExec: true, foregroundShellOwner: owned, signal: controller.signal,
    });
    const pids = await f.ready();
    expect(owned.activeCount).toBe(1);
    controller.abort();
    failure(await pending, "cancelled");
    expect(pids.some(alive)).toBe(false);
    expect(owned.activeCount).toBe(0);
  });

  for (const inheritPipes of [true, false]) {
    test(`TERM-resistant descendants are killed after grace (inherited pipes: ${inheritPipes})`, async () => {
      const owned = owner();
      const f = fixture(true, true, inheritPipes);
      const pending = shellStreamExec(message(f.command), owned);
      const pids = await f.ready();
      const started = Date.now();
      const closing = owned.close();
      failure(await pending, "cancelled");
      await closing;
      expect(Date.now() - started).toBeGreaterThanOrEqual(TERM_GRACE);
      expect(Date.now() - started).toBeLessThan(TERM_GRACE + 2500);
      expect(pids.some(alive)).toBe(false);
      expect(owned.activeCount).toBe(0);
    }, 10_000);
  }

  test("timeout stops a TERM-resistant shell and drains its pipes", async () => {
    const owned = owner();
    const f = fixture(true);
    const pending = shellStreamExec(message(f.command, 1000), owned);
    const pids = await f.ready();
    failure(await pending, "timed out");
    expect(pids.some(alive)).toBe(false);
    expect(owned.activeCount).toBe(0);
  }, 10_000);

  test("spawn error, abort and close race settle once and release the registry", async () => {
    const owned = owner();
    const controller = new AbortController();
    const pending = shellStreamExec(message("exit 0", 1, join(tmpdir(), crypto.randomUUID())), owned, controller.signal);
    controller.abort();
    await Promise.all([owned.close(), owned.close()]);
    failure(await pending, "Cursor shell");
    expect(owned.activeCount).toBe(0);
  });

  test("ordinary nonzero exit keeps bounded output and a single failure completion", async () => {
    const owned = owner();
    const value = result(await shellStreamExec(message("printf diagnostic >&2; exit 7"), owned));
    expect(value.case).toBe("failure");
    expect(value.value).toMatchObject({ stderr: "diagnostic", exitCode: 7, aborted: false });
    expect(owned.activeCount).toBe(0);
  });
});

test.skipIf(process.platform !== "win32")("Windows refuses foreground execution without a process-tree owner", async () => {
  failure(await shellStreamExec(message("echo should-not-run"), owner()), "POSIX process-group ownership");
});

const request: CursorRunRequest = {
  modelId: "test-model", conversationId: "shell-transport-fixture",
  system: [], messages: [{ role: "user", content: "test" }], tools: [],
};

describe.skipIf(process.platform === "win32")("Cursor live foreground ownership", () => {
  for (const teardown of ["close", "abort", "eof", "reset", "session-error"] as const) {
    test(`${teardown} cancels in-flight native work before waiting for frameWork`, async () => {
      const f = fixture(true, true);
      const server = http2.createServer();
      let stream!: http2.ServerHttp2Stream;
      server.on("stream", value => {
        stream = value;
        stream.on("error", () => {});
        stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
        stream.write(encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
          message: { case: "execServerMessage", value: message(f.command) },
        }))));
        stream.resume();
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture address missing");
      const transport = createLiveCursorTransport({
        provider: { adapter: "cursor", baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test-token", nativeLocalExec: "on" },
        translatorBudget: createTestTranslatorBudget(), headers: new Headers(),
      });
      const owned = (transport as unknown as { foregroundShellOwner: CursorForegroundShellOwner }).foregroundShellOwner;
      owners.push(owned);
      const controller = new AbortController();
      const consume = (async () => { try { for await (const _event of transport.run(request, controller.signal)) { /* drain */ } } catch { /* transport failure is expected */ } })();
      try {
        const pids = await f.ready();
        expect(owned.activeCount).toBe(1);
        if (teardown === "close") void transport.close?.();
        else if (teardown === "abort") controller.abort();
        else if (teardown === "eof") stream.end();
        else if (teardown === "reset") stream.close(http2.constants.NGHTTP2_CANCEL);
        else stream.session!.destroy(new Error("fixture session failure"));
        await until(() => owned.activeCount === 0, 5000);
        expect(pids.some(alive)).toBe(false);
        expect(owned.isClosed).toBe(true);
      } finally {
        await transport.close?.();
        await consume;
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }, 15_000);
  }
});
