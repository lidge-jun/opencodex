import { createCodexCliTestRoot } from "./codex-cli-fixture-root";
// Isolated POSIX contract model over real files; uid/mode and directory fsync
// are injected on Windows. This does not establish native POSIX scheduling.
import { expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createCodexCliUpdateRecovery, codexCliUpdateRecoveryBlocksAdmission,
  finishClosedCodexCliUpdateRecovery } from "../../src/codex/cli-update-recovery";
import { recoverClosedCodexCliUpdateWorker } from "../../src/codex/cli-update-worker-recovery";
import * as gate from "../../src/codex/cli-update-selection-gate";
import { removeTreeWithRetry } from "./remove-tree";

const scenario = process.argv[2]!;
const root = createCodexCliTestRoot("ocx-recovery-publication-");
const canonical = join(root, "home"), alias = join(root, "alias");
fs.mkdirSync(canonical);
fs.symlinkSync(canonical, alias, process.platform === "win32" ? "junction" : "dir");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const geteuid = Object.getOwnPropertyDescriptor(process, "geteuid");
const savedHome = process.env.OPENCODEX_HOME;
const uid = process.geteuid?.() ?? 1234, realStat = fs.lstatSync, realFstat = fs.fstatSync;
let unsafe = false;
const stat = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike) => {
  const value = realStat(path);
  return Object.assign(value, { uid, mode: value.isDirectory()
    ? (unsafe && String(path) === canonical ? 0o40777 : 0o40700) : 0o100600 });
}) as typeof fs.lstatSync);
const fstat = spyOn(fs, "fstatSync").mockImplementation(((fd: number) =>
  Object.assign(realFstat(fd), { uid, mode: 0o100600 })) as typeof fs.fstatSync);
const sync = spyOn(fs, "fsyncSync").mockImplementation(() => {});
Object.defineProperty(process, "platform", { value: "linux", configurable: true });
Object.defineProperty(process, "geteuid", { value: () => uid, configurable: true });
try {
  process.env.OPENCODEX_HOME = canonical;
  const token = randomUUID(), recovery = createCodexCliUpdateRecovery(token, canonical);
  const store = join(canonical, "codex-cli-update-recovery");
  if (scenario.startsWith("close-")) {
    if (scenario === "close-existing") fs.mkdirSync(store);
    const buffer = gate.codexCliUpdateSelectionGate(), fence = gate.createCodexCliUpdateFence();
    const owner = gate.allocateCodexCliUpdateGateOwner(buffer);
    const window = gate.createWorkerCommitWindow({ gate: buffer, fence, owner, recovery });
    expect(window.tryEnter()).toBe(true);
    const realMkdir = fs.mkdirSync;
    let closed = false;
    const mkdir = spyOn(fs, "mkdirSync").mockImplementation(((path: fs.PathLike, options: unknown) => {
      if (String(path) === store && !closed) {
        closed = true;
        recoverClosedCodexCliUpdateWorker(buffer, fence, owner, token, canonical);
      }
      return realMkdir(path, options as never);
    }) as typeof fs.mkdirSync);
    try { expect(window.commit()).toBe(false); } finally { mkdir.mockRestore(); }
    // No child spawn or window.exit(): model loss after the late arm publication.
    expect(Atomics.load(new Int32Array(fence), 0)).toBe(gate.CODEX_CLI_UPDATE_FENCE_CANCELLED);
    expect(Atomics.load(new Int32Array(buffer), 0)).toBe(gate.CODEX_CLI_UPDATE_GATE_FREE);
    expect(codexCliUpdateRecoveryBlocksAdmission(canonical)).toBe(false);
    const writer = gate.beginCodexCliSelectionParentWrite();
    try { expect(writer.entered).toBe(true); } finally { writer.exit(); }
  } else if (scenario === "sync-failure") {
    const callbacks: (() => void)[] = [];
    const interval = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
      callbacks.push(callback); return { unref() {} };
    }) as never);
    const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    const buffer = gate.codexCliUpdateSelectionGate(), fence = gate.createCodexCliUpdateFence();
    const owner = gate.allocateCodexCliUpdateGateOwner(buffer);
    const window = gate.createWorkerCommitWindow({ gate: buffer, fence, owner, recovery });
    expect(window.tryEnter()).toBe(true);
    let unavailable = true;
    const flushedDirectories: number[] = [];
    const homeIdentity = realStat(canonical), storeIdentity = () => realStat(store);
    sync.mockImplementation(fd => {
      const value = realFstat(fd);
      if (!value.isDirectory()) return;
      if (unavailable) throw new Error("fixture_directory_sync_failure");
      flushedDirectories.push(value.ino);
    });
    try {
      recoverClosedCodexCliUpdateWorker(buffer, fence, owner, token, canonical);
      expect(Atomics.load(new Int32Array(buffer), 0)).toBe(owner);
      expect(callbacks).toHaveLength(1);
      unavailable = false; callbacks[0]!();
      expect(flushedDirectories).toContain(homeIdentity.ino);
      expect(flushedDirectories).toContain(storeIdentity().ino);
      expect(Atomics.load(new Int32Array(buffer), 0)).toBe(gate.CODEX_CLI_UPDATE_GATE_FREE);
      expect(codexCliUpdateRecoveryBlocksAdmission(canonical)).toBe(false);
    } finally { interval.mockRestore(); clear.mockRestore(); }
  } else if (scenario === "late-arm") {
    fs.mkdirSync(store);
    finishClosedCodexCliUpdateRecovery(token, canonical);
    recovery.arm();
    expect(fs.existsSync(join(store, token + ".json"))).toBe(false);
    expect(codexCliUpdateRecoveryBlocksAdmission(canonical)).toBe(false);
  } else {
    if (["alias-armed", "alias-terminal", "alias-unsafe", "canonical-armed"].includes(scenario)) recovery.arm();
    if (scenario === "alias-terminal") finishClosedCodexCliUpdateRecovery(token, canonical);
    if (scenario === "alias-unsafe") unsafe = true;
    if (scenario === "linked-store" || scenario === "dangling-store") {
      const target = join(root, "other-store");
      if (scenario === "linked-store") fs.mkdirSync(target);
      fs.symlinkSync(target, store, platform.value === "win32" ? "junction" : "dir");
    }
    if (scenario === "ancestor-alias-absent") fs.mkdirSync(join(canonical, "nested"));
    const config = scenario.startsWith("canonical-") ? canonical
      : scenario === "ancestor-alias-absent" ? join(alias, "nested") : alias;
    process.env.OPENCODEX_HOME = config;
    const blocks = ["alias-armed", "alias-unsafe", "linked-store", "dangling-store", "canonical-armed"].includes(scenario);
    expect(codexCliUpdateRecoveryBlocksAdmission(config)).toBe(blocks);
    const writer = gate.beginCodexCliSelectionParentWrite();
    try { expect(writer.entered).toBe(!blocks); } finally { writer.exit(); }
    if (scenario.endsWith("absent")) expect(fs.existsSync(join(config, "codex-cli-update-recovery"))).toBe(false);
  }
} finally {
  stat.mockRestore(); fstat.mockRestore(); sync.mockRestore();
  Object.defineProperty(process, "platform", platform);
  if (geteuid) Object.defineProperty(process, "geteuid", geteuid); else Reflect.deleteProperty(process, "geteuid");
  if (savedHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = savedHome;
  removeTreeWithRetry(root);
}
