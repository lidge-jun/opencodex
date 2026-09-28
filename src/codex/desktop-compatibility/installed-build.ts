import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { isTestHomeGuardArmed } from "../../lib/test-home-guard";
import { resolveTrustedWindowsPowerShellExe } from "../../lib/windows-elevation";
import { parseWindowsDesktopPackage, WINDOWS_PACKAGE_DISCOVERY_SCRIPT } from "../desktop-app/windows";
import type { DesktopAppInstall } from "../desktop-app/types";

export const DESKTOP_COMPATIBILITY_ASSESSED_VERSION = "26.924.2738.0";
export const DESKTOP_COMPATIBILITY_ASSESSED_FAMILY = "OpenAI.Codex_2p2nqsd0c76g0";

function matchesAssessedPackage(install: DesktopAppInstall): boolean {
  const name = win32.basename(install.root);
  const parts = /^OpenAI\.Codex_(\d+\.\d+\.\d+\.\d+)_(x64|arm64|x86|neutral)_([A-Za-z0-9.-]*)_([A-Za-z0-9]+)$/.exec(name);
  return install.id === DESKTOP_COMPATIBILITY_ASSESSED_FAMILY && install.relaunch === `${install.id}!App`
    && !!parts && parts[1] === DESKTOP_COMPATIBILITY_ASSESSED_VERSION && `OpenAI.Codex_${parts[4]}` === install.id;
}

/** Resolve only after the exact asynchronous child has closed, including abort/timeout. */
function queryInstalledPackage(signal: AbortSignal): Promise<DesktopAppInstall | null> {
  if (process.platform !== "win32" || isTestHomeGuardArmed() || signal.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    let completed = false, closed = false, result: DesktopAppInstall | null = null;
    const finish = () => { if (completed && closed) { signal.removeEventListener("abort", abort); resolve(result); } };
    const child = execFile(resolveTrustedWindowsPowerShellExe(), ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PACKAGE_DISCOVERY_SCRIPT], {
      timeout: 10000, maxBuffer: 65536, encoding: "utf8", windowsHide: true,
    }, (error, stdout) => { result = error ? null : parseWindowsDesktopPackage(stdout); completed = true; finish(); });
    const abort = () => { try { child.kill(); } catch { /* Keep ownership until execFile reports close. */ } };
    child.once("close", () => { closed = true; finish(); });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Coalesce concurrent fresh probes; never cache a positive verdict across requests. */
export function createInstalledBuildProbe(query: (signal: AbortSignal) => Promise<DesktopAppInstall | null> = queryInstalledPackage) {
  let pending: Promise<boolean> | null = null, controller: AbortController | null = null, closed = false;
  return {
    check(): Promise<boolean> {
      if (closed) return Promise.resolve(false);
      if (pending) return pending;
      const current = new AbortController(); controller = current;
      pending = Promise.resolve().then(() => current.signal.aborted ? null : query(current.signal))
        .then(install => !closed && !current.signal.aborted && !!install
          && matchesAssessedPackage(install))
        .catch(() => false).finally(() => { pending = null; controller = null; });
      return pending;
    },
    async close(): Promise<void> { closed = true; controller?.abort(); await pending; },
  };
}

export async function isAssessedDesktopInstalled(): Promise<boolean> {
  const probe = createInstalledBuildProbe();
  try { return await probe.check(); } finally { await probe.close(); }
}
