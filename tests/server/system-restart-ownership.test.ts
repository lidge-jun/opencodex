import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { fixturePath, repoRoot } from "../helpers/repo-root";
import {
  getPidPath, getRuntimePortPath, readPidFileValue, readRuntimePort, writePid, writeRuntimePort,
} from "../../src/config/process-state";
import { inspectOwnershipMutationLease } from "../../src/service/ownership-mutation-lease.mjs";
import { serviceStatePaths } from "../../src/service/state";
import { retireRestartParentOwnership } from "../../src/server/restart-parent-ownership";
import { observeProxyLiveness } from "../../src/server/proxy-liveness";
import { isProcessAlive, killProxy } from "../../src/lib/process-control";

let home: TempHome | undefined;
let settleProcesses: (() => Promise<void>) | undefined;
afterEach(async () => {
  await settleProcesses?.();
  settleProcesses = undefined;
  home?.remove(); home = undefined;
});
function fixture(): TempHome { return home = createTempHome("ocx-restart-parent-ownership-"); }

test("retirement removes only the current parent's records and releases the ownership lease", () => {
  fixture();
  writePid(process.pid); writeRuntimePort({ pid: process.pid, port: 10123, hostname: "127.0.0.1" });
  retireRestartParentOwnership(10123);
  expect(existsSync(getPidPath())).toBe(false);
  expect(existsSync(getRuntimePortPath())).toBe(false);
  expect(inspectOwnershipMutationLease(serviceStatePaths())).toBeNull();
  expect(() => retireRestartParentOwnership(10123)).not.toThrow();
});

for (const mismatch of ["foreign-pid", "foreign-runtime", "different-port", "malformed-pid", "malformed-runtime"]) {
  test(`retirement refuses ${mismatch} without removing either ownership record`, () => {
    fixture();
    writePid(mismatch === "foreign-pid" ? process.pid + 1 : process.pid);
    writeRuntimePort({ pid: mismatch === "foreign-runtime" ? process.pid + 1 : process.pid, port: 10123 });
    if (mismatch === "malformed-pid") writeFileSync(getPidPath(), "not a pid");
    if (mismatch === "malformed-runtime") writeFileSync(getRuntimePortPath(), "{}");
    const before = [readFileSync(getPidPath(), "utf8"), readFileSync(getRuntimePortPath(), "utf8")];
    expect(() => retireRestartParentOwnership(mismatch === "different-port" ? 10124 : 10123))
      .toThrow("ownership could not be retired safely");
    expect([readFileSync(getPidPath(), "utf8"), readFileSync(getRuntimePortPath(), "utf8")]).toEqual(before);
    expect(inspectOwnershipMutationLease(serviceStatePaths())).toBeNull();
  });
}

test("a non-file runtime cannot retire the parent's alive-PID fence", () => {
  fixture(); writePid(process.pid); mkdirSync(getRuntimePortPath());
  expect(() => retireRestartParentOwnership()).toThrow();
  expect(readPidFileValue()).toBe(process.pid);
});

test.skipIf(process.platform === "win32")("a linked record is preserved, including its external target", () => {
  const owned = fixture(), target = owned.path("pid-target");
  writeFileSync(target, String(process.pid)); symlinkSync(target, getPidPath());
  expect(() => retireRestartParentOwnership()).toThrow();
  expect(readFileSync(target, "utf8")).toBe(String(process.pid));
  expect(existsSync(getPidPath())).toBe(true);
});

test("a genuinely exited parent remains an ordinary absent-owner control", async () => {
  fixture();
  const dead = Bun.spawn([process.execPath, "--version"], { stdout: "ignore", stderr: "ignore" });
  expect(await dead.exited).toBe(0);
  writePid(dead.pid);
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
  const port = listener.port!; await listener.stop(true);
  writeRuntimePort({ pid: dead.pid, port, hostname: "127.0.0.1" });
  const observed = await observeProxyLiveness({ configFn: () => ({ port, hostname: "127.0.0.1" }), attempts: 1 });
  expect(observed).toEqual({ kind: "absent", live: null });
  expect(readRuntimePort()?.pid).toBe(dead.pid); // Observation never retires records itself.
});

