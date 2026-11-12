import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoPath } from "../helpers/repo-root";
import {
  CREDENTIAL_FENCE_FILENAME,
  readUnderCredentialPublicationFence,
  withCredentialPublicationFenceAsync,
} from "../../src/local-credentials/publication-fence";

const moduleUrl = pathToFileURL(repoPath("src/local-credentials/publication-fence.ts")).href;

/** Synchronize subprocess readiness without timing-dependent sleeps. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** Keep a real peer-process SQLite lock until its parent explicitly releases it. */
async function holder(home: string, mode: "reader" | "writer" = "writer") {
  const locked = deferred<void>();
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
    import { Database } from "bun:sqlite";
    import { join } from "node:path";
    import { CREDENTIAL_FENCE_FILENAME, withCredentialPublicationFence, withCredentialPublicationFenceAsync } from ${JSON.stringify(moduleUrl)};
    const home = process.env.FENCE_TEST_HOME;
    const release = new Promise(resolve => process.on("message", message => { if (message === "release") resolve(); }));
    if (${JSON.stringify(mode)} === "writer") {
      await withCredentialPublicationFenceAsync(home, async () => { process.send("locked"); await release; });
    } else {
      withCredentialPublicationFence(home, () => {});
      const db = new Database(join(home, CREDENTIAL_FENCE_FILENAME), { readonly: true });
      db.exec("BEGIN"); db.query("SELECT count(*) FROM sqlite_master").get();
      process.send("locked"); await release; db.exec("ROLLBACK"); db.close();
    }
    process.exit(0);
  `], {
    env: { ...process.env, FENCE_TEST_HOME: home },
    stdout: "ignore", stderr: "inherit",
    ipc(message) { if (message === "locked") locked.resolve(); },
  });
  await Promise.race([
    locked.promise,
    child.exited.then(code => { throw new Error(`Fence holder exited before locking: ${code}`); }),
  ]);
  return child;
}

for (const mode of ["reader", "writer"] as const) {
  test(`healthz stays responsive while an async writer waits for a separate ${mode}`, async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-fence-health-"));
    let owner: Bun.Subprocess | undefined;
    let server: Bun.Subprocess | undefined;
    let write: Promise<Response> | undefined;
    try {
      owner = await holder(home, mode);
      const ready = deferred<number>();
      const attempting = deferred<void>();
      server = Bun.spawn([process.execPath, "--no-env-file", "-e", `
        import { withCredentialPublicationFenceAsync } from ${JSON.stringify(moduleUrl)};
        let entered = false;
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
          if (new URL(request.url).pathname === "/healthz") return Response.json({ entered });
          process.send("attempting");
          const value = await withCredentialPublicationFenceAsync(process.env.FENCE_TEST_HOME, async () => { entered = true; return "written"; });
          return new Response(value);
        }});
        process.send({ port: server.port });
      `], {
        env: { ...process.env, FENCE_TEST_HOME: home },
        stdout: "ignore", stderr: "inherit",
        ipc(message) {
          if (message === "attempting") attempting.resolve();
          else if (message && typeof message === "object" && "port" in message) ready.resolve(Number(message.port));
        },
      });
      const port = await Promise.race([
        ready.promise,
        server.exited.then(code => { throw new Error(`Fence server exited before listening: ${code}`); }),
      ]);
      const base = `http://127.0.0.1:${port}`;
      write = fetch(`${base}/write`);
      await attempting.promise;
      // An independent process must service HTTP while the real SQLite lock is
      // still held. The parent, not a timer, releases it after this assertion.
      const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(750) });
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ entered: false });
      owner.send("release");
      expect(await owner.exited).toBe(0);
      expect(await (await write).text()).toBe("written");
    } finally {
      try { owner?.send("release"); } catch { /* already exited */ }
      if (owner) await owner.exited;
      if (write) await write.catch(() => undefined);
      try { server?.kill(); } catch { /* already exited */ }
      if (server) await server.exited;
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
}

test("nested async holders keep readers excluded until the outer callback ends", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-fence-nested-"));
  try {
    expect(await withCredentialPublicationFenceAsync(home, async () => {
      const inner = await withCredentialPublicationFenceAsync(home, async () => 42);
      expect(readUnderCredentialPublicationFence(home, () => "read")).toEqual({ kind: "busy" });
      return inner;
    })).toBe(42);
    expect(readUnderCredentialPublicationFence(home, () => "read")).toEqual({ kind: "read", value: "read" });
    const failure = new Error("fixture callback failure");
    await expect(withCredentialPublicationFenceAsync(home, async () => { throw failure; })).rejects.toBe(failure);
    expect(readUnderCredentialPublicationFence(home, () => "released")).toEqual({ kind: "read", value: "released" });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

for (const liveClockReads of [1, 2]) {
  test(`async contention keeps its monotonic deadline before/after yielding (${liveClockReads})`, async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-fence-deadline-"));
    const owner = await holder(home);
    let calls = 0;
    let nowCalls = 0;
    const timer = spyOn(globalThis, "setTimeout");
    const clock = spyOn(performance, "now").mockImplementation(() => nowCalls++ < liveClockReads ? 0 : 10_001);
    try {
      await expect(withCredentialPublicationFenceAsync(home, async () => { calls += 1; })).rejects.toMatchObject({ code: "SQLITE_BUSY" });
      expect(calls).toBe(0);
      expect(timer).toHaveBeenCalledTimes(liveClockReads - 1);
    } finally {
      clock.mockRestore(); timer.mockRestore(); owner.send("release"); await owner.exited;
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("prolonged contention bounds retry churn without extending the acquisition deadline", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-fence-backoff-"));
  const owner = await holder(home);
  let now = 0;
  let calls = 0;
  const waits: number[] = [];
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay = 0) => {
    waits.push(delay);
    now += delay;
    queueMicrotask(callback);
    return {} as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  try {
    await expect(withCredentialPublicationFenceAsync(home, async () => { calls += 1; })).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    expect(calls).toBe(0);
    expect(waits[0]).toBe(25);
    expect(Math.max(...waits)).toBeLessThanOrEqual(100);
    expect(waits.length).toBeLessThan(120);
    expect(now).toBe(10_000);
  } finally {
    timer.mockRestore(); clock.mockRestore(); owner.send("release"); await owner.exited;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a peer that releases during the final wait is still acquired before the deadline", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-fence-final-"));
  const owner = await holder(home);
  let now = 0;
  let calls = 0;
  let released = false;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay = 0) => {
    now += delay;
    void (async () => {
      // The last sleep ends exactly at the deadline; the peer lets go while it runs.
      if (now >= 10_000 && !released) {
        released = true;
        owner.send("release");
        await owner.exited;
      }
      callback();
    })();
    return {} as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  try {
    await withCredentialPublicationFenceAsync(home, async () => { calls += 1; });
    expect(released).toBe(true);
    expect(calls).toBe(1);
    expect(now).toBe(10_000);
  } finally {
    timer.mockRestore(); clock.mockRestore();
    if (!released) { owner.send("release"); await owner.exited; }
    rmSync(home, { recursive: true, force: true });
  }
});

test("async acquisition propagates permanent open failures without invoking the callback", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-fence-open-"));
  let calls = 0;
  try {
    writeFileSync(join(home, CREDENTIAL_FENCE_FILENAME), "not a SQLite database");
    await expect(withCredentialPublicationFenceAsync(home, async () => { calls += 1; })).rejects.toMatchObject({ code: "SQLITE_NOTADB" });
    expect(calls).toBe(0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
