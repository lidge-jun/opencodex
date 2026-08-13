import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { durableBunPath } from "../lib/bun-runtime";
import {
  WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER,
  isWindowsSchtasksCreateAccessDenied,
} from "../lib/windows-elevation";
import {
  finalizeWindowsSchedulerServiceRegistration,
  type ElevatedReconciliationOutcome,
  type FinalizeWindowsSchedulerOptions,
  type FinalizeWindowsSchedulerResult,
  type WindowsSchedulerTaskProbe,
} from "../service";

export type StartupInstallAction = "install-service" | "install-shim";

export type StartupInstallState =
  | { status: "idle" }
  | {
      status: "running";
      action: StartupInstallAction;
      attemptId: string;
      startedAt: number;
    }
  | {
      status: "indeterminate";
      action: "install-service";
      attemptId: string;
      startedAt: number;
      timedOutAt: number;
      reconciliation: Promise<ElevatedReconciliationOutcome>;
    }
  | {
      status: "blocked";
      reason: "partial-elevated-install";
      action: "install-service";
      attemptId: string;
      detail: string;
    };

const INSTALL_DETAIL_LIMIT = 2_000;
const INDETERMINATE_MESSAGE =
  "Windows elevation timed out, but the elevated Task Scheduler transaction may still be running. New service installation attempts are temporarily blocked while OpenCodex reconciles its final state.";
const RECONCILING_MESSAGE =
  "A previous elevated Windows service installation is still being reconciled. Wait for it to finish or inspect the Task Scheduler state before retrying.";
const BLOCKED_PARTIAL_MESSAGE =
  "A previous elevated Windows service installation left a partial Task Scheduler state. Remove the OpenCodex scheduler task (or confirm it is absent), then clear the install block before retrying.";

let installState: StartupInstallState = { status: "idle" };

type FinalizeFn = (
  script?: string,
  options?: FinalizeWindowsSchedulerOptions,
) => Promise<FinalizeWindowsSchedulerResult>;
let finalizeImpl: FinalizeFn = finalizeWindowsSchedulerServiceRegistration;

/** Test-only seam so elevation retry tests do not mock.module the service package. */
export function setStartupInstallFinalizeForTests(next: FinalizeFn | null): void {
  finalizeImpl = next ?? finalizeWindowsSchedulerServiceRegistration;
}

/** Snapshot of the install lock for diagnostics and tests. */
export function getStartupInstallState(): StartupInstallState {
  return installState;
}

/** True when this attempt still owns the active/indeterminate/blocked lock. */
export function ownsStartupInstallAttempt(attemptId: string): boolean {
  return (installState.status === "running"
    || installState.status === "indeterminate"
    || installState.status === "blocked")
    && installState.attemptId === attemptId;
}

/**
 * Clear a partial-install block after the operator has cleaned up Task Scheduler.
 * Requires an observed probe and clears only when the task is proven absent.
 * Does not itself delete the task.
 */
export function clearStartupInstallPartialBlock(options: {
  probe: WindowsSchedulerTaskProbe;
}): { cleared: boolean; detail: string } {
  if (installState.status !== "blocked") {
    return { cleared: false, detail: `Install lock is ${installState.status}, not blocked.` };
  }
  if (options.probe.status === "present") {
    return {
      cleared: false,
      detail: "OpenCodex Task Scheduler task is still present; remove it before clearing the block.",
    };
  }
  if (options.probe.status === "unknown") {
    return {
      cleared: false,
      detail: `Could not verify Task Scheduler absence (${options.probe.detail}); not clearing the block.`,
    };
  }
  installState = { status: "idle" };
  return { cleared: true, detail: "Partial-install block cleared." };
}

/** Test-only reset of the install lock. */
export function resetStartupInstallStateForTests(): void {
  installState = { status: "idle" };
}

export function startupInstallArgv(
  action: StartupInstallAction,
  options?: { repair?: boolean },
): string[] {
  if (action === "install-service") {
    return options?.repair ? ["service", "repair"] : ["service", "install"];
  }
  return ["codex-shim", "install"];
}

export interface CliInstallFailure {
  /** Machine marker such as OCX_ERROR_CODE=..., when present in any stream. */
  code: string | null;
  stdout: string;
  stderr: string;
  message: string;
  /** Bounded user-facing diagnostic (may append the marker if truncated away). */
  detail: string;
}

function extractOcxErrorCode(text: string): string | null {
  const match = text.match(/OCX_ERROR_CODE=[A-Z0-9_]+/);
  return match ? match[0] : null;
}

/**
 * Classify a CLI install failure, keeping the machine marker separate from the
 * truncated user-facing diagnostic.
 */
export function classifyCliInstallFailure(stdout: string, stderr: string, error: Error): CliInstallFailure {
  const stdoutText = stdout.trim();
  const stderrText = stderr.trim();
  const message = error.message.trim();
  const combined = [stderrText, stdoutText, message].filter(Boolean).join("\n");
  const code = extractOcxErrorCode(combined);
  let detail = combined || message;
  if (detail.length > INSTALL_DETAIL_LIMIT) {
    const truncated = detail.slice(0, INSTALL_DETAIL_LIMIT);
    detail = code && !truncated.includes(code)
      ? `${truncated}\n${code}… (truncated)`
      : `${truncated}… (truncated)`;
  }
  return { code, stdout: stdoutText, stderr: stderrText, message, detail };
}

