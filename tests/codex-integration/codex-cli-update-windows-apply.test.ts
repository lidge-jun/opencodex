import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { applyCodexCliUpdate } from "../../src/codex/cli-update-apply";
import { createCodexCliUpdatePlan } from "../../src/codex/cli-update-plan";
import { inspectCodexCliInstall } from "../../src/codex/cli-install-provenance";
import { holdWindowsCodexCliPlanToolchain } from "../../src/codex/cli-windows-plan-provenance";
import { openWindowsCliApplyAuthority, type WindowsApplyAcquisition } from "../../src/codex/cli-update-job-store-windows";
import { trackBackgroundWork } from "../../src/lib/background-work";
import { repoPath } from "../helpers/repo-root";
import { spawnTestChild } from "../helpers/spawn-test-child";
import { startWindowsCliChild, type WindowsCliChild } from "../../src/codex/windows-cli-child";
import { createCodexCliUpdateFence, createWorkerCommitWindow, allocateCodexCliUpdateGateOwner, codexCliUpdateSelectionGate, resetCodexCliSelectionGatesForTests } from "../../src/codex/cli-update-selection-gate";
import { installCodexShim } from "../../src/codex/shim";
import { clearPersistedCodexRuntime } from "../../src/codex/runtime";
import { restartCodexDesktopApp } from "../../src/codex/desktop-app-restart";
import { recoverWindowsCodexCliInstallations } from "../../src/codex/cli-update-windows-apply";
import { windowsNpmExecutionArgs } from "../../src/codex/windows-npm-execution";
import { CodexRemoteWorkspaceRuntimeFactory, RemoteWorkspaceCoordinator } from "../../src/remote-control";
import { createWindowsApplyFixtures, native, WINDOWS_APPLY_BUDGET_MS, fixtureCleanupProven, type WorkerFixtureReply, write } from "../helpers/codex-cli-windows-apply-fixture";

const { liveFixtureRoots, fixture, approved } = createWindowsApplyFixtures();

