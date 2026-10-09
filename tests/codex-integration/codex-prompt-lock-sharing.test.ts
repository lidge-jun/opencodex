import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { release, stillHeld, tryAcquire, type LockDeps } from "../../src/codex/prompt-lock";
import { withLockClaim } from "../../src/codex/prompt-lock-claim";
import { ownerDefaults } from "../../src/codex/prompt-lock-owner";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];
const restores: Array<() => void> = [];
const host = { hostname: "fixture", machine: "sharing-test" };
const deps: LockDeps = { ...ownerDefaults, platform: "win32", hostIdentity: () => host,
  processStart: () => undefined, isProcessAlive: () => false, now: () => 100_000 };
function setup() {
  const root = fs.mkdtempSync(join(tmpdir(), "ocx-lock-sharing-")); roots.push(root);
  const path = join(root, "prompt.lock"), peer = join(path + ".claims", "999999999-0123456789abcdef.claim");
  const body = JSON.stringify({ token: "old", pid: 999999999, host, acquiredAt: 0 });
  return { path, peer, body };
}
function sharing(code: string) { return Object.assign(new Error(code), { code }); }
afterEach(() => {
  while (restores.length) restores.pop()!();
  while (roots.length) removeTreeWithRetry(roots.pop()!);
});

type Method = "mkdirSync" | "writeFileSync" | "linkSync" | "unlinkSync" | "renameSync" | "readFileSync" | "readdirSync";
const stages: Array<{ name: string; method: Method; matches: (args: unknown[], path: string, peer: string) => boolean; stale?: boolean; peer?: boolean }> = [
  { name: "claims directory open", method: "mkdirSync", matches: ([p], path) => p === path + ".claims" },
  { name: "initial choosing open", method: "writeFileSync", matches: ([p, body], path) => String(p).startsWith(path + ".claim-init-") && JSON.parse(String(body)).ticket === 0 },
  { name: "choosing hard link", method: "linkSync", matches: ([p], path) => String(p).startsWith(path + ".claim-init-") },
  { name: "initial temporary unlink", method: "unlinkSync", matches: ([p], path) => String(p).startsWith(path + ".claim-init-") },
  { name: "claim scan open", method: "readdirSync", matches: ([p], path) => p === path + ".claims" },
  { name: "peer evidence open", method: "readFileSync", peer: true, matches: ([p], _path, peer) => p === peer },
  { name: "dead peer unlink", method: "unlinkSync", peer: true, matches: ([p], _path, peer) => p === peer },
  { name: "ticket temporary open", method: "writeFileSync", matches: ([p, body], path) => String(p).startsWith(path + ".claim-init-") && JSON.parse(String(body)).ticket > 0 },
  { name: "ticket publication rename", method: "renameSync", matches: ([p], path) => String(p).startsWith(path + ".claim-init-") },
  { name: "exclusive lock open", method: "writeFileSync", matches: ([p], path) => p === path },
  { name: "stale evidence open", method: "readFileSync", stale: true, matches: ([p], path) => p === path },
  { name: "stale quarantine rename", method: "renameSync", stale: true, matches: ([p], path) => p === path },
  { name: "post-quarantine lock open", method: "writeFileSync", stale: true, matches: ([p], path) => p === path && !fs.existsSync(path) },
];
for (const code of ["EPERM", "EBUSY", "EACCES"]) for (const stage of stages) for (const exhausted of [false, true]) {
  test(`${stage.name}: ${code} ${exhausted ? "exhausts as busy" : "retries"} without bypassing ownership`, () => {
    const { path, peer, body } = setup();
    if (stage.stale) fs.writeFileSync(path, body);
    if (stage.peer) {
      fs.mkdirSync(path + ".claims");
      fs.writeFileSync(peer, JSON.stringify({ pid: 999999999, host, ticket: 1 }));
    }
    const original = fs[stage.method] as (...args: unknown[]) => unknown;
    let attempts = 0; const sleeps: number[] = [];
    const sleep = spyOn(Bun, "sleepSync").mockImplementation(ms => { sleeps.push(ms); }); restores.push(() => sleep.mockRestore());
    const target = fs as unknown as Record<Method, (...args: unknown[]) => unknown>;
    const spy = spyOn(target, stage.method).mockImplementation((...args) => {
      if (stage.matches(args, path, peer)) {
        attempts++;
        if (exhausted || attempts === 1) throw sharing(code);
      }
      return Reflect.apply(original, fs, args);
    }); restores.push(() => spy.mockRestore());
    const result = tryAcquire(path, deps);
    spy.mockRestore();
    expect(attempts).toBeGreaterThanOrEqual(exhausted ? 3 : 2);
    expect(sleeps.slice(0, exhausted ? 2 : 1)).toEqual(exhausted ? [25, 50] : [25]);
    if (exhausted) {
      expect(result).toEqual({ ok: false, error: "locked" });
      if (stage.stale && stage.name !== "post-quarantine lock open") expect(fs.readFileSync(path, "utf8")).toBe(body);
      else expect(fs.existsSync(path)).toBe(false);
      if (stage.peer) expect(fs.existsSync(peer)).toBe(true);
    } else {
      expect(result.ok).toBe(true);
      if (result.ok) expect(JSON.parse(fs.readFileSync(path, "utf8")).token).toBe(result.handle.token);
    }
  });
}

