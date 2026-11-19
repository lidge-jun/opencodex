import { execFile } from "node:child_process";
import { windowsDefaultExec, windowsDesktopAppAdapter, WINDOWS_PACKAGE_PROCESS_SCRIPT, parseWindowsPackageProcesses } from "../desktop-app/windows";
import type { DesktopAsyncExec, DesktopExec } from "../desktop-app/types";
import { resolveTrustedWindowsPowerShellExe } from "../../lib/windows-elevation";
import { windowsDesktopPayloadEnv } from "../desktop-app/windows-command-payload";
import type { VerifiedDesktopPackage } from "./installed-build";
import { activateWindowsCodexCompatibility, activateWindowsCodexCompatibilityAsync, validatedCompatibilityPacUrl } from "./windows-package-command";
export { validatedCompatibilityPacUrl } from "./windows-package-command";

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

/** Abort and timeout settle only after the child closes, so Stop can drain ownership. */
export const windowsCompatibilityAsyncExec: DesktopAsyncExec = (file, args, options) => new Promise((resolve, reject) => {
  let completed = false, closed = false, output = "", failure: Error | null = null;
  const finish = () => { if (completed && closed) { if (failure) reject(failure); else resolve(output); } };
  const child = execFile(file, [...args], { ...options, encoding: "utf8", maxBuffer: 65536 }, (error, stdout) => {
    failure = error; output = stdout; completed = true; finish();
  });
  child.once("close", () => { closed = true; finish(); });
});

/** Runtime launch owns asynchronous process discovery and the full package proof. */
export async function launchWindowsCodexCompatibilityAsync(pacUrl: string, build: VerifiedDesktopPackage | null,
  io: { execAsync?: DesktopAsyncExec; platform?: string; signal?: AbortSignal } = {}): Promise<CompatibilityLaunchResult> {
  validatedCompatibilityPacUrl(pacUrl);
  if ((io.platform ?? process.platform) !== "win32") return { status: "refused", reason: "unsupported_platform" };
  if (process.env.OCX_TEST_HOME_GUARD === "1" && !io.execAsync) return { status: "refused", reason: "test_environment" };
  if (!build) return { status: "refused", reason: "package_unavailable" };
  const exec = io.execAsync ?? windowsCompatibilityAsyncExec;
  try {
    if (io.signal?.aborted) return { status: "refused", reason: "activation_failed" };
    const stdout = await exec(resolveTrustedWindowsPowerShellExe(), ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PACKAGE_PROCESS_SCRIPT],
      { timeout: 10_000, windowsHide: true, env: windowsDesktopPayloadEnv({ root: build.root }), signal: io.signal });
    if (io.signal?.aborted) return { status: "refused", reason: "activation_failed" };
    if (parseWindowsPackageProcesses(stdout, build).length > 0) return { status: "refused", reason: "app_running" };
  } catch { return { status: "refused", reason: "process_probe_failed" }; }
  try { return { status: "started", ...await activateWindowsCodexCompatibilityAsync(exec, build, pacUrl, io.signal) }; }
  catch { return { status: "refused", reason: "activation_failed" }; }
}
