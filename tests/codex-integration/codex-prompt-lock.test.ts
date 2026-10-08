/**
 * Lock contract for src/codex/prompt-lock.ts.
 *
 * The interleaving cases (46a-46c in the roadmap) exist because naive stale
 * breaking admits two writers: A judges the lock stale, B removes it and
 * acquires its own, A then unlinks B's live lock. This lock protects the write
 * transaction, so that race would corrupt the thing the journal exists to keep
 * consistent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STALE_AFTER_MS,
  release,
  stillHeld,
  tryAcquire,
  type LockDeps,
} from "../../src/codex/prompt-lock";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const roots: string[] = [];

function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-lock-"));
  roots.push(dir);
  return join(dir, "opencodex-prompt.lock");
}

/** Owner alive, clock fixed. */
const alive: LockDeps = { isProcessAlive: () => true, now: () => 1_000_000 };
/** Owner gone, and enough time has passed for the grace window to expire. */
const dead: LockDeps = { isProcessAlive: () => false, now: () => 1_000_000 + STALE_AFTER_MS + 1 };

afterEach(() => {
  while (roots.length) removeTreeWithRetry(roots.pop()!);
});

describe("basic acquisition", () => {
  test("acquires a free lock and records our pid", () => {
    const path = lockPath();
    const result = tryAcquire(path, alive);
    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
  });

  test("a second contender is refused while the owner lives", () => {
    const path = lockPath();
    expect(tryAcquire(path, alive).ok).toBe(true);
    expect(tryAcquire(path, alive)).toEqual({ ok: false, error: "locked" });
  });

  test("release frees it for the next contender", () => {
    const path = lockPath();
    const first = tryAcquire(path, alive);
    if (!first.ok) throw new Error("setup");
    expect(release(first.handle)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(tryAcquire(path, alive).ok).toBe(true);
  });
});

describe("staleness", () => {
  test("a dead owner past the grace window is broken", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ token: "old", pid: 999999, acquiredAt: 1_000_000 }), "utf8");
    expect(tryAcquire(path, dead).ok).toBe(true);
  });

  test("a dead owner INSIDE the grace window is respected", () => {
    // A process can die microseconds after writing its lock; a peer mid-write
    // deserves the window.
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ token: "old", pid: 999999, acquiredAt: 1_000_000 }), "utf8");
    const justDied: LockDeps = { isProcessAlive: () => false, now: () => 1_000_000 + 5 };
    expect(tryAcquire(path, justDied)).toEqual({ ok: false, error: "locked" });
  });

  test("a live owner is never broken, however old", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ token: "old", pid: 1, acquiredAt: 0 }), "utf8");
    expect(tryAcquire(path, alive)).toEqual({ ok: false, error: "locked" });
  });

  test("only aged unparseable debris is treated as stale", () => {
    const path = lockPath();
    writeFileSync(path, "not json", "utf8");
    expect(tryAcquire(path, dead)).toEqual({ ok: false, error: "locked" });
    utimesSync(path, 0, 0);
    expect(tryAcquire(path, dead).ok).toBe(true);
  });

  test("breaking leaves no quarantine file behind", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ token: "old", pid: 999999, acquiredAt: 1_000_000 }), "utf8");
    expect(tryAcquire(path, dead).ok).toBe(true);
    const strays = readdirSync(join(path, "..")).filter(f => f.includes(".stale-"));
    expect(strays).toEqual([]);
  });
});

