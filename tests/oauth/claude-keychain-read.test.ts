import { describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { claudeKeychainReader, createClaudeKeychainReader } from "../../src/oauth/claude-keychain-read";
import { repoPath } from "../helpers/repo-root";

const READ_ARGS = ["find-generic-password", "-s", "Claude Code-credentials", "-w"];
const PROBE_ARGS = ["find-generic-password", "-s", "Claude Code-credentials"];

class FakeChild extends EventEmitter {
  readonly stdout = Object.assign(new EventEmitter(), { unref: mock(() => undefined) });
  readonly unref = mock(() => undefined);
  readonly kill = mock(() => true);
  constructor(readonly args: readonly string[], readonly captureStdout: boolean) { super(); }
}

function harness(platform = "darwin") {
  let clock = 1_000;
  const children: FakeChild[] = [];
  const deadlines: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  const reader = createClaudeKeychainReader({
    platform,
    spawn: (command, args, captureStdout) => {
      expect(command).toBe("security");
      const child = new FakeChild(args, captureStdout);
      children.push(child);
      return child;
    },
    now: () => clock,
    schedule(ms, fn) {
      const entry = { ms, fn, cancelled: false };
      deadlines.push(entry);
      return () => { entry.cancelled = true; };
    },
    timeoutMs: 5_000,
    probeTimeoutMs: 1_500,
    backoffMs: 60_000,
  });
  const fireDeadline = (index = deadlines.length - 1): void => {
    const entry = deadlines[index]!;
    if (!entry.cancelled) entry.fn();
  };
  const killed = (): number => children.reduce((count, child) => count + child.kill.mock.calls.length, 0);
  return { reader, children, deadlines, fireDeadline, killed, advance: (ms: number) => { clock += ms; } };
}

describe("Claude Keychain credential read never kills a blocked security child (#8161)", () => {
  test("a non-darwin host never spawns", async () => {
    const h = harness("linux");
    expect(await h.reader.readAsync()).toBeNull();
    expect(h.children).toHaveLength(0);
  });

  test("a successful read returns trimmed stdout and cancels its deadline", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    expect(h.children[0]!.args).toEqual(READ_ARGS);
    expect(h.children[0]!.captureStdout).toBe(true);
    h.children[0]!.stdout.emit("data", Buffer.from("{\"claudeAiOauth\":{}}\n"));
    h.children[0]!.emit("close", 0, null);
    expect(await read).toBe("{\"claudeAiOauth\":{}}");
    expect(h.deadlines[0]!.cancelled).toBe(true);
  });

  test("a nonzero exit (item not found) resolves null without backoff", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    h.children[0]!.emit("close", 44, null);
    expect(await read).toBeNull();
    void h.reader.readAsync();
    expect(h.children).toHaveLength(2);
  });

  test("the deadline resolves null without killing, and unrefs the child", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    expect(h.deadlines[0]!.ms).toBe(5_000);
    h.fireDeadline();
    expect(await read).toBeNull();
    const child = h.children[0]!;
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.stdout.unref).toHaveBeenCalledTimes(1);
  });

  test("concurrent reads share one child", async () => {
    const h = harness();
    const first = h.reader.readAsync();
    const second = h.reader.readAsync();
    expect(second).toBe(first);
    expect(h.children).toHaveLength(1);
    h.children[0]!.stdout.emit("data", "secret");
    h.children[0]!.emit("close", 0, null);
    expect(await Promise.all([first, second])).toEqual(["secret", "secret"]);
  });

  test("a timed-out child that is still blocked keeps every later read from spawning", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    h.fireDeadline();
    await read;
    expect(await h.reader.readAsync()).toBeNull();
    // Past the backoff window, but the first child has still not exited.
    h.advance(60_001);
    expect(await h.reader.readAsync()).toBeNull();
    expect(h.children).toHaveLength(1);
    expect(h.killed()).toBe(0);
  });

  test("after a timeout, reads back off until the window passes, then spawn again", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    h.fireDeadline();
    await read;
    // The prompt is dismissed and the blocked child exits on its own.
    h.children[0]!.emit("close", 1, null);
    h.advance(59_999);
    expect(await h.reader.readAsync()).toBeNull();
    expect(h.children).toHaveLength(1);
    h.advance(2);
    void h.reader.readAsync();
    expect(h.children).toHaveLength(2);
  });

  test("stdout is decoded once, so a multi-byte character split across chunks survives", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    const bytes = Buffer.from("{\"label\":\"caf\u00e9\"}");
    const split = bytes.indexOf(0xc3) + 1;
    h.children[0]!.stdout.emit("data", bytes.subarray(0, split));
    h.children[0]!.stdout.emit("data", bytes.subarray(split));
    h.children[0]!.emit("close", 0, null);
    expect(await read).toBe("{\"label\":\"caf\u00e9\"}");
  });

  test("an exit event alone does not settle the read before stdout closes", async () => {
    const h = harness();
    let settled = false;
    const read = h.reader.readAsync().then(value => { settled = true; return value; });
    h.children[0]!.emit("exit", 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);
    h.children[0]!.stdout.emit("data", "tail");
    h.children[0]!.emit("close", 0, null);
    expect(await read).toBe("tail");
  });

  test("a late exit after the deadline does not resurrect the timed-out read", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    h.fireDeadline();
    h.children[0]!.stdout.emit("data", "late");
    h.children[0]!.emit("close", 0, null);
    expect(await read).toBeNull();
  });

  test("a spawn error resolves null and releases the slot", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    h.children[0]!.emit("error", new Error("ENOENT"));
    expect(await read).toBeNull();
    void h.reader.readAsync();
    expect(h.children).toHaveLength(2);
  });

  test("a late close from an errored child does not free its replacement's slot", async () => {
    const h = harness();
    const first = h.reader.readAsync();
    h.children[0]!.emit("error", new Error("spawn failure"));
    expect(await first).toBeNull();
    const second = h.reader.readAsync();
    expect(h.children).toHaveLength(2);
    h.children[0]!.emit("close", -2, null);
    // The replacement still owns the slot, so a probe does not start beside it.
    expect(await h.reader.probe()).toBe("unknown");
    expect(h.children).toHaveLength(2);
    h.children[1]!.emit("close", 44, null);
    expect(await second).toBeNull();
  });

  test("an error from a child that did start keeps its slot until that child closes", async () => {
    const h = harness();
    const first = h.reader.readAsync();
    // A started process: its error event does not mean it is gone, so no sibling may start.
    Object.assign(h.children[0]!, { pid: 4242 });
    h.children[0]!.emit("error", new Error("stdio failure"));
    expect(await first).toBeNull();
    expect(await h.reader.readAsync()).toBeNull();
    expect(await h.reader.probe()).toBe("unknown");
    expect(h.children).toHaveLength(1);
    h.children[0]!.emit("close", 1, null);
    void h.reader.readAsync();
    expect(h.children).toHaveLength(2);
  });

  test("stdout past the 1 MiB cap is not a credential, even across chunks", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    const chunk = Buffer.alloc(600 * 1024, 0x61);
    h.children[0]!.stdout.emit("data", chunk);
    h.children[0]!.stdout.emit("data", chunk);
    h.children[0]!.emit("close", 0, null);
    expect(await read).toBeNull();
  });

  test("an empty Keychain value is no credential", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    h.children[0]!.stdout.emit("data", " \n");
    h.children[0]!.emit("close", 0, null);
    expect(await read).toBeNull();
  });
});

