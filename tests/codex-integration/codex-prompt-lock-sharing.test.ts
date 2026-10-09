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

for (const code of ["EPERM", "EBUSY", "EACCES"]) {
  test(`abandoned live-self reservation after ${code} exhaustion permits reacquisition`, () => {
    const { path } = setup(); const original = fs.unlinkSync; let attempts = 0;
    const liveSelf = { ...deps, isProcessAlive: ownerDefaults.isProcessAlive };
    const sleep = spyOn(Bun, "sleepSync").mockImplementation(() => {}); restores.push(() => sleep.mockRestore());
    const spy = spyOn(fs, "unlinkSync").mockImplementation(p => {
      if (String(p).endsWith(".claim")) { attempts++; throw sharing(code); }
      original(p);
    }); restores.push(() => spy.mockRestore());
    const first = tryAcquire(path, liveSelf); expect(first.ok).toBe(true); expect(attempts).toBe(3);
    spy.mockRestore();
    expect(fs.readdirSync(path + ".claims")).toHaveLength(1);
    if (!first.ok) throw Error("setup");
    expect(release(first.handle)).toBe(true);
    const next = tryAcquire(path, liveSelf); expect(next.ok).toBe(true);
    if (next.ok) expect(release(next.handle)).toBe(true);
    expect(fs.existsSync(path + ".claims")).toBe(false);
  });
  for (const stage of ["peer deletion", "ticket publication", "reservation cleanup"] as const) {
    for (const replacement of ["entry", "contents", "parent"] as const) {
      test(`${stage}: ${code} retry preserves replaced ${replacement}`, () => {
        const { path, peer } = setup(), directory = path + ".claims";
        if (stage === "peer deletion") {
          fs.mkdirSync(directory);
          fs.writeFileSync(peer, JSON.stringify({ pid: 999999999, host, ticket: 1 }));
        }
        let target = "", attempts = 0, replaced = false;
        const replacementBody = JSON.stringify({ pid: process.pid, host, ticket: 0, token: "replacement" });
        const sleep = spyOn(Bun, "sleepSync").mockImplementation(() => {
          if (!target || replaced) return;
          replaced = true;
          if (replacement === "parent") {
            fs.renameSync(directory, directory + ".original"); fs.mkdirSync(directory);
          } else if (replacement === "entry") fs.renameSync(target, target + ".original");
          fs.writeFileSync(target, replacementBody);
        }); restores.push(() => sleep.mockRestore());
        const unlink = fs.unlinkSync, rename = fs.renameSync;
        const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation(p => {
          const name = String(p);
          if (stage === "peer deletion" ? name === peer : stage === "reservation cleanup" && name.endsWith(".claim")) {
            target = name; attempts++; if (attempts === 1) throw sharing(code);
          }
          unlink(p);
        }); restores.push(() => unlinkSpy.mockRestore());
        const renameSpy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
          if (stage === "ticket publication" && String(from).startsWith(path + ".claim-init-")) {
            target = String(to); attempts++; if (attempts === 1) throw sharing(code);
          }
          rename(from, to);
        }); restores.push(() => renameSpy.mockRestore());
        tryAcquire(path, deps);
        expect(replaced).toBe(true); expect(attempts).toBe(1);
        expect(fs.readFileSync(target, "utf8")).toBe(replacementBody);
      });
    }
  }
}

test("an active live-self reservation cannot be recovered as abandoned", () => {
  const { path } = setup(); let nested: unknown;
  const liveSelf = { ...deps, isProcessAlive: ownerDefaults.isProcessAlive };
  const first = tryAcquire(path, { ...liveSelf, onClaimInitialized: () => {
    nested = tryAcquire(path, liveSelf);
    expect(fs.readdirSync(path + ".claims")).toHaveLength(1);
  } });
  expect(nested).toEqual({ ok: false, error: "locked" }); expect(first.ok).toBe(true);
  if (first.ok) expect(release(first.handle)).toBe(true);
});

test("a peer released between directory scan and evidence capture is not unsafe", () => {
  const { path, peer } = setup(); fs.mkdirSync(path + ".claims");
  fs.writeFileSync(peer, JSON.stringify({ pid: 999999999, host, ticket: 1 }));
  let reads = 0;
  const acquired = tryAcquire(path, { ...deps, lstat: p => {
    if (p === peer && ++reads === 2) fs.unlinkSync(peer);
    return fs.lstatSync(p);
  } });
  expect(acquired.ok).toBe(true);
  if (acquired.ok) expect(release(acquired.handle)).toBe(true);
});

