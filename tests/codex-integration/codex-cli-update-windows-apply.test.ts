import { createCodexCliTestRoot } from "../helpers/codex-cli-fixture-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { trustWindowsTempFixtureAncestry, windowsTempAncestryPreload } from "../helpers/windows-temp-ancestry";
import { afterEach, expect, test } from "bun:test";
import { cpSync, realpathSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, symlinkSync, unlinkSync, linkSync } from "node:fs";
import { join, dirname, parse } from "node:path";
import { applyCodexCliUpdate } from "../../src/codex/cli-update-apply";
import { createCodexCliUpdatePlan } from "../../src/codex/cli-update-plan";
import { inspectCodexCliInstall } from "../../src/codex/cli-install-provenance";
import { holdWindowsCodexCliPlanToolchain, withWindowsCodexCliPlanToolchain } from "../../src/codex/cli-windows-plan-provenance";
import { openWindowsCliApplyAuthority, type WindowsApplyAcquisition } from "../../src/codex/cli-update-job-store-windows";
import { hardenSecretDirAsync } from "../../src/lib/windows-secret-acl";
import { trackBackgroundWork } from "../../src/lib/background-work";
import { removeTreeAfterBackgroundWork } from "../helpers/remove-tree";
import { fixtureArtifact, fixtureTar } from "../helpers/codex-cli-apply-artifact";
import { fixturePath, repoPath, repoRoot } from "../helpers/repo-root";
import { spawnTestChild } from "../helpers/spawn-test-child";
import { runCodexCliUpdateJobWork } from "../../src/codex/cli-update-job-execution";
import { startWindowsCliChild, type WindowsCliChild } from "../../src/codex/windows-cli-child";
import { windowsInstallNamespaceSupported } from "../../src/codex/cli-update-windows-observation";
import { createCodexCliUpdateFence, cancelCodexCliUpdateFence, createWorkerCommitWindow,
  codexCliUpdateIsCancelled, allocateCodexCliUpdateGateOwner, codexCliUpdateSelectionGate, resetCodexCliSelectionGatesForTests } from "../../src/codex/cli-update-selection-gate";
import { installCodexShim } from "../../src/codex/shim";
import { clearPersistedCodexRuntime } from "../../src/codex/runtime";
import { restartCodexDesktopApp } from "../../src/codex/desktop-app-restart";
import { recoverWindowsCodexCliInstallations } from "../../src/codex/cli-update-windows-apply";
import { windowsNpmExecutionArgs } from "../../src/codex/windows-npm-execution";
import { CodexRemoteWorkspaceRuntimeFactory, RemoteWorkspaceCoordinator } from "../../src/remote-control";

