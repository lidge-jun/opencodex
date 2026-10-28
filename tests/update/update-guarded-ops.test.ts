import { expect, test } from "bun:test";
import { guardedRun as run, materializeMutationData } from "../../src/update/mutation-guard.mjs";
import { createUpdateServiceHomePolicy } from "../../src/update/service-home-policy.mjs";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { guardedUpdateIo } from "../helpers/update-guarded-io.mjs";
import { guardedPublishJob } from "../../src/update/guarded-runtime-ops";
import { atomicWriteFile, renameAtomicFile, type AtomicWriteHooks } from "../../src/config/atomic-write";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

for (const shape of ["getter", "namedOptions", "spreadOptions", "memberOptions", "proxy"] as const) {
  test(`materialize ${shape} before authorization; no native operation after authority changes`, () => {
    let home: "same" | "unknown" = "same", calls = 0, reads = 0;
    const policy = createUpdateServiceHomePolicy(() => ({ kind: home }), () => {});
    const named = { get stdio() { reads++; home = "unknown"; return "ignore"; } };
    const options = shape === "spreadOptions" ? { ...named } : shape === "memberOptions" ? { stdio: named.stdio }
      : shape === "proxy" ? new Proxy({ stdio: "ignore" }, { get(target, key) { reads++; home = "unknown"; return Reflect.get(target, key); } }) : named;
    expect(() => run(policy.authorizeMutation, "runtime", (copy: any) => {
      // A native implementation consumes options only after entry.
      calls++; return copy.stdio;
    }, [options])).toThrow();
    expect(calls).toBe(0); expect(reads).toBe(1);
    home = "same";
    expect(policy.authorizeMutation("package")).toBe(false);
  });
}

test("materialization rejects functions in data, including a named accessor returning a callback", () => {
  let called = false;
  for (const options of [{ callback() {} }, { get stdio() { return () => {}; } }, [() => {}], { [Symbol("callback")]: () => {} }]) {
    expect(() => run(() => true, "runtime", () => { called = true; }, [options])).toThrow();
  }
  expect(called).toBe(false);
});

for (const phase of ["snapshot", "directory", "missing-authorizer"]) test(`job publication checks after ${phase} preparation`, () => {
  const source = readFileSync(repoPath("src/update/job.ts"), "utf8");
  const from = source.indexOf("function prepareUpdateJob("), to = source.indexOf("export function updateExecutionCommand", from);
  const writer = source.slice(source.indexOf("function writeJob("), source.indexOf("export function readUpdateJob("));
  const body = new Bun.Transpiler({ loader: "ts" }).transformSync(writer + source.slice(from, to));
  let home: "same" | "unknown" = "same", writes = 0;
  const policy = createUpdateServiceHomePolicy(() => ({ kind: home }), () => {});
  const execute = new Function("deps", `with(deps){${body}; return writeJob(prepareUpdateJob({id:"fixture",log:[]},{status:"succeeded"}),authorize,"publish");}`);
  expect(() => execute({ guardedRun: run, guardedPublishJob: (auth: any, kind: any, path: string, text: string) => run(auth, kind, () => { writes++; }, [path, text]), materializeMutationData, authorize: phase === "missing-authorizer" ? undefined : policy.authorizeMutation,
    readUpdateJob: () => { if (phase === "snapshot") home = "unknown"; return null; },
    ensureJobDir: () => { if (phase === "directory") home = "unknown"; }, updateJobPath: () => "/fixture/job",
    sanitizePersistedUpdateJob: (job: object) => job, atomicWriteFile: () => { writes++; } })).toThrow();
  expect(writes).toBe(0);
});

