import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { acquireTestRunLock } from "../../scripts/test-run-lock";
import { TEST_RUN_LOCK_RELEASE_WAIT_MS, withTestRunLockGate } from "../../scripts/test-run-lock-gate";
import { helperPath, repoPath } from "../helpers/repo-root";

const startA = "win32:1600000000000";
const reader = (pids: readonly number[]) => new Map(pids.map(pid => [pid, startA]));

async function fixture(body: (f: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>) {
  const f = await makeFixture();
  try { await body(f); }
  finally { await f.finish(); }
}

async function makeFixture() {
  fs.mkdirSync(repoPath(".tmp"), { recursive: true });
  const root = fs.mkdtempSync(repoPath(".tmp", "lock-generation-"));
  const path = join(root, "suite.lock");
  fs.writeFileSync(join(root, "private-fixture"), randomUUID());
  const children: { child: ReturnType<typeof Bun.spawn>; output: Promise<string[]>; startedAt: string }[] = [];
  const crashes = new Set<number>();
  const put = (role: string, suffix: string) => {
    const file = join(root, `${role}.${suffix}`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, "true", { flag: "wx" });
  };
  const has = (role: string, suffix: string) => fs.existsSync(join(root, `${role}.${suffix}`));
  const wait = async (role: string, suffix: string) => {
    const end = Date.now() + 20_000;
    while (!has(role, suffix)) {
      if (Date.now() >= end) throw new Error(`Private barrier timed out: ${role}.${suffix}`);
      await Bun.sleep(10);
    }
  };
  const spawn = (role: string, runId = role) => {
    const startedAt = new Date().toISOString();
    const child = Bun.spawn([process.execPath, helperPath("test-run-lock-generation-worker.ts"), root, role, runId], {
      cwd: root, env: { ...process.env, OCX_TEST_NO_QUEUE: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    children.push({ child, output, startedAt });
    console.info(JSON.stringify({ lockChildStart: { pid: child.pid, parentPid: process.pid, startedAt, role } }));
    return child;
  };
  const owner = () => JSON.parse(fs.readFileSync(join(path, "owner.json"), "utf8"));
  return { root, path, put, has, wait, spawn, owner, expectCrash(pid: number) { crashes.add(pid); }, async finish() {
    for (const role of ["A", "B", "member", "gate"]) { put(role, "resume"); put(role, "release"); }
    for (const { child, output, startedAt } of children) {
      const timeout = setTimeout(() => child.kill(), 2_000);
      const exitCode = await child.exited;
      clearTimeout(timeout);
      const [stdout, stderr] = await output;
      console.info(JSON.stringify({ lockChildTerminal: { pid: child.pid, startedAt, exitCode, stdout, stderr } }));
      if (crashes.has(child.pid)) expect(exitCode).not.toBe(0);
      else expect(exitCode).toBe(0);
    }
    // Inspect the exact private root separately from removal. No shared lock path
    // or redirect is accepted, and cleanup never uses force.
    expect(root.startsWith(repoPath(".tmp", "lock-generation-"))).toBe(true);
    expect(fs.lstatSync(root).isSymbolicLink()).toBe(false);
    for (const name of fs.readdirSync(root)) expect(fs.lstatSync(join(root, name)).isSymbolicLink()).toBe(false);
    fs.rmSync(root, { recursive: true });
    expect(fs.existsSync(root)).toBe(false);
  } };
}

for (const initializing of [false, true]) {
  test(`generation gate prevents duplicate acquisition during ${initializing ? "initial probe" : "stale verdict"}`, async () => {
    await fixture(async f => {
      if (!initializing) {
        fs.mkdirSync(f.path);
        fs.writeFileSync(join(f.path, "owner.json"), JSON.stringify({ version: 1, runId: "seed", token: "seed",
          pid: process.pid, acquiredAt: new Date().toISOString(), processStart: startA }));
      }
      f.spawn("A");
      await f.wait("A", "blocked");
      const first = fs.existsSync(f.path) ? fs.lstatSync(f.path, { bigint: true }).ino : null;
      f.spawn("B");
      await f.wait("B", "waited");
      if (initializing) await Bun.sleep(10_300); // real grace, no timestamp spoofing
      expect(f.has("B", "acquired")).toBe(false);
      if (initializing) expect(fs.existsSync(f.path)).toBe(false);
      else expect(String(fs.lstatSync(f.path, { bigint: true }).ino)).toBe(String(first));
      f.put("A", "resume");
      await f.wait("A", "acquired");
      expect(f.owner().runId).toBe("A");
      expect(f.has("B", "acquired")).toBe(false);
      f.put("A", "release");
      await f.wait("A", "terminal");
      await f.wait("B", "acquired");
      expect(f.owner().runId).toBe("B");
    });
  }, 40_000);
}

test("generation gate is recovered after its exact holder process dies", async () => {
  const f = await makeFixture();
  try {
    const holder = f.spawn("gate");
    await f.wait("gate", "blocked");
    const gateIdentity = fs.lstatSync(`${f.path}.gate.sqlite`, { bigint: true }).ino;
    f.spawn("B");
    await f.wait("B", "waited");
    expect(f.has("B", "acquired")).toBe(false);
    f.expectCrash(holder.pid);
    holder.kill();
    await holder.exited;
    // The intentional crash's terminal is checked here, separately from clean workers.
    await f.wait("B", "acquired");
    expect(f.owner().runId).toBe("B");
    expect(fs.lstatSync(`${f.path}.gate.sqlite`, { bigint: true }).ino).toBe(gateIdentity);
  } finally { await f.finish(); }
}, 30_000);

test("member registration and obsolete owner release preserve generation ownership", async () => {
  await fixture(async f => {
    const owner = await acquireTestRunLock({ runId: "held", lockPath: f.path, env: {},
      processStartBatch: pids => new Map(pids.map(pid => [pid, null])) });
    f.spawn("member", "held");
    await f.wait("member", "blocked");
    let waits = 0;
    await expect(acquireTestRunLock({ runId: "other", lockPath: f.path, env: {}, pollMs: 5, maxWaitMs: 80,
      onWait() { waits++; }, processStartBatch: reader })).rejects.toThrow("timed out");
    expect(waits).toBe(1);
    f.put("member", "resume");
    await f.wait("member", "acquired");
    expect(fs.readdirSync(join(f.path, "members")).length).toBe(1);
    owner.release();
    const next = await acquireTestRunLock({ runId: "next", lockPath: f.path, env: {}, processStartBatch: reader });
    owner.release();
    expect(f.owner().token).toBe(next.owner!.token);
    next.release();
  });
}, 30_000);

test("busy owner release is bounded and preserves the current generation", async () => {
  await fixture(async f => {
    const owner = await acquireTestRunLock({ runId: "held", lockPath: f.path, env: {}, processStartBatch: reader });
    f.spawn("gate");
    await f.wait("gate", "blocked");
    // Test-only stage timing for the real release() path: each release opens a
    // fresh gate connection, so Database.open, the busy_timeout PRAGMA,
    // BEGIN IMMEDIATE and close are separately measurable through temporary
    // mocks of the public bun:sqlite surface. Budgets and SQLite behavior are
    // unchanged; the diagnostic prints only when the bound is exceeded.
    const stageMs: Record<string, number> = {};
    const track = <T>(stage: string, call: () => T): T => {
      const t0 = Date.now();
      try { return call(); }
      finally { stageMs[stage] = (stageMs[stage] ?? 0) + Date.now() - t0; }
    };
    const stageOf = (sql: unknown): string => {
      const s = typeof sql === "string" ? sql.trimStart() : "";
      if (s.startsWith("BEGIN")) return "begin";
      if (s.startsWith("PRAGMA")) return "pragma";
      if (s.startsWith("ROLLBACK") || s.startsWith("COMMIT")) return "endTxn";
      return "execOther";
    };
    const originalOpen = Database.open;
    const openSpy = spyOn(Database, "open").mockImplementation((...args: Parameters<typeof Database.open>) => track("open", () => {
      const db = originalOpen.apply(Database, args);
      try {
        const exec = db.exec, close = db.close;
        db.exec = function (this: unknown, sql: string, ...rest: unknown[]) {
          return track(stageOf(sql), () => exec.call(this, sql, ...(rest as never[])));
        };
        db.close = function (this: unknown, ...rest: unknown[]) {
          return track("close", () => close.apply(this, rest as never[]));
        };
      } catch {
        stageMs.instrumented = -1;
      }
      return db;
    }));
    const started = Date.now();
    // Capture elapsed at the exact release() boundary so post-call fixture I/O
    // (owner.json read below) stays outside the measured budget.
    let elapsed = -1;
    const releaseOnce = () => { try { owner.release(); } finally { elapsed = Date.now() - started; } };
    try {
      expect(releaseOnce).toThrow("generation gate during release");
      // Instrumentation must have observed each real stage; a silently
      // uninstrumented PASS would leave the diagnostic unverified. Stages may
      // legitimately measure 0ms, so only own-property + finite is required.
      for (const stage of ["open", "pragma", "begin", "close"]) {
        expect(Object.hasOwn(stageMs, stage) && Number.isFinite(stageMs[stage])).toBe(true);
      }
      // Correctness before timing: a bound violation must not hide whether the
      // current generation owner survived the failed release.
      expect(f.owner().token).toBe(owner.owner!.token);
      expect(elapsed).toBeGreaterThanOrEqual(TEST_RUN_LOCK_RELEASE_WAIT_MS - 100);
      if (elapsed >= TEST_RUN_LOCK_RELEASE_WAIT_MS + 3_000) {
        console.info(JSON.stringify({ releaseStageMs: stageMs, elapsedMs: elapsed,
          bun: Bun.version, platform: process.platform, arch: process.arch }));
      }
      expect(elapsed).toBeLessThan(TEST_RUN_LOCK_RELEASE_WAIT_MS + 3_000);
    } finally {
      openSpy.mockRestore();
    }
    f.put("gate", "resume");
    await f.wait("gate", "terminal");
    owner.release();
    expect(fs.existsSync(f.path)).toBe(false);
  });
}, 30_000);

// Spies installed by the controlled gate model; restored via afterEach even if
// an assertion interrupts a test.
const gateSpies: { mockRestore(): void }[] = [];
afterEach(() => { for (const spy of gateSpies.splice(0)) spy.mockRestore(); });

/** Intercepts busy_timeout PRAGMAs and BEGIN IMMEDIATE on gate connections
 * opened during the test; the callback models the native BEGIN outcome. */
function controlGateBegin(begin: (pragmas: number[]) => void): { pragmas: number[] } {
  const pragmas: number[] = [];
  const originalOpen = Database.open;
  const spy = spyOn(Database, "open").mockImplementation((...args: Parameters<typeof Database.open>) => {
    const db = originalOpen.apply(Database, args);
    const exec = db.exec;
    db.exec = function (this: unknown, sql: string, ...rest: unknown[]) {
      const s = sql.trimStart();
      const busy = /^PRAGMA busy_timeout\s*=\s*(\d+)/.exec(s);
      if (busy) { pragmas.push(Number(busy[1])); return; }
      if (s === "BEGIN IMMEDIATE") { begin(pragmas); return; }
      return exec.call(this, sql, ...(rest as never[]));
    };
    return db;
  });
  gateSpies.push(spy);
  return { pragmas };
}

test("release gate wait stops on the remaining elapsed budget, never a fresh full timeout", async () => {
  await fixture(async f => {
    let fakeNow = 1_000;
    gateSpies.push(spyOn(performance, "now").mockImplementation(() => fakeNow));
    // Controlled model of a held gate: every BEGIN stays busy for 1.4x the
    // requested busy_timeout — one native wait may overshoot its slice.
    const { pragmas } = controlGateBegin((p) => {
      fakeNow += Math.round((p.at(-1) ?? 0) * 1.4);
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    });
    const startedAt = fakeNow;
    let ran = 0;
    const result = withTestRunLockGate(f.path, () => { ran++; }, 10_000);
    expect(result).toBeUndefined();
    expect(ran).toBe(0);
    // Counterfactual: an un-sliced wait requests one busy_timeout of 10_000 and
    // lands near 14_000ms elapsed under this model — all three assertions
    // below fail on that implementation. Slices re-issue busy_timeout only
    // against remaining budget, so elapsed stops near the deadline.
    expect(pragmas.length).toBeGreaterThan(1);
    expect(Math.max(...pragmas)).toBeLessThanOrEqual(1_000);
    expect(fakeNow - startedAt).toBeLessThan(10_500);
  });
}, 30_000);

test("gate propagates a non-busy BEGIN failure without retrying", async () => {
  await fixture(async f => {
    const { pragmas } = controlGateBegin(() => {
      throw Object.assign(new Error("gate io failure"), { code: "EIO" });
    });
    expect(() => withTestRunLockGate(f.path, () => { throw new Error("action must not run"); }, 5_000))
      .toThrow("gate io failure");
    expect(pragmas.length).toBe(1);
  });
}, 30_000);

test("gate normalizes a non-finite busyMs to one immediate attempt", async () => {
  await fixture(async f => {
    const { pragmas } = controlGateBegin(() => {
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    });
    for (const busyMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      // A non-finite budget must degrade to the documented busyMs=0 single
      // immediate attempt; an unguarded loop would hang this test instead.
      const result = withTestRunLockGate(f.path, () => { throw new Error("action must not run"); }, busyMs);
      expect(result).toBeUndefined();
    }
    expect(pragmas).toEqual([0, 0, 0]);
  });
}, 30_000);

test("gate busyMs=0 declines a held gate without running the action", async () => {
  await fixture(async f => {
    f.spawn("gate");
    await f.wait("gate", "blocked");
    let ran = 0;
    const result = withTestRunLockGate(f.path, () => { ran++; }, 0);
    expect(result).toBeUndefined();
    expect(ran).toBe(0);
    f.put("gate", "resume");
    await f.wait("gate", "terminal");
  });
}, 30_000);

test("gate executes a granted action exactly once", async () => {
  await fixture(async f => {
    let ran = 0;
    const result = withTestRunLockGate(f.path, () => { ran++; return "held"; }, 5_000);
    expect(result).toEqual({ value: "held" });
    expect(ran).toBe(1);
  });
}, 30_000);

test("failed owner publication preserves a foreign owner installed at that path", async () => {
  await fixture(async f => {
    const original = fs.writeFileSync;
    let injected = false;
    const write = spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      if (args[0] === join(f.path, "owner.json") && !injected) {
        injected = true;
        original(args[0], JSON.stringify({ version: 1, runId: "foreign", token: "foreign", pid: process.pid,
          acquiredAt: new Date().toISOString() }));
        throw Object.assign(new Error("fixture publication failure"), { code: "EACCES" });
      }
      return original(...args);
    });
    try {
      await expect(acquireTestRunLock({ runId: "new", lockPath: f.path, env: {}, processStartBatch: reader }))
        .rejects.toThrow("fixture publication failure");
    } finally { write.mockRestore(); }
    expect(injected).toBe(true);
    expect(f.owner().runId).toBe("foreign");
  });
});

test("gate rejects redirected, hardlinked and non-file paths without touching targets", async () => {
  await fixture(async f => {
    const target = join(f.root, "target");
    fs.writeFileSync(target, "not a gate");
    const digest = () => createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    const before = digest();
    const gate = `${f.path}.gate.sqlite`;
    fs.linkSync(target, gate);
    expect(() => withTestRunLockGate(f.path, () => {})).toThrow("generation gate");
    expect(digest()).toBe(before);
    fs.unlinkSync(gate);
    fs.mkdirSync(gate);
    expect(() => withTestRunLockGate(f.path, () => {})).toThrow("generation gate");
    fs.rmdirSync(gate);
    // Directory junctions do not require Windows symlink privileges.
    const redirected = join(f.root, "redirected");
    fs.mkdirSync(redirected);
    fs.symlinkSync(redirected, gate, process.platform === "win32" ? "junction" : "dir");
    expect(() => withTestRunLockGate(f.path, () => {})).toThrow("generation gate");
    expect(fs.readdirSync(redirected)).toEqual([]);
    fs.unlinkSync(gate);
    const alias = join(f.root, "parent-alias");
    fs.symlinkSync(redirected, alias, process.platform === "win32" ? "junction" : "dir");
    expect(() => withTestRunLockGate(join(alias, "suite.lock"), () => {})).toThrow("generation gate");
    expect(fs.readdirSync(redirected)).toEqual([]);
    fs.unlinkSync(alias);
  });
});

test("corrupt gate I/O never falls back to an ungated owner", async () => {
  await fixture(async f => {
    fs.writeFileSync(`${f.path}.gate.sqlite`, "not a database");
    await expect(acquireTestRunLock({ runId: "blocked", lockPath: f.path, env: {}, processStartBatch: reader }))
      .rejects.toThrow();
    expect(fs.existsSync(f.path)).toBe(false);
  });
});

test("owner metadata I/O failure refuses retirement rather than treating it as missing", async () => {
  await fixture(async f => {
    const owner = await acquireTestRunLock({ runId: "held", lockPath: f.path, env: {}, processStartBatch: reader });
    const original = fs.readFileSync;
    const read = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === join(f.path, "owner.json")) throw Object.assign(new Error("fixture I/O failure"), { code: "EIO" });
      return original(...args);
    }) as typeof fs.readFileSync);
    try {
      await expect(acquireTestRunLock({ runId: "blocked", lockPath: f.path, env: {}, processStartBatch: reader }))
        .rejects.toThrow("fixture I/O failure");
    } finally { read.mockRestore(); }
    expect(f.owner().token).toBe(owner.owner!.token);
    owner.release();
  });
});