const native = process.platform === "win32" && process.arch === "x64" ? test : test.skip;
// Full native npm-tree ACL/identity renewal and real children are the proof.
// Bound this class for a shared Windows host; keep every admission/readback assertion.
const WINDOWS_APPLY_BUDGET_MS = 4 * SPAWN_BUDGET_MS;
const WINDOWS_APPLY_CHILD_BUDGET_MS = 2 * SPAWN_BUDGET_MS;
const roots: string[] = [];
const liveFixtureRoots = new Set<string>();
type WorkerFixtureReply = { type: string; requestId?: string; cleanupConfirmed?: boolean; result?: import("../../src/codex/cli-update-apply").CodexCliApplyResult };
function fixtureCleanupProven(messages: readonly unknown[], requestId: string, closed: boolean, errored: boolean): boolean {
  if (!closed || errored) return false;
  const replies: WorkerFixtureReply[] = [];
  for (const value of messages) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const message = value as WorkerFixtureReply;
    // Assertions can fail independently: teardown authority rejects ALL foreign,
    // malformed or error traffic, including traffic mixed with a valid result.
    if (message.requestId !== requestId || !["native-start", "result"].includes(message.type)) return false;
    if (message.type === "native-start" && (value as { committed?: unknown }).committed !== true) return false;
    if (message.type === "result" && (!message.result || typeof message.result !== "object"
      || Array.isArray(message.result) || message.cleanupConfirmed !== true)) return false;
    if (message.type === "result") {
      const result = message.result!;
      const version = (value: unknown) => value === null || typeof value === "string";
      if (!["applied", "not_applied", "refused", "ambiguous"].includes(result.outcome)
        || typeof result.reason !== "string" || !/^[a-f0-9]{32}$/.test(result.planId)
        || !version(result.installedVersion) || !version(result.targetVersion)
        || !(result.installerExitCode === null || Number.isInteger(result.installerExitCode))
        || !(result.verificationPid === null || (Number.isInteger(result.verificationPid) && result.verificationPid > 0))) return false;
    }
    replies.push(message);
  }
  const results = replies.filter(message => message.type === "result");
  return results.length === 1
    && results[0]!.cleanupConfirmed === true && results[0]!.result?.leaseRetained === false
    && Array.isArray(results[0]!.result?.cleanupErrors) && results[0]!.result!.cleanupErrors.length === 0;
}
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
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (liveFixtureRoots.has(root)) { roots.push(root); continue; }
    await removeTreeAfterBackgroundWork(root);
  }
});
const mainRoot = "node_modules/@openai/codex", backingRoot = "node_modules/@openai/codex-win32-x64";
const nativePath = "vendor/x86_64-pc-windows-msvc/bin/codex.exe";
const write = (path: string, bytes: string | Buffer) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
function artifacts(version: string, executable?: Buffer) {
  const pe = Buffer.alloc(512); pe.write("MZ"); pe.writeUInt32LE(64, 60); pe.write("PE\0\0", 64);
  pe.writeUInt16LE(0x8664, 68); pe.writeUInt16LE(1, 70); pe.writeUInt16LE(240, 84); pe.writeUInt16LE(2, 86); pe.writeUInt16LE(0x20b, 88);
  // Synthetic PE only. The real Node verification child executes this fixture's JS;
  // this is an npm/readback test, not a claim that a real Codex native binary ran.
  const mainFiles = { "package.json": JSON.stringify({ name: "@openai/codex", version,
    bin: { codex: "bin/codex.js" }, optionalDependencies: { "@openai/codex-win32-x64": version } }),
    "bin/codex.js": executable ? '#!/usr/bin/env node\n' +
      'const cp=require("node:child_process"), path=require("node:path");\n' +
      'const exe=path.join(__dirname,"../../codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");\n' +
      'const child=cp.spawn(exe,process.argv.slice(2),{stdio:"inherit",windowsHide:true});\n' +
      'child.on("error",()=>{process.exitCode=91});child.on("exit",code=>{process.exitCode=code??92});\n'
      : `#!/usr/bin/env node\nconsole.log("codex-cli ${version}");\n`, "README.md": "auxiliary\n" };
  const backingFiles = { "package.json": JSON.stringify({ name: "@openai/codex-win32-x64", version, os: ["win32"], cpu: ["x64"] }),
    [nativePath]: executable ?? pe, "vendor/auxiliary.txt": "auxiliary\n" };
  const main = fixtureTar(mainFiles), backing = fixtureTar(backingFiles);
  return { mainFiles, backingFiles, main, backing, set: { platform: "win32" as const, arch: "x64",
    main: fixtureArtifact(main, version), backing: fixtureArtifact(backing, version, "@openai/codex-win32-x64", "@openai/codex-win32-x64") } };
}
async function fixture(executable?: Buffer, onCreated?: (root: string) => void) {
  // This host's observed writable AppData ancestry refused; this is not a ban on
  // every profile. Evaluate actual ancestry ACL/owner/reparse evidence instead.
  // Create only this test-owned directory below the repository's volume anchor;
  // never repair or suppress metadata on the host's existing ancestor directories.
  const root = createCodexCliTestRoot("ocx-win-apply-");
  onCreated?.(root); roots.push(root);
  await hardenSecretDirAsync(root, { required: true });
  trustWindowsTempFixtureAncestry(root);
  const prefix = join(root, "prefix"); mkdirSync(prefix);
  await hardenSecretDirAsync(prefix, { required: true });
  const old = artifacts("1.0.0"), target = artifacts("1.1.0", executable);
  for (const [relative, bytes] of Object.entries(old.mainFiles)) write(join(prefix, mainRoot, relative), bytes);
  for (const [relative, bytes] of Object.entries(old.backingFiles)) write(join(prefix, backingRoot, relative), bytes);
  const shims = JSON.parse(readFileSync(fixturePath("codex-windows-npm-shims.json"), "utf8"));
  for (const [name, bytes] of Object.entries(shims.files)) write(join(prefix, name), String(bytes));
  const sourceNode = realpathSync(Bun.which("node.exe")!);
  const nodeDir = join(root, "nodejs"); mkdirSync(nodeDir);
  copyFileSync(sourceNode, join(nodeDir, "node.exe"));
  cpSync(join(dirname(sourceNode), "node_modules", "npm"), join(nodeDir, "node_modules", "npm"), { recursive: true });
  const inspectionDeps = { env: { CODEX_CLI_PATH: join(prefix, "codex.cmd"), PATH: nodeDir, PATHEXT: ".EXE;.CMD" },
    configDir: join(root, "absent-home"), arch: "x64" as const, selectionAttested: true };
  const deps = { platform: "win32" as const, inspectionDeps,
    resolveTarget: () => ({ kind: "resolved" as const, version: "1.1.0", integrity: target.set.main.integrity, artifacts: target.set }),
    scanProcesses: () => ({ kind: "observed" as const, processes: [] }),
    fetchArtifact: async (artifact: typeof target.set.main) => artifact.installName === "@openai/codex" ? target.main : target.backing };
  return { root, prefix, old, target, deps };
}
async function approved(f: Awaited<ReturnType<typeof fixture>>) {
  const plan = await createCodexCliUpdatePlan(f.deps);
  expect(plan, JSON.stringify(plan)).toMatchObject({ applicable: true, refusal: null });
  expect(plan.planId).toMatch(/^[a-f0-9]{32}$/); return plan.planId!;
}

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