/** @deprecated Prefer classifyCliInstallFailure; kept for existing tests. */
export function installFailureDetail(stdout: string, stderr: string, error: Error): string {
  return classifyCliInstallFailure(stdout, stderr, error).detail;
}

function runCliInstall(
  action: StartupInstallAction,
  options?: { repair?: boolean },
): Promise<{ stdout: string; stderr: string }> {
  const bun = durableBunPath();
  const cli = join(import.meta.dir, "..", "cli", "index.ts");
  const argv = [cli, ...startupInstallArgv(action, options)];
  return new Promise((resolve, reject) => {
    const timeout = process.platform === "win32" && action === "install-service"
      ? 0
      : 60_000;
    execFile(bun, argv, {
      encoding: "utf8",
      env: process.env,
      // A fresh Windows scheduler install now owns its UAC prompt inside this CLI
      // transaction. Killing only the CLI at 60s can orphan its elevated schtasks child,
      // which may register the task after the Dashboard has reported failure. Keep the
      // async request/attempt lock alive until Windows returns approval or cancellation.
      timeout,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const failure = classifyCliInstallFailure(stdout, stderr, error);
        reject(Object.assign(new Error(failure.detail), { ocxInstallFailure: failure }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function installFailureCode(error: unknown): string | null {
  if (error && typeof error === "object" && "ocxInstallFailure" in error) {
    const failure = (error as { ocxInstallFailure?: CliInstallFailure }).ocxInstallFailure;
    if (failure?.code) return failure.code;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return extractOcxErrorCode(detail);
}

function rejectIfBusy(_action: StartupInstallAction): Error | null {
  if (installState.status === "running") {
    return new Error(`Another startup installation is already running: ${installState.action}`);
  }
  if (installState.status === "indeterminate") {
    return new Error(RECONCILING_MESSAGE);
  }
  if (installState.status === "blocked") {
    return new Error(BLOCKED_PARTIAL_MESSAGE);
  }
  return null;
}

function applyReconciliationOutcome(
  attemptId: string,
  outcome: ElevatedReconciliationOutcome,
): void {
  if (installState.status !== "indeterminate" || installState.attemptId !== attemptId) {
    return;
  }
  if (outcome === "blocked-partial") {
    installState = {
      status: "blocked",
      reason: "partial-elevated-install",
      action: "install-service",
      attemptId,
      detail: BLOCKED_PARTIAL_MESSAGE,
    };
    return;
  }
  installState = { status: "idle" };
}

/**
 * Execute the existing fixed CLI installer outside the proxy event loop.
 *
 * Repair mode (`options.repair`) runs `ocx service repair` — asset rewrite + restart
 * without Task Scheduler re-registration, so it must not enter the UAC elevation path.
 *
 * After an elevation request timeout the lock becomes `indeterminate` until the
 * original elevated transaction completes and is reconciled. A process restart
 * clears this in-memory lock — callers must then inspect Task Scheduler reality
 * (see evaluateSchedulerInstallRestartReconciliation) before installing again.
 */
export function runStartupInstallAction(
  action: StartupInstallAction,
  options?: { repair?: boolean },
): Promise<{ message: string }> {
  const busy = rejectIfBusy(action);
  if (busy) return Promise.reject(busy);

  const repair = options?.repair === true;
  const attemptId = randomUUID();
  const startedAt = Date.now();
  installState = { status: "running", action, attemptId, startedAt };

  const operation = (async () => {
    try {
      await runCliInstall(action, { repair });
    } catch (error) {
      const code = installFailureCode(error);
      const detail = error instanceof Error ? error.message : String(error);
      // Elevate only for fresh install + structured Task Scheduler /create access denial —
      // never for repair, WinSW removal, asset writes, or generic permission errors.
      if (
        !repair
        && action === "install-service"
        && process.platform === "win32"
        && (code === WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER
          || isWindowsSchtasksCreateAccessDenied(detail))
      ) {
        const finalized = await finalizeImpl(undefined, {
          attemptId,
          stillOwnsAttempt: ownsStartupInstallAttempt,
        });
        if (finalized.kind === "indeterminate") {
          const ownedAttemptId = finalized.attemptId;
          installState = {
            status: "indeterminate",
            action: "install-service",
            attemptId: ownedAttemptId,
            startedAt,
            timedOutAt: Date.now(),
            reconciliation: finalized.reconciliation,
          };
          void finalized.reconciliation.then(
            outcome => {
              applyReconciliationOutcome(ownedAttemptId, outcome);
            },
            () => {
              // Fail closed: a rejected reconciliation must not leave an unhandled rejection
              // or silently idle the lock while Task Scheduler state may still be partial.
              applyReconciliationOutcome(ownedAttemptId, "blocked-partial");
            },
          );
          throw new Error(INDETERMINATE_MESSAGE);
        }
      } else {
        throw error;
      }
    }
    if (action === "install-service") {
      return { message: repair ? "Background service repaired." : "Background service installed." };
    }
    return {
      message: repair ? "Codex launcher shim repaired." : "Codex launcher shim installed.",
    };
  })();

  return operation.finally(() => {
    // Do not clear an indeterminate or blocked lock from a timed-out elevation.
    if (installState.status === "running" && installState.attemptId === attemptId) {
      installState = { status: "idle" };
    }
  });
}
