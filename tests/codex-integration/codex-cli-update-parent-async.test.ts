import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as gate from "../../src/codex/cli-update-selection-gate";
import * as recovery from "../../src/codex/cli-update-recovery";
import * as runtime from "../../src/codex/runtime";
import { codexCliUpdateWorkerDiagnostics } from "../../src/codex/cli-update-job-worker";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { hardenSecretDirAsync, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { setWindowsOwnerAclAsyncRunnerForTests, setWindowsOwnerAclRunnerForTests } from "../../src/lib/windows-owner-acl";
import { createCodexCliRecoveryTestHome } from "../helpers/codex-cli-recovery-home";
import { trustWindowsTempFixtureAncestry } from "../helpers/windows-temp-ancestry";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";

let home: string;
let saved: Record<string, string | undefined>;
const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  home = createCodexCliRecoveryTestHome();
  saved = Object.fromEntries(["OPENCODEX_HOME", "CODEX_CLI_PATH", "CODEX_HOME"].map(key => [key, process.env[key]]));
  process.env.OPENCODEX_HOME = home;
  delete process.env.CODEX_CLI_PATH;
  gate.resetCodexCliSelectionGatesForTests();
  runtime.clearCodexRuntimeResolveCache();
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  setWindowsOwnerAclAsyncRunnerForTests(null);
  setWindowsOwnerAclRunnerForTests(null);
  setIcaclsRunnerForTests(null);
  gate.resetCodexCliSelectionGatesForTests();
  runtime.clearCodexRuntimeResolveCache();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  removeTreeWithRetry(home);
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const free = () => Atomics.load(new Int32Array(gate.codexCliUpdateSelectionGate()), 0) === gate.CODEX_CLI_UPDATE_GATE_FREE;

test("parent reserves before awaited recovery, yields, and excludes both another parent and a Worker", async () => {
  const proof = deferred<boolean>();
  let probes = 0;
  const pending = gate.beginCodexCliSelectionParentWriteAsync({ recoveryBlocksAdmission: () => { probes++; return proof.promise; } });
  const worker = gate.createWorkerCommitWindow({ gate: gate.codexCliUpdateSelectionGate(), fence: gate.createCodexCliUpdateFence() });
  let timerProgress = false;
  await new Promise<void>(resolve => setTimeout(() => { timerProgress = true; resolve(); }, 0));
  expect(timerProgress).toBe(true);
  expect(free()).toBe(false);
  expect(codexCliUpdateWorkerDiagnostics().gate).toBe("parent_write");
  expect(worker.tryEnter()).toBe(false);
  const second = await gate.beginCodexCliSelectionParentWriteAsync({ recoveryBlocksAdmission: async () => { probes++; return false; } });
  expect(second.entered).toBe(false);
  expect(probes).toBe(1);
  expect(gate.beginCodexCliSelectionParentWrite().entered).toBe(false);
  proof.resolve(false);
  const admitted = await pending;
  try {
    expect(admitted.entered).toBe(true);
    expect(gate.beginCodexCliSelectionParentWrite().entered).toBe(false);
    admitted.commit(() => {
      const nested = gate.beginCodexCliSelectionParentWrite();
      expect(nested.entered).toBe(true);
      nested.exit();
      expect(free()).toBe(false);
      expect(gate.beginCodexCliSelectionParentWrite(join(home, "different-home")).entered).toBe(false);
    });
  } finally { admitted.exit(); }
  expect(worker.tryEnter()).toBe(true);
  expect(codexCliUpdateWorkerDiagnostics().gate).toBe("worker_commit");
  worker.exit();
  expect(free()).toBe(true);
});

for (const outcome of ["denied", "thrown"] as const) test(`recovery ${outcome} leaves no mutation and allows a fresh admission`, async () => {
  let writes = 0;
  const pending = gate.withCodexCliSelectionParentWriteAsync(() => { writes++; }, {
    recoveryBlocksAdmission: async () => { if (outcome === "thrown") throw new Error("fixture"); return true; },
  });
  await expect(pending).rejects.toThrow("codex_cli_selection_busy");
  expect(writes).toBe(0);
  expect(free()).toBe(true);
  await gate.withCodexCliSelectionParentWriteAsync(() => { writes++; }, { recoveryBlocksAdmission: async () => false });
  expect(writes).toBe(1);
});

test("aborting a pending check cannot free its gate before the check settles or admit a late allow", async () => {
  const proof = deferred<boolean>(), controller = new AbortController();
  const pending = gate.beginCodexCliSelectionParentWriteAsync({ signal: controller.signal, recoveryBlocksAdmission: () => proof.promise });
  controller.abort();
  expect(free()).toBe(false);
  expect((await gate.beginCodexCliSelectionParentWriteAsync()).entered).toBe(false);
  proof.resolve(false);
  const refused = await pending;
  expect(refused.entered).toBe(false);
  expect(() => refused.commit(() => { throw new Error("must not run"); })).toThrow("codex_cli_selection_busy");
  expect(free()).toBe(true);
});

test("stale async refusal and repeated exit never release a later Worker generation", async () => {
  const proof = deferred<boolean>(), buffer = gate.codexCliUpdateSelectionGate();
  const pending = gate.beginCodexCliSelectionParentWriteAsync({ recoveryBlocksAdmission: () => proof.promise });
  const old = Atomics.load(new Int32Array(buffer), 0);
  gate.releaseCodexCliUpdateGateOwner(buffer, old);
  const worker = gate.createWorkerCommitWindow({ gate: buffer, fence: gate.createCodexCliUpdateFence() });
  expect(worker.tryEnter()).toBe(true);
  const current = Atomics.load(new Int32Array(buffer), 0);
  expect(current).not.toBe(old);
  proof.resolve(false);
  const stale = await pending;
  expect(stale.entered).toBe(false);
  stale.exit(); stale.exit();
  expect(Atomics.load(new Int32Array(buffer), 0)).toBe(current);
  expect(codexCliUpdateWorkerDiagnostics().gate).toBe("worker_commit");
  worker.exit();
});

test("commit authority does not reach queued work and its exception releases through the async wrapper", async () => {
  let queued!: Promise<boolean>;
  const admitted = await gate.beginCodexCliSelectionParentWriteAsync({ recoveryBlocksAdmission: async () => false });
  try {
    admitted.commit(() => {
      queued = Promise.resolve().then(() => gate.beginCodexCliSelectionParentWrite().entered);
      expect(gate.beginCodexCliSelectionParentWrite().entered).toBe(true);
    });
    expect(await queued).toBe(false);
  } finally { admitted.exit(); }
  await expect(gate.withCodexCliSelectionParentWriteAsync(() => { throw new Error("commit failed"); },
    { recoveryBlocksAdmission: async () => false })).rejects.toThrow("commit failed");
  expect(free()).toBe(true);
});

for (const verdict of ["allow", "deny", "throw"] as const)
for (const change of ["input", "epoch", "cancel", "currentness"] as const) test(`runtime publication rechecks ${change} after async admission ${verdict}`, async () => {
  const command = join(home, "codex.exe");
  writeFileSync(command, "fixture", { mode: 0o700 });
  process.env.CODEX_CLI_PATH = command;
  const controller = new AbortController();
  const deps = { discoverAlternatives: false, signal: controller.signal };
  runtime.setCodexRuntimeResolveCacheForTests({ runtime: { command, source: "environment", version: "0.160.0" }, failures: [] }, { discoverAlternatives: false });
  const entered = deferred<void>(), proof = deferred<boolean>();
  spies.push(spyOn(recovery, "codexCliUpdateRecoveryBlocksAdmissionAsync").mockImplementation(() => { entered.resolve(); return proof.promise; }));
  let current = true;
  const pending = runtime.resolveAndPersistCodexRuntimeAsync(deps, () => current);
  await entered.promise;
  if (change === "input") process.env.CODEX_CLI_PATH = join(home, "other.exe");
  if (change === "epoch") runtime.clearCodexRuntimeResolveCache();
  if (change === "cancel") controller.abort();
  if (change === "currentness") current = false;
  if (verdict === "throw") proof.reject(new Error("fixture recovery failure"));
  else proof.resolve(verdict === "deny");
  expect(await pending).toBeNull();
  expect(existsSync(join(home, "codex-runtime.json"))).toBe(false);
  expect(free()).toBe(true);
});

test("async runtime persistence owns the requested home, not an unrelated default home", async () => {
  // POSIX admission legitimately delegates bounded filesystem checks to the
  // sync checker. Isolate the admitted callback here; native tests cover ACL IO.
  spies.push(spyOn(recovery, "codexCliUpdateRecoveryBlocksAdmissionAsync").mockResolvedValue(false));
  const reentry = spyOn(recovery, "codexCliUpdateRecoveryBlocksAdmission").mockImplementation(() => { throw new Error("sync recovery re-entry"); });
  spies.push(reentry);
  const target = join(home, "selected"), record = { command: "codex", version: "0.160.0", source: "configured" as const };
  await runtime.persistCodexRuntimeAsync(record, { configDir: target });
  expect(JSON.parse(readFileSync(join(target, "codex-runtime.json"), "utf8")).command).toBe("codex");
  expect(existsSync(join(home, "codex-runtime.json"))).toBe(false);
  await runtime.clearPersistedCodexRuntimeAsync({ configDir: target });
  expect(existsSync(join(target, "codex-runtime.json"))).toBe(false);
  expect(reentry).not.toHaveBeenCalled();
});

test("the async resolver publishes its selection without re-entering synchronous recovery", async () => {
  const command = join(home, "codex.exe");
  writeFileSync(command, "fixture", { mode: 0o700 });
  process.env.CODEX_CLI_PATH = command;
  runtime.setCodexRuntimeResolveCacheForTests({ runtime: { command, source: "environment", version: "0.160.0" }, failures: [] }, { discoverAlternatives: false });
  spies.push(spyOn(recovery, "codexCliUpdateRecoveryBlocksAdmissionAsync").mockResolvedValue(false));
  const reentry = spyOn(recovery, "codexCliUpdateRecoveryBlocksAdmission").mockImplementation(() => { throw new Error("sync recovery re-entry"); });
  spies.push(reentry);
  const result = await runtime.resolveAndPersistCodexRuntimeAsync({ discoverAlternatives: false });
  expect(result?.persistError).toBeUndefined();
  expect(JSON.parse(readFileSync(join(home, "codex-runtime.json"), "utf8")).command).toBe(command);
  expect(reentry).not.toHaveBeenCalled();
  expect(free()).toBe(true);
});

for (const outcome of ["allow", "deny", "plan-changed", "cancel"] as const) test(`management combined write waits for recovery and handles ${outcome} before mutation`, async () => {
  process.env.CODEX_HOME = join(home, "codex");
  mkdirSync(process.env.CODEX_HOME);
  const path = join(process.env.CODEX_HOME, "config.toml");
  const original = "[agents]\nmax_threads = 2\n";
  writeFileSync(path, original);
  const config = { providers: [] } as unknown as OcxConfig;
  const entered = deferred<void>(), proof = deferred<boolean>(), controller = new AbortController();
  let toggles = 0, syncProbes = 0;
  spies.push(spyOn(recovery, "codexCliUpdateRecoveryBlocksAdmissionAsync").mockImplementation(() => { entered.resolve(); return proof.promise; }));
  spies.push(spyOn(recovery, "codexCliUpdateRecoveryBlocksAdmission").mockImplementation(() => { syncProbes++; throw new Error("synchronous recovery must not re-enter"); }));
  const req = new Request("http://localhost/api/v2", { method: "PUT", signal: controller.signal,
    headers: { "host": "localhost", "content-type": "application/json" }, body: JSON.stringify({ enabled: true, multiAgentMode: "v2", agentsEnabled: false }) });
  const pending = handleManagementAPI(req, new URL(req.url), config, {
    toggleCodexMultiAgentV2: enabled => {
      toggles++;
      // The real default toggle resolves/persists a runtime synchronously. This
      // injected command exercises that nested writer without spawning a CLI.
      runtime.persistCodexRuntime({ command: "fixture", source: "configured", version: null });
      writeFileSync(path, readFileSync(path, "utf8").replace(/^enabled\s*=\s*(?:true|false)$/m, `enabled = ${enabled}`));
    }, createManagementConvergeCodex: catalogConvergenceFactory(),
  });
  try {
    await Promise.race([entered.promise, pending.then(async response => {
      throw new Error(`request settled before recovery: ${response?.status} ${await response?.text()}`);
    })]);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(free()).toBe(false);
    expect(toggles).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(existsSync(join(home, "codex-runtime.json"))).toBe(false);
    expect(config.multiAgentMode).toBeUndefined();
    if (outcome === "plan-changed") config.keepNativeChatGptOnV1 = true;
    if (outcome === "cancel") controller.abort();
    proof.resolve(outcome === "deny");
    const response = await pending;
    expect(response?.status).toBe(outcome === "allow" ? 200 : outcome === "plan-changed" ? 400 : 503);
    expect(syncProbes).toBe(0);
    expect(free()).toBe(true);
    if (outcome === "allow") {
      expect(toggles).toBe(1);
      expect(config.multiAgentMode).toBe("v2");
      expect(readFileSync(path, "utf8")).toContain("enabled = false");
      expect(existsSync(join(home, "codex-runtime.json"))).toBe(true);
    } else {
      expect(toggles).toBe(0);
      expect(config.multiAgentMode).toBeUndefined();
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(existsSync(join(home, "codex-runtime.json"))).toBe(false);
    }
  } finally { proof.resolve(true); await pending; }
});

const native = process.platform === "win32" && process.arch === "x64" ? test : test.skip;
async function nativeTerminalStore() {
  await hardenSecretDirAsync(home, { required: true });
  trustWindowsTempFixtureAncestry(home);
  const config = join(home, "config");
  mkdirSync(config);
  await hardenSecretDirAsync(config, { required: true });
  const owner = recovery.createCodexCliUpdateRecovery(crypto.randomUUID(), config);
  owner.arm(); owner.terminal();
  return config;
}
native("native recovery uses async ACL subprocesses while timers advance; the commit never re-enters synchronous recovery", async () => {
  const configDir = await nativeTerminalStore();
  let syncCalls = 0, syncHardenCalls = 0, ticks = 0;
  setWindowsOwnerAclRunnerForTests(() => { syncCalls++; throw new Error("sync ACL forbidden during recovery"); });
  setIcaclsRunnerForTests(() => { syncHardenCalls++; throw new Error("sync hardening forbidden during recovery"); });
  const timer = setInterval(() => { ticks++; }, 1);
  let admitted: gate.CodexCliSelectionAsyncParentWrite | undefined;
  try {
    admitted = await gate.beginCodexCliSelectionParentWriteAsync({ configDir });
    expect(admitted.entered).toBe(true);
    expect(ticks).toBeGreaterThan(0);
    expect(syncCalls).toBe(0);
    expect(syncHardenCalls).toBe(0);
    // Ordinary atomic secret-file publication retains its synchronous contract.
    // Only recovery admission is asynchronous; the nested writer must reuse
    // this root/generation's admission without re-running recovery.
    setWindowsOwnerAclRunnerForTests(null);
    setIcaclsRunnerForTests(null);
    const reentry = spyOn(recovery, "codexCliUpdateRecoveryBlocksAdmission").mockImplementation(() => { throw new Error("sync recovery re-entry"); });
    spies.push(reentry);
    admitted.commit(() => runtime.persistCodexRuntime({ command: "fixture", version: null, source: "configured" }, { configDir }));
    expect(existsSync(join(configDir, "codex-runtime.json"))).toBe(true);
    expect(reentry).not.toHaveBeenCalled();
  } finally { clearInterval(timer); admitted?.exit(); }
}, 30_000);

native("native async ACL denial preserves recovery bytes, releases pins, and refuses publication", async () => {
  const configDir = await nativeTerminalStore();
  const dir = join(configDir, "codex-cli-update-recovery");
  const snapshot = () => readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), "utf8")]);
  const before = snapshot();
  setWindowsOwnerAclAsyncRunnerForTests(async () => ({ success: false, timedOut: true, stdout: "" }));
  await expect(runtime.persistCodexRuntimeAsync({ command: "fixture", version: null, source: "configured" }, { configDir }))
    .rejects.toThrow("codex_cli_selection_busy");
  expect(existsSync(join(configDir, "codex-runtime.json"))).toBe(false);
  expect(snapshot()).toEqual(before);
  expect(free()).toBe(true);
  setWindowsOwnerAclAsyncRunnerForTests(null);
  expect(await recovery.codexCliUpdateRecoveryBlocksAdmissionAsync(configDir)).toBe(false);
}, 30_000);