native("a fresh Worker runs real offline Windows FFI install and closes only after native settlement", async () => {
  let root: string | undefined, closed = false, errored = false, worker: Worker | undefined;
  const requestId = crypto.randomUUID(), messages: WorkerFixtureReply[] = [];
  try {
    const f = await fixture(undefined, created => { root = created; liveFixtureRoots.add(created); });
    const id = await approved(f);
    worker = new Worker(new URL("../helpers/windows-apply-worker.ts", import.meta.url),
      { type: "module", preload: windowsTempAncestryPreload(f.root) });
    const joined = new Promise<void>((resolve, reject) => {
      worker!.addEventListener("message", event => { messages.push(event.data); });
      worker!.addEventListener("error", () => { errored = true; reject(new Error("offline Worker failed")); }, { once: true });
      worker!.addEventListener("close", () => { closed = true; resolve(); }, { once: true });
    });
    const gate = new SharedArrayBuffer(8), fence = createCodexCliUpdateFence();
    worker.postMessage({ requestId, planId: id, inspectionDeps: f.deps.inspectionDeps, target: f.target, gate, fence });
    await joined;
    expect(messages.filter(m => m.type === "native-start")).toHaveLength(1);
    expect(messages.filter(m => m.type === "fixture-error")).toHaveLength(0);
    const results = messages.filter(m => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0]!.result).toMatchObject({ outcome: "applied", reason: "verified_target", leaseRetained: false, cleanupErrors: [] });
    expect(fixtureCleanupProven(messages, requestId, closed, errored)).toBe(true);
    expect(Atomics.load(new Int32Array(gate), 0)).toBe(0);
    expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
  } finally {
    // A still-live native Worker keeps its exact fixture; never terminate to fake settlement.
    if (root && fixtureCleanupProven(messages, requestId, closed, errored)) liveFixtureRoots.delete(root);
  }
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows cancellation won inside final synchronous scan cannot create an installer", async () => {
  const f = await fixture(undefined, root => liveFixtureRoots.add(root)), id = await approved(f);
  const fence = createCodexCliUpdateFence(), gate = new SharedArrayBuffer(8);
  const gateOwner = allocateCodexCliUpdateGateOwner(gate);
  let scans = 0, starts = 0;
  const result = await applyCodexCliUpdate(id, { ...f.deps,
    isCancelled: codexCliUpdateIsCancelled(fence),
    commitWindow: createWorkerCommitWindow({ gate, fence, owner: gateOwner }),
    scanProcesses: () => {
      scans++;
      if (Atomics.load(new Int32Array(gate), 0) === gateOwner) expect(cancelCodexCliUpdateFence(fence)).toBe(true);
      return { kind: "observed", processes: [] };
    },
    startWindowsChild: invocation => { starts++; return startWindowsCliChild(invocation); },
  });
  if (!result.leaseRetained) liveFixtureRoots.delete(f.root);
  expect(scans).toBeGreaterThan(0);
  expect(result).toMatchObject({ outcome: "refused", reason: "cancelled", leaseRetained: false });
  expect(starts).toBe(0);
  expect(Atomics.load(new Int32Array(gate), 0)).toBe(0);
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows apply runs real offline npm under owned Job, then verifies full target and version", async () => {
  const f = await fixture(), id = await approved(f);
  const result = await applyCodexCliUpdate(id, f.deps);
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", reason: "verified_target",
    installerExitCode: 0, installedVersion: "1.1.0", leaseRetained: false, cleanupErrors: [] });
  expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows terminal no-op is not_applied even with nonzero installer exit", async () => {
  const f = await fixture(), id = await approved(f);
  const result = await applyCodexCliUpdate(id, { ...f.deps, install: async () => ({ terminal: true, exitCode: 17 }) });
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "not_applied", leaseRetained: false, cleanupErrors: [] });
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows pack children and installer descendant share transaction ownership", async () => {
  const f = await fixture(), realNode = join(f.deps.inspectionDeps.env.PATH, "node.exe");
  const realNpm = join(f.deps.inspectionDeps.env.PATH, "node_modules/npm/bin/npm-cli.js");
  const tools = join(f.root, "toolchain"), npmCli = join(tools, "node_modules/npm/bin/npm-cli.js"), trace = join(f.root, "trace.jsonl");
  mkdirSync(dirname(npmCli), { recursive: true }); copyFileSync(realNode, join(tools, "node.exe"));
  write(join(tools, "node_modules/npm/package.json"), JSON.stringify({ name: "npm", version: "11.16.0", bin: { npm: "bin/npm-cli.js" } }));
  const sources = Object.fromEntries([f.target.set.main, f.target.set.backing].map((a, i) => {
    const path = join(f.root, `${i}.tgz`); write(path, i ? f.target.backing : f.target.main); return [`${a.name}@${a.version}`, path];
  }));
  write(npmCli, [
    'const fs=require("node:fs"), path=require("node:path"), cp=require("node:child_process");',
    'const args=process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(args[0])+"\\n");`,
    `const sources=${JSON.stringify(sources)};`,
    'if(args[0]==="pack") { const source=sources[args[1]]; if(!source)process.exit(91);',
    'const name=path.basename(source); fs.copyFileSync(source,path.join(args[args.indexOf("--pack-destination")+1],name));',
    'console.log(JSON.stringify([{filename:name}])); } else if(args[0]==="install") {',
    `const r=cp.spawnSync(${JSON.stringify(realNode)},[${JSON.stringify(realNpm)},...args],{env:process.env,stdio:"inherit"});process.exit(r.status??92);`,
    '} else process.exit(93);',
  ].join("\n"));
  f.deps.inspectionDeps.env.PATH = tools;
  const id = await approved(f);
  const result = await applyCodexCliUpdate(id, { ...f.deps, fetchArtifact: undefined });
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", leaseRetained: false, cleanupErrors: [] });
  expect(readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual(["pack", "pack", "install"]);
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows complete readback outranks a nonzero installer exit", async () => {
  const f = await fixture(), id = await approved(f);
  const result = await applyCodexCliUpdate(id, { ...f.deps, install: async () => {
    for (const [path, bytes] of Object.entries(f.target.mainFiles)) write(join(f.prefix, mainRoot, path), bytes);
    for (const [path, bytes] of Object.entries(f.target.backingFiles)) write(join(f.prefix, backingRoot, path), bytes);
    return { terminal: true, exitCode: 17 };
  } });
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", installerExitCode: 17, cleanupErrors: [] });
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows cancellation and unknown session observation cannot start an installer", async () => {
  const f = await fixture(), id = await approved(f); let installs = 0;
  const install = async () => { installs++; return { terminal: true, exitCode: 0 }; };
  const abort = new AbortController(); abort.abort();
  expect((await applyCodexCliUpdate(id, { ...f.deps, install, signal: abort.signal })).reason).toBe("cancelled");
  expect((await applyCodexCliUpdate(id, { ...f.deps, install,
    scanProcesses: () => ({ kind: "unavailable" }) })).reason).toBe("blocked_process_state_unknown");
  let scans = 0;
  expect((await applyCodexCliUpdate(id, { ...f.deps, install,
    scanProcesses: () => ++scans < 3 ? { kind: "observed", processes: [] } : { kind: "unavailable" } })).reason)
    .toBe("blocked_process_state_unknown");
  expect(scans).toBe(3);
  expect(installs).toBe(0);
}, WINDOWS_APPLY_BUDGET_MS);

