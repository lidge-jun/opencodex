import { expect, spyOn, test } from "bun:test";
import { createSshRunner, SSH_MAX_OUTPUT_BYTES } from "../../src/link/ssh-runner";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options: { blockWrite?: boolean; blockEnd?: boolean; openOutput?: boolean; code?: number; output?: Uint8Array; stderr?: Uint8Array } = {}) {
  const exit = deferred<number>();
  const write = deferred<number>();
  const end = deferred<number>();
  const cancelled: string[] = [];
  const signals: unknown[] = [];
  const inputs: Array<string | Uint8Array> = [];
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  let ends = 0;
  const stream = (name: string) => new ReadableStream<Uint8Array>({
    start(controller) {
      controllers.push(controller);
      if (name === "stdout" && options.output) controller.enqueue(options.output);
      if (name === "stderr" && options.stderr) controller.enqueue(options.stderr);
      if (!options.openOutput) controller.close();
    },
    // Closing the reader must not await a descendant's unbounded cancellation.
    cancel() { cancelled.push(name); return new Promise<void>(() => {}); },
  });
  const stdout = stream("stdout"), stderr = stream("stderr");
  if (options.code !== undefined) exit.resolve(options.code);
  const child = {
    pid: 7, stdout, stderr, exited: exit.promise,
    stdin: {
      async write(value: string | Uint8Array) {
        inputs.push(value);
        return options.blockWrite ? write.promise : 1;
      },
      async end() { ends += 1; return options.blockEnd ? end.promise : 0; },
    },
    kill(signal: unknown) { signals.push(signal); },
  };
  const spawn = (() => child) as unknown as typeof Bun.spawn;
  return {
    runner: createSshRunner({ spawn, timeoutMs: 25 }), spawn, child, exit, write, end,
    stdout, stderr, cancelled, signals, inputs, ends: () => ends,
    release() {
      write.resolve(1); end.resolve(0); exit.resolve(0);
      for (const controller of controllers) { try { controller.close(); } catch { /* A cancelled or already-closed fixture stream needs no further cleanup. */ } }
    },
  };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("run did not settle within the test deadline")), 250);
    })]);
  } finally { clearTimeout(timer); }
}

for (const stage of ["write", "end", "exit", "inherited pipes"] as const) {
  test(`runner deadline covers ${stage === "write" ? "blocked stdin write" : stage === "end" ? "blocked stdin end" : stage}`, async () => {
    const f = fixture({ blockWrite: stage === "write", blockEnd: stage === "end", openOutput: true,
      code: stage === "inherited pipes" ? 0 : undefined });
    const pending = f.runner.run(["ssh"], { stdin: "command input" });
    try {
      await expect(bounded(pending)).rejects.toMatchObject({ code: "timeout" });
      expect(f.signals).toEqual(["SIGTERM"]);
      expect(f.cancelled.sort()).toEqual(["stderr", "stdout"]);
      expect(f.stdout.locked).toBe(false);
      expect(f.stderr.locked).toBe(false);
      if (stage === "write") expect(f.ends()).toBe(0);
    } finally { f.release(); await pending.catch(() => {}); }
  });
}

test("stdin, process exit and output drain share one deadline", async () => {
  const f = fixture({ blockWrite: true, openOutput: true });
  const schedule = spyOn(globalThis, "setTimeout");
  const pending = f.runner.run(["ssh"], { stdin: "input", timeoutMs: 100 });
  try {
    expect(schedule.mock.calls.filter(([, delay]) => delay === 100)).toHaveLength(1);
    await Bun.sleep(60);
    f.write.resolve(1);
    f.exit.resolve(0);
    await expect(bounded(pending)).rejects.toMatchObject({ code: "timeout" });
    expect(schedule.mock.calls.filter(([, delay]) => delay === 100)).toHaveLength(1);
    expect(f.cancelled.sort()).toEqual(["stderr", "stdout"]);
  } finally { f.release(); schedule.mockRestore(); await pending.catch(() => {}); }
});

for (const timeoutMs of [0, -1, NaN, Infinity, 0.5, 2_147_483_648]) {
  test(`runner rejects invalid timeout ${timeoutMs} before spawning`, async () => {
    let spawns = 0;
    const spawn = (() => { spawns += 1; throw new Error("must not spawn"); }) as unknown as typeof Bun.spawn;
    await expect(createSshRunner({ spawn }).run(["ssh"], { timeoutMs })).rejects.toMatchObject({ code: "timeout" });
    expect(spawns).toBe(0);
    await expect(createSshRunner({ spawn, timeoutMs }).run(["ssh"])).rejects.toMatchObject({ code: "timeout" });
    expect(spawns).toBe(0);
  });
}

