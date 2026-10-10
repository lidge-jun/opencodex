import { expect, test } from "bun:test";
import { MessageBudget } from "../../src/messaging/budget";
import { RemoteCapacity, REMOTE_LIMITS } from "../../src/messaging/remote-contract";
import { remotePortIsLoopback } from "../../src/messaging/remote-ports";
import { runRemoteHelper, spawnRemoteHelper, type RemoteHelperOptions, type RemoteHelperProcess } from "../../src/messaging/remote-process";

function fakeProcess(options: { exitCode?: number; output?: string; inputFailure?: boolean; asyncInputFailure?: boolean; exitOnSignal?: boolean } = {}) {
  let finish!: (code: number) => void, exitCode = options.exitCode ?? null;
  const signals: NodeJS.Signals[] = [];
  const exited = new Promise<number>(resolve => { finish = resolve; });
  const stream = (text = "") => new ReadableStream<Uint8Array>({ start(controller) {
    if (text) controller.enqueue(new TextEncoder().encode(text));
    if (exitCode !== null) controller.close();
  } });
  const child: RemoteHelperProcess = { pid: 12345, get exitCode() { return exitCode; }, exited,
    stdout: stream(options.output), stderr: stream(), stdin: {
      write() { if (options.inputFailure) throw new Error("private fixture input diagnostic"); return 0; },
      end() { return options.asyncInputFailure ? Promise.reject(new Error("private fixture input diagnostic")) : 0; },
    } };
  const exit = (code: number) => { exitCode = code; finish(code); };
  if (exitCode !== null) finish(exitCode);
  const deps: RemoteHelperOptions = { spawn: () => child, signalGroup(_pid, signal) {
    signals.push(signal); if (options.exitOnSignal) exit(0);
  } };
  return { child, deps, signals, exit };
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
    expect(capacity.snapshot().helpers).toBe(0);
  }, 10000);
}

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