native.each(["auxiliary", "shim", "hidden-lock", "extra-file", "new-empty-backing", "selection"] as const)("Windows partial %s refuses not_applied", async kind => {
  const f = await fixture();
  if (kind === "new-empty-backing") {
    const nested = join(f.prefix, mainRoot, "bin", "node_modules", "@openai", "codex-win32-x64");
    mkdirSync(dirname(nested), { recursive: true }); renameSync(join(f.prefix, backingRoot), nested);
  }
  const id = await approved(f);
  const result = await applyCodexCliUpdate(id, { ...f.deps, install: async () => {
    if (kind === "auxiliary") write(join(f.prefix, mainRoot, "README.md"), "changed");
    if (kind === "shim") write(join(f.prefix, "codex.ps1"), "changed");
    if (kind === "hidden-lock") write(join(f.prefix, "node_modules/.package-lock.json"), "{}");
    if (kind === "extra-file") write(join(f.prefix, backingRoot, "unexpected.txt"), "extra");
    if (kind === "new-empty-backing") mkdirSync(join(f.prefix, backingRoot));
    if (kind === "selection") f.deps.inspectionDeps.env.CODEX_CLI_PATH = join(f.prefix, "other.cmd");
    return { terminal: true, exitCode: 1 };
  } });
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "ambiguous", leaseRetained: false });
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows uncertain installer retains lease and staging until owning process exits", async () => {
  const f = await fixture(), id = await approved(f);
  const entry = join(f.root, "uncertain.test.ts"), receipt = join(f.root, "result.json");
  const literals = JSON.stringify({ id, inspectionDeps: f.deps.inspectionDeps, target: f.deps.resolveTarget(),
    main: f.target.main.toString("base64"), backing: f.target.backing.toString("base64"), receipt, prefix: f.prefix });
  writeFileSync(entry, [
    'import { test, expect } from "bun:test";',
    'import { existsSync, writeFileSync } from "node:fs";',
    `import { applyCodexCliUpdate } from ${JSON.stringify(repoPath("src/codex/cli-update-apply.ts"))};`,
    `const f = ${literals};`,
    'test("retained transaction", async () => {',
    'const result = await applyCodexCliUpdate(f.id, { platform:"win32", inspectionDeps:f.inspectionDeps,',
    'resolveTarget:()=>f.target, scanProcesses:()=>({kind:"observed",processes:[]}),',
    'fetchArtifact:async a=>Buffer.from(a.installName==="@openai/codex"?f.main:f.backing,"base64"),',
    'install:async()=>({terminal:false,exitCode:null}) });',
    'const stage=existsSync(f.prefix+"/.ocx-codex-cli-apply.lock/stage");',
    'writeFileSync(f.receipt,JSON.stringify({result,stage}));',
    'expect(result.outcome).toBe("ambiguous"); expect(result.leaseRetained).toBe(true); expect(stage).toBe(true);',
    `},${WINDOWS_APPLY_CHILD_BUDGET_MS});`,
  ].join("\n"));
  const child = await spawnTestChild([process.execPath, "test", "--preload", windowsTempAncestryPreload(f.root),
    "--no-env-file", "--no-install", "--timeout", String(WINDOWS_APPLY_CHILD_BUDGET_MS), entry],
    { cwd: repoRoot(), env: process.env, deadlineMs: WINDOWS_APPLY_CHILD_BUDGET_MS + 5000 });
  expect(child.reaped).toBe(true); expect(child.pipesClosed).toBe(true); expect(child.exitCode, child.stderr).toBe(0);
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ stage: true,
    result: { outcome: "ambiguous", reason: "installer_state_unknown", leaseRetained: true } });
  // The child has exited: only now can the fixture's retained kernel handles be gone.
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows completion persistence retry does not repeat the installer", async () => {
  const f = await fixture(), id = await approved(f); let installs = 0, finishes = 0;
  await runCodexCliUpdateJobWork(() => applyCodexCliUpdate(id, { ...f.deps,
    install: async () => { installs++; return { terminal: true, exitCode: 0 }; } }), {
    begin: async () => 1,
    finish: async (_revision, result) => {
      expect(result.outcome).toBe("not_applied");
      if (++finishes < 3) throw Object.assign(new Error("fixture busy"), { code: "EBUSY" });
      return null;
    }, read: async () => null, release: async () => {},
  });
  expect(installs).toBe(1); expect(finishes).toBe(3);
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows toolchain pins survive an awaited callback; bounded shared prefix is eligible", async () => {
  const f = await fixture();
  const tools = join(f.root, "toolchain"), npmCli = join(tools, "node_modules/npm/bin/npm-cli.js");
  write(join(tools, "node.exe"), f.old.backingFiles[nativePath]);
  write(join(tools, "node_modules/npm/package.json"), JSON.stringify({ name: "npm", version: "11.0.0", bin: { npm: "bin/npm-cli.js" } }));
  write(npmCli, "// never executed\n"); f.deps.inspectionDeps.env.PATH = tools;
  const report = await inspectCodexCliInstall({ ...f.deps.inspectionDeps, observeInstallContent: true });
  expect(report.managed).toBe(true);
  expect(await withWindowsCodexCliPlanToolchain(report, async () => {
    await Bun.sleep(10);
    // This write must still be denied after await; returning a promise while
    // releasing native pins early would make this assertion fail.
    expect(() => writeFileSync(npmCli, "replacement")).toThrow(); return 42;
  })).toBe(42);
  writeFileSync(npmCli, "// changed after release\n");
  const refreshed = await inspectCodexCliInstall({ ...f.deps.inspectionDeps, observeInstallContent: true });
  const pin = await holdWindowsCodexCliPlanToolchain(refreshed); expect(pin).not.toBeNull(); expect(await pin!.release()).toBe(true);
  mkdirSync(join(f.prefix, "node_modules", "unrelated"));
  expect((await createCodexCliUpdatePlan(f.deps)).applicable).toBe(true);
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows shared prefix preserves unrelated package and shims while executing x64 backing", async () => {
  // Use the existing Windows compiler, with no package install or downloaded binary.
  // This is a CLR x64 executable fixture with actual Win32 Job observation, not vendor Codex.
  const build = createCodexCliTestRoot("ocx-win-apply-"); roots.push(build);
  const source = join(build, "Backing.cs"), exe = join(build, "backing.exe"), trace = join(build, "native.json");
  write(source, [
    'using System; using System.IO; using System.Runtime.InteropServices;',
    'class Backing {',
    '[DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();',
    '[DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool inside);',
    'static int Main(string[] args) { bool inside;',
    'if(IntPtr.Size!=8 || args.Length!=1 || args[0]!="--version" || !IsProcessInJob(GetCurrentProcess(),IntPtr.Zero,out inside) || !inside)return 93;',
    'var self=System.Diagnostics.Process.GetCurrentProcess();',
    `File.WriteAllText(@"${trace.replaceAll('"', '""')}", "{\\"inJob\\":true,\\"x64\\":true,\\"pid\\":"+self.Id+",\\"startUtc\\":\\""+self.StartTime.ToUniversalTime().ToString("o")+"\\"}");`,
    'Console.WriteLine("codex-cli 1.1.0"); return 0; } }',
  ].join("\n"));
  const compiler = join(process.env.SystemRoot ?? "C:/Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  expect(existsSync(compiler), "x64 fixture compiler must be available; do not substitute a synthetic PE").toBe(true);
  const compiled = await spawnTestChild([compiler, "/nologo", "/platform:x64", "/target:exe", `/out:${exe}`, source],
    { cwd: build, env: process.env, deadlineMs: 10000 });
  expect(compiled.reaped && compiled.pipesClosed).toBe(true); expect(compiled.exitCode, compiled.stdout + compiled.stderr).toBe(0);
  const f = await fixture(readFileSync(exe));
  const unrelated = { "node_modules/unrelated/package.json": '{"name":"unrelated","version":"2.0.0","bin":"index.js"}',
    "node_modules/unrelated/index.js": '#!/usr/bin/env node\nconsole.log("unrelated");\n',
    "unrelated": "unrelated bare shim\n", "unrelated.cmd": "unrelated cmd shim\n", "unrelated.ps1": "unrelated powershell shim\n" };
  for (const [path, bytes] of Object.entries(unrelated)) write(join(f.prefix, path), bytes);
  const children: WindowsCliChild[] = [];
  const id = await approved(f), result = await applyCodexCliUpdate(id, { ...f.deps, startWindowsChild: invocation => {
    const child = startWindowsCliChild(invocation); children.push(child); return child;
  } });
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", reason: "verified_target", installerExitCode: 0,
    installedVersion: "1.1.0", leaseRetained: false, cleanupErrors: [], verificationPid: null });
  const backing = JSON.parse(readFileSync(trace, "utf8"));
  expect(backing).toMatchObject({ inJob: true, x64: true }); expect(backing.pid).toBeGreaterThan(0);
  expect(Number.isNaN(Date.parse(backing.startUtc))).toBe(false);
  expect(children).toHaveLength(2);
  for (const child of children) {
    expect(child.observe()).toMatchObject({ terminal: true, unknown: false });
    expect((await child.wait()).cleanupComplete).toBe(true); expect(child.native.handles.size).toBe(0);
  }
  // Preserve actual descendant identity in the supervisor's bounded test log.
  console.log("owned x64 fixture", JSON.stringify({ backing, jobs: children.map(c => ({ pid: c.pid, start: c.creationTime })) }));
  for (const [path, bytes] of Object.entries(unrelated)) expect(readFileSync(join(f.prefix, path), "utf8")).toBe(bytes);
  expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
}, WINDOWS_APPLY_BUDGET_MS);

