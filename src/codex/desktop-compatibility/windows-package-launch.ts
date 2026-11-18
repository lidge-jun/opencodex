import { windowsDefaultExec, windowsDesktopAppAdapter } from "../desktop-app/windows";
import type { DesktopExec } from "../desktop-app/types";
import type { VerifiedDesktopPackage } from "./installed-build";
import { activateWindowsCodexCompatibility, validatedCompatibilityPacUrl } from "./windows-package-command";
export { compatibilityActivationScript, validatedCompatibilityPacUrl } from "./windows-package-command";

export interface CompatibilityLaunchIo {
  exec?: DesktopExec;
  platform?: string;
}
export type CompatibilityLaunchResult =
  | { status: "started"; pid: number; packageFullName: string }
  | { status: "refused"; reason: "unsupported_platform" | "test_environment" | "package_unavailable" | "app_running" | "process_probe_failed" | "activation_failed" };

/** Never quits an app, launches the raw EXE, changes login or installs a watcher. */
export function launchWindowsCodexCompatibility(pacUrl: string, build: VerifiedDesktopPackage | null, io: CompatibilityLaunchIo = {}): CompatibilityLaunchResult {
  validatedCompatibilityPacUrl(pacUrl);
  if ((io.platform ?? process.platform) !== "win32") return { status: "refused", reason: "unsupported_platform" };
  if (process.env.OCX_TEST_HOME_GUARD === "1" && !io.exec) return { status: "refused", reason: "test_environment" };
  if (!build) return { status: "refused", reason: "package_unavailable" };
  const exec = io.exec ?? windowsDefaultExec;
  const processes = windowsDesktopAppAdapter.listProcesses(exec, build);
  if (processes === null) return { status: "refused", reason: "process_probe_failed" };
  if (processes.length > 0) return { status: "refused", reason: "app_running" };
  try {
    return { status: "started", ...activateWindowsCodexCompatibility(exec, build, pacUrl) };
  } catch { return { status: "refused", reason: "activation_failed" }; }
}
