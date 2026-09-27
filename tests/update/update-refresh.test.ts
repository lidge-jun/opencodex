import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRefreshScheduler, RETRY_BASE_MS, STALENESS_TICK_MS, type RefreshDeps } from "../../src/update/refresh-scheduler";
import { latestVersionAsync, pnpmOwner, REGISTRY_DEADLINE_MS, REGISTRY_OUTPUT_LIMIT } from "../../src/update/async-check";
import type { VersionCache } from "../../src/update/notify";
import type { Channel, Installer } from "../../src/update/index";

function fixture(installer: Installer = "npm", disabled = false, lookupFn?: RefreshDeps["lookup"]) {
  let now = 1_700_000_000_000;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const cache = new Map<Channel, VersionCache>();
  const calls: Channel[] = [];
  const replies: Array<Promise<string | null>> = [];
  const writes: VersionCache[] = [];
  const deps: RefreshDeps = {
    now: () => now,
    current: () => "2.7.43",
    install: () => installer,
    ownership: () => ({ installer, owner: null }) as ReturnType<RefreshDeps["ownership"]>,
    guidance: () => null,
    disabled: () => disabled,
    read: tag => cache.get(tag) ?? null,
    write: (tag, latest, at) => {
      const previous = cache.get(tag);
      const value: VersionCache = {
        tag, latest_version: latest, last_checked_at: new Date(at).toISOString(),
        dismissed_version: previous?.latest_version === latest && previous.dismissed_version === latest
          ? latest : undefined,
      };
      cache.set(tag, value);
      writes.push(value);
    },
    lookup: async (tag, activeInstaller) => {
      calls.push(tag);
      return lookupFn ? lookupFn(tag, activeInstaller) : replies.length ? await replies.shift()! : "2.7.44";
    },
    setTimer: ((run: () => void, delay: number) => {
      const id = ++nextId;
      timers.set(id, { at: now + delay, run });
      return { id, unref() {} } as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimer: ((timer: ReturnType<typeof setTimeout>) => {
      timers.delete((timer as unknown as { id: number }).id);
    }) as typeof clearTimeout,
  };
  async function advance(ms: number) {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) { timers.delete(id); timer.run(); }
    }
    for (let index = 0; index < 8; index++) await Promise.resolve();
  }
  // Bounded condition wait for chains longer than advance()'s eight fixed turns (the real async
  // lookup's fake child settles over ~16 microtask turns). Fails loudly instead of hanging.
  async function settle(done: () => boolean, turns = 64) {
    for (let index = 0; index < turns && !done(); index++) await Promise.resolve();
    if (!done()) throw new Error(`condition not reached within ${turns} microtask turns`);
  }
  return { scheduler: createRefreshScheduler(deps), calls, replies, writes, cache, timers, advance, settle, now: () => now };
}

