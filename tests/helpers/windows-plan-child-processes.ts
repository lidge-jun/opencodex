import { dlopen, ptr } from "bun:ffi";

// This preload runs in the dedicated fixture child before it can start any
// subprocess. The job handle is non-inheritable and intentionally remains open
// until process exit: if Bun terminates this child, Windows also terminates its
// job descendants. Failure to establish containment refuses the fixture.
const kernel = dlopen("kernel32.dll", {
  CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
  SetInformationJobObject: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
  AssignProcessToJobObject: { args: ["u64", "u64"], returns: "i32" },
  GetCurrentProcess: { args: [], returns: "u64" },
  CloseHandle: { args: ["u64"], returns: "i32" },
});
const job = kernel.symbols.CreateJobObjectW(null, null);
if (!job) throw new Error("Windows plan fixture job creation failed");
const limits = Buffer.alloc(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, Windows x64.
limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
if (!kernel.symbols.SetInformationJobObject(job, 9, ptr(limits), limits.length)
  || !kernel.symbols.AssignProcessToJobObject(job, kernel.symbols.GetCurrentProcess())) {
  kernel.symbols.CloseHandle(job);
  throw new Error("Windows plan fixture job containment failed");
}

// Loaded before the fixture's imports. A successful receipt requires proof that
// every Bun child started in this process has actually exited; timeout is not exit.
const originalSpawn = Bun.spawn;
const originalSpawnSync = Bun.spawnSync;
const live = new Set<Promise<number>>();
let unconfirmed = false;
let terminationRequested = false;

Bun.spawn = ((...args: unknown[]) => {
  try {
    const child = Reflect.apply(originalSpawn, Bun, args) as { exited: Promise<number>; kill: (...args: unknown[]) => unknown };
    const kill = child.kill;
    Object.defineProperty(child, "kill", { configurable: true, value: (...killArgs: unknown[]) => {
      terminationRequested = true;
      return Reflect.apply(kill, child, killArgs);
    } });
    const exited = child.exited;
    live.add(exited);
    void exited.then(() => { live.delete(exited); }, () => { unconfirmed = true; live.delete(exited); });
    return child;
  } catch (error) {
    unconfirmed = true;
    throw error;
  }
}) as typeof Bun.spawn;

Bun.spawnSync = ((...args: unknown[]) => {
  try {
    const result = Reflect.apply(originalSpawnSync, Bun, args) as { exitCode: number | null; exitedDueToTimeout?: boolean };
    if (result.exitedDueToTimeout || typeof result.exitCode !== "number") unconfirmed = true;
    return result;
  } catch (error) {
    unconfirmed = true;
    throw error;
  }
}) as typeof Bun.spawnSync;

export function assertWindowsPlanChildrenExited(): void {
  if (unconfirmed || terminationRequested || live.size !== 0) throw new Error("Windows plan fixture subprocess exit unconfirmed");
}
