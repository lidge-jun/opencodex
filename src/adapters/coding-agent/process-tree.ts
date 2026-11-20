import { execFile, execFileSync } from "node:child_process";

const TASKKILL_TIMEOUT_MS = 5_000;

function taskkillPath(): string {
  return `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
}

/** Terminate the owned CLI and its descendants; never resolve on an unconfirmed tree kill. */
export function killWindowsProcessTree(pid: number): void {
  execFileSync(taskkillPath(), ["/PID", String(pid), "/T", "/F"], {
    stdio: "pipe",
    windowsHide: true,
    timeout: TASKKILL_TIMEOUT_MS,
  });
}

/** StepCode needs a tree-kill receipt without blocking the shutdown clock. */
export function killWindowsProcessTreeAsync(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(taskkillPath(), ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: TASKKILL_TIMEOUT_MS,
      killSignal: "SIGKILL",
    }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}
