/**
 * Darwin eager-relay abort-stress probe — PARENT (watchdog) process.
 *
 * Gate for devlog/_fin/260731_macos_rss_retention/100_darwin_eager_optin.md:
 * spawns the child server (scripts/darwin-eager-abort-stress-child.ts), then
 * issues real network fetches with socket aborts in three classes:
 *   before-first-byte | mid-frame | during-backpressure
 * ≥50 per class and ≥200 total, scheduled by a deterministic mulberry32
 * PRNG whose seed is recorded in the output. Child phase markers prove each
 * class was reached before its client abort. Outcomes distinguish clean
 * workload completion, expected teardown, signal/exit crashes, and timeout.
 *
 * Usage: bun scripts/darwin-eager-abort-stress.ts [--seed N] [--per-class N]
 * This is an offline probe, never a test or CI job. Run on darwin only.
 */

type AbortClass = "before-first-byte" | "mid-frame" | "during-backpressure";
type ChildEvent =
  | { type: "ready"; port: number }
  | { type: "phase"; id: string; class: AbortClass }
  | { type: "cancel-ack"; id: string }
  | { type: "backpressure-unreachable"; id: string }
  | { type: "shutdown-ack" };

type ChildExit = { code: number; signal: NodeJS.Signals | null };

class ChildExitedError extends Error {
  constructor(readonly childExit: ChildExit, label: string) {
    super(`child exited while waiting for ${label}`);
  }
}

class ProbeTimeoutError extends Error {
  constructor(readonly label: string) {
    super(`timeout while waiting for ${label}`);
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const args = Bun.argv.slice(2);
function argNum(name: string, fallback: number): number {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return fallback;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

const SEED = argNum("--seed", 260801);
const PER_CLASS = Math.trunc(argNum("--per-class", 67));
const OVERALL_DEADLINE_MS = Math.trunc(argNum("--deadline-ms", 240_000));
const PHASE_DEADLINE_MS = 3_000;
const rand = mulberry32(SEED);

if (process.platform !== "darwin") {
  console.log(JSON.stringify({
    type: "SUMMARY",
    outcome: "FAIL",
    classification: "unsupported-platform",
    seed: SEED,
    platform: process.platform,
  }));
  process.exit(2);
}
if (!Number.isInteger(PER_CLASS) || PER_CLASS < 50 || OVERALL_DEADLINE_MS < 5_000 || OVERALL_DEADLINE_MS > 600_000) {
  console.log(JSON.stringify({
    type: "SUMMARY",
    outcome: "FAIL",
    classification: "invalid-arguments",
    seed: SEED,
    message: "--per-class must be an integer >= 50; --deadline-ms must be 5000..600000",
  }));
  process.exit(2);
}

const child = Bun.spawn({
  cmd: [process.execPath, `${import.meta.dir}/darwin-eager-abort-stress-child.ts`],
  stdout: "pipe",
  stderr: "pipe",
  cwd: import.meta.dir + "/..",
});

const childExitPromise: Promise<ChildExit> = child.exited.then(code => ({
  code,
  signal: child.signalCode,
}));
const seenEvents = new Set<string>();
const eventWaiters = new Map<string, Set<() => void>>();
let childStdoutTail = "";
let childStderrTail = "";
let readyPort: number | null = null;

function eventKey(event: ChildEvent): string {
  if (event.type === "ready") return "ready";
  if (event.type === "shutdown-ack") return "shutdown-ack";
  if (event.type === "phase") return `phase:${event.id}:${event.class}`;
  if (event.type === "cancel-ack") return `cancel-ack:${event.id}`;
  return `backpressure-unreachable:${event.id}`;
}

function noteEvent(event: ChildEvent): void {
  if (event.type === "ready") readyPort = event.port;
  const key = eventKey(event);
  if (seenEvents.has(key)) return;
  seenEvents.add(key);
  for (const resolve of eventWaiters.get(key) ?? []) resolve();
  eventWaiters.delete(key);
}

function waitForEvent(key: string): Promise<void> {
  if (seenEvents.has(key)) return Promise.resolve();
  return new Promise(resolve => {
    const waiters = eventWaiters.get(key) ?? new Set<() => void>();
    waiters.add(resolve);
    eventWaiters.set(key, waiters);
  });
}

function appendTail(current: string, chunk: string): string {
  return (current + chunk).slice(-16_384);
}

async function consumeChildStdout(): Promise<void> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    childStdoutTail = appendTail(childStdoutTail, text);
    pending += text;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line) as ChildEvent;
        if (event.type === "ready"
          || event.type === "phase"
          || event.type === "cancel-ack"
          || event.type === "backpressure-unreachable"
          || event.type === "shutdown-ack") {
          noteEvent(event);
        }
      } catch { /* retained in the bounded stdout tail for failure diagnostics */ }
    }
  }
}

