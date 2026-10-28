import { createCodexCliTestRoot } from "./codex-cli-fixture-root";
// Isolated process: module substitution supplies only provenance evidence.
// Apply, archive validation, filesystem, shared gate and both callers are real.
import { expect, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import * as provenance from "../../src/codex/cli-install-provenance";
import * as artifacts from "../../src/codex/cli-update-artifacts";
import * as files from "../../src/codex/cli-update-files";
import { fixtureArtifactSet } from "./codex-cli-apply-artifact";
import { removeTreeWithRetry } from "./remove-tree";

const root = createCodexCliTestRoot("ocx-apply-admission-");
const lane = process.argv[2] ?? "terminal";
const prefix = join(root, "prefix"), temporaryRoot = join(root, "temp");
fs.mkdirSync(prefix); fs.mkdirSync(temporaryRoot);
const mutationDirectory = join(prefix, "lib"); fs.mkdirSync(mutationDirectory);
const artifact = fixtureArtifactSet("linux", "x64");
const evidence = { prefix, packageRoot: join(prefix, "lib/node_modules/@openai/codex"),
  backingRoot: join(prefix, "lib/node_modules/@openai/codex-linux-x64"), launcher: join(prefix, "bin/codex"),
  canonicalLauncher: join(prefix, "lib/node_modules/@openai/codex/bin/codex.js") };
const report = { managed: true, packageVersion: "1.0.0", provenance: "npm-global", installDigest: "a".repeat(64),
  installContentDigest: "c".repeat(64), versionEvidence: { kind: "package-manifest" }, shim: { status: "not-tracked" } };
if (lane === "arming") {
  // This lane tests pre-child lifetime only. Model verified target readback;
  // archive parsing and all apply control/cleanup/gate code stay real.
  mock.module("../../src/codex/cli-update-artifacts", () => ({ ...artifacts, verifiedCodexCliContent: () => "d".repeat(64) }));
  mock.module("../../src/codex/cli-update-files", () => ({ ...files, sameCodexCliFiles: () => true }));
}
mock.module("../../src/codex/cli-install-provenance", () => ({ ...provenance,
  inspectCodexCliInstall: async () => report, codexCliMutationEvidence: () => evidence,
  observeCodexCliSelectedCommand: () => evidence.launcher, codexCliMutationSelectionMatches: () => true }));
const { applyCodexCliUpdate } = await import("../../src/codex/cli-update-apply");
const { createCodexCliUpdatePlan } = await import("../../src/codex/cli-update-plan");
const gate = await import("../../src/codex/cli-update-selection-gate");
const { CodexRemoteWorkspaceRuntimeFactory, RemoteWorkspaceCoordinator } = await import("../../src/remote-control");
const { restartCodexDesktopApp } = await import("../../src/codex/desktop-app-restart");
const { linuxDesktopAppAdapter } = await import("../../src/codex/desktop-app/linux");

// Model POSIX directory ownership only; actual paths, identities and operations
// remain native. No Windows installation or real Codex child is permitted.
const lstat = fs.lstatSync, uid = process.geteuid?.() ?? 1234;
const originalUid = Object.getOwnPropertyDescriptor(process, "geteuid");
let barrier = false;
Object.defineProperty(process, "geteuid", { configurable: true, value: () => uid });
const stat = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike) => {
  const value = lstat(path);
  return value.isDirectory() ? Object.assign(value, { uid,
    mode: 0o40700 | (path === temporaryRoot && lane === "unsafe-stage" ? 0o002 : 0)
      | (barrier && path === mutationDirectory && lane === "unsafe-install" ? 0o020 : 0) }) : value;
}) as typeof fs.lstatSync);
let arms = 0, unavailable = false;
const recoveryTimers: (() => void)[] = [];
const retry = lane === "arming" ? spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
  recoveryTimers.push(callback); return { unref() {} };
}) as never) : undefined;
const installWindow = gate.createWorkerCommitWindow({ gate: gate.codexCliUpdateSelectionGate(), fence: gate.createCodexCliUpdateFence(),
  recovery: lane !== "arming" ? undefined : {
    arm() { if (++arms === 2) { unavailable = true; throw new Error("fixture_arming_failed"); } },
    child() {}, terminal() { if (unavailable) throw new Error("fixture_durable_terminal_unavailable"); },
  } });