for (const code of ["EPERM", "EBUSY", "EACCES"]) {
  for (const stage of ["stale rename", "quarantine cleanup", "failed-create cleanup", "exclusive creation", "post-quarantine creation", "lock release"] as const) {
    const replacements = stage.includes("creation") ? ["parent", "parent-link"] as const : ["entry", "contents", "parent", "parent-link"] as const;
    for (const replacement of replacements) test(`${stage}: ${code} retry fences replaced ${replacement}`, () => {
      const { path, body } = setup(), root = join(path, "..");
      const stale = !["exclusive creation", "lock release"].includes(stage);
      if (stale) fs.writeFileSync(path, body);
      const held = stage === "lock release" ? tryAcquire(path, deps) : undefined;
      if (held && !held.ok) throw Error("setup");
      const platform = ownerDefaults.platform;
      ownerDefaults.platform = "win32"; restores.push(() => { ownerDefaults.platform = platform; });
      const unlink = fs.unlinkSync, rename = fs.renameSync, write = fs.writeFileSync;
      let target = "", attempts = 0, replaced = false;
      let replacementBody = "", savedBody = "", originalTarget = "";
      const sleep = spyOn(Bun, "sleepSync").mockImplementation(() => {
        if (!target || replaced) return;
        replaced = true;
        savedBody = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
        // Preserve the token for release/entry replacements: token-only checks miss these.
        replacementBody = replacement === "contents"
          ? JSON.stringify({ ...JSON.parse(savedBody), pid: process.pid, acquiredAt: 100_000, extra: "replacement" })
          : savedBody || JSON.stringify({ token: "replacement", pid: process.pid, host, acquiredAt: 100_000 });
        if (replacement === "parent" || replacement === "parent-link") {
          const originalRoot = root + ".original"; roots.push(originalRoot);
          rename(root, originalRoot);
          originalTarget = join(originalRoot, target.slice(root.length + 1));
          if (replacement === "parent-link") fs.symlinkSync(originalRoot, root, "junction");
          else fs.mkdirSync(root);
        } else if (replacement === "entry") {
          originalTarget = target + ".original"; rename(target, originalTarget);
        }
        write(target, replacementBody);
      }); restores.push(() => sleep.mockRestore());
      const matches = (name: string) => stage === "stale rename" || stage.includes("creation") || stage === "lock release"
        ? name === path : name.startsWith(path + ".stale-");
      const hit = (name: string) => {
        if (!matches(name)) return;
        target = name; attempts++;
        if (attempts === 1) throw sharing(code);
      };
      const renameSpy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (stage === "stale rename") hit(String(from));
        rename(from, to);
      }); restores.push(() => renameSpy.mockRestore());
      const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation(p => {
        if (["quarantine cleanup", "failed-create cleanup", "lock release"].includes(stage)) hit(String(p));
        unlink(p);
      }); restores.push(() => unlinkSpy.mockRestore());
      const writeSpy = spyOn(fs, "writeFileSync").mockImplementation((p, data, options) => {
        if (stage === "failed-create cleanup" && String(p) === path && !fs.existsSync(path)) {
          write(path, JSON.stringify({ token: "successor", pid: process.pid, host, acquiredAt: 100_000 }));
        }
        if (stage === "exclusive creation" || (stage === "post-quarantine creation" && !fs.existsSync(path))) hit(String(p));
        write(p, data, options);
      }); restores.push(() => writeSpy.mockRestore());
      const result = held?.ok ? release(held.handle) : tryAcquire(path, { ...deps, isProcessAlive: pid => pid === process.pid });
      expect(replaced).toBe(true); expect(attempts).toBe(1);
      expect(fs.readFileSync(target, "utf8")).toBe(replacementBody);
      if (originalTarget && replacement !== "parent-link" && savedBody) expect(fs.readFileSync(originalTarget, "utf8")).toBe(savedBody);
      if (stage === "lock release") expect(result).toBe(false);
      else if (!["quarantine cleanup"].includes(stage)) expect(result).toEqual({ ok: false, error: "locked" });
      if (stage === "failed-create cleanup") expect(JSON.parse(fs.readFileSync(replacement === "parent" ? join(root + ".original", "prompt.lock") : path, "utf8")).token).toBe("successor");
    });
  }
}
