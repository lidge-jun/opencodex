import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { dlopen, ptr } from "bun:ffi";
import { quoteWindowsChildArg } from "../../src/codex/windows-cli-child";
import { INTERNAL_DEADLINE_MS } from "./test-budget";
import { createWindowsPlanFixtureJob, createWindowsPlanJobWithoutKillForTests } from "./windows-plan-fixture-job";
import { repoRoot } from "./repo-root";

// Keep handles and native dispatch reachable if the OS never confirms release.
const retainedProofs: unknown[] = [];

/** Uses only handles returned by CreateProcessW; no PID is read or reopened. */
export function proveWindowsPlanJobExit(killOnClose: boolean): void {
  const kernel = dlopen("kernel32.dll", {
    CreateEventW: { args: ["ptr", "i32", "i32", "ptr"], returns: "u64" },
    SetEvent: { args: ["u64"], returns: "i32" },
    SetLastError: { args: ["u32"], returns: "void" },
    GetLastError: { args: [], returns: "u32" },
    CreateProcessW: { args: ["ptr", "ptr", "ptr", "ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    ResumeThread: { args: ["u64"], returns: "u32" },
    WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
    TerminateProcess: { args: ["u64", "u32"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });
  const k = kernel.symbols;
  const wide = (value: string) => Buffer.from(value + "\0", "utf16le");
  const token = randomUUID(), readyName = `Local\\ocx-plan-ready-${token}`, releaseName = `Local\\ocx-plan-release-${token}`;
  let ready = 0n, release = 0n, process = 0n, thread = 0n;
  let releaseOwned = false, job: ReturnType<typeof createWindowsPlanFixtureJob> | undefined, jobCloseAttempted = false;
  let bodyFailed = false, bodyError: unknown;
  const closeJob = () => { if (job && !jobCloseAttempted) { jobCloseAttempted = true; job.close(); } };
  try {
    const readyBytes = wide(readyName), releaseBytes = wide(releaseName);
    k.SetLastError(0); ready = k.CreateEventW(null, 1, 0, ptr(readyBytes));
    if (!ready || k.GetLastError() === 183) throw new Error("fixture ready event unavailable");
    k.SetLastError(0); release = k.CreateEventW(null, 1, 0, ptr(releaseBytes));
    if (!release || k.GetLastError() === 183) throw new Error("fixture release event unavailable");
    releaseOwned = true;
    const script = `const {dlopen,ptr}=require('bun:ffi'); const k=dlopen('kernel32.dll',{
      OpenEventW:{args:['u32','i32','ptr'],returns:'u64'},SetEvent:{args:['u64'],returns:'i32'},
      WaitForSingleObject:{args:['u64','u32'],returns:'u32'}}).symbols;
      const w=s=>Buffer.from(s+'\\0','utf16le'); const r=w(${JSON.stringify(readyName)}), q=w(${JSON.stringify(releaseName)});
      const a=k.OpenEventW(2,0,ptr(r)), b=k.OpenEventW(0x100000,0,ptr(q));
      if(!a||!b||!k.SetEvent(a)||k.WaitForSingleObject(b,0xffffffff)!==0) throw Error('fixture event failure');`;
    const executable = wide(processExecPath()), command = wide([processExecPath(), "--no-env-file", "-e", script].map(quoteWindowsChildArg).join(" "));
    const cwd = wide(repoRoot()), startup = Buffer.alloc(104), info = Buffer.alloc(24);
    startup.writeUInt32LE(startup.length, 0);
    job = killOnClose ? createWindowsPlanFixtureJob() : createWindowsPlanJobWithoutKillForTests();
    if (!k.CreateProcessW(ptr(executable), ptr(command), null, null, 0, 0x08000004, null, ptr(cwd), ptr(startup), ptr(info))) {
      throw new Error("fixture process creation failed");
    }
    process = info.readBigUInt64LE(0); thread = info.readBigUInt64LE(8);
    if (!process || !thread) throw new Error("fixture process handles missing");
    expect(k.WaitForSingleObject(process, 0)).toBe(258); // Suspended child is alive.
    job.assign(process); // Original CreateProcessW handle, before user code runs.
    expect(k.ResumeThread(thread)).not.toBe(0xffffffff);
    expect(k.WaitForSingleObject(ready, INTERNAL_DEADLINE_MS)).toBe(0);
    expect(k.WaitForSingleObject(process, 0)).toBe(258); // Handshake from live child.
    closeJob();
    if (killOnClose) {
      expect(k.WaitForSingleObject(process, INTERNAL_DEADLINE_MS)).toBe(0);
    } else {
      expect(k.WaitForSingleObject(process, 0)).toBe(258);
      expect(k.SetEvent(release)).not.toBe(0);
      expect(k.WaitForSingleObject(process, INTERNAL_DEADLINE_MS)).toBe(0);
    }
  } catch (error) {
    bodyFailed = true; bodyError = error;
  } finally {
    const cleanupErrors: Error[] = [];
    let exitUnconfirmed = false;
    try { closeJob(); } catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
    if (process) {
      let state = k.WaitForSingleObject(process, 0);
      if (state === 258 && releaseOwned) {
        if (!k.SetEvent(release)) cleanupErrors.push(new Error("fixture release signal failed"));
        state = k.WaitForSingleObject(process, INTERNAL_DEADLINE_MS);
      }
      if (state !== 0) {
        // This is the original CreateProcessW handle, never a PID-derived handle.
        if (!k.TerminateProcess(process, 1)) cleanupErrors.push(new Error("fixture process termination failed"));
        if (k.WaitForSingleObject(process, INTERNAL_DEADLINE_MS) !== 0) {
          exitUnconfirmed = true;
          cleanupErrors.push(new Error("fixture process exit unconfirmed"));
        }
      }
    }
    if (exitUnconfirmed || cleanupErrors.length) {
      retainedProofs.push({ kernel, process, thread, ready, release, job });
    } else {
      for (const handle of [thread, process, release, ready]) {
        if (handle && !k.CloseHandle(handle)) cleanupErrors.push(new Error("fixture handle close failed"));
      }
      if (cleanupErrors.length) retainedProofs.push({ kernel, process, thread, ready, release, job });
      else kernel.close();
    }
    if (cleanupErrors.length) throw new AggregateError(bodyFailed ? [bodyError, ...cleanupErrors] : cleanupErrors, "Windows plan job proof cleanup failed");
  }
  if (bodyFailed) throw bodyError;
}

// Keep the local process handle name distinct from the global process object.
function processExecPath(): string { return globalThis.process.execPath; }
