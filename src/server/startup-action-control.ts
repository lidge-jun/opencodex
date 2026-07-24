import { execFile } from "node:child_process";
import { join } from "node:path";
import { durableBunPath } from "../lib/bun-runtime";
import { isWindowsAccessDenied } from "../lib/windows-elevation";
import { finalizeWindowsSchedulerServiceRegistration, windowsSchedulerTaskInstalled } from "../service";

export type StartupInstallAction = "install-service" | "install-shim";
let activeInstall: StartupInstallAction | null = null;

export function startupInstallArgv(action: StartupInstallAction): string[] {
  return action === "install-service"
    ? ["service", "install"]
    : ["codex-shim", "install"];
}

function installFailureDetail(stdout: string, stderr: string, error: Error): string {
  return stderr.trim() || stdout.trim() || error.message;
}

function runCliInstall(action: StartupInstallAction): Promise<{ stdout: string; stderr: string }> {
  const bun = durableBunPath();
  const cli = join(import.meta.dir, "..", "cli", "index.ts");
  const argv = [cli, ...startupInstallArgv(action)];
  return new Promise((resolve, reject) => {
    execFile(bun, argv, {
      encoding: "utf8",
      env: process.env,
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(installFailureDetail(stdout, stderr, error)));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/** Execute the existing fixed CLI installer outside the proxy event loop. */
export function runStartupInstallAction(action: StartupInstallAction): Promise<{ message: string }> {
  if (activeInstall) return Promise.reject(new Error(`Another startup installation is already running: ${activeInstall}`));
  activeInstall = action;
  const operation = (async () => {
    try {
      await runCliInstall(action);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (action === "install-service" && process.platform === "win32" && isWindowsAccessDenied(detail)) {
        await finalizeWindowsSchedulerServiceRegistration();
        if (!windowsSchedulerTaskInstalled()) {
          throw new Error("Background service install still failed after requesting administrator approval.");
        }
      } else {
        throw error;
      }
    }
    return {
      message: action === "install-service"
        ? "Background service installed."
        : "Codex launcher shim installed.",
    };
  })();
  return operation.finally(() => { activeInstall = null; });
}
