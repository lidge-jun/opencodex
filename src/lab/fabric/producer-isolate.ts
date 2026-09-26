import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRestrictedDir } from "../paths";
import { FABRIC_LIMITS } from "./constants";
import {
  FABRIC_PRODUCER_PROTOCOL_MAX_BYTES,
  FABRIC_PRODUCER_REQUEST_MAX_BYTES,
  FABRIC_PRODUCER_STDERR_MAX_BYTES,
  parseProducerProtocolLine,
  type IsolatedProducerResult,
} from "./producer-protocol";
import type { FabricHarnessProducerKind, FabricPatchExecutorInput, SyntheticPatchV1 } from "./types";
import { FabricTaskError } from "./types";

const CHILD_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "producer-child.ts");

/**
 * Bounded drain window between a child's `exit` and our decision. `close` also
 * waits for the child's stdio to end, and a descendant holding an inherited pipe
 * can delay it forever — so a missing `close` must not keep the run pending.
 * The bound only has to cover an ordinary stdio flush after process death: the
 * kernel releases a dead child's pipe ends immediately, so a `close` slower
 * than this almost always means a descendant still holds a pipe. A slow-but-
 * normal pipe that outlives the bound costs an inconclusive verdict plus
 * deferred scratch cleanup — a bounded price that does not grow with the wait.
 */
const EXIT_DRAIN_MS = 250;

/**
 * Bounded wait for exit/close after a parent-owned SIGKILL. Neither event is
 * guaranteed — a child in uninterruptible sleep, or a kill() that failed, produces
 * neither — and a latched killReason must not leave the run pending forever.
 */
const KILL_CONFIRM_MS = 2_000;

type FabricProducerIsolationLimits = {
  totalTimeoutMs: number;
  inactivityTimeoutMs: number;
};

let testIsolationLimits: FabricProducerIsolationLimits | undefined;

interface IsolateRequest {
  harnessKind?: FabricHarnessProducerKind;
  executorModulePath?: string;
  scratchRoot: string;
  totalTimeoutMs: number;
  inactivityTimeoutMs: number;
  executorInput?: FabricPatchExecutorInput;
  now?: () => number;
}

/**
 * The environment an isolated producer child runs with.
 *
 * Exported so a test that spawns `producer-child.ts` directly cannot drift from
 * the environment production actually uses. The Windows loader state and the
 * scratch-owned temp paths below are load-bearing, and a test carrying its own
 * literal copy of this object silently loses them.
 */
