import { expect, test } from "bun:test";
import { createSshRunner, SshRunnerError } from "../../src/link/ssh-runner";

/** A clock the test advances by hand; nothing here waits on real time. */
function manualClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    setTimeout: ((callback: () => void, ms: number) => { const id = nextId++; timers.set(id, { at: now + ms, callback }); return id; }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        await flush();
      }
      now = target;
      await flush();
    },
    pending: () => timers.size,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** A spawned ssh that exits only when told to, or never. */
function fakeProcess(options: { exitOnTerm?: boolean; exitOnKill?: boolean } = {}) {
  const signals: string[] = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>(resolve => { resolveExit = resolve; });
  let closeOut!: () => void;
  let closeErr!: () => void;
  const stream = (setClose: (close: () => void) => void) => new ReadableStream<Uint8Array>({
    start(controller) { setClose(() => { try { controller.close(); } catch { /* already closed or cancelled */ } }); },
  });
  const stdout = stream(close => { closeOut = close; });
  const stderr = stream(close => { closeErr = close; });
  const exit = (code: number) => { closeOut(); closeErr(); resolveExit(code); };
  const process = {
    pid: 4242, stdin: undefined, stdout, stderr, exited,
    kill(signal?: string) {
      signals.push(signal ?? "SIGTERM");
      if ((signal ?? "SIGTERM") === "SIGTERM" && options.exitOnTerm) exit(143);
      if (signal === "SIGKILL" && options.exitOnKill) exit(137);
    },
  };
  return { process, signals, exit };
}

function runnerWith(process: unknown, clock: ReturnType<typeof manualClock>) {
  let spawned = 0;
  const runner = createSshRunner({
    spawn: (() => { spawned += 1; return process; }) as unknown as typeof Bun.spawn,
    env: () => undefined,
    clock,
  });
  return { runner, spawned: () => spawned };
}

async function settled<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown } | undefined> {
  let result: { value?: T; error?: unknown } | undefined;
  promise.then(value => { result = { value }; }, error => { result = { error }; });
  await flush();
  return result;
}

test("an already aborted signal rejects without spawning ssh", async () => {
  const clock = manualClock();
  const fake = fakeProcess();
  const { runner, spawned } = runnerWith(fake.process, clock);
  const controller = new AbortController();
  controller.abort();
  const error = await runner.run(["ssh"], { timeoutMs: 10_000, signal: controller.signal }).catch(value => value);
  expect(error).toBeInstanceOf(SshRunnerError);
  expect((error as SshRunnerError).code).toBe("aborted");
  expect(spawned()).toBe(0);
});

test("an abort terminates ssh and settles once its exit is observed", async () => {
  const clock = manualClock();
  const fake = fakeProcess({ exitOnTerm: true });
  const { runner } = runnerWith(fake.process, clock);
  const controller = new AbortController();
  const run = runner.run(["ssh"], { timeoutMs: 10_000, signal: controller.signal });
  await flush();
  controller.abort();
  const result = await settled(run);
  expect(result?.error).toBeInstanceOf(SshRunnerError);
  expect((result!.error as SshRunnerError).code).toBe("aborted");
  expect((result!.error as SshRunnerError).exitConfirmed).toBe(true);
  expect(fake.signals).toEqual(["SIGTERM"]);
  expect(clock.pending()).toBe(0);
});

test("a timeout uses the same termination: TERM, KILL after the grace, then settles", async () => {
  const clock = manualClock();
  const fake = fakeProcess({ exitOnKill: true });
  const { runner } = runnerWith(fake.process, clock);
  const run = runner.run(["ssh"], { timeoutMs: 10_000, signal: new AbortController().signal });
  await clock.advance(9_999);
  expect(await settled(run)).toBeUndefined();
  await clock.advance(1);
  expect(fake.signals).toEqual(["SIGTERM"]);
  expect(await settled(run)).toBeUndefined();
  await clock.advance(2_000);
  expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
  const result = await settled(run);
  expect((result!.error as SshRunnerError).code).toBe("timeout");
  expect((result!.error as SshRunnerError).exitConfirmed).toBe(true);
  expect(clock.pending()).toBe(0);
});

test.each(["timeout first", "abort first"] as const)("%s: a second trigger starts no second termination", async order => {
  const clock = manualClock();
  const fake = fakeProcess();
  const { runner } = runnerWith(fake.process, clock);
  const controller = new AbortController();
  const run = runner.run(["ssh"], { timeoutMs: 10_000, signal: controller.signal });
  await flush();
  if (order === "timeout first") { await clock.advance(10_000); controller.abort(); }
  else { controller.abort(); await clock.advance(10_000); }
  await flush();
  expect(fake.signals.filter(signal => signal === "SIGTERM")).toHaveLength(1);
  await clock.advance(4_000);
  const result = await settled(run);
  expect((result!.error as SshRunnerError).code).toBe(order === "timeout first" ? "timeout" : "aborted");
  expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test("an exit that never arrives settles within the bound and says so", async () => {
  const clock = manualClock();
  const fake = fakeProcess();
  const { runner } = runnerWith(fake.process, clock);
  const controller = new AbortController();
  const run = runner.run(["ssh"], { timeoutMs: 10_000, signal: controller.signal });
  await flush();
  controller.abort();
  await clock.advance(3_999);
  expect(await settled(run)).toBeUndefined();
  await clock.advance(1);
  const result = await settled(run);
  expect((result!.error as SshRunnerError).code).toBe("aborted");
  expect((result!.error as SshRunnerError).exitConfirmed).toBe(false);
  expect(clock.pending()).toBe(0);
});

test("a successful exit after the abort does not turn into a result", async () => {
  const clock = manualClock();
  const fake = fakeProcess();
  const { runner } = runnerWith(fake.process, clock);
  const controller = new AbortController();
  const run = runner.run(["ssh"], { timeoutMs: 10_000, signal: controller.signal });
  await flush();
  controller.abort();
  fake.exit(0);
  const result = await settled(run);
  expect((result!.error as SshRunnerError).code).toBe("aborted");
});
