// Child for tests/ci-workflows/test-runner-spawnsync-finalizer.test.ts (#4956).
//
// Bun 1.4.0 points the VM at Bun.spawnSync's private event loop for the length of the call, so a
// FilePoll that a garbage collection finalizes during the call is released against that loop
// instead of the thread's. The private loop is cached for the life of the process, so its poll
// count drifts down; once the drift cancels a later call's polls, that call never polls for its
// child again and spins, past its own timeout (oven-sh/bun#34069, fixed by oven-sh/bun#44581 in
// Bun 1.4.3). In a multi-file `bun test --isolate` process the finalized objects are earlier files'
// stdout/stderr sinks and stream readers, which is how a 15-second spawnSync bound in
// release-version-sources.test.ts stalled shard 1/4 batch 5 until the 120-second batch deadline.
//
// This reproduces it deterministically, after upstream's own regression case: stderr is a pipe, so
// each Bun.stderr writer registers a poll; the first spawnSync collects them while it waits; the
// second has to poll for a grandchild that outlives the registration of its polls.

const state = globalThis as typeof globalThis & { driftWriters?: unknown[] | null };
const count = Number(process.env.OCX_DRIFT_WRITERS ?? "1");
const refs: WeakRef<object>[] = [];
state.driftWriters = [];
for (let i = 0; i < count; i++) {
  const writer = Bun.stderr.writer();
  writer.write("");
  writer.flush();
  state.driftWriters.push(writer);
  refs.push(new WeakRef(writer));
}
// A WeakRef keeps its target alive until the job that created it ends.
await Bun.sleep(0);
Bun.spawnSync({
  cmd: ["true"],
  stdout: "pipe",
  stderr: "ignore",
  // maxBuffer is the last option spawnSync reads; collecting here lands the finalizers inside the call.
  get maxBuffer() {
    Bun.gc(true);
    state.driftWriters = null;
    return undefined;
  },
});
const collectedDuringCall = refs.filter(ref => ref.deref() === undefined).length;
const started = performance.now();
const second = Bun.spawnSync({
  cmd: ["sh", "-c", "sleep 0.1; echo polled"],
  stdout: "pipe",
  stderr: "pipe",
  timeout: 2_000,
});
console.log(JSON.stringify({
  runtime: Bun.version,
  collectedDuringCall,
  stdout: second.stdout.toString(),
  exitedDueToTimeout: second.exitedDueToTimeout ?? false,
  elapsedMs: Math.round(performance.now() - started),
}));
