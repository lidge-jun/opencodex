import { dlopen, ptr } from "bun:ffi";

/** Fixture-only Windows job. Its non-inheritable handle stays owned by the creator. */
function createWindowsPlanJob(killOnClose: boolean) {
  const kernel = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
    SetInformationJobObject: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
    AssignProcessToJobObject: { args: ["u64", "u64"], returns: "i32" },
    GetCurrentProcess: { args: [], returns: "u64" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });
  const job = kernel.symbols.CreateJobObjectW(null, null);
  if (!job) { kernel.close(); throw new Error("Windows plan fixture job creation failed"); }
  const limits = Buffer.alloc(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, Windows x64.
  limits.writeUInt32LE(killOnClose ? 0x2000 : 0, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
  if (!kernel.symbols.SetInformationJobObject(job, 9, ptr(limits), limits.length)) {
    const error = new Error("Windows plan fixture job setup failed");
    if (!kernel.symbols.CloseHandle(job)) throw new AggregateError([error, new Error("Windows plan fixture job close failed")], "Windows plan fixture job setup and close failed");
    kernel.close();
    throw error;
  }
  let closed = false;
  return {
    assign(process: bigint) {
      if (closed || !kernel.symbols.AssignProcessToJobObject(job, process)) throw new Error("Windows plan fixture job containment failed");
    },
    currentProcess() { return kernel.symbols.GetCurrentProcess(); },
    close() {
      if (closed) return;
      if (!kernel.symbols.CloseHandle(job)) throw new Error("Windows plan fixture job close failed");
      closed = true;
      kernel.close();
    },
  };
}

/** The production fixture and its positive proof use the same fixed policy. */
export function createWindowsPlanFixtureJob() { return createWindowsPlanJob(true); }
/** Negative control only; the fixture preload must never call this. */
export function createWindowsPlanJobWithoutKillForTests() { return createWindowsPlanJob(false); }
