/** Process ownership for the completed-drain fixture, independent of its diagnostic PID journal. */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

async function kernel32() {
  const { dlopen } = await import("bun:ffi");
  const { resolveTrustedWindowsSystemDirectory } = await import("../../src/lib/windows-elevation");
  return dlopen(join(resolveTrustedWindowsSystemDirectory(), "kernel32.dll"), {
    GetLastError: { args: [], returns: "u32" },
    SetLastError: { args: ["u32"], returns: "void" },
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
    OpenJobObjectW: { args: ["u32", "i32", "ptr"], returns: "u64" },
    SetInformationJobObject: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
    QueryInformationJobObject: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    AssignProcessToJobObject: { args: ["u64", "u64"], returns: "i32" },
    IsProcessInJob: { args: ["u64", "u64", "ptr"], returns: "i32" },
    TerminateJobObject: { args: ["u64", "u32"], returns: "i32" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });
}

const wide = (value: string) => Buffer.from(value + "\0", "utf16le");
function requireNative(ok: number | bigint, operation: string): void {
  if (!ok) throw new Error(`restart fixture: ${operation} failed`);
}

/** Each entry joins before any product code can spawn a descendant. No PID lookup admits members. */
export async function enterRestartFixture(pidsPath: string, stopPath: string): Promise<void> {
  if (existsSync(stopPath)) process.exit(98);
  if (process.platform === "win32") {
    const native = await kernel32(), k = native.symbols;
    const name = process.env.OCX_RESTART_FIXTURE_JOB;
    if (!name) throw new Error("restart fixture Job required");
    const job = BigInt(k.OpenJobObjectW(5, 0, wide(name))); // JOB_OBJECT_ASSIGN_PROCESS | QUERY
    requireNative(job, "OpenJobObjectW");
    let self = 0n;
    try {
      self = BigInt(k.OpenProcess(0x1101, 0, process.pid)); // QUERY_LIMITED_INFORMATION | SET_QUOTA | TERMINATE, always self
      requireNative(self, "OpenProcess(self)");
      const member = new Uint32Array(1);
      requireNative(k.IsProcessInJob(self, job, member), "IsProcessInJob");
      if (!member[0]) requireNative(k.AssignProcessToJobObject(job, self), "AssignProcessToJobObject");
    } finally {
      if (self) k.CloseHandle(self);
      k.CloseHandle(job);
      native.close();
    }
    appendFileSync(pidsPath, process.pid + "\n"); // Diagnostics only, never termination authority.
  } else {
    const { readTestRunProcessStartBatch } = await import("../../scripts/test-run-lock");
    const start = readTestRunProcessStartBatch([process.pid]).get(process.pid);
    if (!start) throw new Error("restart fixture process start identity unavailable");
    appendFileSync(pidsPath, JSON.stringify({ pid: process.pid, start }) + "\n");
    // POSIX roles terminate themselves; journal identities are used only to observe exit.
    setInterval(() => { if (existsSync(stopPath)) process.exit(98); }, 25).unref();
  }
  if (existsSync(stopPath)) process.exit(98);
}

export async function ownRestartFixture(pidsPath: string, stopPath: string) {
  if (process.platform !== "win32") return {
    env: {},
    async stop() {
      writeFileSync(stopPath, "stop");
      const { readTestRunProcessStartBatch } = await import("../../scripts/test-run-lock");
      const { isProcessAlive } = await import("../../src/lib/process-control");
      const deadline = Date.now() + 5_000;
      for (;;) {
        const records = (existsSync(pidsPath) ? readFileSync(pidsPath, "utf8") : "")
          .trim().split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as { pid: number; start: string });
        const current = readTestRunProcessStartBatch(records.map(record => record.pid));
        if (records.every(record => !isProcessAlive(record.pid)
          || (current.get(record.pid) != null && current.get(record.pid) !== record.start))) return;
        if (Date.now() >= deadline) throw new Error("restart fixture roles did not exit");
        await Bun.sleep(25);
      }
    },
  };
  const native = await kernel32(), k = native.symbols;
  const name = `Local\\ocx-restart-fixture-${randomUUID()}`;
  k.SetLastError(0);
  const job = BigInt(k.CreateJobObjectW(null, wide(name)));
  const existing = k.GetLastError() === 183;
  try {
    requireNative(job, "CreateJobObjectW");
    if (existing) throw new Error("restart fixture refuses a pre-existing Job");
    const limits = Buffer.alloc(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, Windows 64-bit
    limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    requireNative(k.SetInformationJobObject(job, 9, limits, limits.length), "SetInformationJobObject");
  } catch (error) {
    if (job) k.CloseHandle(job);
    native.close(); throw error;
  }
  return {
    env: { OCX_RESTART_FIXTURE_JOB: name },
    async stop() {
      writeFileSync(stopPath, "stop");
      try {
        requireNative(k.TerminateJobObject(job, 98), "TerminateJobObject");
        const accounting = Buffer.alloc(48); // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
        const deadline = Date.now() + 5_000;
        for (;;) {
          requireNative(k.QueryInformationJobObject(job, 1, accounting, accounting.length, null), "QueryInformationJobObject");
          if (accounting.readUInt32LE(40) === 0) return;
          if (Date.now() >= deadline) throw new Error("restart fixture Job did not empty");
          await Bun.sleep(25);
        }
      } finally {
        k.CloseHandle(job);
        native.close();
      }
    },
  };
}
