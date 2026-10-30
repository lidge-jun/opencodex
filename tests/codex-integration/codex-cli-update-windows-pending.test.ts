import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ffi from "bun:ffi";
import * as acl from "../../src/lib/windows-secret-acl";
import { hardenSecretDirAsync, hardenSecretPath } from "../../src/lib/windows-secret-acl";
import { withWindowsCliRecoveryStore } from "../../src/codex/cli-update-job-store-windows";
import { codexCliUpdateRecoveryBlocksAdmission } from "../../src/codex/cli-update-recovery";
import { startWindowsCliChild } from "../../src/codex/windows-cli-child";
import * as lifetime from "../../src/codex/windows-cli-recovery";
import { createCodexCliTestRoot } from "../helpers/codex-cli-fixture-root";
import { trustWindowsTempFixtureAncestry } from "../helpers/windows-temp-ancestry";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const native = process.platform === "win32" && process.arch === "x64";
const windows = native ? test : test.skip;
let root: string, home: string, deadPid: number;
const token = "11111111-2222-4333-8444-555555555555";
const other = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const jobName = `Global\\ocx-cli-${token}`;
type RecordBody = { version: number; token: string; parentPid: number; phase: string; pgid: number | null;
  windows: { jobName: string; creationTime: string | null } };
beforeAll(() => {
  if (!native) return;
  // A PID that must stay dead for the whole file. The PID of an exited child is not: hosted Windows
  // reuses PIDs quickly, and a reused parent PID made recovery fence before the publication step
  // these cases inject into (dev batch 40824593871). Windows PIDs are multiples of 4 and are never
  // allocated this high, so the value stays dead while remaining a valid in-range record PID.
  deadPid = 0x7ffffffc;
  expect(() => process.kill(deadPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
});
beforeEach(async () => {
  if (!native) return;
  root = createCodexCliTestRoot("ocx-pending-child-"); home = join(root, "config"); mkdirSync(home);
  await hardenSecretDirAsync(root, { required: true }); trustWindowsTempFixtureAncestry(root);
  await hardenSecretDirAsync(home, { required: true });
});
afterEach(() => { if (native) removeTreeWithRetry(root); });
function records(): { armed: RecordBody; child: RecordBody; proof: RecordBody } {
  // Same wire shape as the interrupted publication: armed JSON, complete child
  // pending, and guardian terminal proof with null pgid/creationTime.
  const armed: RecordBody = { version: 1, token, parentPid: deadPid, phase: "armed", pgid: null,
    windows: { jobName, creationTime: null } };
  return { armed, child: { ...armed, phase: "child", pgid: deadPid,
    windows: { jobName, creationTime: "1" } }, proof: { ...armed, phase: "terminal" } };
}
function seed(armed: RecordBody, child: RecordBody | string, proof?: RecordBody | string) {
  withWindowsCliRecoveryStore(home, true, io => {
    io.write(token + ".json", token + ".pending", JSON.stringify(armed));
    if (proof !== undefined) io.write(token + ".proof", token + ".proof.pending",
      typeof proof === "string" ? proof : JSON.stringify(proof));
  });
  const path = join(home, "codex-cli-update-recovery", token + ".pending");
  writeFileSync(path, typeof child === "string" ? child : JSON.stringify(child), { flag: "wx", mode: 0o600 });
  hardenSecretPath(path, { required: true });
}
function snapshot() {
  return withWindowsCliRecoveryStore(home, false, io => io.names().sort().map(name => [name, io.read(name)]));
}
windows("restart publishes a complete pending child only after terminal native proof", () => {
  const { armed, child, proof } = records(); seed(armed, child, proof);
  const pendingIdentity = statSync(join(home, "codex-cli-update-recovery", token + ".pending")).ino;
  expect(lifetime.windowsCodexCliChildGone(child.pgid!, child.windows.creationTime!, jobName)).toBe(true);
  expect(codexCliUpdateRecoveryBlocksAdmission(home)).toBe(false);
  expect(existsSync(join(home, "codex-cli-update-recovery", token + ".pending"))).toBe(false);
  expect(withWindowsCliRecoveryStore(home, false, io => JSON.parse(io.read(token + ".json")))).toEqual(child);
  expect(statSync(join(home, "codex-cli-update-recovery", token + ".json")).ino).toBe(pendingIdentity);
  expect(codexCliUpdateRecoveryBlocksAdmission(home)).toBe(false);
}, 30000);
const negatives = ["token", "job", "parent", "parent-alive", "armed-child", "armed-identity", "missing-child-pid",
  "missing-child-time", "proof-missing", "proof-malformed", "proof-armed", "proof-token", "proof-job", "proof-parent",
  "proof-pid", "pending-malformed", "pending-armed", "native-unknown", "native-throws", "parent-denied",
  "overflow-child-pid", "overflow-child-time"] as const;
windows.each(negatives)("pending child stays fenced without matching authority: %s", scenario => {
  const { armed, child, proof } = records();
  if (scenario === "token") child.token = other;
  if (scenario === "job") child.windows.jobName = `Global\\ocx-cli-${other}`;
  if (scenario === "parent") child.parentPid += 1;
  if (scenario === "parent-alive") armed.parentPid = child.parentPid = proof.parentPid = process.pid;
  if (scenario === "armed-child") { armed.phase = "child"; armed.pgid = deadPid; armed.windows.creationTime = "1"; }
  if (scenario === "armed-identity") armed.windows.creationTime = "1";
  if (scenario === "missing-child-pid") child.pgid = null;
  if (scenario === "missing-child-time") child.windows.creationTime = null;
  if (scenario === "overflow-child-pid") child.pgid = 0x100000000;
  if (scenario === "overflow-child-time") child.windows.creationTime = "18446744073709551616";
  if (scenario === "proof-armed") proof.phase = "armed";
  if (scenario === "proof-token") proof.token = other;
  if (scenario === "proof-job") proof.windows.jobName = `Global\\ocx-cli-${other}`;
  if (scenario === "proof-parent") proof.parentPid += 1;
  if (scenario === "proof-pid") proof.pgid = deadPid;
  if (scenario === "pending-armed") child.phase = "armed";
  seed(armed, scenario === "pending-malformed" ? "{" : child,
    scenario === "proof-missing" ? undefined : scenario === "proof-malformed" ? "{" : proof);
  const before = snapshot();
  const parentProbe = scenario === "parent-denied" ? spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("denied"), { code: "EPERM" });
  }) : undefined;
  const probe = scenario.startsWith("native-") ? spyOn(lifetime, "windowsCodexCliChildGone") : undefined;
  if (scenario === "native-unknown") probe!.mockReturnValue(false);
  if (scenario === "native-throws") probe!.mockImplementation(() => { throw new Error("query_failed"); });
  try { expect(codexCliUpdateRecoveryBlocksAdmission(home)).toBe(true); expect(snapshot()).toEqual(before); }
  finally { probe?.mockRestore(); parentProbe?.mockRestore(); }
}, 30000);
windows.each(["file-flush", "harden", "rename", "readback", "flush"] as const)("reconciliation publication failure fences: %s", stage => {
  const { armed, child, proof } = records(); seed(armed, child, proof);
  let injected = 0, renamed = false;
  const harden = stage === "harden" ? spyOn(acl, "hardenSecretPath").mockImplementation(() => { injected++; throw new Error("harden_failed"); }) : undefined;
  const realOpen = ffi.dlopen;
  const open = stage !== "harden" ? spyOn(ffi, "dlopen").mockImplementation(((...args: Parameters<typeof ffi.dlopen>) => {
    const lib = realOpen(...args);
    if (args[0] !== "kernel32.dll" || !("SetFileInformationByHandle" in lib.symbols)) return lib;
    const set = lib.symbols.SetFileInformationByHandle!, info = lib.symbols.GetFileInformationByHandleEx!, flush = lib.symbols.FlushFileBuffers!;
    return { ...lib, symbols: { ...lib.symbols,
      SetFileInformationByHandle: (...call: Parameters<typeof set>) => {
        if (call[1] === 3 && stage === "rename") { injected++; return 0; }
        const result = set(...call); if (call[1] === 3 && result) renamed = true; return result;
      },
      GetFileInformationByHandleEx: (...call: Parameters<typeof info>) => {
        if (renamed && stage === "readback") { injected++; return 0; } return info(...call);
      },
      FlushFileBuffers: (...call: Parameters<typeof flush>) => {
        if (stage === "file-flush" || (stage === "flush" && renamed)) { injected++; return 0; } return flush(...call);
      },
    } };
  }) as typeof ffi.dlopen) : undefined;
  try { expect(codexCliUpdateRecoveryBlocksAdmission(home)).toBe(true); expect(injected).toBeGreaterThan(0); }
  finally { harden?.mockRestore(); open?.mockRestore(); }
  // Failure may leave either armed+pending or an already renamed child. Neither
  // path fabricates terminal proof or changes the persisted child identity.
  expect(withWindowsCliRecoveryStore(home, false, io => JSON.parse(io.read(token + ".json"))).phase)
    .toBe(renamed ? "child" : "armed");
  if (!renamed) expect(withWindowsCliRecoveryStore(home, false, io => JSON.parse(io.read(token + ".pending")))).toEqual(child);
}, 30000);
windows.each(["child-alive", "job-active"] as const)("fresh native evidence fences %s despite terminal receipt", async scenario => {
  const { armed, child, proof } = records();
  const live = startWindowsCliChild({ executable: process.execPath,
    args: ["-e", "while (!require('fs').existsSync('release')) await Bun.sleep(10)"], cwd: home,
    env: { SystemRoot: process.env.SystemRoot, TEMP: home, TMP: home }, policy: "installer", recoveryJobName: jobName });
  try {
    expect(live.setupFailure).toBeNull(); expect(live.pid).toBeGreaterThan(0);
    if (scenario === "child-alive") {
      // An absent Job alone cannot clear the still-live exact primary lifetime.
      armed.windows.jobName = child.windows.jobName = proof.windows.jobName = `Global\\ocx-cli-${other}`;
      child.pgid = live.pid; child.windows.creationTime = live.creationTime;
    }
    // job-active keeps the dead primary identity but uses the live Job.
    seed(armed, child, proof); const before = snapshot();
    expect(codexCliUpdateRecoveryBlocksAdmission(home)).toBe(true); expect(snapshot()).toEqual(before);
  } finally {
    writeFileSync(join(home, "release"), "release");
    expect((await live.wait()).terminal).toBe(true);
  }
  expect(codexCliUpdateRecoveryBlocksAdmission(home)).toBe(false);
}, 30000);