let spawned!: () => void, terminate!: () => void, readback!: () => void, completeReadback!: () => void;
const started = new Promise<void>(resolve => { spawned = resolve; });
const terminal = new Promise<{ terminal: boolean; exitCode: number }>(resolve => { terminate = () => resolve({ terminal: true, exitCode: 0 }); });
const inspecting = new Promise<void>(resolve => { readback = resolve; });
const receipt = new Promise<void>(resolve => { completeReadback = resolve; });
let running = false;
let recover!: () => void;
const recovery = new Promise<void>(resolve => { recover = resolve; });
let scans = 0, installs = 0;
const pathLane = ["unsafe-stage", "unsafe-install", "rename-install", "rename-stage"].includes(lane);
const deps = { platform: "linux" as const, temporaryRoot, inspectionDeps: { arch: "x64", env: process.env },
  scanProcesses: () => {
    if (++scans === 3) {
      barrier = true;
      const target = lane === "rename-install" ? mutationDirectory : lane === "rename-stage"
        ? join(temporaryRoot, fs.readdirSync(temporaryRoot)[0]!) : null;
      if (target) {
        fs.renameSync(target, target + "-displaced"); fs.mkdirSync(target);
        if (lane === "rename-stage") {
          for (const name of fs.readdirSync(target + "-displaced")) {
            fs.cpSync(join(target + "-displaced", name), join(target, name), { recursive: true });
          }
        }
      }
    }
    return { kind: "observed" as const, processes: [] };
  },
  resolveTarget: () => ({ kind: "resolved" as const, version: "1.1.0", integrity: artifact.artifacts.main.integrity, artifacts: artifact.artifacts }),
  fetchArtifact: async (value: { installName: string }) => value.installName === artifact.artifacts.main.installName ? artifact.main : artifact.backing,
  acquireLease: () => ({ kind: "acquired" as const, release: () => true }), commitWindow: installWindow,
  inspect: async () => { if (running && lane !== "arming") { readback(); await receipt; } return report as provenance.CodexCliInstallReport; },
  install: () => { installs++; if (pathLane) return Promise.resolve({ terminal: true, exitCode: 0 });
    running = true; spawned(); return terminal.then(value => {
      if (lane === "arming") {
        report.packageVersion = "1.1.0"; report.installContentDigest = "d".repeat(64);
        for (const [dir, entries] of [[evidence.packageRoot, artifact.mainFiles], [evidence.backingRoot, artifact.backingFiles]] as const) {
          for (const [name, bytes] of Object.entries(entries)) {
            const path = join(dir, name); fs.mkdirSync(join(path, ".."), { recursive: true });
            fs.writeFileSync(path, bytes, { mode: 0o755 });
          }
        }
        fs.mkdirSync(join(evidence.launcher, ".."), { recursive: true }); fs.writeFileSync(evidence.launcher, "fixture", { mode: 0o755 });
      }
      return ["unknown", "recovery"].includes(lane)
      ? { ...value, terminal: false, ...(lane === "recovery" ? { recovery } : {}) } : value; }); } };
