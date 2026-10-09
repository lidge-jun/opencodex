/**
 * Lock contract for src/codex/prompt-lock.ts.
 *
 * The interleaving cases (46a-46c in the roadmap) exist because naive stale
 * breaking admits two writers: A judges the lock stale, B removes it and
 * acquires its own, A then unlinks B's live lock. This lock protects the write
 * transaction, so that race would corrupt the thing the journal exists to keep
 * consistent.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
import { createOwnerIdentity, ownEvidence, ownerDefaults, ownerState } from "../../src/codex/prompt-lock-owner";
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
    writeFileSync(path, JSON.stringify({ ...ownEvidence(ownerDefaults), token: "old", pid: 999999, acquiredAt: 1_000_000 }), "utf8");
    expect(tryAcquire(path, dead).ok).toBe(true);
  });

  for (const token of [undefined, 42] as const) test(`a dead expired record with a ${token === undefined ? "missing" : "non-string"} token is unsafe and preserved`, () => {
    const path = lockPath();
    const body = JSON.stringify({ ...ownEvidence(ownerDefaults), ...(token === undefined ? {} : { token }), pid: 999999, acquiredAt: 1_000_000 });
    writeFileSync(path, body, "utf8");
    expect(tryAcquire(path, dead)).toEqual({ ok: false, error: "unsafe", detail: path });
    expect(readFileSync(path, "utf8")).toBe(body);
  });

  test("a dead owner INSIDE the grace window is respected", () => {
    // A process can die microseconds after writing its lock; a peer mid-write
    // deserves the window.
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ ...ownEvidence(ownerDefaults), token: "old", pid: 999999, acquiredAt: 1_000_000 }), "utf8");
    const justDied: LockDeps = { isProcessAlive: () => false, now: () => 1_000_000 + 5 };
    expect(tryAcquire(path, justDied)).toEqual({ ok: false, error: "locked" });
  });

  test("a live owner is never broken, however old", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ ...ownEvidence(ownerDefaults), token: "old", pid: 1, acquiredAt: 0 }), "utf8");
    expect(tryAcquire(path, alive)).toEqual({ ok: false, error: "locked" });
  });

  test("unparseable hostless debris is unsafe regardless of age", () => {
    const path = lockPath();
    writeFileSync(path, "not json", "utf8");
    expect(tryAcquire(path, dead)).toEqual({ ok: false, error: "unsafe", detail: path });
    utimesSync(path, 0, 0);
    expect(tryAcquire(path, dead)).toEqual({ ok: false, error: "unsafe", detail: path });
  });

  test("breaking leaves no quarantine file behind", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ ...ownEvidence(ownerDefaults), token: "old", pid: 999999, acquiredAt: 1_000_000 }), "utf8");
    expect(tryAcquire(path, dead).ok).toBe(true);
    const strays = readdirSync(join(path, "..")).filter(f => f.includes(".stale-"));
    expect(strays).toEqual([]);
  });
});

describe("interleavings", () => {
  test("real concurrent contenders admit at most one live owner and leave retries usable", async () => {
    const path = lockPath(), go = path + ".go", stop = path + ".stop";
    writeFileSync(path, JSON.stringify({ ...ownEvidence(ownerDefaults), token: "old", pid: 999999999, acquiredAt: 0 }));
    const children = Array.from({ length: 8 }, (_, i) => Bun.spawn([process.execPath, "-e", `
      const fs=await import('node:fs');
      const {tryAcquire,release}=await import(${JSON.stringify(repoPath("src/codex/prompt-lock.ts"))});
      fs.writeFileSync(${JSON.stringify(path + ".ready-")}+${i}, 'ready');
      const barrierUntil=Date.now()+15000;
      while(!fs.existsSync(${JSON.stringify(go)})){if(Date.now()>barrierUntil)throw Error('barrier timeout');await Bun.sleep(5);}
      const acquisitionUntil=Date.now()+5000;
      const result=tryAcquire(${JSON.stringify(path)});
      const resultPath=${JSON.stringify(path + ".result-")}+${i};
      fs.writeFileSync(resultPath+'.tmp', JSON.stringify(result));
      fs.renameSync(resultPath+'.tmp', resultPath);
      if(result.ok){while(!fs.existsSync(${JSON.stringify(stop)})){if(Date.now()>acquisitionUntil)throw Error('hold timeout');await Bun.sleep(5);}release(result.handle);}
    `], { stdout: "pipe", stderr: "pipe" }));
    try {
      const barrierUntil = Date.now() + 15000;
      while (!children.every((_, i) => existsSync(path + ".ready-" + i))) {
        if (Date.now() > barrierUntil) throw Error("contenders did not reach barrier");
        await Bun.sleep(5);
      }
      const acquisitionUntil = Date.now() + 5000;
      writeFileSync(go, "go");
      while (!children.every((_, i) => existsSync(path + ".result-" + i))) {
        if (Date.now() > acquisitionUntil) throw Error("contenders did not finish acquisition");
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
  }, 25000);

  test("a dead process's unique reservation is reclaimed without blocking future writers", async () => {
    const path = lockPath(), ready = path + ".ready";
    writeFileSync(path, JSON.stringify({ ...ownEvidence(ownerDefaults), token: "old", pid: 999999999, acquiredAt: 0 }));
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
    writeFileSync(path, JSON.stringify({ ...ownEvidence(ownerDefaults), token: "old", pid: 999999999, acquiredAt: 0 }));
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

  test("an incomplete hostless exclusive lock is unsafe and preserved", async () => {
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
      expect(tryAcquire(path)).toEqual({ ok: false, error: "unsafe", detail: path });
      writeFileSync(go, "go");
      expect(await child.exited).toBe(0);
      expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(token);
    } finally { writeFileSync(go, "go"); child.kill(); }
  });

  test("46a: A quarantines, B acquires first, A backs off without touching B's lock", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ ...ownEvidence(ownerDefaults), token: "old", pid: 999999, acquiredAt: 1_000_000 }), "utf8");

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
    writeFileSync(path, JSON.stringify({ ...ownEvidence(ownerDefaults), token: "old", pid: 999999, acquiredAt: 1_000_000 }), "utf8");
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

describe("owner evidence and namespace guards", () => {
  const host = { hostname: "fixture-host", machine: "fixture-boot" };
  const deps: LockDeps = {
    now: () => 1_000_000,
    hostIdentity: () => host,
    processStart: () => "fixture-start",
    isProcessAlive: pid => pid === process.pid,
  };
  const record = (overrides = {}) => ({ token: "old", pid: 999999999,
    acquiredAt: 0, host, processStart: "fixture-start", ...overrides });
  function assertUnsafe(path: string, injected: LockDeps = deps, detail = path): void {
    const before = existsSync(path) ? readFileSync(path, "utf8") : null;
    const result = tryAcquire(path, injected);
    expect(result).toEqual({ ok: false, error: "unsafe", detail });
    expect(existsSync(path) ? readFileSync(path, "utf8") : null).toBe(before);
  }
  test("foreign-host records refuse takeover", () => {
    const path = lockPath(); writeFileSync(path, JSON.stringify(record({ host: { ...host, machine: "foreign" } })));
    assertUnsafe(path);
  });
  test("hostless legacy records refuse takeover", () => {
    const path = lockPath(); writeFileSync(path, JSON.stringify({ token: "legacy", pid: 999999999, acquiredAt: 0 }));
    assertUnsafe(path);
  });
  test("same-host live owners remain busy", () => {
    const path = lockPath(); writeFileSync(path, JSON.stringify(record({ pid: process.pid })));
    expect(tryAcquire(path, deps)).toEqual({ ok: false, error: "locked" });
  });
  test("same-host proven dead owners are taken over", () => {
    const path = lockPath(); writeFileSync(path, JSON.stringify(record()));
    const result = tryAcquire(path, deps); expect(result.ok).toBe(true);
    if (result.ok) release(result.handle);
  });
  test("a reused PID with another start identity is never taken over", () => {
    const path = lockPath(); writeFileSync(path, JSON.stringify(record()));
    expect(tryAcquire(path, { ...deps, processStart: () => "new-start" })).toEqual({ ok: false, error: "locked" });
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe("old");
  });
  test("unreadable host identity writes hostless and cannot break hostless evidence", () => {
    const path = lockPath();
    const unknown = { ...deps, hostIdentity: () => { throw Error("unavailable identity"); } };
    const acquired = tryAcquire(path, unknown); expect(acquired.ok).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).host).toBeUndefined();
    assertUnsafe(path, unknown);
    if (acquired.ok) release(acquired.handle);
  });
  test("Windows unknown liveness is alive", () => {
    const path = lockPath(); writeFileSync(path, JSON.stringify(record()));
    expect(tryAcquire(path, { ...deps, platform: "win32", isProcessAlive: () => undefined })).toEqual({ ok: false, error: "locked" });
  });
  test("a lock path symlink is unsafe", () => {
    const path = lockPath(), target = path + ".target";
    writeFileSync(target, JSON.stringify(record())); require("node:fs").symlinkSync(target, path);
    assertUnsafe(path);
    expect(require("node:fs").lstatSync(path).isSymbolicLink()).toBe(true);
  });
  test.skipIf(process.platform === "win32")("a lock owned by another uid is unsafe", () => {
    const path = lockPath(); writeFileSync(path, JSON.stringify(record()));
    const fs = require("node:fs") as typeof import("node:fs");
    assertUnsafe(path, { ...deps, lstat: p => {
      const stat = fs.lstatSync(p);
      if (p === path) Object.defineProperty(stat, "uid", { value: (process.getuid?.() ?? 0) + 1 });
      return stat;
    } });
  });
  for (const kind of ["symlink", "file"] as const) test(`a ${kind} claims namespace is unsafe`, () => {
    const path = lockPath(), dir = path + ".claims", fs = require("node:fs") as typeof import("node:fs");
    if (kind === "file") writeFileSync(dir, "preserve");
    else { fs.mkdirSync(dir + ".target"); fs.symlinkSync(dir + ".target", dir); }
    const result = tryAcquire(path, deps);
    expect(result).toEqual({ ok: false, error: "unsafe", detail: dir });
    expect(fs.lstatSync(dir).isSymbolicLink() ? fs.readlinkSync(dir) : readFileSync(dir, "utf8")).toBe(kind === "file" ? "preserve" : dir + ".target");
  });
  for (const kind of ["symlink", "directory"] as const) test(`a ${kind} claim entry is unsafe and preserved`, () => {
    const path = lockPath(), dir = path + ".claims", fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(dir); const entry = join(dir, "999999999-0123456789abcdef.claim");
    if (kind === "directory") fs.mkdirSync(entry);
    else { writeFileSync(path + ".target", "preserve"); fs.symlinkSync(path + ".target", entry); }
    expect(tryAcquire(path, deps)).toEqual({ ok: false, error: "unsafe", detail: entry });
    expect(fs.lstatSync(entry).isSymbolicLink() || fs.lstatSync(entry).isDirectory()).toBe(true);
  });
  for (const kind of ["directory", "entry"] as const) test.skipIf(process.platform === "win32")(`another uid's claims ${kind} refuses without running the writer`, () => {
    const path = lockPath(), dir = path + ".claims", fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(dir); const entry = join(dir, "999999999-0123456789abcdef.claim");
    const body = JSON.stringify({ ...record(), ticket: 1 }); writeFileSync(entry, body);
    const foreign = kind === "directory" ? dir : entry;
    const injected = { ...ownerDefaults, ...deps, lstat: (p: string) => {
      const stat = fs.lstatSync(p);
      if (p === foreign) Object.defineProperty(stat, "uid", { value: (process.getuid?.() ?? 0) + 1 });
      return stat;
    } };
    let ran = false;
    const { withLockClaim } = require("../../src/codex/prompt-lock-claim") as typeof import("../../src/codex/prompt-lock-claim");
    expect(() => withLockClaim(path, "fedcba9876543210", injected, () => { ran = true; })).toThrow("Unsafe lock state");
    expect(ran).toBe(false); expect(readFileSync(entry, "utf8")).toBe(body);
  });
  test("incomplete hostless claim debris is unsafe and names its path", () => {
    const path = lockPath(), dir = path + ".claims";
    require("node:fs").mkdirSync(dir); const entry = join(dir, "999999999-0123456789abcdef.claim");
    writeFileSync(entry, "");
    expect(tryAcquire(path, deps)).toEqual({ ok: false, error: "unsafe", detail: entry });
    expect(readFileSync(entry, "utf8")).toBe("");
  });
  for (const killed of [false, true]) test(killed ? "a killed initialized reservation is recovered" : "a live paused initializer yields busy", async () => {
    const path = lockPath();
    const child = Bun.spawn([process.execPath, "-e", `
      const {readSync}=require('node:fs');
      const {tryAcquire,release}=require(${JSON.stringify(repoPath("src/codex/prompt-lock.ts"))});
      const acquired=tryAcquire(${JSON.stringify(path)},{now:Date.now,isProcessAlive:pid=>{try{process.kill(pid,0);return true}catch{return false}},
        onClaimInitialized(){console.log('initialized');readSync(0,Buffer.alloc(1),0,1,null);}});
      if(acquired.ok)release(acquired.handle);
    `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      const reader = child.stdout.getReader(); const message = await reader.read(); reader.releaseLock();
      expect(new TextDecoder().decode(message.value)).toContain("initialized");
      if (killed) { child.kill(); await child.exited; }
      const result = tryAcquire(path);
      if (killed) { expect(result.ok).toBe(true); if (result.ok) release(result.handle); }
      else { expect(result).toEqual({ ok: false, error: "locked" }); child.stdin.write("g"); child.stdin.end(); expect(await child.exited).toBe(0); }
    } finally { child.kill(); }
  });
});


test("Windows acquisitions rely on profile ACLs without spawning a claims hardener", () => {
  const path = lockPath();
  let hardened = 0;
  const deps = {
    isProcessAlive: () => true, now: () => 0, platform: "win32" as const,
    hostIdentity: () => ({ hostname: "fixture-host", machine: "fixture-machine" }),
    processStart: () => "fixture-start",
    hardenDirectory: () => { hardened++; return false; },
  };
  const spawned = spyOn(Bun, "spawnSync");
  try {
    for (let i = 0; i < 10; i++) {
      const result = tryAcquire(path, deps);
      expect(result.ok).toBe(true);
      if (result.ok) expect(release(result.handle)).toBe(true);
    }
    expect(hardened).toBe(0);
    expect(spawned).not.toHaveBeenCalled();
  } finally { spawned.mockRestore(); }
});

for (const available of [true, false]) test(`Windows identity commands are cached across acquisitions (${available ? "available" : "unavailable"})`, () => {
  const path = lockPath(), commands: string[][] = [];
  const guid = "01234567-89ab-cdef-0123-456789abcdef";
  const identity = createOwnerIdentity({
    platform: "win32", regExe: () => "fixture-reg.exe", powerShellExe: () => "fixture-powershell.exe",
    runCommand(args, timeoutMs) {
      expect(timeoutMs).toBe(args[0] === "fixture-reg.exe" ? 3000 : 1000);
      commands.push(args);
      return available ? (args[0] === "fixture-reg.exe"
        ? `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${guid}\r\n` : "fixture-start") : undefined;
    },
  });
  expect(commands).toHaveLength(0);
  const deps = { ...alive, ...identity, platform: "win32" as const };
  for (let i = 0; i < 20; i++) {
    const result = tryAcquire(path, deps);
    expect(result.ok).toBe(true);
    const record = JSON.parse(readFileSync(path, "utf8"));
    expect(record.host?.machine).toBe(available ? guid : undefined);
    expect(record.processStart).toBeUndefined();
    expect(tryAcquire(path, deps)).toEqual(available
      ? { ok: false, error: "locked" } : { ok: false, error: "unsafe", detail: path });
    if (result.ok) expect(release(result.handle)).toBe(true);
  }
  expect(commands).toHaveLength(1);
  expect(commands.filter(args => args.at(-1)!.includes("MachineGuid"))).toHaveLength(1);
  expect(commands[0]).toEqual(["fixture-reg.exe", "query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
  // A live or unknown foreign PID does not require a start-time subprocess.
  writeFileSync(path, JSON.stringify({ token: "old", pid: 999999999, acquiredAt: 0,
    host: identity.hostIdentity(), processStart: "fixture-start" }));
  for (const liveness of [true, undefined]) {
    const result = tryAcquire(path, { ...deps, isProcessAlive: () => liveness });
    expect(result.ok).toBe(false);
  }
  expect(commands).toHaveLength(1);
  if (available) {
    const result = tryAcquire(path, { ...deps, isProcessAlive: () => false });
    expect(result.ok).toBe(true);
    expect(commands).toHaveLength(2);
    expect(commands[1]!.at(-1)).toContain("Get-Process -Id 999999999 ");
    if (result.ok) expect(release(result.handle)).toBe(true);
  }
});


test("failed Windows identity command leaves our hostless record unsafe for an identified peer", () => {
  const path = lockPath(); let calls = 0;
  const unavailable = createOwnerIdentity({ platform: "win32", regExe: () => "fixture-reg.exe",
    powerShellExe: () => { throw Error("PowerShell must not resolve during acquisition"); },
    runCommand: () => { calls++; throw Error("injected command failure"); } });
  const acquired = tryAcquire(path, { ...alive, ...unavailable });
  expect(acquired.ok).toBe(true);
  const before = readFileSync(path, "utf8");
  expect(JSON.parse(before).host).toBeUndefined();
  expect(tryAcquire(path, { ...dead, hostIdentity: () => ({ hostname: "peer", machine: "peer-machine" }) }))
    .toEqual({ ok: false, error: "unsafe", detail: path });
  expect(readFileSync(path, "utf8")).toBe(before); expect(calls).toBe(1);
  if (acquired.ok) expect(release(acquired.handle)).toBe(true);
});

for (const lives of [[true], [undefined], [false, true], [false, undefined], [false, false]] as const) {
  test(`unknown start evidence requires two dead observations (${lives.join(",")})`, () => {
    const host = { hostname: "fixture", machine: "fixture-machine" };
    let probes = 0, startProbes = 0;
    const deps = { ...ownerDefaults, hostIdentity: () => host,
      processStart: () => { startProbes++; return "another-start"; },
      isProcessAlive: () => lives[Math.min(probes++, lives.length - 1)] };
    expect(ownerState({ pid: 999999999, host }, deps)).toBe(lives.length === 2 && lives[1] === false ? "dead" : "live");
    expect(probes).toBe(lives.length); expect(startProbes).toBe(0);
  });
}

test("unknown Windows start evidence preserves grace, live owners and stale takeover", () => {
  const host = { hostname: "fixture", machine: "fixture-machine" }, path = lockPath();
  const deps = { ...dead, hostIdentity: () => host, processStart: () => undefined, platform: "win32" as const };
  const body = JSON.stringify({ token: "old", pid: 999999999, host, acquiredAt: 1_000_000 });
  writeFileSync(path, body);
  expect(tryAcquire(path, { ...deps, now: () => 1_000_005 })).toEqual({ ok: false, error: "locked" });
  expect(tryAcquire(path, { ...deps, isProcessAlive: () => true })).toEqual({ ok: false, error: "locked" });
  expect(readFileSync(path, "utf8")).toBe(body);
  const acquired = tryAcquire(path, deps); expect(acquired.ok).toBe(true);
  if (acquired.ok) expect(release(acquired.handle)).toBe(true);
});

const guid = "01234567-89ab-cdef-0123-456789abcdef";
for (const output of [guid, `HKEY_LOCAL_MACHINE\\OTHER\r\n    MachineGuid    REG_SZ    ${guid}`,
  `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_BINARY    ${guid}`,
  `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    invalid`,
  `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${guid} extra`,
  `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${guid}\r\n    MachineGuid    REG_SZ    ${guid}`]) {
  test(`Windows identity rejects malformed registry output: ${JSON.stringify(output)}`, () => {
    const identity = createOwnerIdentity({ platform: "win32", regExe: () => "fixture-reg.exe", runCommand: () => output });
    expect(identity.hostIdentity()).toBeUndefined();
  });
}

for (const primary of ["missing", "invalid", "valid"] as const) test(`Linux machine identity reads files without spawning (${primary})`, () => {
  const reads: string[] = [], machine = "0123456789abcdef0123456789abcdef";
  const identity = createOwnerIdentity({ platform: "linux",
    runCommand: () => { throw Error("must not spawn"); }, readFile: path => {
      reads.push(path);
      if (path === "/etc/machine-id") {
        if (primary === "missing") throw Error("missing");
        return primary === "invalid" ? "not-machine-id" : machine + "\n";
      }
      return machine + "\n";
    } });
  expect(identity.hostIdentity()?.machine).toBe(machine); identity.hostIdentity();
  expect(reads).toEqual(primary === "valid" ? ["/etc/machine-id"] : ["/etc/machine-id", "/var/lib/dbus/machine-id"]);
});

test.skipIf(process.platform !== "win32")("native Windows own evidence has a registry host and unknown start", () => {
  const evidence = ownEvidence(ownerDefaults);
  expect(evidence.host?.machine).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(evidence.processStart).toBeUndefined();
});
