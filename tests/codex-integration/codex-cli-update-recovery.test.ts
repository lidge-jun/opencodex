import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyInstalledCodexVersion } from "../../src/codex/cli-update-apply";
import { runCodexCliUpdateApplyInWorker } from "../../src/codex/cli-update-job-worker";
import { recoverClosedCodexCliUpdateWorker } from "../../src/codex/cli-update-worker-recovery";
import * as gate from "../../src/codex/cli-update-selection-gate";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { helperPath, repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { createCodexCliRecoveryTestHome } from "../helpers/codex-cli-recovery-home";

let recoveryHome: string, savedHome: string | undefined;
beforeEach(() => {
  savedHome = process.env.OPENCODEX_HOME;
  recoveryHome = createCodexCliRecoveryTestHome();
  process.env.OPENCODEX_HOME = recoveryHome;
});
afterEach(() => {
  gate.resetCodexCliSelectionGatesForTests();
  if (savedHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = savedHome;
  removeTreeWithRetry(recoveryHome);
});

test.each(["macos-temp", "macos-unsafe", "linux-tmp", "linux-tmp-unsafe", "linux-home-755", "linux-home-700"])(
  "recovery fixture and admission honor the %s layout", async scenario => {
    const child = childProcess.spawn(process.execPath, [helperPath("codex-cli-recovery-layout.ts"), scenario], {
      cwd: repoRoot(), env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    expect({ code, output }).toMatchObject({ code: 0 });
  }, SPAWN_BUDGET_MS,
);

test.each([
  "child-terminal", "parent-terminal", "parent-no-record", "worker-no-record",
  "child-malformed", "parent-malformed", "child-foreign", "parent-foreign",
  "child-armed", "parent-armed", "child-unsafe", "parent-unsafe",
  "child-live-group", "parent-live-group", "child-live-parent", "parent-live-parent",
  "child-denied", "parent-denied", "child-wrong-parent", "parent-wrong-parent",
  "child-nonnull-group", "parent-nonnull-group", "child-other-owner", "parent-other-owner",
  "child-reprobe", "parent-reprobe",
  "child-competing-armed", "parent-competing-armed", "child-competing-malformed", "parent-competing-malformed",
  "child-competing-terminal", "parent-competing-terminal", "worker-armed-terminal",
])("fresh-process interrupted terminal publication: %s", async scenario => {
  const child = childProcess.spawn(process.execPath, [helperPath("codex-cli-recovery-restart.ts"), scenario], {
    cwd: repoRoot(), env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  expect({ code, output }).toMatchObject({ code: 0 });
}, SPAWN_BUDGET_MS);

test.each([
  "close-absent", "close-existing", "sync-failure", "late-arm", "alias-absent", "ancestor-alias-absent",
  "alias-armed", "alias-terminal", "alias-unsafe", "linked-store", "dangling-store",
  "canonical-absent", "canonical-armed",
])("isolated recovery publication and home admission: %s", async scenario => {
  const child = childProcess.spawn(process.execPath, [helperPath("codex-cli-recovery-publication.ts"), scenario], {
    cwd: repoRoot(), env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  expect({ code, output }).toMatchObject({ code: 0 });
});

test("precommit recovery atomically prevents a late commit during publication", () => {
  const buffer = gate.codexCliUpdateSelectionGate(), fence = gate.createCodexCliUpdateFence();
  const owner = gate.allocateCodexCliUpdateGateOwner(buffer);
  const window = gate.createWorkerCommitWindow({ gate: buffer, fence, owner, recovery: {
    arm() { recoverClosedCodexCliUpdateWorker(buffer, fence, owner, "a".repeat(36)); },
    child() {}, terminal() {},
  } });
  expect(window.tryEnter()).toBe(true);
  expect(window.commit()).toBe(false);
  const writer = gate.beginCodexCliSelectionParentWrite();
  try { expect(writer.entered).toBe(true); } finally { writer.exit(); }
});

test("worker-close recovery seals out a subsequent verifier spawn", () => {
  const buffer = gate.codexCliUpdateSelectionGate(), fence = gate.createCodexCliUpdateFence();
  const owner = gate.allocateCodexCliUpdateGateOwner(buffer);
  const window = gate.createWorkerCommitWindow({ gate: buffer, fence, owner });
  expect(window.tryEnter()).toBe(true); expect(window.commit()).toBe(true);
  recoverClosedCodexCliUpdateWorker(buffer, fence, owner, "b".repeat(36));
  expect(() => window.childStarting!()).toThrow("cli_update_owner_recovering");
  expect(gate.beginCodexCliSelectionParentWrite().entered).toBe(false);
});

test("close before gate acquisition prevents that worker's later commit", () => {
  const buffer = gate.codexCliUpdateSelectionGate(), fence = gate.createCodexCliUpdateFence();
  const owner = gate.allocateCodexCliUpdateGateOwner(buffer);
  const window = gate.createWorkerCommitWindow({ gate: buffer, fence, owner });
  recoverClosedCodexCliUpdateWorker(buffer, fence, owner, "c".repeat(36));
  try { window.tryEnter(); expect(window.commit()).toBe(false); } finally { window.exit(); }
});

test("terminal admission cleanup retries after a transient durable publication failure", () => {
  const timers: (() => void)[] = [];
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
    timers.push(callback); return { unref() {} };
  }) as never);
  const buffer = gate.codexCliUpdateSelectionGate(), fence = gate.createCodexCliUpdateFence();
  let unavailable = true;
  const window = gate.createWorkerCommitWindow({ gate: buffer, fence, recovery: {
    arm() {}, child() {}, terminal() { if (unavailable) throw new Error("fixture_storage_unavailable"); },
  } });
  expect(window.tryEnter()).toBe(true);
  try {
    expect(() => window.exit()).not.toThrow();
    expect(gate.beginCodexCliSelectionParentWrite().entered).toBe(false);
    unavailable = false;
    timers[0]!();
    const writer = gate.beginCodexCliSelectionParentWrite();
    try { expect(writer.entered).toBe(true); } finally { writer.exit(); }
  } finally { interval.mockRestore(); }
});

test("restart recovery uses durable group evidence and retains armed or inaccessible owners", async () => {
  const child = childProcess.spawn(process.execPath, [helperPath("codex-cli-recovery-store.ts")], {
    cwd: repoRoot(), env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  expect({ code, output }).toMatchObject({ code: 0 });
  expect(output).toContain("durable recovery verified");
});

test("late verifier close after reap uncertainty releases only its admission owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-late-close-"));
  const timers: { ms: number; callback(): void }[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { destroy() {} }), kill() {}, unref() {},
  });
  const spawn = spyOn(childProcess, "spawn").mockReturnValue(child as never);
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
    timers.push({ ms, callback }); return { unref() {} };
  }) as never);
  const window = gate.createWorkerCommitWindow({ gate: gate.codexCliUpdateSelectionGate(), fence: gate.createCodexCliUpdateFence() });
  expect(window.tryEnter()).toBe(true);
  try {
    const verify = verifyInstalledCodexVersion as (...args: unknown[]) => Promise<{ terminal: boolean }>;
    const pending = verify("fixture", "1.1.0", root, {}, () => window.exit());
    timers.find(timer => timer.ms === 8000)!.callback();
    timers.find(timer => timer.ms === 1000)!.callback();
    expect((await pending).terminal).toBe(false);
    expect(gate.beginCodexCliSelectionParentWrite().entered).toBe(false);
    child.emit("close", null);
    const writer = gate.beginCodexCliSelectionParentWrite();
    try { expect(writer.entered).toBe(true); } finally { writer.exit(); }
    expect((await pending).terminal).toBe(false);
  } finally { window.exit(); timeout.mockRestore(); spawn.mockRestore(); removeTreeWithRetry(root); }
});

