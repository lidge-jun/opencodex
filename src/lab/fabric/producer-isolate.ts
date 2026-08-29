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

/** Run a fabric patch producer in an isolated child process with parent-owned timeouts. */
export async function runIsolatedFabricProducer(request: IsolateRequest): Promise<IsolatedProducerResult> {
  const now = request.now ?? (() => Date.now());
  let lastActivityAt = now();

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
    let receivedResult: SyntheticPatchV1 | undefined;
    let killReason: FabricTaskError | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearTimeout(inactivityTimer);
      fn();
    };

    const settleTimeout = (error: FabricTaskError) => {
      if (settled) return;
      killReason = error;
      killChild(child);
    };

    const armInactivity = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        settleTimeout(new FabricTaskError("inactivity timeout exceeded", "inactivity_timeout", "environment"));
      }, request.inactivityTimeoutMs);
    };

    let inactivityTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
      settleTimeout(new FabricTaskError("inactivity timeout exceeded", "inactivity_timeout", "environment"));
    }, request.inactivityTimeoutMs);

    const totalTimer = setTimeout(() => {
      settleTimeout(new FabricTaskError("total timeout exceeded", "timeout", "environment"));
    }, request.totalTimeoutMs);

    const handleProtocolLine = (line: string) => {
      try {
        const message = parseProducerProtocolLine(line);
        if (message.type === "activity") {
          lastActivityAt = now();
          armInactivity();
          return;
        }
        if (message.type === "result") {
          if (settled) return;
          receivedResult = message.patch;
          finish(() => resolve({ patch: message.patch, lastActivityAt }));
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
          finish(() => reject(fabricError));
          killChild(child);
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
      if (settled) return;
      finish(() => reject(new FabricTaskError(error.message, "harness_failure", "harness")));
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk.toString("utf8"), "utf8");
      if (stderrBytes > FABRIC_PRODUCER_STDERR_MAX_BYTES) {
        stderrBytes = FABRIC_PRODUCER_STDERR_MAX_BYTES;
      }
    });

    child.on("error", (error) => {
      finish(() => reject(new FabricTaskError(error.message, "harness_failure", "harness")));
    });

    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (settled || error.code === "EPIPE") return;
      killChild(child);
      finish(() => reject(new FabricTaskError(error.message, "harness_failure", "harness")));
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
      killChild(child);
      finish(() => reject(new FabricTaskError("producer request exceeds protocol limit", "budget_exhausted", "environment")));
      return;
    }

    try {
      child.stdin?.write(payload);
      child.stdin?.end();
    } catch (error) {
      killChild(child);
      finish(() => reject(new FabricTaskError(
        error instanceof Error ? error.message : String(error),
        "harness_failure",
        "harness",
      )));
      return;
    }

    child.on("close", (code, signal) => {
      if (settled) return;
      if (killReason) {
        finish(() => reject(killReason!));
        return;
      }
      if (receivedResult) {
        finish(() => resolve({ patch: receivedResult!, lastActivityAt }));
        return;
      }
      if (stdoutBuffer.trim()) {
        try {
          handleProtocolLine(stdoutBuffer.trim());
          if (receivedResult) return;
        } catch {
          /* fall through */
        }
      }
      if (signal === "SIGKILL") {
        finish(() => reject(new FabricTaskError("total timeout exceeded", "timeout", "environment")));
        return;
      }
      finish(() => reject(new FabricTaskError(
        code === 0 ? "isolated producer returned no result" : `isolated producer exited (${code ?? signal ?? "unknown"})`,
        "harness_failure",
        "harness",
      )));
    });
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