describe("package cache refresh", () => {
  test("missing cache refreshes immediately and writes through", async () => {
    const f = fixture();
    f.scheduler.start();
    await f.advance(0);
    expect(f.calls).toEqual(["latest"]);
    expect(f.cache.get("latest")?.latest_version).toBe("2.7.44");
    f.scheduler.stop();
  });

  test("fresh cache is checked hourly and refreshed at 20 hours", async () => {
    const f = fixture();
    f.cache.set("latest", { tag: "latest", latest_version: "2.7.43", last_checked_at: new Date(f.now()).toISOString() });
    f.scheduler.start();
    await f.advance(0);
    for (let hour = 0; hour < 19; hour++) await f.advance(STALENESS_TICK_MS);
    expect(f.calls).toHaveLength(0);
    await f.advance(STALENESS_TICK_MS);
    expect(f.calls).toEqual(["latest"]);
    f.scheduler.stop();
  });

  test("explicit checks coalesce per channel", async () => {
    const f = fixture();
    let release!: (value: string | null) => void;
    f.replies.push(new Promise(resolve => { release = resolve; }));
    const a = f.scheduler.check("latest");
    const b = f.scheduler.check("latest");
    await Promise.resolve();
    expect(f.calls).toEqual(["latest"]);
    release("2.7.44");
    expect((await a).latestVersion).toBe("2.7.44");
    expect((await b).latestVersion).toBe("2.7.44");
    expect(f.writes).toHaveLength(1);
  });

  test("background and explicit checks join the same channel flight", async () => {
    const f = fixture();
    let release!: (value: string | null) => void;
    f.replies.push(new Promise(resolve => { release = resolve; }));
    f.scheduler.start();
    await f.advance(0);
    const explicit = f.scheduler.check("latest");
    expect(f.calls).toEqual(["latest"]);
    release("2.7.44");
    expect((await explicit).latestVersion).toBe("2.7.44");
    expect(f.writes).toHaveLength(1);
    f.scheduler.stop();
  });

  test("an older explicit flight cannot overwrite a newer generation's write", async () => {
    const f = fixture();
    let releaseOld!: (value: string | null) => void;
    f.replies.push(new Promise(resolve => { releaseOld = resolve; }), Promise.resolve("2.7.45"));
    f.scheduler.start();
    await f.advance(0);
    f.scheduler.stop();
    const explicit = f.scheduler.check("latest"); // joins the old flight and keeps it writable
    f.scheduler.start();
    await f.advance(0);
    await f.settle(() => f.writes.length === 1);
    expect(f.cache.get("latest")?.latest_version).toBe("2.7.45");
    releaseOld("2.7.44");
    expect((await explicit).latestVersion).toBe("2.7.44"); // the caller still gets its own answer
    await f.advance(0);
    expect(f.writes).toHaveLength(1);
    expect(f.cache.get("latest")?.latest_version).toBe("2.7.45");
    f.scheduler.stop();
  });

  test("explicit interest writes a joined automatic result after stop", async () => {
    const f = fixture();
    let release!: (value: string | null) => void;
    f.replies.push(new Promise(resolve => { release = resolve; }));
    f.scheduler.start();
    await f.advance(0);
    const explicit = f.scheduler.check("latest");
    expect(f.calls).toEqual(["latest"]);
    f.scheduler.stop();
    release("2.7.44");
    expect((await explicit).latestVersion).toBe("2.7.44");
    expect(f.cache.get("latest")?.latest_version).toBe("2.7.44");
    expect(f.writes).toHaveLength(1);
    expect(f.timers.size).toBe(0);
  });

  test("one listener stopping leaves the other listener's refresh active", async () => {
    const f = fixture();
    f.scheduler.start();
    f.scheduler.start();
    f.scheduler.stop();
    await f.advance(0);
    expect(f.calls).toEqual(["latest"]);
    expect(f.cache.get("latest")?.latest_version).toBe("2.7.44");
    expect(f.timers.size).toBe(1);
    f.scheduler.stop();
    expect(f.timers.size).toBe(0);
  });

  test("different channels have separate flights", async () => {
    const f = fixture();
    await Promise.all([f.scheduler.check("latest"), f.scheduler.check("preview")]);
    expect(f.calls).toEqual(["latest", "preview"]);
    expect(f.writes.map(value => value.tag)).toEqual(["latest", "preview"]);
  });

  test("failed lookup does not stamp and retries with exponential delay", async () => {
    const f = fixture();
    f.replies.push(Promise.resolve(null), Promise.resolve(null), Promise.resolve("2.7.44"));
    f.scheduler.start();
    await f.advance(0);
    expect(f.cache.size).toBe(0);
    await f.advance(RETRY_BASE_MS);
    expect(f.calls).toHaveLength(2);
    await f.advance(RETRY_BASE_MS * 2);
    expect(f.calls).toHaveLength(3);
    expect(f.cache.get("latest")?.latest_version).toBe("2.7.44");
    f.scheduler.stop();
  });

  test("repeated failure caps retry at one hour", async () => {
    const f = fixture();
    for (let n = 0; n < 9; n++) f.replies.push(Promise.resolve(null));
    f.scheduler.start();
    await f.advance(0);
    for (const minutes of [1, 2, 4, 8, 16, 32, 60]) await f.advance(minutes * 60_000);
    expect(f.calls).toHaveLength(8);
    await f.advance(59 * 60_000);
    expect(f.calls).toHaveLength(8);
    await f.advance(60_000);
    expect(f.calls).toHaveLength(9);
    f.scheduler.stop();
  });

  test("invalid and wrong-channel caches refresh immediately", async () => {
    const invalid = fixture();
    invalid.cache.set("latest", { tag: "latest", latest_version: "2.7.44", last_checked_at: "bad" });
    invalid.scheduler.start();
    await invalid.advance(0);
    expect(invalid.calls).toEqual(["latest"]);
    invalid.scheduler.stop();
    const mismatch = fixture();
    mismatch.cache.set("preview", { tag: "preview", latest_version: "2.8.0-preview.1", last_checked_at: new Date(mismatch.now()).toISOString() });
    mismatch.scheduler.start();
    await mismatch.advance(0);
    expect(mismatch.calls).toEqual(["latest"]);
    mismatch.scheduler.stop();
  });

  test("stop cancels timer and suppresses a late automatic write", async () => {
    const f = fixture();
    let release!: (value: string | null) => void;
    f.replies.push(new Promise(resolve => { release = resolve; }));
    f.scheduler.start();
    await f.advance(0);
    f.scheduler.stop();
    release("2.7.44");
    await f.advance(STALENESS_TICK_MS);
    expect(f.writes).toHaveLength(0);
    expect(f.timers.size).toBe(0);
  });

  test("restart does not join the stopped listener's pending lookup", async () => {
    const f = fixture();
    let release!: (value: string | null) => void;
    f.replies.push(new Promise(resolve => { release = resolve; }));
    f.scheduler.start();
    await f.advance(0);
    expect(f.calls).toEqual(["latest"]);
    f.scheduler.stop();
    f.scheduler.start();
    await f.advance(0);
    await f.settle(() => f.writes.length === 1);
    // The new generation ran its own lookup and wrote, instead of waiting an hour behind the old flight.
    expect(f.calls).toEqual(["latest", "latest"]);
    expect(f.cache.get("latest")?.latest_version).toBe("2.7.44");
    release("2.7.44");
    await f.advance(0);
    expect(f.writes).toHaveLength(1);
    f.scheduler.stop();
  });

  test.each(["source", "mise"] as Installer[])("%s never starts automatic lookup", async installer => {
    const f = fixture(installer);
    f.scheduler.start();
    await f.advance(0);
    expect(f.calls).toHaveLength(0);
    expect(f.timers.size).toBe(0);
  });

  test("opt-out stops only automatic checks", async () => {
    const f = fixture("npm", true);
    f.scheduler.start();
    await f.advance(0);
    expect(f.calls).toHaveLength(0);
    expect((await f.scheduler.check("latest")).latestVersion).toBe("2.7.44");
  });
});

