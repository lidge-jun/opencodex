import { lstatSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TEST_TEMP_OWNER_FILE } from "../../scripts/test-temp";

/** Place retained child state outside every parent test-sandbox cleanup root. */
export function overflowScratchBase(temp = tmpdir()): string {
  const canonical = realpathSync.native(temp);
  let current = canonical;
  let outermost: string | undefined;
  for (;;) {
    try { lstatSync(join(current, TEST_TEMP_OWNER_FILE)); outermost = current; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!outermost) return canonical;
  const outside = dirname(outermost);
  if (outside === outermost) throw new Error("test sandbox cannot be escaped safely");
  return outside;
}

/** Preserve a test failure if scratch cleanup also fails; never remove unverified state. */
export function finishOverflowScratch(
  root: string,
  safeToRemove: boolean,
  failure: { error: unknown } | undefined,
  remove: (path: string) => void = path => rmSync(path, { recursive: true, force: true }),
): void {
  let cleanupError: unknown;
  let cleanupFailed = false;
  try {
    if (safeToRemove) remove(root);
    else console.error(`Overflow child cleanup was not confirmed; retained scratch: ${root}`);
  } catch (error) { cleanupError = error; cleanupFailed = true; }
  if (failure && cleanupFailed) throw new AggregateError([failure.error, cleanupError], "overflow failure and scratch cleanup failure");
  if (failure) throw failure.error;
  if (cleanupFailed) throw cleanupError;
}

/** The overflow test owns this direct child and both of its output streams. */
export interface OverflowChild {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(): unknown;
}

type Outcome = { exit: number; stdout: string; stderr: string };

/**
 * An internal deadline leaves time inside Bun's unchanged outer test budget to
 * stop and join the direct child. An unsuccessful call never authorizes the
 * caller to remove its scratch: a terminated child may have descendants.
 */
export async function collectOverflowChild(child: OverflowChild, deadline: number | null, reapMs = 2_000): Promise<Outcome> {
  let exitObserved = false;
  const exit = Promise.resolve().then(() => child.exited).then(code => { exitObserved = true; return code; });
  const stdout = Promise.resolve().then(() => new Response(child.stdout).text());
  const stderr = Promise.resolve().then(() => new Response(child.stderr).text());
  // Attach handlers immediately, including to the losing completion branch.
  const joined = Promise.allSettled([exit, stdout, stderr]);
  const completion = Promise.all([exit, stdout, stderr]).then(
    ([code, out, err]) => ({ kind: "complete" as const, value: { exit: code, stdout: out, stderr: err } }),
    error => ({ kind: "failed" as const, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: "timeout" }>(resolve => {
    if (deadline !== null) timer = setTimeout(() => resolve({ kind: "timeout" }), Math.max(0, deadline - performance.now()));
  });
  try {
    const first = await Promise.race([completion, timeout]);
    if (first.kind === "complete" && (deadline === null || performance.now() < deadline)) return first.value;
    const primary = first.kind === "failed" ? first.error : new Error("overflow child exceeded its internal deadline");
    const cleanupErrors: unknown[] = [];
    // On Windows Bun can resolve `exited` with 143 while leaving exitCode null.
    // The joined exit promise, not that stale property, owns the lifetime.
    if (!exitObserved) {
      try { child.kill(); } catch (error) { if (!exitObserved) cleanupErrors.push(error); }
    }
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const remaining = deadline === null ? reapMs : Math.max(0, Math.min(reapMs, deadline + reapMs - performance.now()));
    const cleanup = await Promise.race([
      joined,
      new Promise<null>(resolve => { reapTimer = setTimeout(() => resolve(null), remaining); }),
    ]);
    clearTimeout(reapTimer);
    if (cleanup === null) cleanupErrors.push(new Error(`child ${child.pid} exit or output drain was not confirmed`));
    else for (const result of cleanup) if (result.status === "rejected") cleanupErrors.push(result.reason);
    if (cleanupErrors.length) throw new AggregateError([primary, ...cleanupErrors], `overflow child ${child.pid} failed; cleanup incomplete`);
    throw primary;
  } finally {
    clearTimeout(timer);
  }
}