test("completed drain hands off to a healthy child while the real parent is still alive", async () => {
  const owned = fixture();
  mkdirSync(owned.codexHome);
  const entry = owned.path("src", "cli", "index.ts");
  mkdirSync(owned.path("src", "cli"), { recursive: true });
  // The real process identity verifier recognizes this source-launch path.
  const pidsPath = owned.path("fixture-pids");
  writeFileSync(entry, `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(pidsPath)}, process.pid + "\\n");
console.error("[restart-fixture " + process.pid + "] loading runner");
await import(${JSON.stringify(fixturePath("restart-parent-ownership-runner.ts"))});\n`);
  // Resolve/transpile this same product graph once. Three cold source imports on Windows
  // otherwise spend the handoff watchdog on fixture loading before exercising ownership.
  // Keep the recognized source-launch path and all real process/discovery/recovery calls.
  const built = await Bun.build({ entrypoints: [entry], target: "bun" });
  if (!built.success) throw new AggregateError(built.logs, "restart fixture bundle failed");
  await Bun.write(entry, built.outputs[0]!);
  const child = Bun.spawn([process.execPath, entry, "start", "parent"], {
    cwd: repoRoot(), env: { ...process.env, HOME: owned.root, USERPROFILE: owned.root,
      OPENCODEX_HOME: owned.configDir, CODEX_HOME: owned.codexHome,
      OCX_OWNER_REGISTRY_DIR: owned.path("registry"), XDG_RUNTIME_DIR: owned.root },
    stdout: "pipe", stderr: "pipe",
  });
  const output = Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  let cleanup: Promise<void> | undefined;
  settleProcesses = () => cleanup ??= (async () => {
    // Stop the live parent tree first, including descendants still loading their entry.
    // The test runner is outside that tree. Then join every registered fixture PID,
    // including a detached replacement whose parent has already exited normally.
    if (child.exitCode === null && isProcessAlive(child.pid)) killProxy(child.pid);
    const pids = existsSync(pidsPath) ? readFileSync(pidsPath, "utf8").trim().split("\n").map(Number) : [];
    for (const pid of pids) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error("invalid fixture PID");
      if (isProcessAlive(pid)) killProxy(pid);
    }
    await output;
  })();
  const watchdog = setTimeout(() => {
    void settleProcesses!().catch(error => console.error("restart fixture cleanup failed", error));
  }, 18_000);
  let captured: unknown;
  try {
    const [code, stdout, stderr] = await output;
    captured = { code, stdout, stderr };
    const logPath = owned.path("restart-handoff.log");
    const handoffLog = existsSync(logPath) ? readFileSync(logPath, "utf8") : "(not created)";
    const phasesPath = owned.path("fixture-phases.log");
    const phases = existsSync(phasesPath) ? readFileSync(phasesPath, "utf8") : "(not loaded)";
    const probeOutput = ["probe.stdout.log", "probe.stderr.log"].map(name =>
      existsSync(owned.path(name)) ? readFileSync(owned.path(name), "utf8") : "(not created)");
    expect({ code, stdout, stderr, handoffLog, phases, probeOutput }).toMatchObject({ code: 0 });
    const resultPath = owned.path("child-result.json");
    for (let i = 0; i < 100 && !existsSync(resultPath); i++) await Bun.sleep(50);
    expect(existsSync(resultPath)).toBe(true);
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    expect(result).toMatchObject({ parentPid: child.pid, parentAliveBeforeRecovery: true,
      observed: "absent", parentExited: true });
    expect(result.parentResult).toMatchObject({ code: 0, pid: child.pid,
      beforeHandoff: { refused: true, pidUnchanged: true },
      successorPid: result.pid, successorRuntime: { pid: result.pid, port: result.port } });
    expect(readFileSync(owned.path("restart-handoff.log"), "utf8")).toContain("is serving port");
  } catch (error) {
    const logs = Object.fromEntries(["fixture-phases.log", "probe.stdout.log", "probe.stderr.log", "restart-handoff.log"]
      .map(name => [name, existsSync(owned.path(name)) ? readFileSync(owned.path(name), "utf8") : "(not created)"]));
    console.error("restart fixture failed", { captured, logs });
    throw error;
  } finally {
    clearTimeout(watchdog);
    await settleProcesses();
  }
}, 25_000);
