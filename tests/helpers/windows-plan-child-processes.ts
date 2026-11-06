import { createWindowsPlanFixtureJob } from "./windows-plan-fixture-job";

// This preload runs in the dedicated fixture child before it can start any
// subprocess. The job handle is non-inheritable and intentionally remains open
// until process exit: if Bun terminates this child, Windows also terminates its
// job descendants. Failure to establish containment refuses the fixture.
const job = createWindowsPlanFixtureJob();
try { job.assign(job.currentProcess()); }
catch (error) {
  try { job.close(); }
  catch (cleanupError) { throw new AggregateError([error, cleanupError], "Windows plan job assignment and cleanup failed"); }
  throw error;
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
