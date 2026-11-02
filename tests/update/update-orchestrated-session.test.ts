import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { repoPath } from "../helpers/repo-root";
import { isUpdateInFlight, tryAcquireUpdateSyncMutex } from "../../src/update/sync-update-mutex";
import { createOrchestratedChildSession, encodeOrchestratedExpect, decodeOrchestratedExpect } from "../../src/update/orchestrated-session.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ocx-session-")); roots.push(home);
  return { home, resultPath: join(home, "result.json"), expect: { home, cliRoot: join(home, "cli"), servingRoot: null, runtimePid: null, planToken: "a".repeat(43) } };
}
function read(path: string) { return JSON.parse(readFileSync(path, "utf8")); }

test("preflight must be writable before proceeding", () => {
  const f = fixture();
  const session = createOrchestratedChildSession({ ...f, resultPath: join(f.home, "missing", "result"), verifyIdentity: () => true });
  expect(() => session.start()).toThrow();
  expect(isUpdateInFlight(f.home)).toBe(false);
});

test("sync holder refuses without writing an orchestrated marker", async () => {
  const f = fixture(); const lock = tryAcquireUpdateSyncMutex(f.home, "sync");
  if (lock.kind !== "acquired") throw new Error("fixture lock");
  try {
    const session = createOrchestratedChildSession({ ...f, verifyIdentity: () => true }); session.start();
    expect(await session.enterMutation()).toEqual({ ok: false, error: "sync-in-progress" });
    expect(read(f.resultPath)).toEqual({ phase: "refused", error: "sync-in-progress" });
    expect(existsSync(join(f.home, "update-orchestrated.json"))).toBe(false);
  } finally { lock.release(); }
});

test("deadline check sees update in flight before refusing and releases the lock", async () => {
  const f = fixture(); let observed = false;
  const session = createOrchestratedChildSession({ ...f, notAfter: 10, now: () => {
    if (existsSync(join(f.home, "update-orchestrated.json"))) observed = isUpdateInFlight(f.home);
    return 11;
  }, verifyIdentity: () => { throw new Error("should not run"); } });
  session.start(); expect(await session.enterMutation()).toEqual({ ok: false, error: "deadline-passed" });
  expect(observed).toBe(true);
  expect(read(join(f.home, "update-orchestrated.json")).phase).toBe("refused");
  expect(read(f.resultPath)).toEqual({ phase: "refused", error: "deadline-passed" });
  expect(isUpdateInFlight(f.home)).toBe(false);
});

test.each([false, "throw"] as const)("identity %s refuses after publishing in-flight", async value => {
  const f = fixture(); let observed = false;
  const session = createOrchestratedChildSession({ ...f, verifyIdentity: async () => {
    observed = isUpdateInFlight(f.home); if (value === "throw") throw new Error("identity"); return value;
  } });
  session.start(); expect(await session.enterMutation()).toEqual({ ok: false, error: "plan-changed" });
  expect(observed).toBe(true); expect(isUpdateInFlight(f.home)).toBe(false);
  expect(read(join(f.home, "update-orchestrated.json")).phase).toBe("refused");
});

test("finish writes final outcome before releasing mutex; failed marker write keeps mutex", async () => {
  const f = fixture(); const session = createOrchestratedChildSession({ ...f, verifyIdentity: () => true });
  session.start(); expect(await session.enterMutation()).toEqual({ ok: true });
  const marker = join(f.home, "update-orchestrated.json"); rmSync(marker); mkdirSync(marker);
  expect(() => session.finish({ phase: "installed", activeRoot: "/active" })).toThrow();
  expect(read(f.resultPath)).toEqual({ phase: "installed", activeRoot: "/active" });
  expect(isUpdateInFlight(f.home)).toBe(true);
  rmSync(marker, { recursive: true }); session.finish({ phase: "installed", activeRoot: "/active" });
  expect(isUpdateInFlight(f.home)).toBe(false); expect(read(marker).phase).toBe("installed");
});

test("unreadable marker fails closed and a stale dead holder is recovered", () => {
  const f = fixture(); const marker = join(f.home, "update-orchestrated.json"); mkdirSync(marker);
  expect(isUpdateInFlight(f.home)).toBe(true); rmSync(marker, { recursive: true });
  const lock = join(f.home, "sync-update.mutation.lock"); mkdirSync(lock);
  const instance = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", token = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const owner = join(lock, `v1-${process.pid}-${instance}-${token}.json`);
  writeFileSync(owner, JSON.stringify({ version: 1, pid: process.pid, processInstance: instance, token, createdAt: 1000, holderKind: "sync" })); utimesSync(owner, 1, 1);
  const acquired = tryAcquireUpdateSyncMutex(f.home, "update", { now: () => 100_000, processAlive: () => false });
  expect(acquired.kind).toBe("acquired"); if (acquired.kind === "acquired") acquired.release();
});

test("expect round trips and malformed payloads are rejected", () => {
  const f = fixture(); expect(decodeOrchestratedExpect(encodeOrchestratedExpect(f.expect))).toEqual(f.expect);
  for (const bad of ["", "!", "e30", "eyJob21lIjoxfQ", Buffer.from(JSON.stringify({ ...f.expect, runtimePid: -1 })).toString("base64url"), Buffer.from(JSON.stringify({ ...f.expect, planToken: "short" })).toString("base64url")]) {
    expect(() => decodeOrchestratedExpect(bad)).toThrow();
  }
});

test("plain Node performs the session lifecycle", () => {
  const f = fixture();
  const url = pathToFileURL(repoPath("src/update/orchestrated-session.mjs")).href;
  const script = `const { createOrchestratedChildSession } = await import(${JSON.stringify(url)});
    const f = ${JSON.stringify(f)};
    const session = createOrchestratedChildSession({ ...f, verifyIdentity: () => true });
    session.start(); if (!(await session.enterMutation()).ok) process.exit(2);
    session.finish({ phase: "failed", error: "test" });`;
  const result = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" });
  expect(result.stderr).toBe(""); expect(result.status).toBe(0);
  expect(read(f.resultPath)).toEqual({ phase: "failed", error: "test" });
  expect(read(join(f.home, "update-orchestrated.json")).phase).toBe("failed");
  expect(isUpdateInFlight(f.home)).toBe(false);
});