test("an absent pnpm owner cannot reach the registry child", async () => {
  let spawned = false;
  expect(await latestVersionAsync("latest", "pnpm", {
    ownerFn: async () => null,
    spawnFn: (() => { spawned = true; throw new Error("unexpected child"); }) as never,
  })).toBeNull();
  expect(spawned).toBe(false);
});

test("pnpm owner resolution failure is unavailable, not an unowned PATH lookup", async () => {
  let spawned = false;
  expect(await latestVersionAsync("latest", "pnpm", {
    ownerFn: async () => { throw new Error("owner probe failed"); },
    spawnFn: (() => { spawned = true; throw new Error("unexpected child"); }) as never,
  })).toBeNull();
  expect(spawned).toBe(false);
});

const CAN_RUN_BUN_WORKER = ["darwin", "linux", "win32"].includes(process.platform)
  && typeof Worker === "function";

test.skipIf(!CAN_RUN_BUN_WORKER)("production pnpm worker starts and answers an empty invocation", async () => {
  const worker = new Worker(new URL("../../src/update/pnpm-owner-worker.ts", import.meta.url).href);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = new Promise<unknown>((resolve, reject) => {
      worker.onmessage = event => resolve(event.data);
      worker.onerror = reject;
    });
    worker.postMessage("");
    expect(await Promise.race([
      answer,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("pnpm worker did not reply")), 2_000); }),
    ])).toBeNull();
  } finally {
    if (timeout) clearTimeout(timeout);
    await worker.terminate();
  }
});