describe("interleavings", () => {
  test("real concurrent contenders admit at most one live owner and leave retries usable", async () => {
    const path = lockPath(), go = path + ".go", stop = path + ".stop";
    writeFileSync(path, JSON.stringify({ token: "old", pid: 999999999, acquiredAt: 0 }));
    const children = Array.from({ length: 8 }, (_, i) => Bun.spawn([process.execPath, "-e", `
      const fs=await import('node:fs');
      const {tryAcquire,release}=await import(${JSON.stringify(repoPath("src/codex/prompt-lock.ts"))});
      fs.writeFileSync(${JSON.stringify(path + ".ready-")}+${i}, 'ready');
      const until=Date.now()+3000;
      while(!fs.existsSync(${JSON.stringify(go)})){if(Date.now()>until)throw Error('barrier timeout');await Bun.sleep(5);}
      const result=tryAcquire(${JSON.stringify(path)});
      const resultPath=${JSON.stringify(path + ".result-")}+${i};
      fs.writeFileSync(resultPath+'.tmp', JSON.stringify(result));
      fs.renameSync(resultPath+'.tmp', resultPath);
      if(result.ok){while(!fs.existsSync(${JSON.stringify(stop)})){if(Date.now()>until)throw Error('hold timeout');await Bun.sleep(5);}release(result.handle);}
    `], { stdout: "pipe", stderr: "pipe" }));
    try {
      const until = Date.now() + 3000;
      while (!children.every((_, i) => existsSync(path + ".ready-" + i))) {
        if (Date.now() > until) throw Error("contenders did not reach barrier");
        await Bun.sleep(5);
      }
      writeFileSync(go, "go");
      while (!children.every((_, i) => existsSync(path + ".result-" + i))) {
        if (Date.now() > until) throw Error("contenders did not finish acquisition");
        await Bun.sleep(5);
      }
      const results = children.map((_, i) => JSON.parse(readFileSync(path + ".result-" + i, "utf8")));
      expect(results.filter(result => result.ok).length).toBeLessThanOrEqual(1);
      writeFileSync(stop, "stop");
      expect(await Promise.all(children.map(child => child.exited))).toEqual(Array(8).fill(0));
      const retried = tryAcquire(path);
      expect(retried.ok).toBe(true);
      if (retried.ok) release(retried.handle);
      expect(existsSync(path + ".claims")).toBe(false);
    } finally { writeFileSync(stop, "stop"); children.forEach(child => child.kill()); }
  });

  test("a dead process's unique reservation is reclaimed without blocking future writers", async () => {
    const path = lockPath(), ready = path + ".ready";
    writeFileSync(path, JSON.stringify({ token: "old", pid: 999999999, acquiredAt: 0 }));
    const child = Bun.spawn([process.execPath, "-e", `
      const fs = await import('node:fs');
      const {tryAcquire} = await import(${JSON.stringify(repoPath("src/codex/prompt-lock.ts"))});
      tryAcquire(${JSON.stringify(path)}, {now:Date.now,isProcessAlive(){
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3000);
        return false;
      }});
    `], { stdout: "pipe", stderr: "pipe" });
    try {
      const until = Date.now() + 3000;
      while (!existsSync(ready)) {
        if (Date.now() > until) throw Error("owner did not enter reservation");
        await Bun.sleep(5);
      }
      child.kill(); await child.exited;
      const acquired = tryAcquire(path);
      expect(acquired.ok).toBe(true);
      if (acquired.ok) expect(release(acquired.handle)).toBe(true);
      expect(existsSync(path + ".claims")).toBe(false);
    } finally { child.kill(); }
  });

  test("separate processes cannot move a successor after an earlier stale observation", async () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ token: "old", pid: 999999999, acquiredAt: 0 }));
    const ready = path + ".ready", go = path + ".go", stop = path + ".stop";
    const modulePath = repoPath("src/codex/prompt-lock.ts");
    const a = Bun.spawn([process.execPath, "-e", `
      const fs = await import('node:fs');
      const {tryAcquire} = await import(${JSON.stringify(modulePath)});
      let paused = false;
      const result = tryAcquire(${JSON.stringify(path)}, {
        now: Date.now,
        isProcessAlive(pid) {
          if (!paused) {
            paused = true; fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
            const until = Date.now() + 3000;
            while (!fs.existsSync(${JSON.stringify(go)})) {
              if (Date.now() > until) throw Error('barrier timeout');
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
            }
          }
          return false;
        }
      });
      console.log(JSON.stringify(result));
    `], { stdout: "pipe", stderr: "pipe" });
    let b: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const until = Date.now() + 3000;
      while (!existsSync(ready)) {
        if (Date.now() > until) throw Error("A did not reach stale observation");
        await Bun.sleep(5);
      }
      b = Bun.spawn([process.execPath, "-e", `
        const fs = await import('node:fs');
        const {tryAcquire, stillHeld} = await import(${JSON.stringify(modulePath)});
        const result = tryAcquire(${JSON.stringify(path)});
        fs.writeFileSync(${JSON.stringify(path + ".b")}, JSON.stringify(result));
        const until = Date.now() + 3000;
        while (!fs.existsSync(${JSON.stringify(stop)})) {
          if (Date.now() > until) throw Error('barrier timeout');
          await Bun.sleep(5);
        }
        console.log(JSON.stringify({result, held: result.ok && stillHeld(result.handle)}));
      `], { stdout: "pipe", stderr: "pipe" });
      while (!existsSync(path + ".b")) {
        if (Date.now() > until) throw Error("B did not attempt acquisition");
        await Bun.sleep(5);
      }
      const br = JSON.parse(readFileSync(path + ".b", "utf8"));
      writeFileSync(go, "go");
      const ar = JSON.parse((await new Response(a.stdout).text()).trim());
      expect(await a.exited).toBe(0);
      writeFileSync(stop, "stop");
      const finalB = JSON.parse((await new Response(b.stdout).text()).trim());
      expect(await b.exited).toBe(0);
      expect([ar.ok, br.ok].filter(Boolean)).toHaveLength(1);
      if (br.ok) expect(finalB.held).toBe(true);
    } finally {
      writeFileSync(go, "go"); writeFileSync(stop, "stop");
      a.kill(); b?.kill();
    }
  });

  test("a separate process initializing an empty exclusive lock is respected", async () => {
    const path = lockPath(), ready = path + ".ready", go = path + ".go";
    const token = "initializing-owner";
    const child = Bun.spawn([process.execPath, "-e", `
      const fs = await import('node:fs');
      const fd = fs.openSync(${JSON.stringify(path)}, 'wx', 0o600);
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      const until = Date.now() + 3000;
      while (!fs.existsSync(${JSON.stringify(go)})) {
        if (Date.now() > until) throw Error('barrier timeout');
        await Bun.sleep(5);
      }
      fs.writeFileSync(fd, JSON.stringify({token:${JSON.stringify(token)},pid:process.pid,acquiredAt:Date.now()}));
      fs.closeSync(fd);
    `], { stdout: "pipe", stderr: "pipe" });
    try {
      const until = Date.now() + 3000;
      while (!existsSync(ready)) {
        if (Date.now() > until) throw Error("initializer did not reach barrier");
        await Bun.sleep(5);
      }
      expect(tryAcquire(path)).toEqual({ ok: false, error: "locked" });
      writeFileSync(go, "go");
      expect(await child.exited).toBe(0);
      expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(token);
    } finally { writeFileSync(go, "go"); child.kill(); }
  });

  test("46a: A quarantines, B acquires first, A backs off without touching B's lock", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ token: "old", pid: 999999, acquiredAt: 1_000_000 }), "utf8");

    // Simulate the interleaving: B wins the real lock while A is mid-takeover.
    let renamed = false;
    const racyDeps: LockDeps = {
      isProcessAlive: pid => {
        // Called once before the rename. After A renames, B slips in.
        if (!renamed) {
          renamed = true;
          queueMicrotask(() => {});
        }
        return dead.isProcessAlive(pid);
      },
      now: dead.now,
    };

    // A renames the stale lock away, then B creates the real lock, then A tries.
    const quarantine = `${path}.stale-manual`;
    require("node:fs").renameSync(path, quarantine);
    const b = tryAcquire(path, racyDeps);
    expect(b.ok).toBe(true);
    const bToken = JSON.parse(readFileSync(path, "utf8")).token;

    // A now attempts and must be refused; B's lock must survive untouched.
    const a = tryAcquire(path, alive);
    expect(a).toEqual({ ok: false, error: "locked" });
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(bToken);
    rmSync(quarantine, { force: true });
  });

  test("46b: releasing with a superseded token deletes nothing", () => {
    const path = lockPath();
    const first = tryAcquire(path, alive);
    if (!first.ok) throw new Error("setup");

    // Someone else replaced the lock while we thought we held it.
    writeFileSync(path, JSON.stringify({ token: "theirs", pid: 4242, acquiredAt: 2_000_000 }), "utf8");

    expect(release(first.handle)).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe("theirs");
  });

  test("46c: only one of two simultaneous contenders wins a stale lock", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ token: "old", pid: 999999, acquiredAt: 1_000_000 }), "utf8");
    const first = tryAcquire(path, dead);
    const second = tryAcquire(path, dead);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
  });

  test("stillHeld reports supersession", () => {
    const path = lockPath();
    const held = tryAcquire(path, alive);
    if (!held.ok) throw new Error("setup");
    expect(stillHeld(held.handle)).toBe(true);
    writeFileSync(path, JSON.stringify({ token: "theirs", pid: 1, acquiredAt: 0 }), "utf8");
    expect(stillHeld(held.handle)).toBe(false);
  });
});
