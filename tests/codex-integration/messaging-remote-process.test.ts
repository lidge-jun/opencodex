import { expect, test } from "bun:test";
import { MessageBudget } from "../../src/messaging/budget";
import { RemoteCapacity, REMOTE_LIMITS } from "../../src/messaging/remote-contract";
import { remotePortIsLoopback } from "../../src/messaging/remote-ports";
import { runRemoteHelper, spawnRemoteHelper, type RemoteHelperOptions, type RemoteHelperProcess } from "../../src/messaging/remote-process";

test("Linux inspection allows absent IPv6 tables but refuses failed or public listener inspection", async () => {
  const budget = new MessageBudget(), capacity = new RemoteCapacity();
  const table = (address: string) => `header\n 0: ${address}:5BA0 00000000:0000 0A\n`;
  const inspect = async (options: { ipv6?: string; openError?: string; failedPath?: string; readError?: string; ipv4?: string }) => {
    const opened: string[] = [], closed: string[] = [];
    const result = remotePortIsLoopback(23456, budget, capacity, { platform: "linux", async openProc(path) {
      opened.push(path);
      if (options.openError && path === (options.failedPath ?? "/proc/net/tcp6")) throw Object.assign(new Error("fixture open"), { code: options.openError });
      const bytes = Buffer.from(path.endsWith("tcp6") ? options.ipv6 ?? "header\n" : options.ipv4 ?? table("0100007F"));
      let offset = 0;
      return { async read(buffer, start, length) {
        if (options.readError && path.endsWith("tcp6")) throw Object.assign(new Error("fixture read"), { code: options.readError });
        const bytesRead = bytes.copy(buffer, start, offset, offset + length); offset += bytesRead; return { bytesRead };
      }, async close() { closed.push(path); } };
    } });
    return { result: await result.catch(error => error), opened, closed };
  };
  try {
    const absent = await inspect({ openError: "ENOENT" });
    expect(absent.result).toBe(true); expect(absent.opened).toEqual(["/proc/net/tcp", "/proc/net/tcp6"]);
    expect(absent.closed).toEqual(["/proc/net/tcp"]);
    for (const code of ["EACCES", "EPERM", "EIO"]) expect((await inspect({ openError: code })).result.code).toBe(code);
    expect((await inspect({ openError: "ENOENT", failedPath: "/proc/net/tcp" })).result.code).toBe("ENOENT");
    const readFailure = await inspect({ readError: "ENOENT" });
    expect(readFailure.result.code).toBe("ENOENT"); expect(readFailure.closed).toEqual(["/proc/net/tcp", "/proc/net/tcp6"]);
    expect((await inspect({ ipv6: table("00000000000000000000000001000000") })).result).toBe(true);
    expect((await inspect({ ipv6: table("00000000000000000000000000000000") })).result).toBe(false);
    expect((await inspect({ ipv4: table("00000000"), openError: "ENOENT" })).result).toBe(false);
    expect((await inspect({ ipv4: "header\n", openError: "ENOENT" })).result).toBe(false);
  } finally { budget.dispose(); }
});

function fakeProcess(options: { exitCode?: number; output?: string; inputFailure?: boolean; asyncInputFailure?: boolean; exitOnSignal?: boolean; holdPipes?: boolean } = {}) {
  let finish!: (code: number) => void, exitCode = options.exitCode ?? null;
  const signals: NodeJS.Signals[] = [];
  const exited = new Promise<number>(resolve => { finish = resolve; });
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const stream = (text = "") => new ReadableStream<Uint8Array>({ start(controller) {
    controllers.push(controller);
    if (text) controller.enqueue(new TextEncoder().encode(text));
    if (exitCode !== null) controller.close();
  } });
  const child: RemoteHelperProcess = { pid: 12345, get exitCode() { return exitCode; }, exited,
    stdout: stream(options.output), stderr: stream(), stdin: {
      write() { if (options.inputFailure) throw new Error("private fixture input diagnostic"); return 0; },
      end() { return options.asyncInputFailure ? Promise.reject(new Error("private fixture input diagnostic")) : 0; },
    } };
  const endPipes = () => { for (const controller of controllers) { try { controller.close(); } catch { /* Already cancelled. */ } } };
  const exit = (code: number) => { exitCode = code; if (!options.holdPipes) endPipes(); finish(code); };
  if (exitCode !== null) finish(exitCode);
  const deps: RemoteHelperOptions = { spawn: () => child, signalGroup(_pid, signal) {
    signals.push(signal); if (options.exitOnSignal) exit(0);
  } };
  return { child, deps, signals, exit, endPipes };
}