test("normal stdin command and nonzero exit preserve output and clear the deadline", async () => {
  for (const code of [0, 255]) {
    const f = fixture({ code, output: new TextEncoder().encode("command output") });
    const input = new Uint8Array([0, 1, 255]);
    expect(await f.runner.run(["ssh"], { stdin: input })).toEqual({ code, stdout: "command output", stderr: "" });
    expect(f.inputs).toEqual([input]);
    expect(f.ends()).toBe(1);
    expect(f.signals).toEqual([]);
    expect(f.stdout.locked).toBe(false);
    expect(f.stderr.locked).toBe(false);
    await Bun.sleep(40);
    expect(f.signals).toEqual([]);
  }
});

test("output limit cancels the other pipe even while stdin and exit are pending", async () => {
  const f = fixture({ blockWrite: true, openOutput: true, output: new Uint8Array(3) });
  const pending = f.runner.run(["ssh"], { stdin: "input", maxOutputBytes: 2 });
  try {
    await expect(bounded(pending)).rejects.toMatchObject({ code: "output_limit" });
    expect(f.signals).toEqual(["SIGTERM"]);
    expect(f.cancelled.sort()).toEqual(["stderr", "stdout"]);
    expect(f.stdout.locked).toBe(false);
    expect(f.stderr.locked).toBe(false);
  } finally { f.release(); await pending.catch(() => {}); }
});

test("stdin failure terminates and releases open readers", async () => {
  const f = fixture({ blockWrite: true, openOutput: true });
  const pending = f.runner.run(["ssh"], { stdin: "input" });
  f.write.reject(new Error("broken pipe"));
  try {
    await expect(bounded(pending)).rejects.toMatchObject({ code: "spawn", message: "could not write ssh stdin" });
    expect(f.signals).toEqual(["SIGTERM"]);
    expect(f.cancelled.sort()).toEqual(["stderr", "stdout"]);
    expect(f.stdout.locked).toBe(false);
    expect(f.stderr.locked).toBe(false);
  } finally { f.release(); await pending.catch(() => {}); }
});

for (const stage of ["write", "end"] as const) {
  test(`late stdin ${stage} and exit rejections after timeout are observed`, async () => {
    const f = fixture({ blockWrite: stage === "write", blockEnd: stage === "end", openOutput: true });
    const unhandled: unknown[] = [];
    const listener = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", listener);
    try {
      await expect(bounded(f.runner.run(["ssh"], { stdin: "input" }))).rejects.toMatchObject({ code: "timeout" });
      f[stage].reject(new Error("late stdin error"));
      f.exit.reject(new Error("late exit error"));
      await Bun.sleep(0);
      expect(unhandled).toEqual([]);
    } finally { f.release(); process.off("unhandledRejection", listener); }
  });
}

test("a late successful stdin write never starts end after timeout", async () => {
  const f = fixture({ blockWrite: true, openOutput: true });
  try {
    await expect(bounded(f.runner.run(["ssh"], { stdin: "input" }))).rejects.toMatchObject({ code: "timeout" });
    f.write.resolve(1);
    await Bun.sleep(0);
    expect(f.ends()).toBe(0);
  } finally { f.release(); }
});

test("a local kill failure does not hide timeout or stall reader cleanup", async () => {
  const f = fixture({ openOutput: true });
  f.child.kill = () => { throw new Error("already exited"); };
  try {
    await expect(bounded(f.runner.run(["ssh"]))).rejects.toMatchObject({ code: "timeout" });
    expect(f.cancelled.sort()).toEqual(["stderr", "stdout"]);
    expect(f.stdout.locked).toBe(false);
    expect(f.stderr.locked).toBe(false);
  } finally { f.release(); }
});

test("real Bun subprocess receives stdin and returns its complete output", async () => {
  const result = await createSshRunner().run([process.execPath, "-e", "process.stdout.write(await Bun.stdin.text());"], {
    stdin: "normal stdin command\n", timeoutMs: 2_000,
  });
  expect(result).toEqual({ code: 0, stdout: "normal stdin command\n", stderr: "" });
});