describe("Claude Keychain metadata probe is asynchronous and shares the read's admission (#8161)", () => {
  test("a non-darwin host answers absent without spawning", async () => {
    const h = harness("linux");
    expect(await h.reader.probe()).toBe("absent");
    expect(h.children).toHaveLength(0);
  });

  test("the probe asks for metadata only and discards every output stream", async () => {
    const h = harness();
    const probed = h.reader.probe();
    expect(h.children[0]!.args).toEqual(PROBE_ARGS);
    expect(h.children[0]!.args).not.toContain("-w");
    expect(h.children[0]!.args).not.toContain("-g");
    expect(h.children[0]!.captureStdout).toBe(false);
    h.children[0]!.emit("close", 0, null);
    expect(await probed).toBe("present");
  });

  test("exit codes map to present, absent and unknown; unknown is never absent", async () => {
    for (const [code, expected] of [[0, "present"], [44, "absent"], [1, "unknown"], [51, "unknown"], [null, "unknown"]] as const) {
      const h = harness();
      const probed = h.reader.probe();
      h.children[0]!.emit("close", code, code === null ? "SIGTERM" : null);
      expect(await probed).toBe(expected);
    }
    const failed = harness();
    const probed = failed.reader.probe();
    failed.children[0]!.emit("error", new Error("ENOENT"));
    expect(await probed).toBe("unknown");
  });

  test("the probe deadline answers unknown without killing, unrefs the child, and backs off", async () => {
    const h = harness();
    const probed = h.reader.probe();
    expect(h.deadlines[0]!.ms).toBe(1_500);
    h.fireDeadline();
    expect(await probed).toBe("unknown");
    const child = h.children[0]!;
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalledTimes(1);
    // The blocked child exits on its own; the backoff still holds every lookup off.
    child.emit("close", 1, null);
    expect(await h.reader.probe()).toBe("unknown");
    expect(await h.reader.readAsync()).toBeNull();
    expect(h.children).toHaveLength(1);
    h.advance(60_000);
    void h.reader.probe();
    expect(h.children).toHaveLength(2);
    expect(h.killed()).toBe(0);
  });

  test("a read timeout backs the probe off too", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    h.fireDeadline();
    await read;
    h.children[0]!.emit("close", 1, null);
    expect(await h.reader.probe()).toBe("unknown");
    expect(h.children).toHaveLength(1);
  });

  test("a probe and a read never run side by side, in either order", async () => {
    const h = harness();
    const read = h.reader.readAsync();
    expect(await h.reader.probe()).toBe("unknown");
    expect(h.children).toHaveLength(1);
    h.children[0]!.emit("close", 44, null);
    expect(await read).toBeNull();

    const probed = h.reader.probe();
    expect(h.children).toHaveLength(2);
    // A read that arrives during a probe waits for it instead of reading as absent.
    const queued = h.reader.readAsync();
    await Promise.resolve();
    expect(h.children).toHaveLength(2);
    h.children[1]!.emit("close", 0, null);
    expect(await probed).toBe("present");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.children).toHaveLength(3);
    h.children[2]!.stdout.emit("data", Buffer.from("secret-after-probe\n"));
    h.children[2]!.emit("close", 0, null);
    expect(await queued).toBe("secret-after-probe");
  });

  test("a timed-out probe child that is still blocked keeps every later lookup from spawning", async () => {
    const h = harness();
    const probed = h.reader.probe();
    h.fireDeadline();
    expect(await probed).toBe("unknown");
    h.advance(60_001);
    expect(await h.reader.probe()).toBe("unknown");
    expect(await h.reader.readAsync()).toBeNull();
    expect(h.children).toHaveLength(1);
    h.children[0]!.emit("close", 0, null);
    void h.reader.readAsync();
    expect(h.children).toHaveLength(2);
    expect(h.killed()).toBe(0);
  });

  test("concurrent probes share one child", async () => {
    const h = harness();
    const first = h.reader.probe();
    const second = h.reader.probe();
    expect(second).toBe(first);
    expect(h.children).toHaveLength(1);
    h.children[0]!.emit("close", 44, null);
    expect(await Promise.all([first, second])).toEqual(["absent", "absent"]);
  });

  test("the reader has no synchronous lookup left", () => {
    expect(Object.keys(createClaudeKeychainReader({
      platform: "darwin", spawn: () => { throw new Error("unused"); }, now: () => 0, schedule: () => () => {},
    })).sort()).toEqual(["probe", "readAsync"]);
  });

  // A synchronous child cannot be bounded without killing it, so none of the modules that look up
  // the Claude Code item may reach a synchronous child_process API.
  test("no Claude Keychain module uses a synchronous child_process API", () => {
    for (const file of ["src/oauth/claude-keychain-read.ts", "src/claude/auth-detect.ts", "src/oauth/local-token-detect.ts"]) {
      expect(readFileSync(repoPath(file), "utf8")).not.toMatch(/\b(?:spawnSync|execFileSync|execSync)\b/);
    }
  });

  test("the production probe spawns security with metadata args and all stdio ignored", async () => {
    const calls: Array<{ file: string; args: readonly string[]; stdio: unknown }> = [];
    const spy = spyOn(childProcess, "spawn").mockImplementation(((file: string, args: readonly string[], options: { stdio?: unknown }) => {
      calls.push({ file, args, stdio: options.stdio });
      const child = Object.assign(new EventEmitter(), { pid: 1, stdout: null, unref() {} });
      queueMicrotask(() => child.emit("close", 44, null));
      return child;
    }) as never);
    try {
      expect(await claudeKeychainReader.probe()).toBe("absent");
      if (process.platform !== "darwin") return void expect(calls).toHaveLength(0);
      expect(calls).toEqual([{ file: "security", args: PROBE_ARGS, stdio: ["ignore", "ignore", "ignore"] }]);
    } finally {
      spy.mockRestore();
    }
  });
});