native.each(["package", "shim", "new-entry"] as const)("Windows shared prefix unexpected %s mutation is ambiguous", async kind => {
  const f = await fixture();
  write(join(f.prefix, "node_modules/unrelated/package.json"), '{"name":"unrelated","version":"2.0.0"}');
  write(join(f.prefix, "unrelated.cmd"), "original");
  const id = await approved(f);
  const result = await applyCodexCliUpdate(id, { ...f.deps, install: async () => {
    for (const [path, bytes] of Object.entries(f.target.mainFiles)) write(join(f.prefix, mainRoot, path), bytes);
    for (const [path, bytes] of Object.entries(f.target.backingFiles)) write(join(f.prefix, backingRoot, path), bytes);
    write(join(f.prefix, kind === "package" ? "node_modules/unrelated/package.json" : kind === "shim" ? "unrelated.cmd" : "unexpected"), "changed");
    return { terminal: true, exitCode: 0 };
  } });
  expect(result).toMatchObject({ outcome: "ambiguous", leaseRetained: false });
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows shared namespace still refuses linked unrelated entries", async () => {
  const f = await fixture(), outside = join(f.root, "outside"), alias = join(f.prefix, "node_modules/unrelated");
  mkdirSync(outside); write(join(outside, "value"), "must not be followed or changed");
  symlinkSync(outside, alias, "junction");
  expect(windowsInstallNamespaceSupported(f.prefix)).toBe(false);
  expect((await createCodexCliUpdatePlan(f.deps)).refusal).toBe("windows_apply_disabled");
  unlinkSync(alias);
  linkSync(join(outside, "value"), join(f.prefix, "unrelated.cmd"));
  expect(windowsInstallNamespaceSupported(f.prefix)).toBe(false);
  expect(readFileSync(join(outside, "value"), "utf8")).toBe("must not be followed or changed");
}, WINDOWS_APPLY_BUDGET_MS);