let pending: ReturnType<typeof applyCodexCliUpdate> | undefined;
const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("unexpected_owned_spawn"); });
async function refusedCallers() {
  const writer = gate.beginCodexCliSelectionParentWrite();
  try { expect(writer.entered).toBe(false); } finally { writer.exit(); }
  const factory = new CodexRemoteWorkspaceRuntimeFactory({ command: [process.execPath, "unused-fixture.ts"] });
  await expect(factory.start({ sessionId: "fixture-session", deviceId: "fixture-device", deviceName: "Fixture",
    rootId: "fixture-root", rootLabel: "Fixture", capabilities: ["workspace.read"], tools: ["read_file"],
    coordinator: new RemoteWorkspaceCoordinator({ isOnline: () => true, invoke: async () => ({ ok: true }) }), emit: () => {} }))
    .rejects.toThrow("codex_cli_selection_busy");
  expect(spawn).toHaveBeenCalledTimes(0);
  let discoveries = 0;
  const restart = restartCodexDesktopApp({ platform: "linux", execFile: () => { discoveries++; return null; },
    lock: { lockPath: join(root, "restart.lock") } });
  expect(restart.reason).toBe("selection_mutation_busy");
  expect(discoveries).toBe(0);
}
try {
  const plan = await createCodexCliUpdatePlan(deps);
  expect(plan.applicable).toBe(true);
  scans = 0;
  pending = applyCodexCliUpdate(plan.planId!, deps);
  if (pathLane) {
    const result = await pending;
    expect(result).toMatchObject({ outcome: "refused", reason: lane.endsWith("stage")
      ? "staging_path_untrusted" : "installation_paths_untrusted" });
    expect(installs).toBe(0);
    console.log("admission lifecycle verified");
  } else {
  const admitted = await Promise.race([started.then(() => "started"), pending.then(result => result.reason)]);
  expect(admitted).toBe("started");
  await refusedCallers();
  terminate();
  if (lane === "arming") {
    expect(await pending).toMatchObject({ outcome: "ambiguous", leaseRetained: false });
    expect(arms).toBe(2);
    await refusedCallers();
    unavailable = false;
    expect(recoveryTimers).toHaveLength(1); recoveryTimers[0]!();
    const writer = gate.beginCodexCliSelectionParentWrite();
    try { expect(writer.entered).toBe(true); } finally { writer.exit(); }
  } else
  if (["unknown", "recovery"].includes(lane)) {
    expect(await pending).toMatchObject({ outcome: "ambiguous", reason: "installer_state_unknown", leaseRetained: true });
    await refusedCallers();
    if (lane === "recovery") {
      recover(); await recovery; await Promise.resolve();
      const factory = new CodexRemoteWorkspaceRuntimeFactory({ command: [process.execPath, "unused-fixture.ts"] });
      let remoteFailure = "";
      try { await factory.start({ sessionId: "fixture-session", deviceId: "fixture-device", deviceName: "Fixture",
        rootId: "fixture-root", rootLabel: "Fixture", capabilities: ["workspace.read"], tools: ["read_file"],
        coordinator: new RemoteWorkspaceCoordinator({ isOnline: () => true, invoke: async () => ({ ok: true }) }), emit: () => {} });
      } catch (error) { remoteFailure = (error as Error).message; }
      let discoveries = 0;
      const restarted = restartCodexDesktopApp({ platform: "linux", execFile: () => null,
        adapter: { ...linuxDesktopAppAdapter, discover: () => { discoveries++; return null; } },
        lock: { lockPath: join(root, "restart.lock") } });
      expect({ remoteFailure, desktopReason: restarted.reason }).toEqual({
        remoteFailure: "unexpected_owned_spawn", desktopReason: "package_discovery_failed" });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(discoveries).toBe(1);
    }
  } else {
    await inspecting;
    await refusedCallers();
    completeReadback();
    expect(await pending).toMatchObject({ outcome: "not_applied", reason: "original_install_unchanged" });
    const writer = gate.beginCodexCliSelectionParentWrite();
    try { expect(writer.entered).toBe(true); } finally { writer.exit(); }
  }
  console.log("admission lifecycle verified");
  }
} finally {
  terminate(); completeReadback(); await pending;
  unavailable = false; installWindow.exit(); retry?.mockRestore(); spawn.mockRestore(); stat.mockRestore();
  if (originalUid) Object.defineProperty(process, "geteuid", originalUid); else Reflect.deleteProperty(process, "geteuid");
  removeTreeWithRetry(root);
}