for (const inputFailure of [false, true]) {
  test(`a non-exiting helper settles bounded cleanup after ${inputFailure ? "input failure" : "cancellation"}`, async () => {
    const fixture = fakeProcess({ inputFailure, output: "private fixture output" }), capacity = new RemoteCapacity();
    const controller = new AbortController(), budget = new MessageBudget(10000, controller.signal);
    let physicallyExited = false, timer: ReturnType<typeof setTimeout> | undefined;
    void fixture.child.exited.then(() => { physicallyExited = true; });
    const started = performance.now();
    const operation = runRemoteHelper(["fixture"], budget, capacity, "synthetic input", {}, fixture.deps);
    if (!inputFailure) controller.abort();
    try {
      const error = await Promise.race([operation.catch(error => error), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("logical helper remained pending after cleanup ceiling")), REMOTE_LIMITS.shutdownMs + 1500);
      })]);
      expect(error.code).toBe("cleanup_incomplete"); expect(error.message).not.toContain("private");
      expect(performance.now() - started).toBeLessThan(REMOTE_LIMITS.shutdownMs + 1000);
      expect(fixture.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(physicallyExited).toBe(false);
      expect(capacity.snapshot()).toEqual({ connections: 0, requests: 0, helpers: 1, outputBytes: 0 });
    } finally { clearTimeout(timer); fixture.exit(0); budget.dispose(); await fixture.child.exited; }
    // Forced cancellation of pipes cannot later prove natural EOF, even after leader exit.
    expect(capacity.snapshot().helpers).toBe(1);
  }, 10000);
}

for (const exitOnSignal of [false, true]) test(`leader exit joins natural descendant pipe EOF without historical group signals (TERM=${exitOnSignal})`, async () => {
  const fixture = fakeProcess({ holdPipes: true, exitOnSignal }), capacity = new RemoteCapacity();
  const helper = spawnRemoteHelper(["fixture"], capacity, undefined, undefined, {}, fixture.deps);
  if (!exitOnSignal) { fixture.exit(0); await fixture.child.exited; }
  let settled = false;
  const closing = helper.close().then(() => { settled = true; });
  await Bun.sleep(550);
  expect(settled).toBe(false); expect(fixture.signals).toEqual(exitOnSignal ? ["SIGTERM"] : []);
  expect(capacity.snapshot().helpers).toBe(1);
  fixture.endPipes(); await closing;
  expect(capacity.snapshot().helpers).toBe(0); expect(fixture.signals).toEqual(exitOnSignal ? ["SIGTERM"] : []);
});

test("leader exit with held pipes reports bounded incomplete cleanup and keeps capacity after cancellation", async () => {
  const fixture = fakeProcess({ holdPipes: true }), capacity = new RemoteCapacity();
  const helper = spawnRemoteHelper(["fixture"], capacity, undefined, undefined, {}, fixture.deps);
  fixture.exit(0); await fixture.child.exited;
  const started = performance.now();
  await expect(helper.close()).rejects.toThrow("cleanup budget");
  expect(performance.now() - started).toBeLessThan(REMOTE_LIMITS.shutdownMs + 1000);
  expect(fixture.signals).toEqual([]); expect(capacity.snapshot().helpers).toBe(1);
  fixture.endPipes(); await Bun.sleep(0);
  expect(capacity.snapshot().helpers).toBe(1);
}, 6000);

