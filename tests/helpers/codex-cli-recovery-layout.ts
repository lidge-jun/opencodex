import { createCodexCliTestRoot } from "./codex-cli-fixture-root";
// Real files and aliases under OS temp; injected POSIX ownership/modes and fsync.
// This models path policy, not native macOS scheduling or crash durability.
import { expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createCodexCliUpdateRecovery, codexCliUpdateRecoveryBlocksAdmission } from "../../src/codex/cli-update-recovery";
import { recoverClosedCodexCliUpdateWorker } from "../../src/codex/cli-update-worker-recovery";
import * as gate from "../../src/codex/cli-update-selection-gate";
import { createCodexCliRecoveryTestHome } from "./codex-cli-recovery-home";
import { removeTreeWithRetry } from "./remove-tree";

const scenario = process.argv[2]!;
const macos = scenario.startsWith("macos");
const root = createCodexCliTestRoot("ocx-recovery-layout-");
const canonicalTemp = macos ? join(root, "private/var/folders/zz/user/T")
  : scenario.startsWith("linux-home") ? join(root, "home/user") : join(root, "tmp");
fs.mkdirSync(canonicalTemp, { recursive: true });
const alias = join(root, "var");
if (macos) fs.symlinkSync(join(root, "private/var"), alias, process.platform === "win32" ? "junction" : "dir");
const lexicalTemp = macos ? join(alias, "folders/zz/user/T") : canonicalTemp;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const geteuid = Object.getOwnPropertyDescriptor(process, "geteuid");
const savedHome = process.env.OPENCODEX_HOME;
const lstat = fs.lstatSync, fstat = fs.fstatSync;
const userRoot = macos ? join(root, "private/var/folders/zz/user") : canonicalTemp;
let unsafe = false;
const stat = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike) => {
  const value = lstat(path), name = String(path);
  const userOwned = name === userRoot || name.startsWith(userRoot + "/") || name.startsWith(userRoot + "\\");
  const sharedTemp = name === join(root, "tmp");
  const mode = sharedTemp ? 0o41777 : userOwned
    ? (name === userRoot && scenario === "linux-home-755" ? 0o40755 : 0o40700) : 0o40755;
  return Object.assign(value, { uid: sharedTemp || !userOwned ? 0 : 1234,
    mode: value.isDirectory() ? (unsafe && name === userRoot ? 0o40777 : mode) : 0o100600 });
}) as typeof fs.lstatSync);
const fileStat = spyOn(fs, "fstatSync").mockImplementation(((fd: number) =>
  Object.assign(fstat(fd), { uid: 1234, mode: 0o100600 })) as typeof fs.fstatSync);
const sync = spyOn(fs, "fsyncSync").mockImplementation(() => {});
const temp = spyOn(os, "tmpdir").mockReturnValue(lexicalTemp);
const kill = spyOn(process, "kill").mockReturnValue(true);
Object.defineProperty(process, "platform", { configurable: true, value: macos ? "darwin" : "linux" });
Object.defineProperty(process, "geteuid", { configurable: true, value: () => 1234 });
let home: string | undefined;
try {
  home = createCodexCliRecoveryTestHome();
  process.env.OPENCODEX_HOME = home;
  const token = randomUUID(), buffer = gate.codexCliUpdateSelectionGate(), fence = gate.createCodexCliUpdateFence();
  const owner = gate.allocateCodexCliUpdateGateOwner(buffer);
  const recovery = createCodexCliUpdateRecovery(token, home);
  const window = gate.createWorkerCommitWindow({ gate: buffer, fence, owner, recovery: {
    arm() { recoverClosedCodexCliUpdateWorker(buffer, fence, owner, token, home); },
    child: recovery.child, terminal: recovery.terminal,
  } });
  expect(window.tryEnter()).toBe(true);
  expect(window.commit()).toBe(false);
  const writer = gate.beginCodexCliSelectionParentWrite();
  try { expect(writer.entered).toBe(true); } finally { writer.exit(); }
  recovery.arm(); // Late publication cannot replace the parent's terminal marker.
  expect(home).toBe(fs.realpathSync.native(home));
  expect(codexCliUpdateRecoveryBlocksAdmission(home)).toBe(false);
  // Neither an armed record nor a possibly live installer may be cleared by
  // canonicalizing its home, including admission through the macOS alias.
  const live = createCodexCliUpdateRecovery(randomUUID(), home);
  live.arm();
  expect(codexCliUpdateRecoveryBlocksAdmission(home)).toBe(true);
  live.child(424242);
  expect(codexCliUpdateRecoveryBlocksAdmission(home)).toBe(true);
  if (macos) expect(codexCliUpdateRecoveryBlocksAdmission(join(lexicalTemp, home.slice(canonicalTemp.length + 1)))).toBe(true);
  live.terminal();
  expect(codexCliUpdateRecoveryBlocksAdmission(home)).toBe(false);
  if (macos) {
    const aliasedHome = join(lexicalTemp, home.slice(canonicalTemp.length + 1));
    expect(codexCliUpdateRecoveryBlocksAdmission(aliasedHome)).toBe(false);
  }
  if (scenario.endsWith("unsafe")) {
    unsafe = true;
    expect(codexCliUpdateRecoveryBlocksAdmission(home)).toBe(true);
  }
} finally {
  stat.mockRestore(); fileStat.mockRestore(); sync.mockRestore(); temp.mockRestore(); kill.mockRestore();
  Object.defineProperty(process, "platform", platform);
  if (geteuid) Object.defineProperty(process, "geteuid", geteuid); else Reflect.deleteProperty(process, "geteuid");
  if (savedHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = savedHome;
  gate.resetCodexCliSelectionGatesForTests();
  removeTreeWithRetry(root);
}