for (const phase of ["temp-preparation", "rename-retry", "stable"] as const) test(`publication rechecks at the actual atomic rename: ${phase}`, () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-publish-gate-"));
  let home: "same" | "unknown" = "same", attempts = 0;
  const policy = createUpdateServiceHomePolicy(() => ({ kind: home }), () => {});
  const native: typeof atomicWriteFile = (path, text, _io, hooks: AtomicWriteHooks = {}) => atomicWriteFile(path, text, {
    write() { if (phase === "temp-preparation") home = "unknown"; }, harden() {}, truncate() {}, unlink() {},
    rename: (from, to) => renameAtomicFile(from, to, { platform: "win32",
      rename() { attempts++; if (phase === "rename-retry" && attempts === 1) throw Object.assign(new Error("fixture hold"), { code: "EBUSY" }); },
      sleep() { home = "unknown"; },
    }, "config", hooks),
  }, hooks);
  try {
    const publish = () => guardedPublishJob(policy.authorizeMutation, "publish", join(root, "job.json"), '{"status":"succeeded"}', native);
    if (phase === "stable") { publish(); expect(attempts).toBe(1); }
    else { expect(publish).toThrow(); expect(attempts).toBe(phase === "temp-preparation" ? 0 : 1); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const phase of ["liveness", "grace-wait", "stable"] as const) test(`update kill checks immediately before every POSIX signal: ${phase}`, () => {
  const source = readFileSync(repoPath("src/update/guarded-runtime-ops.ts"), "utf8");
  const from = source.indexOf("export function guardedKillProxy"), to = source.indexOf("export function guardedPublishJob", from);
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(from, to).replace("export ", ""));
  let home: "same" | "unknown" = "same", waits = 0;
  const signals: string[] = [], policy = createUpdateServiceHomePolicy(() => ({ kind: home }), () => {});
  const invoke = () => new Function("deps", `with(deps){${js};return guardedKillProxy(authorize,"runtime",123);}`)({
    authorize: policy.authorizeMutation, guardedRun: run, materializeMutationData, process: { platform: "linux" },
    isProcessAlive: () => { if (phase === "liveness") home = "unknown"; return true; },
    waitForExit: () => { waits++; if (phase === "grace-wait") home = "unknown"; return waits > 1; },
    guardedKill: (auth: any, kind: any, pid: number, signal: string) => run(auth, kind, (_pid: number, s: string) => { signals.push(s); }, [pid, signal]),
  });
  if (phase === "stable") { invoke(); expect(signals).toEqual(["SIGTERM", "SIGKILL"]); }
  else { expect(invoke).toThrow(); expect(signals).toEqual(phase === "liveness" ? [] : ["SIGTERM"]); }
});

test("an asynchronous authorizer never dispatches a primitive", () => {
  let calls = 0;
  expect(() => run((() => Promise.resolve(true)) as never, "runtime", () => { calls++; }, [])).toThrow();
  expect(calls).toBe(0);
});

test("materialized nested data is detached, null-prototype and read exactly once", () => {
  let reads = 0;
  const input = { get env() { reads++; return { FLAG: "yes" }; }, args: ["a", "b"] };
  const result = run(() => { expect(reads).toBe(1); return true; }, "runtime", (copy: any) => copy, [input]);
  expect(result).not.toBe(input); expect(Object.getPrototypeOf(result)).toBeNull();
  expect(Object.getPrototypeOf(result.env)).toBeNull(); expect(result.args).toEqual(["a", "b"]);
  expect(reads).toBe(1);
});

test("data materialization discards inherited getters without invoking them", () => {
  let inheritedReads = 0;
  const env = Object.assign(Object.create({ get HIDDEN() { inheritedReads++; return "bad"; } }), { FLAG: "yes" });
  const result = run(() => true, "runtime", copy => copy, [env]);
  expect(result.FLAG).toBe("yes"); expect(result.HIDDEN).toBeUndefined(); expect(inheritedReads).toBe(0);
});

test("production pinned start rechecks after command accessors and closes its prepared log on refusal", () => {
  const source = readFileSync(repoPath("src/update/job-pinned-start.ts"), "utf8");
  const body = source.slice(source.indexOf("export function spawnWorkerPinnedStart")).replace("export ", "");
  let home: "same" | "unknown" = "same", nativeCalls = 0, closes = 0;
  const policy = createUpdateServiceHomePolicy(() => ({ kind: home }), () => {});
  const deps = {
    cmd: { get bin() { home = "unknown"; return "fixture-native"; }, args: [], display: "fixture" },
    authorize: policy.authorizeMutation, process: { env: {} },
    withoutSiblingMarker: () => ({}), getConfigDir: () => "/fixture", join: (...parts: string[]) => parts.join("/"),
    mkdirSync() {}, openSync: () => 7, writeSync() {}, closeSync: () => { closes++; },
    spawn: () => { nativeCalls++; return { once() {}, unref() {} }; },
  };
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(body);
  const execute = new Function("deps", `with(deps){${js};return spawnWorkerPinnedStart(cmd,authorize,()=>{},String);}`);
  expect(() => execute({ ...deps, ...guardedUpdateIo(deps) })).toThrow();
  expect(nativeCalls).toBe(0); expect(closes).toBe(1);
});
