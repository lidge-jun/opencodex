import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { createClaudeKeychainService, type KeychainChild } from "../../src/lib/claude-keychain";

class Clock {
  now = 0;
  next = 0;
  timers = new Map<number, { at: number; fn: () => void }>();
  set = (fn: () => void, ms: number) => { const id = ++this.next; this.timers.set(id, { at: this.now + ms, fn }); return id; };
  clear = (id: unknown) => { this.timers.delete(id as number); };
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const entry = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry || entry[1].at > end) break;
      this.now = entry[1].at;
      this.timers.delete(entry[0]);
      entry[1].fn();
    }
    this.now = end;
  }
}

class Child extends EventEmitter {
  stdout = new PassThrough();
  signals = 0;
  kill() { this.signals++; throw new Error("unexpected signal"); }
  start() { this.emit("spawn"); }
  exit(code: number | null) { this.emit("exit", code, null); }
  closeOutput() { this.stdout.emit("end"); this.stdout.emit("close"); }
}

function fixture(platform = "darwin", limit = 64) {
  const clock = new Clock();
  const children: Child[] = [];
  const calls: Array<{ args: readonly string[]; capture: boolean }> = [];
  const service = createClaudeKeychainService({
    platform, maxBytes: limit, now: () => clock.now,
    setTimer: clock.set, clearTimer: clock.clear,
    spawn: (args, capture) => {
      calls.push({ args, capture });
      const child = new Child(); children.push(child);
      return child as unknown as KeychainChild;
    },
  });
  return { service, clock, children, calls };
}