test.each([false, true])("worker close recovers precommit only (committed=%s)", async committed => {
  const worker = new Worker(new URL("../helpers/cli-update-recovery-worker.ts", import.meta.url));
  const post = worker.postMessage.bind(worker);
  worker.postMessage = (message => post({ ...message, fixtureCommitted: committed })) as Worker["postMessage"];
  const result = await runCodexCliUpdateApplyInWorker("a".repeat(32), { snapshot: null, spawnWorkerFn: () => worker });
  expect(result.outcome).toBe("ambiguous");
  const writer = gate.beginCodexCliSelectionParentWrite();
  try { expect(writer.entered).toBe(!committed); } finally { writer.exit(); }
});

test("an obsolete window cannot release a newer generation", () => {
  const buffer = gate.codexCliUpdateSelectionGate();
  const old = gate.createWorkerCommitWindow({ gate: buffer, fence: gate.createCodexCliUpdateFence() });
  expect(old.tryEnter()).toBe(true);
  Atomics.store(new Int32Array(buffer), 0, 0); // recovery of the abandoned owner
  const current = gate.createWorkerCommitWindow({ gate: buffer, fence: gate.createCodexCliUpdateFence() });
  expect(current.tryEnter()).toBe(true);
  old.exit();
  const writer = gate.beginCodexCliSelectionParentWrite();
  try { expect(writer.entered).toBe(false); } finally { writer.exit(); current.exit(); }
});
