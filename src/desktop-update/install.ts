/**
 * Recognizing a Windows OpenCodex Desktop installation from its bundled `ocx.exe` (#8246).
 *
 * The MSI installs `opencodex-desktop.exe` and its sidecar `ocx.exe` side by side; the headless
 * updater and the stale-runtime advice apply only when this CLI is that compiled sidecar.
 */
import { win32 } from "node:path";
import { existsSync } from "node:fs";
import { isStandaloneBinary } from "../lib/standalone";
import type { VersionSkew } from "../cli/version-skew";

export interface WindowsDesktopInstall {
  dir: string;
  ocxExe: string;
  desktopExe: string;
}

export interface DesktopInstallProbe {
  platform?: NodeJS.Platform;
  execPath?: string;
  standalone?: boolean;
  exists?: (path: string) => boolean;
}

export function windowsDesktopInstall(probe: DesktopInstallProbe = {}): WindowsDesktopInstall | null {
  if ((probe.platform ?? process.platform) !== "win32") return null;
  if (!(probe.standalone ?? isStandaloneBinary())) return null;
  const execPath = probe.execPath ?? process.execPath;
  if (win32.basename(execPath).toLowerCase() !== "ocx.exe" || !/^[A-Za-z]:[\\/]/.test(execPath)) return null;
  const dir = win32.dirname(execPath.replaceAll("/", "\\"));
  const desktopExe = win32.join(dir, "opencodex-desktop.exe");
  if (!(probe.exists ?? existsSync)(desktopExe)) return null;
  return { dir, ocxExe: win32.join(dir, "ocx.exe"), desktopExe };
}

/** The command that finishes an installed update by replacing the runtime that still serves. */
export function desktopUpdateCommand(install: WindowsDesktopInstall): string {
  return `"${install.ocxExe}" update --desktop`;
}

/**
 * On a Desktop installation, a CLI newer than the serving proxy means the MSI installed an update
 * the running runtime has not picked up. Say so, with the command that completes it.
 */
export function withDesktopSkewAdvice(skew: VersionSkew, install: WindowsDesktopInstall | null): VersionSkew {
  if (!install || skew.relation !== "cli-newer" || !skew.proxyVersion) return skew;
  return {
    ...skew,
    warning: `OpenCodex Desktop ${skew.cliVersion} is installed, but the running proxy still serves ${skew.proxyVersion}. `
      + `Replace it with: ${desktopUpdateCommand(install)} (or quit and reopen OpenCodex Desktop).`,
  };
}