for (const asyncInputFailure of [false, true]) test(`a failed ${asyncInputFailure ? "async stdin end" : "stdin write"} retains ownership through successful cleanup`, async () => {
  const fixture = fakeProcess({ inputFailure: !asyncInputFailure, asyncInputFailure, exitOnSignal: true }), capacity = new RemoteCapacity(), budget = new MessageBudget();
  try {
    const error = await runRemoteHelper(["fixture"], budget, capacity, "synthetic input", {}, fixture.deps).catch(error => error);
    expect(error.code).toBe("ssh_incomplete"); expect(error.message).not.toContain("private");
    expect(fixture.signals).toEqual(["SIGTERM"]);
    expect(capacity.snapshot()).toEqual({ connections: 0, requests: 0, helpers: 0, outputBytes: 0 });
  } finally { budget.dispose(); }
});

test("persistent tunnels and transient helpers have independent bounded slots and one total", () => {
  const capacity = new RemoteCapacity(), persistent: (() => void)[] = [], transient: (() => void)[] = [];
  try {
    for (let peer = 0; peer < REMOTE_LIMITS.peers; peer++) for (let direction = 0; direction < 2; direction++) persistent.push(capacity.reserveHelper("persistent"));
    expect(() => capacity.reserveHelper("persistent")).toThrow("aggregate");
    for (let i = 0; i < REMOTE_LIMITS.transientHelpers; i++) transient.push(capacity.reserveHelper("transient"));
    expect(capacity.snapshot().helpers).toBe(REMOTE_LIMITS.helpers);
    expect(() => capacity.reserveHelper("transient")).toThrow("aggregate");
    expect(() => capacity.reserve("helpers")).toThrow("aggregate");
  } finally { for (const free of [...persistent, ...transient]) { free(); free(); } }
  expect(capacity.snapshot().helpers).toBe(0);
});

test("Darwin inspection can spawn with four tunnel pairs and polls through an absent listener", async () => {
  const capacity = new RemoteCapacity(), budget = new MessageBudget(), tunnels = [];
  for (let i = 0; i < REMOTE_LIMITS.persistentHelpers; i++) {
    const fixture = fakeProcess({ exitOnSignal: true });
    tunnels.push(spawnRemoteHelper(["fixture tunnel"], capacity, undefined, undefined, {}, fixture.deps));
  }
  try {
    expect(capacity.snapshot().helpers).toBe(8);
    for (const [exitCode, output, ready] of [[1, "", false], [0, "n127.0.0.1:23456\n", true],
      [0, "n*:23456\n", false], [0, "n[::1]:23456\n", true]] as const) {
      const fixture = fakeProcess({ exitCode, output }); let spawned = false;
      const helper = { ...fixture.deps, spawn(argv: readonly string[], env: NodeJS.ProcessEnv | undefined) {
        expect(argv).toEqual(["/usr/sbin/lsof", "-nP", "-iTCP:23456", "-sTCP:LISTEN", "-Fn"]);
        expect(capacity.snapshot().helpers).toBe(9); spawned = true;
        return fixture.deps.spawn!(argv, env);
      } };
      expect(await remotePortIsLoopback(23456, budget, capacity, { platform: "darwin", helper })).toBe(ready);
      expect(spawned).toBe(true); expect(capacity.snapshot().helpers).toBe(8);
    }
    const broken = fakeProcess({ exitCode: 2 });
    await expect(remotePortIsLoopback(23456, budget, capacity, { platform: "darwin", helper: broken.deps })).rejects.toThrow("successfully");
  } finally { budget.dispose(); await Promise.all(tunnels.map(tunnel => tunnel.close())); }
  expect(capacity.snapshot()).toEqual({ connections: 0, requests: 0, helpers: 0, outputBytes: 0 });
});