native.each(["installer", "version"] as const)("Windows %s terminal EOF with native CloseHandle failure retains owner and reports cleanup", async policy => {
  const f = await fixture(), id = await approved(f);
  const entry = join(f.root, "cleanup.test.ts"), receipt = join(f.root, "cleanup.json");
  const literals = JSON.stringify({ id, inspectionDeps: f.deps.inspectionDeps, target: f.deps.resolveTarget(),
    main: f.target.main.toString("base64"), backing: f.target.backing.toString("base64"), receipt, prefix: f.prefix, policy,
    mainFiles: f.target.mainFiles, backingFiles: Object.fromEntries(Object.entries(f.target.backingFiles).map(([p, b]) => [p, Buffer.from(b).toString("base64")])) });
  write(entry, [
    'import { test, expect } from "bun:test";',
    'import { existsSync, writeFileSync, readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    `import { applyCodexCliUpdate } from ${JSON.stringify(repoPath("src/codex/cli-update-apply.ts"))};`,
    `import { WindowsChildNative } from ${JSON.stringify(repoPath("src/codex/windows-cli-child-native.ts"))};`,
    `import { startWindowsCliChildWithNative } from ${JSON.stringify(repoPath("src/codex/windows-cli-child.ts"))};`,
    `import { normalizeCodexCliJobResult } from ${JSON.stringify(repoPath("src/codex/cli-update-job-execution.ts"))};`,
    `import { projectCodexCliUpdateJobLifecycle } from ${JSON.stringify(repoPath("src/codex/cli-update-job.ts"))};`,
    `const f=${literals};`,
    'test("terminal cleanup ownership",async()=>{ let child, realClose; const native=new WindowsChildNative();',
    'try { const result=await applyCodexCliUpdate(f.id,{platform:"win32",inspectionDeps:f.inspectionDeps,',
    'resolveTarget:()=>f.target,scanProcesses:()=>({kind:"observed",processes:[]}),',
    'fetchArtifact:async a=>Buffer.from(a.installName==="@openai/codex"?f.main:f.backing,"base64"),',
    'install:f.policy==="version"?async()=>{ for(const [p,b] of Object.entries(f.mainFiles))writeFileSync(join(f.prefix,"node_modules/@openai/codex",p),b);',
    'for(const [p,b] of Object.entries(f.backingFiles))writeFileSync(join(f.prefix,"node_modules/@openai/codex-win32-x64",p),Buffer.from(b,"base64"));return {terminal:true,exitCode:0}; }:undefined,',
    'startWindowsChild: invocation=>{ child=startWindowsCliChildWithNative(invocation,native);realClose=native.k.CloseHandle;',
    'native.k.CloseHandle=h=>h===child.process?0:realClose(h);return child; }});',
    'expect(child.observe().terminal).toBe(true);expect(child.pipe.eof).toBe(true);',
    'expect((await child.wait()).cleanupComplete).toBe(false);expect(native.handles.has(child.process)).toBe(true);',
    'expect(result).toMatchObject({outcome:"ambiguous",reason:"child_cleanup_unverified",leaseRetained:true,cleanupErrors:["child_cleanup_failed"]});',
    'expect(JSON.parse(readFileSync(join(f.prefix,"node_modules/@openai/codex/package.json"),"utf8")).version).toBe("1.1.0");',
    'expect(normalizeCodexCliJobResult(result)).toEqual(result);',
    'expect(projectCodexCliUpdateJobLifecycle({...result,status:"finished",active:false})).toMatchObject({childState:"terminal",leaseState:"retained"});',
    'const stage=existsSync(join(f.prefix,".ocx-codex-cli-apply.lock/stage"));expect(stage).toBe(true);',
    'writeFileSync(f.receipt,JSON.stringify({result,stage,terminal:child.observe().terminal,handles:native.handles.size}));',
    '} finally { if(realClose)native.k.CloseHandle=realClose; for(const h of [...native.handles])native.close(h);expect(native.dispose()).toBe(true); }',
    `},${WINDOWS_APPLY_CHILD_BUDGET_MS});`,
  ].join("\n"));
  const result = await spawnTestChild([process.execPath, "test", "--preload", windowsTempAncestryPreload(f.root),
    "--no-env-file", "--no-install", "--timeout", String(WINDOWS_APPLY_CHILD_BUDGET_MS), entry],
    { cwd: repoRoot(), env: process.env, deadlineMs: WINDOWS_APPLY_CHILD_BUDGET_MS + 5000 });
  expect(result.reaped && result.pipesClosed).toBe(true); expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ terminal: true, handles: 1, stage: true });
  // Retained authority is intentionally not released by production. This isolated
  // owner has exited, so only now may afterEach remove its private fixture prefix.
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows shared prefix terminal no-op preserves full observed original", async () => {
  const f = await fixture();
  write(join(f.prefix, "node_modules/unrelated/package.json"), '{"name":"unrelated","version":"2.0.0"}');
  write(join(f.prefix, "unrelated.cmd"), "original");
  const id = await approved(f);
  const result = await applyCodexCliUpdate(id, { ...f.deps, install: async () => ({ terminal: true, exitCode: 0 }) });
  expect(result).toMatchObject({ outcome: "not_applied", reason: "original_install_unchanged", leaseRetained: false, cleanupErrors: [] });
}, WINDOWS_APPLY_BUDGET_MS);
