import { dlopen, ptr } from "bun:ffi";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { WindowsCliChild } from "../../src/codex/windows-cli-child";

export interface WindowsRecoveryProcessIdentity { pid: number; creationTime: string }
export interface WindowsRecoveryFixtureIdentity extends WindowsRecoveryProcessIdentity {
  guardian: WindowsRecoveryProcessIdentity;
}

/** Capture the guardian's original lifetime before the fixture owner exits. */
export function windowsRecoveryFixtureIdentity(child: WindowsCliChild): WindowsRecoveryFixtureIdentity {
  const lib = dlopen("kernel32.dll", { GetProcessId: { args: ["u64"], returns: "u32" } });
  try {
    const created = Buffer.alloc(8), exited = Buffer.alloc(8), kernel = Buffer.alloc(8), user = Buffer.alloc(8);
    const pid = lib.symbols.GetProcessId(child.recoveryGuardian);
    if (!pid || !child.native.k.GetProcessTimes(child.recoveryGuardian, ptr(created), ptr(exited), ptr(kernel), ptr(user))) {
      throw new Error("fixture_guardian_identity_unknown");
    }
    return { pid: child.pid!, creationTime: child.creationTime!, guardian: { pid, creationTime: created.readBigUInt64LE().toString() } };
  } finally { lib.close(); }
}

function nativeState(identity: WindowsRecoveryFixtureIdentity, jobName: string) {
  const lib = dlopen("kernel32.dll", {
    OpenJobObjectW: { args: ["u32", "i32", "ptr"], returns: "u64" },
    QueryInformationJobObject: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
    GetProcessTimes: { args: ["u64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
    GetExitCodeProcess: { args: ["u64", "ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });
  const k = lib.symbols;
  let job = 0n, guardian = 0n;
  try {
    job = k.OpenJobObjectW(4, 0, ptr(Buffer.from(jobName + "\0", "utf16le")));
    const jobError = job ? 0 : k.GetLastError(), accounting = Buffer.alloc(48);
    const queried = !!job && !!k.QueryInformationJobObject(job, 1, ptr(accounting), 48, null);
    const jobState = queried ? { state: "observed", activeProcesses: accounting.readUInt32LE(40) }
      : { state: !job && jobError === 2 ? "absent" : "unknown", error: job ? k.GetLastError() : jobError };
    guardian = k.OpenProcess(0x101000, 0, identity.guardian.pid);
    if (!guardian) return { job: jobState, guardian: { state: k.GetLastError() === 87 ? "absent" : "unknown" } };
    const created = Buffer.alloc(8), exited = Buffer.alloc(8), kernel = Buffer.alloc(8), user = Buffer.alloc(8);
    if (!k.GetProcessTimes(guardian, ptr(created), ptr(exited), ptr(kernel), ptr(user))) {
      return { job: jobState, guardian: { state: "unknown" } };
    }
    if (created.readBigUInt64LE().toString() !== identity.guardian.creationTime) {
      return { job: jobState, guardian: { state: "reused" } };
    }
    const wait = k.WaitForSingleObject(guardian, 0), code = Buffer.alloc(4);
    if (wait === 0 && k.GetExitCodeProcess(guardian, ptr(code))) {
      return { job: jobState, guardian: { state: "exited", exitCode: code.readUInt32LE() } };
    }
    return { job: jobState, guardian: { state: wait === 258 ? "running" : "unknown" } };
  } finally {
    if (guardian) k.CloseHandle(guardian);
    if (job) k.CloseHandle(job);
    lib.close();
  }
}

/** Diagnostics only: admission still comes from the real selection gate. */
export function observeWindowsRecoveryFixture(root: string) {
  try {
    const identity = JSON.parse(readFileSync(join(root, "identity.json"), "utf8")) as WindowsRecoveryFixtureIdentity;
    const store = join(root, "config", "codex-cli-update-recovery");
    const records = readdirSync(store).filter(name => name.endsWith(".json"));
    if (records.length !== 1) throw new Error("fixture_recovery_record_count=" + records.length);
    const record = JSON.parse(readFileSync(join(store, records[0]!), "utf8"));
    const state = nativeState(identity, record.windows.jobName);
    let receipt: unknown;
    try { receipt = JSON.parse(readFileSync(join(store, record.token + ".proof"), "utf8")); }
    catch (error) { receipt = { error: String(error) }; }
    return { ...state, record, receipt };
  } catch (error) { return { error: String(error) }; }
}

export type WindowsRecoveryProbe = {
  entered: boolean;
  // False only after the owner exits without reaching the native-start marker.
  guardianStarted?: boolean;
  recovery: ReturnType<typeof observeWindowsRecoveryFixture>;
};
