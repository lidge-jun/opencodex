// Isolated POSIX contract model: real bytes/identity, injected uid/mode,
// liveness and directory fsync. This is not native POSIX execution evidence.
import { expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { removeTreeWithRetry } from "./remove-tree";
import { createCodexCliUpdateRecovery, codexCliUpdateRecoveryBlocksAdmission } from "../../src/codex/cli-update-recovery";
import { recoverClosedCodexCliUpdateWorker } from "../../src/codex/cli-update-worker-recovery";
import * as gate from "../../src/codex/cli-update-selection-gate";

const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "ocx-recovery-store-")));
const uid = process.geteuid?.() ?? 1234, realStat = fs.lstatSync;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const geteuid = Object.getOwnPropertyDescriptor(process, "geteuid");
const stat = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike) => {
  const value = realStat(path); return Object.assign(value, { uid, mode: value.isDirectory() ? 0o40700 : 0o100600 });
}) as typeof fs.lstatSync);
const realFstat = fs.fstatSync;
const fstat = spyOn(fs, "fstatSync").mockImplementation(((fd: number) =>
  Object.assign(realFstat(fd), { uid, mode: 0o100600 })) as typeof fs.fstatSync);
const sync = spyOn(fs, "fsyncSync").mockImplementation(() => {});
Object.defineProperty(process, "platform", { value: "linux", configurable: true });
Object.defineProperty(process, "geteuid", { value: () => uid, configurable: true });
let parentGone = false, groupGone = false, denied = false;
const kill = spyOn(process, "kill").mockImplementation(((pid: number) => {
  if (denied || (pid < 0 ? groupGone : parentGone)) throw Object.assign(new Error("fixture_probe"), { code: denied ? "EPERM" : "ESRCH" });
  return true;
}) as typeof process.kill);
try {
  const token = randomUUID(), owner = createCodexCliUpdateRecovery(token, root);
  expect(codexCliUpdateRecoveryBlocksAdmission(root)).toBe(false);
  owner.arm();
  expect(codexCliUpdateRecoveryBlocksAdmission(root)).toBe(true);
  owner.child(424242);
  expect(codexCliUpdateRecoveryBlocksAdmission(root)).toBe(true);
  parentGone = true;
  expect(codexCliUpdateRecoveryBlocksAdmission(root)).toBe(true);
  groupGone = true; denied = true;
  expect(codexCliUpdateRecoveryBlocksAdmission(root)).toBe(true);
  denied = false;
  expect(codexCliUpdateRecoveryBlocksAdmission(root)).toBe(false);
  owner.arm();
  expect(codexCliUpdateRecoveryBlocksAdmission(root)).toBe(true);
  owner.terminal();
  expect(codexCliUpdateRecoveryBlocksAdmission(root)).toBe(false);
  const newer = createCodexCliUpdateRecovery(randomUUID(), root); newer.arm();
  owner.terminal();
  expect(codexCliUpdateRecoveryBlocksAdmission(root)).toBe(true);
  newer.terminal();
  const interrupted = join(root, "precommit"); fs.mkdirSync(interrupted);
  const interruptedToken = randomUUID(), interruptedOwner = createCodexCliUpdateRecovery(interruptedToken, interrupted);
  const rename = spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("fixture_worker_lost_during_publication"); });
  try { expect(() => interruptedOwner.arm()).toThrow("fixture_worker_lost_during_publication"); }
  finally { rename.mockRestore(); }
  expect(codexCliUpdateRecoveryBlocksAdmission(interrupted)).toBe(true);
  const buffer = gate.codexCliUpdateSelectionGate(), fence = gate.createCodexCliUpdateFence();
  const ownerId = gate.allocateCodexCliUpdateGateOwner(buffer);
  const window = gate.createWorkerCommitWindow({ gate: buffer, fence, owner: ownerId });
  expect(window.tryEnter()).toBe(true);
  recoverClosedCodexCliUpdateWorker(buffer, fence, ownerId, interruptedToken, interrupted);
  expect(codexCliUpdateRecoveryBlocksAdmission(interrupted)).toBe(false);
  interruptedOwner.arm(); // late publication cannot overwrite terminal recovery
  expect(codexCliUpdateRecoveryBlocksAdmission(interrupted)).toBe(false);
  const { finishClosedCodexCliUpdateRecovery } = await import("../../src/codex/cli-update-recovery");
  const retryRoot = join(root, "retries"); fs.mkdirSync(retryRoot);
  const retryToken = randomUUID(); createCodexCliUpdateRecovery(retryToken, retryRoot).arm();
  const retryRename = spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("fixture_disk_failure"); });
  try {
    for (let attempt = 0; attempt < 270; attempt++) {
      expect(() => finishClosedCodexCliUpdateRecovery(retryToken, retryRoot)).toThrow("fixture_disk_failure");
    }
  } finally { retryRename.mockRestore(); }
  finishClosedCodexCliUpdateRecovery(retryToken, retryRoot);
  expect(codexCliUpdateRecoveryBlocksAdmission(retryRoot)).toBe(false);
  fs.writeFileSync(join(root, "codex-cli-update-recovery", "partial.pending"), "");
  expect(codexCliUpdateRecoveryBlocksAdmission(root)).toBe(true);
  console.log("durable recovery verified");
} finally {
  kill.mockRestore(); sync.mockRestore(); stat.mockRestore(); fstat.mockRestore();
  Object.defineProperty(process, "platform", platform);
  if (geteuid) Object.defineProperty(process, "geteuid", geteuid); else Reflect.deleteProperty(process, "geteuid");
  removeTreeWithRetry(root);
}
