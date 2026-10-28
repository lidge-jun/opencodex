import { createCodexCliTestRoot } from "../helpers/codex-cli-fixture-root";
import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, toNamespacedPath } from "node:path";
import { hardenSecretDirAsync } from "../../src/lib/windows-secret-acl";
import { pendingBackgroundWork } from "../../src/lib/background-work";
import { drainWindowsRestartRecovery, waitForWindowsRecovery, withWindowsRestartRecoveryFixture, WINDOWS_RESTART_FIXTURE_MS } from "../helpers/windows-cli-restart-fixture";
import type { WindowsRecoveryProbe } from "../helpers/windows-cli-recovery-state";
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
for (const state of ["absent", "reused", "exited"]) test(`recovery proof polls past observer errors until guardian is ${state}`, async () => {
  const terminal: WindowsRecoveryProbe = { entered: true, recovery: {
    guardian: { state }, job: { state: "absent", error: 2 }, record: {}, receipt: { phase: "terminal" },
  } };
  let calls = 0;
  const result = await waitForWindowsRecovery(() => ++calls === 1
    ? { entered: true, recovery: { error: "fixture_recovery_record_count=0" } } : terminal);
  expect(result).toBe(terminal);
  expect(calls).toBe(2);
});
test("recovery proof retries a thrown probe before accepting a terminal guardian", async () => {
  const terminal: WindowsRecoveryProbe = { entered: true, recovery: {
    guardian: { state: "exited" }, job: { state: "absent", error: 2 }, record: {}, receipt: { phase: "terminal" },
  } };
  let calls = 0;
  expect(await waitForWindowsRecovery(() => {
    if (++calls === 1) throw new Error("fixture_probe_failed");
    return terminal;
  })).toBe(terminal);
  expect(calls).toBe(2);
});
test("recovery proof times out with the observer error instead of accepting missing guardian", async () => {
  let clock = 0;
  await expect(waitForWindowsRecovery(() => { clock = 90_000; return { entered: true, recovery: { error: "native_query_failed" } }; },
    () => clock)).rejects.toThrow('native_recovery_proof_timeout: {"entered":true,"recovery":{"error":"native_query_failed"}}');
});
test("a retry near the deadline gets only the remaining time and late proof is refused", async () => {
  const terminal: WindowsRecoveryProbe = { entered: true, recovery: {
    guardian: { state: "exited" }, job: { state: "absent", error: 2 }, record: {}, receipt: { phase: "terminal" },
  } };
  let clock = 0;
  const budgets: number[] = [];
  await expect(waitForWindowsRecovery(timeoutMs => {
    budgets.push(timeoutMs);
    if (budgets.length === 1) { clock = 89_990; throw new Error("fixture_probe_failed"); }
    clock = 90_001; return terminal;
  }, () => clock)).rejects.toThrow("native_recovery_proof_timeout: " + JSON.stringify(terminal));
  expect(budgets).toEqual([90_000, 10]);
});
test("recovery proof accepts missing guardian only with explicit evidence native startup never began", async () => {
  const probe: WindowsRecoveryProbe = { entered: true, guardianStarted: false, recovery: { error: "identity_missing" } };
  expect(await waitForWindowsRecovery(() => probe)).toBe(probe);
});
for (const state of ["running", "unknown"]) test(`recovery proof keeps polling a ${state} guardian`, async () => {
  let calls = 0;
  await waitForWindowsRecovery(() => ({ entered: true, guardianStarted: true, recovery: {
    guardian: { state: ++calls === 1 ? state : "exited" }, job: { state: "absent", error: 2 }, record: {}, receipt: {},
  } }));
  expect(calls).toBe(2);
});
test("owner timeout stops the wrapper and drains recovery before reporting the timeout", async () => {
  const events: string[] = [];
  const owner = { exited: new Promise<number>(() => {}), kill() { events.push("kill"); } };
  await expect(drainWindowsRestartRecovery(owner, () => {
    events.push("probe");
    return { entered: true, guardianStarted: false, recovery: { error: "identity_missing" } };
  }, () => { events.push("settled"); }, 0)).rejects.toThrow("fixture_owner_exit_timeout");
  expect(events).toEqual(["kill", "probe", "settled"]);
});
test("owner timeout keeps a failed recovery drain visible and tracked", async () => {
  const events: string[] = [], failure = new Error("fixture_probe_failed");
  const owner = { exited: new Promise<number>(() => {}), kill() { events.push("kill"); } };
  let clock = 0;
  await expect(drainWindowsRestartRecovery(owner, () => {
    events.push("probe");
    if (events.length === 2) { clock = 89_999; throw new Error("first_probe_failed"); }
    clock = 90_000; throw failure;
  }, () => { events.push("settled"); }, 0, () => clock)).rejects.toThrow("native_recovery_proof_timeout: Error: fixture_probe_failed");
  expect(events).toEqual(["kill", "probe", "probe"]);
});
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
  await withWindowsRestartRecoveryFixture(descendant, async ({ root, config, alias, owner, probe: observe }) => {
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
    const probe = (home = config) => observe(home).entered;
    writeFileSync(join(root, "ping"), "ping"); await until(() => existsSync(join(root, "pong")));
    expect(probe()).toBe(false);
    expect(probe(alias)).toBe(false);
    writeFileSync(join(root, "stop"), "stop");
    const recovered = await waitForWindowsRecovery(timeoutMs => observe(config, timeoutMs));
    expect(recovered.entered).toBe(true);
    expect(["absent", "reused", "exited"]).toContain("guardian" in recovered.recovery ? recovered.recovery.guardian.state : null);
    expect(recovered.recovery).toMatchObject({ receipt: { token: record.token, phase: "terminal", pgid: null,
      parentPid: record.parentPid, windows: { jobName: record.windows.jobName } } });
    expect(probe(alias)).toBe(true);
    const proofPath = join(store, record.token + ".proof"), proof = readFileSync(proofPath, "utf8");
    try {
      const foreign = JSON.parse(proof); foreign.windows.jobName = `Global\\ocx-cli-${crypto.randomUUID()}`;
      writeFileSync(proofPath, JSON.stringify(foreign)); expect(probe()).toBe(false);
      writeFileSync(proofPath, "{"); expect(probe(alias)).toBe(false);
      writeFileSync(proofPath, proof); expect(probe()).toBe(true);
    } finally { writeFileSync(proofPath, proof); }
  });
}, WINDOWS_RESTART_FIXTURE_MS);

native("restart recovery drains the native Job and guardian when the test body fails", async () => {
  const failure = new Error("deliberate_fixture_body_failure");
  let recovered: (() => WindowsRecoveryProbe) | undefined;
  await expect(withWindowsRestartRecoveryFixture(false, async ({ owner, probe }) => {
    expect(await owner.exited).toBe(0);
    expect(probe().entered).toBe(false);
    recovered = probe;
    throw failure;
  })).rejects.toBe(failure);
  const final = recovered!();
  expect(final.entered).toBe(true);
  expect(final.recovery).toMatchObject({ receipt: { phase: "terminal" } });
  expect(["absent", "reused", "exited"]).toContain("guardian" in final.recovery ? final.recovery.guardian.state : null);
  expect("job" in final.recovery).toBe(true);
  if ("job" in final.recovery) {
    expect(final.recovery.job.state === "absent"
      || (final.recovery.job.state === "observed" && final.recovery.job.activeProcesses === 0)).toBe(true);
  }
  expect(pendingBackgroundWork()).not.toContain("native restart recovery fixture");
}, WINDOWS_RESTART_FIXTURE_MS);