async function consumeChildStderr(): Promise<void> {
  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    childStderrTail = appendTail(childStderrTail, decoder.decode(value, { stream: true }));
  }
}

void consumeChildStdout().catch(error => {
  childStderrTail = appendTail(childStderrTail, `stdout reader failed: ${String(error)}`);
});
void consumeChildStderr().catch(error => {
  childStderrTail = appendTail(childStderrTail, `stderr reader failed: ${String(error)}`);
});

const started = Date.now();
const overallDeadlineAt = started + OVERALL_DEADLINE_MS;

async function guarded<T>(promise: Promise<T>, label: string, timeoutMs = PHASE_DEADLINE_MS): Promise<T> {
  const remaining = overallDeadlineAt - Date.now();
  if (remaining <= 0) throw new ProbeTimeoutError("overall deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProbeTimeoutError(remaining <= timeoutMs ? "overall deadline" : label)),
      Math.min(remaining, timeoutMs),
    );
  });
  try {
    return await Promise.race([
      promise,
      childExitPromise.then(exit => { throw new ChildExitedError(exit, label); }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

try {
  await guarded(waitForEvent("ready"), "child readiness");
  if (!Number.isInteger(readyPort)) throw new Error("child readiness event omitted port");
} catch (error) {
  if (child.exitCode === null) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  const exit = await Promise.race([childExitPromise, Bun.sleep(1_000).then(() => null)]);
  console.log(JSON.stringify({
    type: "SUMMARY",
    outcome: "FAIL",
    classification: error instanceof ProbeTimeoutError
      ? "timeout"
      : error instanceof ChildExitedError && error.childExit.signal
        ? "signal-crash"
        : error instanceof ChildExitedError && error.childExit.code === 0
          ? "unexpected-clean-exit"
          : error instanceof ChildExitedError ? "exit-code-crash" : "probe-error",
    seed: SEED,
    algorithm: "mulberry32",
    durationMs: Date.now() - started,
    failure: error instanceof Error ? error.message : String(error),
    childExitCode: exit?.code ?? child.exitCode,
    childSignal: exit?.signal ?? child.signalCode,
    childStdoutTail,
    childStderrTail,
  }));
  process.exit(1);
}
const base = `http://127.0.0.1:${readyPort!}`;
const counts: Record<AbortClass, number> = {
  "before-first-byte": 0,
  "mid-frame": 0,
  "during-backpressure": 0,
};
let backpressureUnreachableCount = 0;

async function oneAbort(cls: AbortClass, ordinal: number): Promise<void> {
  const id = `${ordinal}-${cls}`;
  const url = `${base}/sse?id=${encodeURIComponent(id)}&class=${encodeURIComponent(cls)}`;
  const ac = new AbortController();
  const phase = waitForEvent(`phase:${id}:${cls}`);
  const cancelAck = waitForEvent(`cancel-ack:${id}`);

  if (cls === "before-first-byte") {
    const request = fetch(url, { signal: ac.signal });
    void request.catch(() => {});
    await guarded(phase, `${cls} phase ${ordinal}`);
    await Bun.sleep(Math.floor(rand() * 4));
    ac.abort();
    await guarded(cancelAck, `${cls} server cancel acknowledgement ${ordinal}`);
  } else if (cls === "mid-frame") {
    const response = await guarded(fetch(url, { signal: ac.signal }), `${cls} response ${ordinal}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`${cls} response ${ordinal} had no body`);
    const firstRead = reader.read();
    void firstRead.catch(() => {});
    await guarded(phase, `${cls} phase ${ordinal}`);
    await Bun.sleep(Math.floor(rand() * 4));
    ac.abort();
    void reader.cancel().catch(() => {});
    await guarded(cancelAck, `${cls} server cancel acknowledgement ${ordinal}`);
  } else {
    const response = await guarded(fetch(url, { signal: ac.signal }), `${cls} response ${ordinal}`);
    if (!response.body) throw new Error(`${cls} response ${ordinal} had no body`);
    const reader = response.body.getReader();
    // Consume one chunk, then become a deliberately slow reader. The child
    // emits its phase marker only after the actual relay producer has
    // plateaued behind the native HTTP sink.
    await guarded(reader.read(), `${cls} initial slow read ${ordinal}`);
    const reachability = await guarded(Promise.race([
      phase.then(() => "phase" as const),
      waitForEvent(`backpressure-unreachable:${id}`).then(() => "unreachable" as const),
    ]), `${cls} phase or unreachable ${ordinal}`);
    if (reachability === "unreachable") {
      backpressureUnreachableCount += 1;
      void reader.cancel().catch(() => {});
      return;
    }
    await Bun.sleep(Math.floor(rand() * 4));
    ac.abort();
    void reader.cancel().catch(() => {});
    await guarded(cancelAck, `${cls} server cancel acknowledgement ${ordinal}`);
  }
  // A phase marker proves the intended timing window; the per-id server ack
  // proves the client abort crossed the network boundary and triggered teardown.
  counts[cls] += 1;
}

const classes: AbortClass[] = ["before-first-byte", "mid-frame", "during-backpressure"];
const schedule: AbortClass[] = [];
for (const c of classes) for (let i = 0; i < PER_CLASS; i++) schedule.push(c);
for (let i = schedule.length; i < 200; i++) schedule.push(classes[i % classes.length]!);
// Deterministic shuffle (Fisher-Yates with the seeded PRNG).
for (let i = schedule.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [schedule[i], schedule[j]] = [schedule[j]!, schedule[i]!];
}
const requestedByClass: Record<AbortClass, number> = {
  "before-first-byte": schedule.filter(cls => cls === "before-first-byte").length,
  "mid-frame": schedule.filter(cls => cls === "mid-frame").length,
  "during-backpressure": schedule.filter(cls => cls === "during-backpressure").length,
};

console.log(JSON.stringify({
  type: "START",
  seed: SEED,
  algorithm: "mulberry32",
  minimumPerClass: PER_CLASS,
  total: schedule.length,
  bunVersion: Bun.version,
  platform: process.platform,
  arch: process.arch,
}));

let outcome: "PASS" | "PASS-WITH-CAVEAT" | "FAIL" = "FAIL";
let classification = "probe-error";
let workloadOutcome = "not-complete";
let childOutcome = "not-observed";
let failure: string | undefined;
let finalExit: ChildExit | null = null;
let backpressureCaveat = false;

async function waitForChildExit(timeoutMs: number): Promise<ChildExit> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      childExitPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeoutError("expected teardown")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

try {
  for (let i = 0; i < schedule.length; i++) await oneAbort(schedule[i]!, i);
  if (child.exitCode !== null) {
    throw new ChildExitedError(
      { code: child.exitCode, signal: child.signalCode },
      "post-workload liveness",
    );
  }
  if (counts["before-first-byte"] !== requestedByClass["before-first-byte"]
    || counts["mid-frame"] !== requestedByClass["mid-frame"]
    || counts["before-first-byte"] < 50
    || counts["mid-frame"] < 50
    || requestedByClass["during-backpressure"] < 50
    || schedule.length < 200) {
    throw new Error("server-acknowledged abort counts did not meet the request minimums");
  }
  if (counts["during-backpressure"] === requestedByClass["during-backpressure"]
    && backpressureUnreachableCount === 0) {
    workloadOutcome = "clean-completion";
  } else if (counts["during-backpressure"] === 0
    && backpressureUnreachableCount === requestedByClass["during-backpressure"]) {
    backpressureCaveat = true;
    workloadOutcome = "completed-with-caveat";
  } else {
    throw new Error("mixed backpressure reachability cannot satisfy the gate");
  }

  const shutdownResponse = await guarded(fetch(`${base}/shutdown`, { method: "POST" }), "shutdown request");
  if (!shutdownResponse.ok) throw new Error(`shutdown request returned ${shutdownResponse.status}`);
  await guarded(waitForEvent("shutdown-ack"), "shutdown acknowledgement");
  finalExit = await waitForChildExit(2_000);
  if (finalExit.code !== 0 || finalExit.signal !== null) {
    throw new ChildExitedError(finalExit, "expected teardown");
  }
  childOutcome = "expected-teardown";
  classification = backpressureCaveat ? "backpressure-unreachable" : "clean";
  outcome = backpressureCaveat ? "PASS-WITH-CAVEAT" : "PASS";
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  if (error instanceof ProbeTimeoutError) classification = "timeout";
  else if (error instanceof ChildExitedError) {
    finalExit = error.childExit;
    classification = finalExit.signal
      ? "signal-crash"
      : finalExit.code === 0 ? "unexpected-clean-exit" : "exit-code-crash";
  }
  if (child.exitCode === null) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  finalExit ??= await Promise.race([
    childExitPromise,
    Bun.sleep(1_000).then(() => null),
  ]);
  childOutcome = classification;
}

console.log(JSON.stringify({
  type: "SUMMARY",
  outcome,
  classification,
  seed: SEED,
  algorithm: "mulberry32",
  requestedTotal: schedule.length,
  requestedByClass,
  verifiedTotal: Object.values(counts).reduce((sum, value) => sum + value, 0),
  verifiedByClass: counts,
  backpressureUnreachableCount,
  durationMs: Date.now() - started,
  workloadOutcome,
  childOutcome,
  childExitCode: finalExit?.code ?? child.exitCode,
  childSignal: finalExit?.signal ?? child.signalCode,
  bunVersion: Bun.version,
  platform: process.platform,
  arch: process.arch,
  ...(failure ? { failure, childStdoutTail, childStderrTail } : {}),
}));
process.exitCode = outcome === "FAIL" ? 1 : 0;