test("Worker close alone never authorizes removing a native fixture", () => {
  const result: import("../../src/codex/cli-update-apply").CodexCliApplyResult = {
    outcome: "applied", reason: "verified_target", planId: "a".repeat(32), installedVersion: "1.0.0", targetVersion: "1.1.0",
    installerExitCode: 0, verificationPid: null, leaseRetained: false, cleanupErrors: [],
  };
  const safe: WorkerFixtureReply = { type: "result", requestId: "owned", result, cleanupConfirmed: true };
  expect(fixtureCleanupProven([], "owned", true, false)).toBe(false);
  expect(fixtureCleanupProven([safe], "different", true, false)).toBe(false);
  expect(fixtureCleanupProven([safe], "owned", true, true)).toBe(false);
  expect(fixtureCleanupProven([{ ...safe, result: { ...result, leaseRetained: true } }], "owned", true, false)).toBe(false);
  expect(fixtureCleanupProven([{ ...safe, cleanupConfirmed: false }], "owned", true, false)).toBe(false);
  expect(fixtureCleanupProven([safe, safe], "owned", true, false)).toBe(false);
  expect(fixtureCleanupProven([safe, { ...safe, requestId: "foreign" }], "owned", true, false)).toBe(false);
  expect(fixtureCleanupProven([safe, { type: "fixture-error", requestId: "foreign" }], "owned", true, false)).toBe(false);
  expect(fixtureCleanupProven([safe, null], "owned", true, false)).toBe(false);
  expect(fixtureCleanupProven([safe, { type: "unknown", requestId: "owned" }], "owned", true, false)).toBe(false);
  expect(fixtureCleanupProven([safe], "owned", false, false)).toBe(false);
  expect(fixtureCleanupProven([safe], "owned", true, false)).toBe(true);
});
native("Windows apply holds distinct prefix lease and private staging, then releases exact owners", async () => {
  // Register before fixture setup/acquisition can yield. A failed assertion or
  // unknown native release leaves both the exact root and preload producer held.
  let settleOwnership!: () => void;
  trackBackgroundWork("windows apply authority fixture", new Promise<void>(resolve => { settleOwnership = resolve; }));
  const f = await fixture(undefined, root => liveFixtureRoots.add(root));
  const acquisitions: WindowsApplyAcquisition[] = [];
  const acquire = () => openWindowsCliApplyAuthority(f.prefix, true, owner => {
    acquisitions.push(owner); // Root this acquisition before its first pin is opened.
    expect(owner.releaseIfClean()).toBe(true);
  });
  const guard = await acquire();
  const original = acquisitions[0]!;
  try {
    expect(original.releaseIfClean()).toBe(false);
    await guard.createStaging();
    expect(() => guard.verifyIdentitySync()).not.toThrow();
    expect(() => renameSync(f.prefix, f.prefix + "-moved")).toThrow();
    expect(() => renameSync(join(f.prefix, "node_modules", "@openai"), join(f.prefix, "node_modules", "moved"))).toThrow();
    await expect(acquire()).rejects.toThrow();
    expect(acquisitions).toHaveLength(2);
    expect(acquisitions[1]!.releaseIfClean()).toBe(true);
    await guard.verify(); await guard.removeStaging();
  } finally {
    const released = await guard.release(); // One attempt; never repeat a failed close.
    const pinsClean = original.releaseIfClean();
    expect(released, JSON.stringify({ pinsClean, lockExists: existsSync(guard.lock) })).toBe(true);
    expect(pinsClean).toBe(true);
  }
  expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
  const replacement = await acquire();
  expect(acquisitions).toHaveLength(3);
  const replacementAcquisition = acquisitions[2]!;
  try {
    expect(replacementAcquisition.releaseIfClean()).toBe(false);
    await expect(guard.createStaging()).rejects.toThrow();
    await expect(guard.verify()).rejects.toThrow();
    expect(() => guard.verifyIdentitySync()).toThrow();
    expect(existsSync(join(replacement.lock, "stage"))).toBe(false);
    await replacement.createStaging(); await replacement.removeStaging();
  } finally {
    const released = await replacement.release();
    const pinsClean = replacementAcquisition.releaseIfClean();
    expect(released, JSON.stringify({ pinsClean, lockExists: existsSync(replacement.lock) })).toBe(true);
    expect(pinsClean).toBe(true);
  }
  expect(existsSync(replacement.lock)).toBe(false);
  liveFixtureRoots.delete(f.root);
  settleOwnership(); // Only fully verified cleanup releases afterEach/preload ownership.
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows paused installer excludes real runtime selection and shim callers through readback", async () => {
  resetCodexCliSelectionGatesForTests();
  const f = await fixture(undefined, root => liveFixtureRoots.add(root)), id = await approved(f);
  const fence = createCodexCliUpdateFence(), gate = codexCliUpdateSelectionGate();
  const gateOwner = allocateCodexCliUpdateGateOwner(gate);
  const paused = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  let starts = 0, retained = 0;
  const applying = applyCodexCliUpdate(id, { ...f.deps,
    commitWindow: createWorkerCommitWindow({ gate, fence, owner: gateOwner }),
    retainExecution: () => { retained++; return { release() { retained--; } }; },
    startWindowsChild: invocation => {
      if (invocation.policy === "installer") {
        starts++;
        expect(Atomics.load(new Int32Array(gate), 0)).toBe(gateOwner);
        expect(Atomics.load(new Int32Array(fence), 0)).toBe(2);
      }
      const child = startWindowsCliChild(invocation);
      const wait = child.wait.bind(child);
      child.wait = async () => {
        if (invocation.policy === "installer") { paused.resolve(); await resume.promise; }
        return wait();
      };
      return child;
    },
  });
  await paused.promise;
  let assertionError: unknown;
  try {
    expect(installCodexShim()).toMatchObject({ installed: false, refused: true, message: "codex_cli_selection_busy" });
    expect(() => clearPersistedCodexRuntime({ configDir: f.deps.inspectionDeps.configDir }))
      .toThrow("codex_cli_selection_busy");
    expect(restartCodexDesktopApp({ execFile: () => { throw new Error("busy must precede OS calls"); } }))
      .toMatchObject({ attempted: false, relaunch: "skipped", reason: "selection_mutation_busy" });
    const factory = new CodexRemoteWorkspaceRuntimeFactory({ command: [process.execPath, repoPath("tests", "fake-codex-server.ts")] });
    await expect(factory.start({ sessionId: "paused-installer", deviceId: "fixture", deviceName: "Fixture",
      rootId: "fixture", rootLabel: "Fixture", capabilities: ["workspace.read"], tools: ["read_file"],
      coordinator: new RemoteWorkspaceCoordinator({ isOnline: () => true, async invoke() { return { ok: true }; } }),
      emit() {} })).rejects.toThrow("codex_cli_selection_busy");
  } catch (error) { assertionError = error; } finally { resume.resolve(); }
  const result = await applying;
  if (!result.leaseRetained) liveFixtureRoots.delete(f.root);
  if (assertionError) throw assertionError;
  expect(result).toMatchObject({ outcome: "applied", reason: "verified_target", leaseRetained: false });
  expect(starts).toBe(1); expect(retained).toBe(0);
  expect(Atomics.load(new Int32Array(gate), 0)).toBe(0);
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows plan refuses an npm required module writable by Everyone before metadata executes", async () => {
  const f = await fixture();
  const module = join(f.deps.inspectionDeps.env.PATH, "node_modules/npm/lib/cli.js");
  const grant = await spawnTestChild([join(process.env.SystemRoot!, "System32/icacls.exe"), module, "/grant", "*S-1-1-0:(M)"],
    { cwd: f.root, env: process.env, deadlineMs: 10_000 });
  expect(grant.exitCode).toBe(0);
  let executed = 0;
  const plan = await createCodexCliUpdatePlan({ ...f.deps, resolveTarget: () => { executed++; return f.deps.resolveTarget(); } });
  expect(plan.applicable).toBe(false);
  expect(executed).toBe(0);
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows approved plan binds npm library bytes and held authority refuses module replacement", async () => {
  const f = await fixture(), id = await approved(f);
  const module = join(f.deps.inspectionDeps.env.PATH, "node_modules/npm/lib/cli.js");
  const report = await inspectCodexCliInstall({ ...f.deps.inspectionDeps, observeInstallContent: true });
  const held = await holdWindowsCodexCliPlanToolchain(report);
  expect(held).not.toBeNull();
  try { await Promise.resolve(); expect(() => writeFileSync(module, "replacement")).toThrow(); }
  finally { expect(await held!.release()).toBe(true); }
  writeFileSync(module, readFileSync(module, "utf8") + "\n// changed after approval\n");
  expect((await createCodexCliUpdatePlan(f.deps)).planId).not.toBe(id);
  let starts = 0;
  expect(await applyCodexCliUpdate(id, { ...f.deps, install: async () => { starts++; return { terminal: true, exitCode: 0 }; } }))
    .toMatchObject({ outcome: "refused", reason: "plan_changed", leaseRetained: false });
  expect(starts).toBe(0);
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows unknown native installer retains admission until original Job termination proves recovery", async () => {
  resetCodexCliSelectionGatesForTests();
  const f = await fixture(undefined, root => liveFixtureRoots.add(root)), id = await approved(f);
  const gate = codexCliUpdateSelectionGate(), fence = createCodexCliUpdateFence();
  let child: WindowsCliChild | undefined, terminal = false, failReadback = false;
  const result = await applyCodexCliUpdate(id, { ...f.deps, commitWindow: createWorkerCommitWindow({ gate, fence }),
    inspect: deps => { if (failReadback) { failReadback = false; throw new Error("transient readback"); }
      return inspectCodexCliInstall(deps); },
    startWindowsChild: invocation => {
      const started = startWindowsCliChild(invocation);
      if (invocation.policy === "installer") {
        child = started;
        const observe = started.observe.bind(started);
        started.observe = () => terminal ? observe() : { terminal: false, exitCode: null, unknown: true };
      }
      return started;
    } });
  expect(result).toMatchObject({ outcome: "ambiguous", leaseRetained: true, reason: "installer_state_unknown" });
  expect(installCodexShim()).toMatchObject({ refused: true, message: "codex_cli_selection_busy" });
  expect(await recoverWindowsCodexCliInstallations()).toBe(0);
  terminal = true;
  // Original native Job/process owner is the only termination proof, never a delay or PID probe.
  expect((await child!.wait()).terminal).toBe(true);
  failReadback = true;
  expect(await recoverWindowsCodexCliInstallations()).toBe(0);
  expect(installCodexShim()).toMatchObject({ refused: true, message: "codex_cli_selection_busy" });
  expect(await recoverWindowsCodexCliInstallations()).toBe(1);
  expect(Atomics.load(new Int32Array(gate), 0)).toBe(0);
  expect(result.leaseRetained).toBe(true); // Earlier receipt remains honest about its own observation.
  liveFixtureRoots.delete(f.root);
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows npm execution refuses ancestor CommonJS and ESM modules outside its held tree", async () => {
  const f = await fixture(), tools = f.deps.inspectionDeps.env.PATH;
  const npmCli = join(tools, "node_modules/npm/bin/npm-cli.js");
  const marker = join(f.root, "outside-executed");
  write(join(tools, "node_modules/npm/lib/owned.js"), 'module.exports="inside";');
  write(npmCli, 'console.log(require("../lib/owned.js"));');
  const positive = startWindowsCliChild({ executable: join(tools, "node.exe"), args: windowsNpmExecutionArgs(npmCli, []),
    cwd: f.root, env: { SystemRoot: process.env.SystemRoot }, policy: "pack" });
  expect(await positive.wait()).toMatchObject({ terminal: true, cleanupComplete: true, exitCode: 0, stdout: "inside\n" });
  write(join(tools, "node_modules", "external", "package.json"), JSON.stringify({ name: "external", main: "index.js", exports: "./index.js" }));
  write(join(tools, "node_modules", "external", "index.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad");`);
  for (const source of ['require("external");', 'import("external");']) {
    write(npmCli, source);
    const child = startWindowsCliChild({ executable: join(tools, "node.exe"), args: windowsNpmExecutionArgs(npmCli, []),
      cwd: f.root, env: { SystemRoot: process.env.SystemRoot }, policy: "pack" });
    const result = await child.wait();
    expect(result.terminal && result.cleanupComplete).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  }
}, WINDOWS_APPLY_BUDGET_MS);