for (const code of ["EPERM", "EBUSY", "EACCES"]) {
  test(`namespace metadata ${code} is bounded contention`, () => {
    const { path } = setup(); let attempts = 0;
    const sleep = spyOn(Bun, "sleepSync").mockImplementation(() => {}); restores.push(() => sleep.mockRestore());
    expect(tryAcquire(path, { ...deps, lstat: () => { attempts++; throw sharing(code); } })).toEqual({ ok: false, error: "locked" });
    expect(attempts).toBe(3); expect(fs.existsSync(path)).toBe(false);
  });
  test(`writer ${code} escapes unchanged after acquiring a reservation`, () => {
    const { path } = setup(), error = sharing(code);
    expect(() => withLockClaim(path, "fedcba9876543210", { ...ownerDefaults, ...deps }, () => { throw error; })).toThrow(error);
    expect(fs.existsSync(path + ".claims")).toBe(false);
  });
  for (const target of ["reservation", "quarantine"] as const) test(`${target} cleanup tolerates exhausted ${code}`, () => {
    const { path, body } = setup(); fs.writeFileSync(path, body);
    const original = fs.unlinkSync; let attempts = 0;
    const sleep = spyOn(Bun, "sleepSync").mockImplementation(() => {}); restores.push(() => sleep.mockRestore());
    const spy = spyOn(fs, "unlinkSync").mockImplementation(p => {
      if (target === "reservation" ? String(p).endsWith(".claim") : String(p).startsWith(path + ".stale-")) {
        attempts++; throw sharing(code);
      }
      original(p);
    }); restores.push(() => spy.mockRestore());
    const acquired = tryAcquire(path, deps);
    expect(acquired.ok).toBe(true); expect(attempts).toBe(3);
    if (acquired.ok) expect(JSON.parse(fs.readFileSync(path, "utf8")).token).toBe(acquired.handle.token);
  });
  for (const successor of [false, true]) test(`release ${code} retries with a fresh token check (successor=${successor})`, () => {
    const { path } = setup(); const acquired = tryAcquire(path, deps);
    if (!acquired.ok) throw Error("setup");
    const platform = ownerDefaults.platform; ownerDefaults.platform = "win32"; restores.push(() => { ownerDefaults.platform = platform; });
    const original = fs.unlinkSync; let attempts = 0;
    const sleep = spyOn(Bun, "sleepSync").mockImplementation(() => {
      if (successor) fs.writeFileSync(path, JSON.stringify({ token: "successor", pid: 42 }));
    }); restores.push(() => sleep.mockRestore());
    const spy = spyOn(fs, "unlinkSync").mockImplementation(p => {
      if (String(p) === path && ++attempts === 1) throw sharing(code);
      original(p);
    }); restores.push(() => spy.mockRestore());
    expect(release(acquired.handle)).toBe(!successor);
    expect(attempts).toBe(successor ? 1 : 2);
    if (successor) {
      expect(JSON.parse(fs.readFileSync(path, "utf8")).token).toBe("successor");
      expect(stillHeld(acquired.handle)).toBe(false);
    } else expect(fs.existsSync(path)).toBe(false);
  });
}

for (const code of ["EPERM", "EBUSY", "EACCES"]) {
  test(`exclusive open ${code} followed by EEXIST cannot enter takeover`, () => {
    const { path, body } = setup(); fs.writeFileSync(path, body);
    const original = fs.writeFileSync; let attempts = 0;
    const sleep = spyOn(Bun, "sleepSync").mockImplementation(() => {}); restores.push(() => sleep.mockRestore());
    const spy = spyOn(fs, "writeFileSync").mockImplementation((p, data, options) => {
      if (String(p) === path && ++attempts === 1) throw sharing(code);
      original(p, data, options);
    }); restores.push(() => spy.mockRestore());
    expect(tryAcquire(path, deps)).toEqual({ ok: false, error: "locked" });
    expect(attempts).toBe(2); expect(fs.readFileSync(path, "utf8")).toBe(body);
  });
  test(`release preserves its lock when ${code} exhausts`, () => {
    const { path } = setup(); const acquired = tryAcquire(path, deps);
    if (!acquired.ok) throw Error("setup");
    const body = fs.readFileSync(path, "utf8"), platform = ownerDefaults.platform;
    ownerDefaults.platform = "win32"; restores.push(() => { ownerDefaults.platform = platform; });
    const original = fs.unlinkSync; let attempts = 0;
    const sleep = spyOn(Bun, "sleepSync").mockImplementation(() => {}); restores.push(() => sleep.mockRestore());
    const spy = spyOn(fs, "unlinkSync").mockImplementation(p => {
      if (String(p) === path) { attempts++; throw sharing(code); }
      original(p);
    }); restores.push(() => spy.mockRestore());
    expect(release(acquired.handle)).toBe(false); expect(attempts).toBe(3);
    expect(fs.readFileSync(path, "utf8")).toBe(body);
  });
}