export function minimalFabricChildEnv(scratchRoot: string): Record<string, string> {
  const childTempDir = join(scratchRoot, ".tmp");
  ensureRestrictedDir(childTempDir, scratchRoot);
  const env: Record<string, string> = {
    TZ: "UTC",
    NO_COLOR: "1",
    OCX_FABRIC_SCRATCH_ROOT: scratchRoot,
    // Executors commonly use os.tmpdir() through libraries they import. Keep
    // those writes inside the same scratch boundary instead of forwarding the
    // user's ambient temp directory (Windows) or falling back to /tmp (POSIX).
    TEMP: childTempDir,
    TMP: childTempDir,
    TMPDIR: childTempDir,
  };
  if (process.platform !== "win32") return env;
  // Windows has no equivalent of "run with an (almost) empty environment". A
  // CreateProcess child inherits nothing here, and the loader itself reads the
  // environment: without SystemRoot it cannot resolve the system DLLs the Bun
  // executable links against, so the child dies before its entry module runs.
  // The parent then sees an immediate non-zero close with no protocol line and
  // reports harness_failure -- which is what turned every CL-07 producer case
  // into "inconclusive" on the Windows leg while POSIX stayed green.
  //
  // These are OS-owned loader state, not caller-supplied configuration. Temp
  // state is deliberately not forwarded; it is rooted in scratch above.
  for (const name of ["SystemRoot", "windir"] as const) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

function killChild(child: ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}

/** Whether the producer rejected while its child might still be running. */
export function isUnconfirmedProducerTermination(error: unknown): boolean {
  return error instanceof FabricTaskError
    && (error as FabricTaskError & { unconfirmedTermination?: boolean }).unconfirmedTermination === true;
}

/**
 * The release signal attached to an unconfirmed-termination rejection: resolves
 * once every monitored inherited stdio pipe reports its natural close. This is
 * observation only: closing a pipe does not prove a descendant exited and must
 * not authorize deletion. Undefined when nothing monitorable remained.
 */
export function producerTerminationSignal(error: unknown): Promise<void> | undefined {
  if (!error || typeof error !== "object") return undefined;
  const signal = (error as { stdioRelease?: unknown }).stdioRelease;
  return signal instanceof Promise ? signal : undefined;
}

/** Run a fabric patch producer in an isolated child process with parent-owned timeouts. */
export async function runIsolatedFabricProducer(request: IsolateRequest): Promise<IsolatedProducerResult> {
  const now = request.now ?? (() => Date.now());
  let lastActivityAt = now();
  // Budget enforcement must not follow wall-clock adjustments; telemetry still does.
  const budgetNow = request.now ?? (() => performance.now());
  const startedAt = request.now ? lastActivityAt : budgetNow();
  const totalDeadline = startedAt + request.totalTimeoutMs;
  let inactivityDeadline = startedAt + request.inactivityTimeoutMs;

  return await new Promise<IsolatedProducerResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, ["run", CHILD_ENTRY], {
        env: minimalFabricChildEnv(request.scratchRoot),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new FabricTaskError(
        error instanceof Error ? error.message : String(error),
        "harness_failure",
        "harness",
      ));
      return;
    }

    let stdoutBuffer = "";
    let stderrBytes = 0;
    let settled = false;
    let childClosed = false;
    let childExitedAt: number | undefined;
    let receivedResult: SyntheticPatchV1 | undefined;
    let killReason: FabricTaskError | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    let killWatchdog: ReturnType<typeof setTimeout> | undefined;
    // Resolves once every still-open inherited stdio pipe reports its natural
    // close. This is not a writer-termination proof or scratch deletion lease.
    // Undefined when no open pipe can be monitored.
    let stdioReleaseSignal: Promise<void> | undefined;

    // Keep monitorable pipes open but unref'd so they never extend process
    // lifetime; a stream without unref() is destroyed instead, and its
    // self-inflicted close must not count toward the release signal.
    const armStdioRelease = (): void => {
      const waiters: Promise<void>[] = [];
      let unmonitorable = false;
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream || stream.destroyed) continue;
        const unref = (stream as unknown as { unref?: unknown }).unref;
        if (typeof unref === "function") {
          waiters.push(new Promise<void>((resolve) => stream.once("close", resolve)));
          unref.call(stream);
        } else {
          unmonitorable = true;
          try { stream.destroy(); } catch { /* already closed */ }
        }
      }
      if (waiters.length > 0 && !unmonitorable) {
        stdioReleaseSignal = Promise.all(waiters).then(() => undefined);
      }
    };

    const finish = (fn: () => void) => {
      // A latched failure owns settlement, but scratch cleanup must wait for close.
      if (settled || (killReason && !childClosed)) return;
      settled = true;
      clearTimeout(totalTimer);
      clearTimeout(inactivityTimer);
      if (reapTimer) clearTimeout(reapTimer);
      if (killWatchdog) clearTimeout(killWatchdog);
      if (killReason) reject(killReason);
      else fn();
    };

    const settleTimeout = (error: FabricTaskError) => {
      if (settled || killReason) return;
      killReason = error;
      if (childClosed) finish(() => reject(error));
      else {
        killChild(child);
        // SIGKILL does not guarantee exit/close: an uninterruptible child, or a
        // kill() that failed, emits neither, and the latched killReason would
        // otherwise keep this run pending forever. Bound the wait; on expiry
        // reject with the original reason flagged unconfirmed so the caller
        // defers scratch cleanup instead of racing a child that may live.
        killWatchdog = setTimeout(() => {
          if (childClosed || settled) return;
          settled = true;
          clearTimeout(totalTimer);
          clearTimeout(inactivityTimer);
          if (reapTimer) clearTimeout(reapTimer);
          if (killWatchdog) {
            clearTimeout(killWatchdog);
            killWatchdog = undefined;
          }
          armStdioRelease();
          try { child.unref(); } catch { /* fake children may lack unref */ }
          const reason = killReason! as FabricTaskError & { unconfirmedTermination?: boolean; stdioRelease?: Promise<void> };
          reason.unconfirmedTermination = true;
          reason.stdioRelease = stdioReleaseSignal;
          reject(killReason);
        }, KILL_CONFIRM_MS);
      }
    };

    const expiredDeadline = (at: number): FabricTaskError | undefined => {
      // Choose the earliest deadline, regardless of which timer/data callback ran first.
      if (at >= inactivityDeadline && inactivityDeadline <= totalDeadline) {
        return new FabricTaskError("inactivity timeout exceeded", "inactivity_timeout", "environment");
      }
      if (at >= totalDeadline) {
        return new FabricTaskError("total timeout exceeded", "timeout", "environment");
      }
      return undefined;
    };

    const onInactivityTimeout = () => {
      settleTimeout(expiredDeadline(budgetNow())
        ?? new FabricTaskError("inactivity timeout exceeded", "inactivity_timeout", "environment"));
    };

    const armInactivity = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(onInactivityTimeout, request.inactivityTimeoutMs);
    };

    let inactivityTimer: ReturnType<typeof setTimeout> = setTimeout(onInactivityTimeout, request.inactivityTimeoutMs);

    const totalTimer = setTimeout(() => {
      settleTimeout(expiredDeadline(budgetNow())
        ?? new FabricTaskError("total timeout exceeded", "timeout", "environment"));
    }, request.totalTimeoutMs);

    const handleProtocolLine = (line: string) => {
      if (settled || killReason) return;
      try {
        const message = parseProducerProtocolLine(line);
        if (message.type === "activity" || message.type === "result") {
          // Bytes drained after `exit` are judged at the exit timestamp: the
          // process met its budgets when it died, so the drain must not
          // condemn data it wrote while still inside them.
          const at = childExitedAt ?? budgetNow();
          const expired = expiredDeadline(at);
          if (expired) {
            settleTimeout(expired);
            return;
          }
          if (message.type === "activity") {
            lastActivityAt = request.now ? at : now();
            inactivityDeadline = at + request.inactivityTimeoutMs;
            if (childExitedAt === undefined) armInactivity();
            return;
          }
        }
        if (message.type === "result") {
          receivedResult = message.patch;
          return;
        }
        if (message.type === "error") {
          const fabricCode = message.code === "inactivity_timeout"
            ? "inactivity_timeout"
            : message.code === "timeout"
              ? "timeout"
              : message.code === "sandbox_violation"
                ? "sandbox_violation"
                : message.code === "budget_exhausted"
                  ? "budget_exhausted"
                  : "harness_failure";
          const attribution = message.attribution === "environment" ? "environment" : "harness";
          const fabricError = new FabricTaskError(message.message, fabricCode, attribution);
          settleTimeout(fabricError);
          return;
        }
      } catch (error) {
        settleTimeout(new FabricTaskError(
          error instanceof Error ? error.message : String(error),
          "harness_failure",
          "harness",
        ));
      }
    };

    const consumeStdout = (chunk: string) => {
      if (settled || killReason) return;
      stdoutBuffer += chunk;
      if (Buffer.byteLength(stdoutBuffer, "utf8") > FABRIC_PRODUCER_PROTOCOL_MAX_BYTES) {
        settleTimeout(new FabricTaskError("producer protocol output exceeded limit", "budget_exhausted", "environment"));
        stdoutBuffer = "";
        return;
      }
      let newlineIdx = stdoutBuffer.indexOf("\n");
      while (newlineIdx >= 0) {
        const line = stdoutBuffer.slice(0, newlineIdx);
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        handleProtocolLine(line);
        newlineIdx = stdoutBuffer.indexOf("\n");
      }
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      consumeStdout(chunk.toString("utf8"));
    });

    child.stdout?.on("error", (error) => {
      settleTimeout(new FabricTaskError(error.message, "harness_failure", "harness"));
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk.toString("utf8"), "utf8");
      if (stderrBytes > FABRIC_PRODUCER_STDERR_MAX_BYTES) {
        stderrBytes = FABRIC_PRODUCER_STDERR_MAX_BYTES;
      }
    });

    child.stderr?.on("error", (error) => {
      settleTimeout(new FabricTaskError(error.message, "harness_failure", "harness"));
    });

    child.on("error", (error) => {
      if (child.pid === undefined) {
        // A spawn failure has no process to supervise and may never emit close.
        childClosed = true;
        finish(() => reject(new FabricTaskError(error.message, "harness_failure", "harness")));
        return;
      }
      settleTimeout(new FabricTaskError(error.message, "harness_failure", "harness"));
    });

    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") return;
      settleTimeout(new FabricTaskError(error.message, "harness_failure", "harness"));
    });

    const decide = (code: number | null, signal: NodeJS.Signals | null, reaped = false) => {
      if (settled) return;
      if (killReason) {
        const reason = killReason as FabricTaskError & { unconfirmedTermination?: boolean; stdioRelease?: Promise<void> };
        if (reaped) {
          // The kill was answered by exit but the pipes stayed open: a
          // descendant can still hold them, so scratch cleanup must defer to
          // the same release contract as an unconfirmed kill.
          reason.unconfirmedTermination = true;
          reason.stdioRelease = stdioReleaseSignal;
        }
        finish(() => reject(reason));
        return;
      }
      if (stdoutBuffer.trim()) {
        try {
          handleProtocolLine(stdoutBuffer.trim());
          if (settled) return;
        } catch {
          /* fall through */
        }
      }
      if (reaped) {
        // `close` never followed `exit`: the pipes outlived the producer, which
        // may mean a descendant escaped supervision — but the drain also cannot
        // rule out a stalled event loop or a slow pipe, so this is reported as
        // an inconclusive harness failure rather than a sandbox escape. Either
        // way the result is rejected: it must never resolve while a descendant
        // might still be alive to mutate scratch after cleanup. The recorded
        // exit status only narrows the message; the deferral contract is the
        // same for a clean exit and a nonzero or signaled one.
        const failure = new FabricTaskError(
          code !== 0 || signal
            ? `isolated producer exited (${code ?? signal ?? "unknown"}); its stdio never closed`
            : "isolated producer exited but its stdio never closed",
          "harness_failure",
          "harness",
        ) as FabricTaskError & { unconfirmedTermination?: boolean; stdioRelease?: Promise<void> };
        // A descendant holding an inherited pipe can still use scratch after
        // the direct child exited, so the caller must retain scratch for manual
        // review — pipe closure alone cannot prove a descendant terminated.
        failure.unconfirmedTermination = true;
        failure.stdioRelease = stdioReleaseSignal;
        finish(() => reject(failure));
        return;
      }
      // A stored result is accepted only when the child exited normally. A
      // signaled or nonzero exit without a latched reason is a harness failure —
      // parent-owned kills always carry a killReason, so this is never a timeout.
      if (code !== 0 || signal) {
        finish(() => reject(new FabricTaskError(
          `isolated producer exited (${code ?? signal ?? "unknown"})`,
          "harness_failure",
          "harness",
        )));
        return;
      }
      if (receivedResult) {
        finish(() => resolve({ patch: receivedResult!, lastActivityAt }));
        return;
      }
      finish(() => reject(new FabricTaskError("isolated producer returned no result", "harness_failure", "harness")));
    };

    child.on("exit", (code, signal) => {
      if (childClosed || settled) return;
      // `exit` ends the budget window even while `close` is still pending on
      // stdio: an already-met deadline still applies, and no producer code can
      // breach one after this point, so both budget timers are disarmed now.
      childExitedAt = budgetNow();
      if (!killReason) {
        const expired = expiredDeadline(childExitedAt);
        if (expired) killReason = expired;
      }
      clearTimeout(totalTimer);
      clearTimeout(inactivityTimer);
      // The direct child is confirmed dead, so the kill-confirmation watchdog
      // is moot; only the stdio drain still needs its bound.
      if (killWatchdog) {
        clearTimeout(killWatchdog);
        killWatchdog = undefined;
      }
      // The direct child is dead, but `close` also waits for its stdio to end.
      // Bound the drain so a descendant holding an inherited pipe cannot keep
      // the run pending, then settle from the recorded exit status.
      reapTimer = setTimeout(() => {
        if (reapTimer) {
          clearTimeout(reapTimer);
          reapTimer = undefined;
        }
        if (childClosed || settled) return;
        childClosed = true;
        armStdioRelease();
        decide(code, signal, true);
      }, EXIT_DRAIN_MS);
    });

    child.on("close", (code, signal) => {
      if (childClosed) return;
      childClosed = true;
      decide(code, signal);
    });

    const payload = JSON.stringify({
      harnessKind: request.harnessKind,
      executorModulePath: request.executorModulePath,
      scratchRoot: request.scratchRoot,
      totalTimeoutMs: request.totalTimeoutMs,
      inactivityTimeoutMs: request.inactivityTimeoutMs,
      executorInput: request.executorInput
        ? {
            routeContext: request.executorInput.routeContext,
            destination: request.executorInput.destination,
            routeSubject: request.executorInput.routeSubject,
            scratchRoot: request.executorInput.scratchRoot,
          }
        : undefined,
    });
    if (Buffer.byteLength(payload, "utf8") > FABRIC_PRODUCER_REQUEST_MAX_BYTES) {
      settleTimeout(new FabricTaskError("producer request exceeds protocol limit", "budget_exhausted", "environment"));
      return;
    }

    try {
      child.stdin?.write(payload);
      child.stdin?.end();
    } catch (error) {
      settleTimeout(new FabricTaskError(
        error instanceof Error ? error.message : String(error),
        "harness_failure",
        "harness",
      ));
      return;
    }
  });
}

/** Internal test seam. Production callers cannot arm it without the test-home guard. */
export function setFabricProducerIsolationLimitsForTests(limits?: FabricProducerIsolationLimits): void {
  if (process.env.OCX_TEST_HOME_GUARD !== "1") {
    throw new Error("fabric isolation limits can only be overridden by the test harness");
  }
  if (limits && (
    !Number.isFinite(limits.totalTimeoutMs)
    || !Number.isFinite(limits.inactivityTimeoutMs)
    || limits.totalTimeoutMs <= 0
    || limits.inactivityTimeoutMs <= 0
    || limits.inactivityTimeoutMs >= limits.totalTimeoutMs
  )) {
    throw new Error("invalid fabric test isolation limits");
  }
  testIsolationLimits = limits ? { ...limits } : undefined;
}

/** Default isolation limits for fabric producer child processes. */
export function fabricProducerIsolationLimits(): FabricProducerIsolationLimits {
  if (testIsolationLimits) return { ...testIsolationLimits };
  return {
    totalTimeoutMs: FABRIC_LIMITS.totalTimeoutMs,
    inactivityTimeoutMs: FABRIC_LIMITS.inactivityTimeoutMs,
  };
}
