import { createCodexCliTestRoot } from "../helpers/codex-cli-fixture-root";
import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, toNamespacedPath } from "node:path";
import { hardenSecretDirAsync } from "../../src/lib/windows-secret-acl";
import { helperPath } from "../helpers/repo-root";
import { trackBackgroundWork } from "../../src/lib/background-work";
import { startWindowsCliChild } from "../../src/codex/windows-cli-child";
import { startWindowsCliChildWithNative } from "../../src/codex/windows-cli-child";
import { WindowsChildNative } from "../../src/codex/windows-cli-child-native";
import { createCodexCliWorkerCommitWindow } from "../../src/codex/cli-update-worker";
import { read } from "bun:ffi";
import { prepareRetentionFixture } from "../helpers/windows-cli-apply-retention-fixture";
import { trustWindowsTempFixtureAncestry } from "../helpers/windows-temp-ancestry";
import { createCodexCliUpdatePlan } from "../../src/codex/cli-update-plan";
import { applyCodexCliUpdate } from "../../src/codex/cli-update-apply";
import { recoverClosedCodexCliUpdateWorker } from "../../src/codex/cli-update-worker-recovery";
import * as recovery from "../../src/codex/cli-update-recovery";
import { codexCliUpdateSelectionGate, createCodexCliUpdateFence, allocateCodexCliUpdateGateOwner,
  createWorkerCommitWindow, beginCodexCliSelectionParentWrite, resetCodexCliSelectionGatesForTests,
  type CodexCliSelectionParentWrite } from "../../src/codex/cli-update-selection-gate";