test("reader abort listeners and deadline timers are removed on success and failure", async () => {
  const add = spyOn(AbortSignal.prototype, "addEventListener");
  const remove = spyOn(AbortSignal.prototype, "removeEventListener");
  const clear = spyOn(globalThis, "clearTimeout");
  const schedule = spyOn(globalThis, "setTimeout");
  const f = fixture({ openOutput: true });
  try {
    await fixture({ code: 0 }).runner.run(["ssh"]);
    await expect(f.runner.run(["ssh"])).rejects.toMatchObject({ code: "timeout" });
    const added = add.mock.calls.filter(([event]) => event === "abort");
    const removed = remove.mock.calls.filter(([event]) => event === "abort");
    expect(added).toHaveLength(4);
    expect(removed).toHaveLength(4);
    expect(removed.map(([, listener]) => listener)).toEqual(added.map(([, listener]) => listener));
    expect(schedule.mock.calls).toHaveLength(2);
    expect(clear.mock.calls.map(([timer]) => timer)).toEqual(schedule.mock.results.map(result => result.value));
  } finally { f.release(); add.mockRestore(); remove.mockRestore(); clear.mockRestore(); schedule.mockRestore(); }
});

test("default stdout cap remains 64 KiB, including when output pipes remain open", async () => {
  const f = fixture({ code: 0, openOutput: true, output: new Uint8Array(64 * 1024 + 1) });
  const pending = f.runner.run(["ssh"]);
  try {
    await expect(bounded(pending)).rejects.toMatchObject({ code: "output_limit" });
    expect(f.cancelled.sort()).toEqual(["stderr", "stdout"]);
  } finally { f.release(); await pending.catch(() => {}); }
});

test("explicit stdout allowance returns a complete catalog larger than 64 KiB", async () => {
  const catalog = JSON.stringify({ data: [{ id: "catalog-model", description: "a".repeat(100_000) }] });
  const f = fixture({ code: 0, output: new TextEncoder().encode(catalog) });
  const result = await f.runner.run(["ssh"], { maxOutputBytes: 4 * 1024 * 1024 });
  expect(result.stdout).toBe(catalog);
  expect(JSON.parse(result.stdout)).toEqual({ data: [{ id: "catalog-model", description: "a".repeat(100_000) }] });
  expect(f.inputs).toEqual([]);
  expect(f.signals).toEqual([]);
});

test("explicit stdout cap admits 4 MiB and rejects even one extra byte", async () => {
  expect(SSH_MAX_OUTPUT_BYTES).toBe(4 * 1024 * 1024);
  const cap = 4 * 1024 * 1024;
  const exact = fixture({ code: 0, output: new Uint8Array(cap).fill(97) });
  expect((await exact.runner.run(["ssh"], { maxOutputBytes: cap })).stdout.length).toBe(cap);
  const excess = fixture({ code: 0, output: new Uint8Array(cap + 1), openOutput: true });
  const pending = excess.runner.run(["ssh"], { maxOutputBytes: cap });
  try {
    await expect(bounded(pending)).rejects.toMatchObject({ code: "output_limit" });
    expect(excess.signals).toEqual(["SIGTERM"]);
    expect(excess.cancelled.sort()).toEqual(["stderr", "stdout"]);
  } finally { excess.release(); await pending.catch(() => {}); }
});

test("larger stdout allowance retains the 64 KiB stderr cap", async () => {
  const f = fixture({ code: 0, stderr: new Uint8Array(64 * 1024 + 1), openOutput: true });
  const pending = f.runner.run(["ssh"], { maxOutputBytes: 4 * 1024 * 1024 });
  try {
    await expect(bounded(pending)).rejects.toMatchObject({ code: "output_limit" });
    expect(f.cancelled.sort()).toEqual(["stderr", "stdout"]);
  } finally { f.release(); await pending.catch(() => {}); }
});

for (const maxOutputBytes of [-1, 4 * 1024 * 1024 + 1, NaN, Infinity, 0.5]) {
  test(`runner rejects invalid stdout allowance ${maxOutputBytes} before spawning`, async () => {
    let spawns = 0;
    const spawn = (() => { spawns += 1; throw new Error("must not spawn"); }) as unknown as typeof Bun.spawn;
    await expect(createSshRunner({ spawn }).run(["ssh"], { maxOutputBytes })).rejects.toMatchObject({ code: "output_limit" });
    expect(spawns).toBe(0);
  });
}