describe("Claude Keychain admission", () => {
  test.each(["read", "probe"] as const)("a %s caller deadline does not keep a Bun parent alive for a blocked synthetic child", async mode => {
    const servicePath = join(import.meta.dir, "../../src/lib/claude-keychain.ts");
    const childScript = 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));';
    const parentScript = `import { spawn } from "node:child_process";
      import { createClaudeKeychainService } from ${JSON.stringify(servicePath)};
      const service = createClaudeKeychainService({ platform: "darwin",
        setTimer: fn => setImmediate(fn), clearTimer: id => clearImmediate(id),
        spawn: (_args, capture) => spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}],
          { stdio: ["pipe", capture ? "pipe" : "ignore", "ignore"], windowsHide: true }) });
      const result = await service.${mode}();
      if (result.status !== "unavailable") process.exitCode = 1;`;
    const parent = Bun.spawn([process.execPath, "-e", parentScript], { stdout: "ignore", stderr: "pipe", env: process.env });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      parent.exited.then(code => ({ code })),
      new Promise<{ timedOut: true }>(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), 2000); }),
    ]);
    if (timer) clearTimeout(timer);
    if ("timedOut" in outcome) {
      parent.kill();
      await parent.exited;
      throw new Error("synthetic parent remained alive after caller deadline");
    }
    expect(outcome.code).toBe(0);
  });

  test("explicit Bun exit after a deadline settles without waiting for a synthetic child", async () => {
    const servicePath = join(import.meta.dir, "../../src/lib/claude-keychain.ts");
    const childScript = 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));';
    const parentScript = `import { spawn } from "node:child_process";
      import { createClaudeKeychainService } from ${JSON.stringify(servicePath)};
      const service = createClaudeKeychainService({ platform: "darwin",
        setTimer: fn => setImmediate(fn), clearTimer: id => clearImmediate(id),
        spawn: () => spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}],
          { stdio: ["pipe", "ignore", "ignore"], windowsHide: true }) });
      const result = await service.probe();
      process.exit(result.status === "unavailable" ? 0 : 1);`;
    const parent = Bun.spawn([process.execPath, "-e", parentScript], { stdout: "ignore", stderr: "pipe", env: process.env });
    expect(await parent.exited).toBe(0);
  });

  test("joins identical reads, refuses conflicts and fresh, then permits fresh after complete success", async () => {
    const f = fixture();
    const a = f.service.read(); const b = f.service.read();
    expect(b).toBe(a);
    expect(f.clock.timers.size).toBe(1);
    expect(await f.service.probe()).toEqual({ status: "unavailable" });
    expect(await f.service.read({ fresh: true })).toEqual({ status: "unavailable" });
    expect(f.children).toHaveLength(1);
    expect(f.calls[0]).toEqual({ args: ["find-generic-password", "-s", "Claude Code-credentials", "-w"], capture: true });
    const child = f.children[0]!; child.start(); child.stdout.write("synthetic"); child.exit(0);
    expect(await f.service.read({ fresh: true })).toEqual({ status: "unavailable" });
    child.closeOutput();
    expect(await a).toEqual({ status: "present", value: "synthetic" });
    expect(await b).toEqual({ status: "present", value: "synthetic" });
    const fresh = f.service.read({ fresh: true });
    expect(f.children).toHaveLength(2);
    f.children[1]!.start(); f.children[1]!.stdout.write("new"); f.children[1]!.exit(0); f.children[1]!.closeOutput();
    expect(await fresh).toEqual({ status: "present", value: "new" });
  });

  test.each([0, 44])("first deadline quarantines every join and discards late exit %i", async code => {
    const f = fixture(); const a = f.service.read(); f.clock.advance(1000); const b = f.service.read();
    const child = f.children[0]!; child.start(); f.clock.advance(4000);
    expect(await a).toEqual({ status: "unavailable" }); expect(await b).toEqual({ status: "unavailable" });
    expect(await f.service.read()).toEqual({ status: "unavailable" });
    child.stdout.write("late-secret"); child.exit(code); child.closeOutput();
    expect(child.signals).toBe(0);
    expect(await f.service.read({ fresh: true })).toEqual({ status: "unavailable" });
    f.clock.advance(59999); expect(await f.service.probe()).toEqual({ status: "unavailable" });
    f.clock.advance(1); const next = f.service.probe();
    expect(f.children).toHaveLength(2); f.children[1]!.start(); f.children[1]!.exit(44);
    expect(await next).toEqual({ status: "absent" });
  });

  test("metadata is output-free, uses no password flag, and repeated absence has no cooldown", async () => {
    const f = fixture();
    for (let i = 0; i < 2; i++) {
      const p = f.service.probe(); const c = f.children[i]!; c.start(); c.exit(44);
      expect(await p).toEqual({ status: "absent" });
    }
    expect(f.calls).toEqual([
      { args: ["find-generic-password", "-s", "Claude Code-credentials"], capture: false },
      { args: ["find-generic-password", "-s", "Claude Code-credentials"], capture: false },
    ]);
  });

  test("post-spawn error retains slot until termination and stdout close", async () => {
    const f = fixture(); const p = f.service.read(); const c = f.children[0]!; c.start(); c.emit("error", new Error("synthetic"));
    expect(await p).toEqual({ status: "unavailable" });
    f.clock.advance(60000); expect(await f.service.probe()).toEqual({ status: "unavailable" });
    c.exit(1); expect(await f.service.probe()).toEqual({ status: "unavailable" }); c.closeOutput();
    expect(await f.service.probe()).toEqual({ status: "unavailable" });
    f.clock.advance(60000); const retry = f.service.probe(); f.children[1]!.start(); f.children[1]!.exit(0);
    expect(await retry).toEqual({ status: "present" });
  });

  test("overflow drains and fails closed, then cooldown expires", async () => {
    const f = fixture("darwin", 3); const p = f.service.read(); const c = f.children[0]!; c.start();
    c.stdout.write("abcd"); c.stdout.write("more"); c.exit(0); c.closeOutput();
    expect(await p).toEqual({ status: "unavailable" }); expect(c.signals).toBe(0); expect(c.stdout.destroyed).toBe(false);
    expect(await f.service.read()).toEqual({ status: "unavailable" });
    f.clock.advance(60000); const next = f.service.read(); f.children[1]!.start(); f.children[1]!.exit(44); f.children[1]!.closeOutput();
    expect(await next).toEqual({ status: "absent" });
    const probe = f.service.probe(); f.children[2]!.start(); f.children[2]!.exit(44); expect(await probe).toEqual({ status: "absent" });
  });

  test("non-Darwin never spawns", async () => {
    const f = fixture("win32"); expect(await f.service.read()).toEqual({ status: "absent" });
    expect(await f.service.probe()).toEqual({ status: "absent" }); expect(f.children).toHaveLength(0);
  });

  test("metadata deadline is 1500ms, retains occupancy, and cools down even on late success", async () => {
    const f = fixture(); const p = f.service.probe(); const joined = f.service.probe(); const c = f.children[0]!; c.start();
    f.clock.advance(1499); expect(f.clock.timers.size).toBe(1);
    expect(await f.service.read()).toEqual({ status: "unavailable" });
    f.clock.advance(1); expect(await p).toEqual({ status: "unavailable" }); expect(await joined).toEqual({ status: "unavailable" });
    expect(await f.service.probe()).toEqual({ status: "unavailable" });
    c.exit(0); expect(await f.service.probe()).toEqual({ status: "unavailable" });
    f.clock.advance(60000); const next = f.service.probe(); f.children[1]!.start(); f.children[1]!.exit(0);
    expect(await next).toEqual({ status: "present" });
  });

  test("spawn failures release the empty slot but impose cooldown", async () => {
    const clock = new Clock(); let attempts = 0;
    const service = createClaudeKeychainService({ platform: "darwin", now: () => clock.now,
      setTimer: clock.set, clearTimer: clock.clear, spawn: () => { attempts++; throw new Error("synthetic"); } });
    expect(await service.read()).toEqual({ status: "unavailable" });
    expect(await service.probe()).toEqual({ status: "unavailable" }); expect(attempts).toBe(1);
    clock.advance(60000); expect(await service.probe()).toEqual({ status: "unavailable" }); expect(attempts).toBe(2);
  });

  test("asynchronous pre-spawn error releases the slot and failure cools down", async () => {
    const f = fixture(); const p = f.service.read(); const c = f.children[0]!;
    c.emit("error", new Error("synthetic")); expect(await p).toEqual({ status: "unavailable" });
    expect(await f.service.probe()).toEqual({ status: "unavailable" });
    f.clock.advance(60000); const next = f.service.probe(); f.children[1]!.start(); f.children[1]!.exit(44);
    expect(await next).toEqual({ status: "absent" });
  });

  test("stdout close before exit does not release the slot; failure never returns output", async () => {
    const f = fixture(); const p = f.service.read(); const c = f.children[0]!; c.start();
    c.stdout.write("synthetic-secret"); c.closeOutput();
    expect(await f.service.read({ fresh: true })).toEqual({ status: "unavailable" });
    c.exit(1); expect(await p).toEqual({ status: "unavailable" });
    expect(await f.service.probe()).toEqual({ status: "unavailable" });
  });

  test("premature stdout close cannot turn truncated output into a credential", async () => {
    const f = fixture(); const p = f.service.read(); const c = f.children[0]!; c.start();
    c.stdout.write("partial"); c.stdout.emit("close");
    expect(await p).toEqual({ status: "unavailable" });
    expect(await f.service.probe()).toEqual({ status: "unavailable" });
    c.exit(0); expect(await f.service.read()).toEqual({ status: "unavailable" });
  });
});