import { observeWindowsInstall } from "../../src/codex/cli-update-windows-observation";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const native = process.platform === "win32" && process.arch === "x64" ? test : test.skip;
for (const kind of ["recovery", "pending", "readback"] as const) native(`Windows ${kind} publication hardens canonical paths beyond MAX_PATH`, async () => {
  const root = createCodexCliTestRoot("ocx-long-store-");
  await hardenSecretDirAsync(root, { required: true }); trustWindowsTempFixtureAncestry(root);
  let parent = root;
  const minimum = kind === "pending" ? 205 : 270;
  while (parent.length < minimum) {
    parent = join(parent, "c".repeat(Math.min(60, minimum - parent.length))); mkdirSync(parent);
    await hardenSecretDirAsync(toNamespacedPath(parent), { required: true });
  }
  const config = join(parent, "config");
  expect(config.length).toBeGreaterThan(kind === "pending" ? 200 : 260);
  try {
    if (kind === "readback") {
      mkdirSync(config); await hardenSecretDirAsync(toNamespacedPath(config), { required: true });
      writeFileSync(join(config, "fixture.txt"), "owned fixture");
      expect((await observeWindowsInstall(config)).files).toMatchObject([{ relativePath: "fixture.txt", size: 13 }]);
    } else {
      mkdirSync(config); await hardenSecretDirAsync(toNamespacedPath(config), { required: true });
      const token = crypto.randomUUID(), owner = recovery.createCodexCliUpdateRecovery(token, config);
      owner.arm(); expect(recovery.codexCliUpdateRecoveryBlocksAdmission(config)).toBe(true);
      recovery.finishClosedCodexCliUpdateRecovery(token, config);
      expect(recovery.codexCliUpdateRecoveryBlocksAdmission(config)).toBe(false);
      expect(readdirSync(join(config, "codex-cli-update-recovery"))).toContain(token + ".terminal");
    }
    expect(realpathSync.native(config)).toBe(config);
  } finally { removeTreeWithRetry(root); }
}, 60000);
async function until(check: () => boolean, deadline = Date.now() + 30000) {
  while (!check()) { if (Date.now() >= deadline) throw new Error("fixture_handshake_timeout"); await Bun.sleep(10); }
}
native("normal guardian settlement isolates profile/cache writes and joins before staging cleanup", async () => {
  const root = createCodexCliTestRoot("ocx-guardian-profile-");
  await hardenSecretDirAsync(root, { required: true }); trustWindowsTempFixtureAncestry(root);
  const f = await prepareRetentionFixture(root); mkdirSync(f.configDir);
  const before = process.env.OPENCODEX_HOME; process.env.OPENCODEX_HOME = f.configDir;
  resetCodexCliSelectionGatesForTests();
  const gate = codexCliUpdateSelectionGate(), fence = createCodexCliUpdateFence();
  const window = createCodexCliWorkerCommitWindow({ gate, fence, requestId: crypto.randomUUID(), owner: allocateCodexCliUpdateGateOwner(gate) });
  let creates = 0, environment: Record<string, string> = {}, staging = "";
  try {
    const plan = await createCodexCliUpdatePlan(f.deps); expect(plan.applicable).toBe(true);
    const result = await applyCodexCliUpdate(plan.planId!, { ...f.deps, commitWindow: window,
      startWindowsChild(invocation) {
        staging = invocation.cwd;
        const native = new WindowsChildNative(), create = native.k.CreateProcessW;
        native.k.CreateProcessW = (...args) => {
          if (++creates === 2) {
            let text = "";
            for (let i = 0; i < 32768; i++) {
              const code = read.u16(args[6]!, i * 2);
              if (!code && text.endsWith("\0")) break; text += String.fromCharCode(code);
            }
            environment = Object.fromEntries(text.split("\0").filter(Boolean).map(item => {
              const separator = item.indexOf("="); return [item.slice(0, separator), item.slice(separator + 1)];
            }));
          }
          return create(...args);
        };
        return startWindowsCliChildWithNative({ ...invocation, executable: process.execPath,
          args: ["-e", "process.exit(0)"], env: { SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root } }, native);
      },
    });
    expect(result).toMatchObject({ outcome: "not_applied", leaseRetained: false, cleanupErrors: [] });
    expect(creates).toBe(2);
    for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) expect(environment[name]).toBe(staging);
    expect(environment.PSModuleAnalysisCachePath).toBe(join(staging, "guardian-module-analysis-cache"));
    expect(existsSync(staging)).toBe(false);
  } finally {
    resetCodexCliSelectionGatesForTests();
    if (before === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = before;
  }
}, 90000);
native("a terminal version child with an unconfirmed guardian keeps the bounded reap result", async () => {
  const root = createCodexCliTestRoot("ocx-guardian-reap-");
  const child = startWindowsCliChild({ executable: process.execPath, args: ["-e", "process.exit(0)"],
    cwd: root, env: { SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root }, policy: "version" });
  await until(() => child.observe().terminal);
  // A real unsignaled native waitable models an observer whose exit is unproven.
  const event = child.native.keep(child.native.k.CreateEventW(null, 1, 0, null));
  child.recoveryGuardian = event;
  const policy = child.policy as { deadlineMs: number; reapMs: number }; policy.deadlineMs = 0; policy.reapMs = 0;
  try { expect(await child.wait()).toMatchObject({ terminal: false, cleanupComplete: false, reason: "recovery_observer_state_unknown" }); }
  finally { child.recoveryGuardian = 0n; child.native.close(event); }
  expect(await child.wait()).toMatchObject({ terminal: true, cleanupComplete: true });
}, 15000);
native("Windows durable uncertainty fences a fresh gate before native creation", async () => {
  const root = createCodexCliTestRoot("ocx-pre-spawn-arm-"), config = join(root, "config");
  await hardenSecretDirAsync(root, { required: true }); mkdirSync(config);
  await hardenSecretDirAsync(config, { required: true }); trustWindowsTempFixtureAncestry(root);
  const token = crypto.randomUUID(), before = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = config;
  const durable = recovery.createCodexCliUpdateRecovery(token, config);
  const gate = codexCliUpdateSelectionGate(), fence = createCodexCliUpdateFence(), owner = allocateCodexCliUpdateGateOwner(gate);
  const window = createWorkerCommitWindow({ gate, fence, owner, recovery: durable });
  try {
    expect(window.tryEnter()).toBe(true); durable.arm();
    resetCodexCliSelectionGatesForTests(); // Restarted memory must consult durable uncertainty.
    expect(beginCodexCliSelectionParentWrite().entered).toBe(false);
    recoverClosedCodexCliUpdateWorker(gate, fence, owner, token, config);
    expect(window.commit()).toBe(false);
    const writer = beginCodexCliSelectionParentWrite(); expect(writer.entered).toBe(true); writer.exit();
  } finally {
    window.exit(); resetCodexCliSelectionGatesForTests();
    if (before === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = before;
  }
}, 60000);
for (const during of ["arm", "publication"] as const) native(`Windows close cannot use a previous child's proof during ${during}`, async () => {
  const root = createCodexCliTestRoot("ocx-proof-generation-"), configDir = join(root, "config");
  await hardenSecretDirAsync(root, { required: true }); mkdirSync(configDir);
  await hardenSecretDirAsync(configDir, { required: true }); trustWindowsTempFixtureAncestry(root);
  resetCodexCliSelectionGatesForTests();
  const gate = codexCliUpdateSelectionGate(), fence = createCodexCliUpdateFence(), owner = allocateCodexCliUpdateGateOwner(gate);
  const staleProof = spyOn(recovery, "closedWindowsCodexCliUpdateChildGone").mockReturnValue(true);
  let calls = 0, entered = false;
  const close = () => {
    recoverClosedCodexCliUpdateWorker(gate, fence, owner, crypto.randomUUID(), configDir);
    const parent = beginCodexCliSelectionParentWrite(); entered = parent.entered; parent.exit();
  };
  const window = createWorkerCommitWindow({ gate, fence, owner, recovery: {
    arm() { if (++calls === 2 && during === "arm") close(); },
    child() { if (during === "publication") close(); }, terminal() {},
  } });
  try {
    expect(window.tryEnter()).toBe(true); expect(window.commit()).toBe(true);
    if (during === "arm") window.childStarted!(123);
    const starting = () => window.childStarting!(`Global\\ocx-cli-${crypto.randomUUID()}`);
    if (during === "arm") expect(starting).toThrow("cli_update_owner_recovering"); else starting();
    if (during === "publication") window.childStarted!(123);
    expect(entered).toBe(false);
    expect(staleProof).not.toHaveBeenCalled();
  } finally { staleProof.mockRestore(); window.exit(); resetCodexCliSelectionGatesForTests(); }
}, 60000);
for (const acquired of [true, false]) native(`Windows apply seals close before a late ${acquired ? "commit" : "acquisition"}`, async () => {
  const root = createCodexCliTestRoot("ocx-windows-close-");
  await hardenSecretDirAsync(root, { required: true }); trustWindowsTempFixtureAncestry(root);
  const f = await prepareRetentionFixture(root); mkdirSync(f.configDir);
  const previous = process.env.OPENCODEX_HOME; process.env.OPENCODEX_HOME = f.configDir;
  resetCodexCliSelectionGatesForTests();
  const gate = codexCliUpdateSelectionGate(), fence = createCodexCliUpdateFence();
  const owner = allocateCodexCliUpdateGateOwner(gate), window = createWorkerCommitWindow({ gate, fence, owner });
  let writer: CodexCliSelectionParentWrite | undefined, closed = false, starts = 0;
  const close = () => {
    recoverClosedCodexCliUpdateWorker(gate, fence, owner, crypto.randomUUID(), f.configDir);
    writer = beginCodexCliSelectionParentWrite(); expect(writer.entered).toBe(true);
    expect(window.commit()).toBe(false);
    writer.exit();
    expect(window.tryEnter()).toBe(false);
    closed = true;
  };
  try {
    const plan = await createCodexCliUpdatePlan(f.deps); expect(plan.applicable).toBe(true);
    const result = await applyCodexCliUpdate(plan.planId!, { ...f.deps,
      commitWindow: acquired ? window : { ...window, tryEnter() { close(); return window.tryEnter(); } },
      scanProcesses() {
        if (acquired && Atomics.load(new Int32Array(gate), 0) === owner) close();
        return { kind: "observed", processes: [] };
      },
      startWindowsChild() { starts++; throw new Error("late_installer_must_not_start"); },
    });
    expect(closed).toBe(true); expect(starts).toBe(0);
    expect(result).toMatchObject({ outcome: "refused", leaseRetained: false });
    expect(window.commit()).toBe(false);
  } finally {
    writer?.exit(); resetCodexCliSelectionGatesForTests();
    if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
  }
}, 60000);
for (const descendant of [false, true]) native(`restarted Windows admission fences the surviving native ${descendant ? "descendant" : "installer"} Job, including home aliases`, async () => {
  const root = createCodexCliTestRoot("ocx-windows-restart-");
  await hardenSecretDirAsync(root, { required: true });
  const config = join(root, "config"), alias = join(root, "home-alias");
  const helper = helperPath("windows-cli-restart-recovery.ts");
  const env = { ...process.env, OPENCODEX_HOME: config };
  let settled!: () => void;
  trackBackgroundWork("native restart recovery fixture", new Promise<void>(resolve => { settled = resolve; }));
  const owner = Bun.spawn([process.execPath, helper, descendant ? "owner-descendant" : "owner", root], { env, stdout: "pipe", stderr: "pipe" });
  try {
  const error = await new Response(owner.stderr).text();
  expect({ exit: await owner.exited, error }).toEqual({ exit: 0, error: "" });
  expect(existsSync(join(root, "identity.json"))).toBe(true);
  const identity = JSON.parse(readFileSync(join(root, "identity.json"), "utf8"));
  const store = join(config, "codex-cli-update-recovery");
  const records = readdirSync(store).filter(name => name.endsWith(".json")); expect(records).toHaveLength(1);
  const record = JSON.parse(readFileSync(join(store, records[0]!), "utf8"));
  expect(record).toMatchObject({ phase: "child", pgid: identity.pid, windows: { creationTime: identity.creationTime } });
  expect(record.windows.jobName).toMatch(/^Global\\ocx-cli-/);
  symlinkSync(config, alias, "junction");
  const probe = (home = config) => {
    const result = Bun.spawnSync([process.execPath, helper, "probe", root], { env: { ...env, OPENCODEX_HOME: home } });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return JSON.parse(result.stdout.toString()).entered as boolean;
  };
    writeFileSync(join(root, "ping"), "ping"); await until(() => existsSync(join(root, "pong")));
    expect(probe()).toBe(false);
    expect(probe(alias)).toBe(false);
    writeFileSync(join(root, "stop"), "stop");
  await until(() => probe());
  expect(probe(alias)).toBe(true);
  const proofPath = join(store, record.token + ".proof"), proof = readFileSync(proofPath, "utf8");
  const foreign = JSON.parse(proof); foreign.windows.jobName = `Global\\ocx-cli-${crypto.randomUUID()}`;
  writeFileSync(proofPath, JSON.stringify(foreign)); expect(probe()).toBe(false);
  writeFileSync(proofPath, "{"); expect(probe(alias)).toBe(false);
  writeFileSync(proofPath, proof); expect(probe()).toBe(true);
  settled(); // Actual Job/receipt proof, not owner-process exit alone.
  } finally { writeFileSync(join(root, "stop"), "stop"); }
}, 90000);
