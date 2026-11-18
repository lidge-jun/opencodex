/**
 * Non-interactive Windows Installer execution for the headless Desktop updater (#8246).
 *
 * msiexec runs as a child this process waits on, so the result is the installer's real exit
 * code, not a launch receipt. 0 and 3010 are both an installed product; 3010 (and 1641, which
 * `/norestart` should prevent) also means a reboot finishes replacing files that were in use.
 * Every other code is a failure Windows Installer has rolled back. If the installer outlives its
 * deadline the outcome is uncertain: it is never killed mid-transaction and nothing that follows
 * treats it as installed.
 */
import type { AcquireTimers } from "./acquire";

export interface InstallerProcess {
  /** Resolves with the exit code, or null when the process ended without one. */
  exited: Promise<number | null>;
}

export type InstallerSpawn = (file: string, args: readonly string[]) => InstallerProcess;

export type MsiOutcome =
  | { kind: "installed"; code: 0 }
  | { kind: "installed-reboot-required"; code: 3010 | 1641 }
  | { kind: "busy"; code: 1618 }
  | { kind: "cancelled"; code: 1602 }
  | { kind: "failed"; code: number | null }
  | { kind: "uncertain"; code: null };

/** Fixed arguments: the verified package, no UI, no reboot, and a verbose log. */
export function msiexecArguments(msiPath: string, logPath: string): string[] {
  return ["/i", msiPath, "/qn", "/norestart", "/l*v", logPath];
}

export function classifyMsiExit(code: number | null): MsiOutcome {
  if (code === 0) return { kind: "installed", code };
  if (code === 3010 || code === 1641) return { kind: "installed-reboot-required", code };
  if (code === 1618) return { kind: "busy", code };
  if (code === 1602) return { kind: "cancelled", code };
  return { kind: "failed", code };
}

export function isInstalled(outcome: MsiOutcome): outcome is Extract<MsiOutcome, { kind: "installed" | "installed-reboot-required" }> {
  return outcome.kind === "installed" || outcome.kind === "installed-reboot-required";
}

/** Plain explanation of an installer exit for the result and the terminal. */
export function describeMsiOutcome(outcome: MsiOutcome): string {
  switch (outcome.kind) {
    case "installed": return "Windows Installer finished (exit 0).";
    case "installed-reboot-required": return `Windows Installer finished (exit ${outcome.code}); some files are replaced only after Windows restarts.`;
    case "busy": return "Another installation is in progress (exit 1618); nothing was changed. Retry when it finishes.";
    case "cancelled": return "The installation was cancelled (exit 1602); nothing was changed.";
    case "failed": return `Windows Installer failed (exit ${outcome.code ?? "unknown"}) and rolled back; nothing was changed. Run this from an elevated terminal if the log reports insufficient privileges.`;
    case "uncertain": return "Windows Installer did not finish within its deadline. It was left running; check the log and 'ocx status' before retrying.";
  }
}

export async function runMsiInstall(
  input: { msiexec: string; msiPath: string; logPath: string; timeoutMs: number },
  deps: { spawn: InstallerSpawn; timers: AcquireTimers },
): Promise<MsiOutcome> {
  let child: InstallerProcess;
  try { child = deps.spawn(input.msiexec, msiexecArguments(input.msiPath, input.logPath)); }
  catch { return { kind: "failed", code: null }; }
  let cancel = () => {};
  const deadline = new Promise<"deadline">(resolve => { cancel = deps.timers.schedule(input.timeoutMs, () => resolve("deadline")); });
  try {
    const settled = await Promise.race([child.exited.then(code => ({ code }), () => ({ code: null })), deadline]);
    return settled === "deadline" ? { kind: "uncertain", code: null } : classifyMsiExit(settled.code);
  } finally {
    cancel();
  }
}