test.skipIf(!CAN_RUN_BUN_WORKER)("pnpm worker deadline terminates an unresponsive worker", async () => {
  const started = performance.now();
  const result = await pnpmOwner({
    workerUrl: new URL("../fixtures/pnpm-owner-stall-worker.ts", import.meta.url),
    deadlineMs: 25,
    invoked: "held-shim",
  });
  expect(result).toBeNull();
  expect(performance.now() - started).toBeLessThan(2_000);
});

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    killed: false,
    kill() { this.killed = true; this.emit("close", null); return true; },
  });
}

// Each named failure enters through the scheduler's actual lookup dependency.
// The injected write seam is the version.json writer; empty writes/cache mean no stamp.
for (const scenario of [
  { name: "child error event", output: "", exitCode: 0, error: true },
  { name: "nonzero child exit", output: "2.7.44\n", exitCode: 1, error: false },
  { name: "malformed zero-exit output", output: "not-a-version\n", exitCode: 0, error: false },
  { name: "empty zero-exit output", output: "", exitCode: 0, error: false },
  { name: "multiline zero-exit output", output: "2.7.44\n2.7.45\n", exitCode: 0, error: false },
]) {
  test(`registry ${scenario.name} returns null and retries after backoff`, async () => {
    const observed: Array<string | null> = [];
    let spawned = 0;
    const f = fixture("npm", false, async (tag, installer) => {
      const result = await latestVersionAsync(tag, installer, {
        ownerFn: async () => null,
        spawnFn: (() => {
          const child = fakeChild();
          const attempt = ++spawned;
          queueMicrotask(() => {
            if (attempt === 1) {
              if (scenario.output) child.stdout.write(scenario.output);
              if (scenario.error) child.emit("error", new Error("registry child failed"));
              child.emit("close", scenario.exitCode);
            } else {
              child.stdout.write("2.7.44\n");
              child.emit("close", 0);
            }
          });
          return child;
        }) as never,
      });
      observed.push(result);
      return result;
    });
    f.scheduler.start();
    await f.advance(0);
    await f.settle(() => f.timers.size === 1);
    expect(observed).toEqual([null]);
    expect(f.calls).toEqual(["latest"]);
    expect(f.writes).toHaveLength(0);
    expect(f.cache.size).toBe(0);
    expect(f.timers.size).toBe(1);
    expect([...f.timers.values()].map(timer => timer.at)).toEqual([f.now() + RETRY_BASE_MS]);
    await f.advance(RETRY_BASE_MS - 1);
    expect(f.calls).toHaveLength(1);
    await f.advance(1);
    await f.settle(() => f.writes.length === 1);
    expect(f.calls).toEqual(["latest", "latest"]);
    expect(observed).toEqual([null, "2.7.44"]);
    expect(f.writes).toHaveLength(1);
    expect(f.cache.get("latest")?.latest_version).toBe("2.7.44");
    f.scheduler.stop();
  });
}

test("registry output is bounded and killed without leaking text", async () => {
  const child = fakeChild();
  const result = latestVersionAsync("latest", "npm", {
    ownerFn: async () => null,
    spawnFn: (() => child) as never,
  });
  child.stderr.write(Buffer.alloc(REGISTRY_OUTPUT_LIMIT + 1));
  expect(await result).toBeNull();
  expect(child.killed).toBe(true);
});

test("registry deadline kills an unresponsive child", async () => {
  expect(REGISTRY_DEADLINE_MS).toBe(12_000);
  const child = fakeChild();
  const result = latestVersionAsync("latest", "npm", {
    ownerFn: async () => null,
    spawnFn: (() => child) as never,
    deadlineMs: 1,
  });
  expect(await result).toBeNull();
  expect(child.killed).toBe(true);
});
