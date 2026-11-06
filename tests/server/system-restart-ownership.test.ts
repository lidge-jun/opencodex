import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { fixturePath, helperPath, repoRoot } from "../helpers/repo-root";
import { ownRestartFixture } from "../helpers/restart-fixture-processes";
import {
  getPidPath, getRuntimePortPath, readPidFileValue, readRuntimePort, writePid, writeRuntimePort,
} from "../../src/config/process-state";
import { inspectOwnershipMutationLease } from "../../src/service/ownership-mutation-lease.mjs";
import { serviceStatePaths } from "../../src/service/state";
import { retireRestartParentOwnership } from "../../src/server/restart-parent-ownership";
import { observeProxyLiveness } from "../../src/server/proxy-liveness";
import { isProcessAlive } from "../../src/lib/process-control";

let home: TempHome | undefined;
let settleProcesses: (() => Promise<void>) | undefined;
afterEach(async () => {
  const settle = settleProcesses, owned = home;
  settleProcesses = undefined;
  home = undefined;
  await settle?.();
  owned?.remove();
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

test("completed drain hands off to a healthy child while the real parent is still alive", () => completedDrain(), 25_000);
test("cleanup refuses an exited fixture PID reused by a foreign live process", () => completedDrain(true), 25_000);

test("cleanup joins an admitted detached descendant after its parent exits", async () => {
  const owned = fixture(), pidsPath = owned.path("fixture-pids"), stopPath = owned.path("fixture-stop");
  const ready = owned.path("descendant-ready"), entry = owned.path("owned-role.ts");
  writeFileSync(entry, `import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { enterRestartFixture } from ${JSON.stringify(helperPath("restart-fixture-processes.ts"))};
await enterRestartFixture(${JSON.stringify(pidsPath)}, ${JSON.stringify(stopPath)});
setTimeout(() => process.exit(97), 20_000).unref();
if (process.argv.includes("descendant")) {
  writeFileSync(${JSON.stringify(ready)}, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  spawn(process.execPath, [process.argv[1], "descendant"], { detached: true, stdio: "ignore", env: process.env }).unref();
  for (let i = 0; i < 100 && !existsSync(${JSON.stringify(ready)}); i++) await Bun.sleep(25);
  process.exit(existsSync(${JSON.stringify(ready)}) ? 0 : 2);
}
`);
  const processes = await ownRestartFixture(pidsPath, stopPath);
  let child: ReturnType<typeof Bun.spawn> | undefined, cleanup: Promise<void> | undefined;
  settleProcesses = () => cleanup ??= (async () => {
    if (child?.exitCode === null) child.kill();
    await processes.stop();
    await child?.exited;
  })();
  child = Bun.spawn([process.execPath, entry], { env: { ...process.env, ...processes.env }, stdout: "ignore", stderr: "ignore" });
  try {
    expect(await child.exited).toBe(0);
    const descendantPid = Number(readFileSync(ready, "utf8"));
    expect(isProcessAlive(descendantPid)).toBe(true);
    await settleProcesses();
    expect(isProcessAlive(descendantPid)).toBe(false);
  } finally { await settleProcesses(); }
}, 25_000);

async function completedDrain(injectReusedPid = false): Promise<void> {
  const owned = fixture();
  mkdirSync(owned.codexHome);
  const entry = owned.path("src", "cli", "index.ts");
  mkdirSync(owned.path("src", "cli"), { recursive: true });
  // The real process identity verifier recognizes this source-launch path.
  const pidsPath = owned.path("fixture-pids");
  const stopPath = owned.path("fixture-stop");
  writeFileSync(entry, `import { enterRestartFixture } from ${JSON.stringify(helperPath("restart-fixture-processes.ts"))};
await enterRestartFixture(${JSON.stringify(pidsPath)}, ${JSON.stringify(stopPath)});
console.error("[restart-fixture " + process.pid + "] loading runner");
await import(${JSON.stringify(fixturePath("restart-parent-ownership-runner.ts"))});\n`);
  // Resolve/transpile this same product graph once. Three cold source imports on Windows
  // otherwise spend the handoff watchdog on fixture loading before exercising ownership.
  // Keep the recognized source-launch path and all real process/discovery/recovery calls.
  const built = await Bun.build({ entrypoints: [entry], target: "bun" });
  if (!built.success) throw new AggregateError(built.logs, "restart fixture bundle failed");
  await Bun.write(entry, built.outputs[0]!);
  const processes = await ownRestartFixture(pidsPath, stopPath);
  let cleanup: Promise<void> | undefined;
  // Install cleanup before spawn so even a failed CreateProcess releases the Job.
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let output: Promise<[number, string, string]> | undefined;
  settleProcesses = () => cleanup ??= (async () => {
    // The retained parent handle covers failure before its entry joins the Job.
    // Descendants can only be spawned after admission and inherit Job membership.
    if (child?.exitCode === null) child.kill();
    await processes.stop();
    await output;
  })();
  const parent = child = Bun.spawn([process.execPath, entry, "start", "parent"], {
    cwd: repoRoot(), env: { ...process.env, ...processes.env, HOME: owned.root, USERPROFILE: owned.root,
      OPENCODEX_HOME: owned.configDir, CODEX_HOME: owned.codexHome,
      OCX_OWNER_REGISTRY_DIR: owned.path("registry"), XDG_RUNTIME_DIR: owned.root },
    stdout: "pipe", stderr: "pipe",
  });
  output = Promise.all([
    parent.exited, new Response(parent.stdout).text(), new Response(parent.stderr).text(),
  ]);
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
    expect(result).toMatchObject({ parentPid: parent.pid, parentAliveBeforeRecovery: true,
      observed: "absent", parentExited: true });
    expect(result.parentResult).toMatchObject({ code: 0, pid: parent.pid,
      beforeHandoff: { refused: true, pidUnchanged: true, observed: "unknown", endpointsRefused: [true, true] },
      successorPid: result.pid, successorRuntime: { pid: result.pid, port: result.port } });
    expect(readFileSync(owned.path("restart-handoff.log"), "utf8")).toContain("is serving port");
  } catch (error) {
    const logs = Object.fromEntries(["fixture-phases.log", "probe.stdout.log", "probe.stderr.log", "restart-handoff.log"]
      .map(name => [name, existsSync(owned.path(name)) ? readFileSync(owned.path(name), "utf8") : "(not created)"]));
    console.error("restart fixture failed", { captured, logs });
    throw error;
  } finally {
    clearTimeout(watchdog);
    if (injectReusedPid) {
      // This child belongs to the regression, outside the restart fixture tree. Model an
      // exited role's journal PID now naming a live foreign process; never rely on OS reuse.
      const foreign = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
        stdout: "ignore", stderr: "ignore",
      });
      try {
        appendFileSync(pidsPath, (process.platform === "win32"
          ? String(foreign.pid)
          : JSON.stringify({ pid: foreign.pid, start: "stale-journal-identity" })) + "\n");
        await settleProcesses();
        expect(isProcessAlive(foreign.pid)).toBe(true);
      } finally {
        foreign.kill();
        await foreign.exited;
      }
    } else await settleProcesses();
  }
}
