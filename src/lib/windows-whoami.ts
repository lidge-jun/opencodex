/**
 * Console-free Windows identity lookups.
 *
 * opencodex previously resolved the effective Windows account by spawning
 * `powershell.exe` without `windowsHide`, so every lookup from the
 * console-less proxy presented a visible console window (the v2.11.0 popup
 * bug). `whoami.exe` replaces the PowerShell SID lookup with the same trust
 * posture and the verified fix: it resolves from the trusted System32
 * directory (never PATH) and is spawned with windowsHide (CREATE_NO_WINDOW),
 * which prevents any console window. It also starts far faster than
 * PowerShell 5.1, which mattered on the startup hot path.
 */
import { resolveTrustedWindowsWhoamiExe } from "./windows-elevation";

export const WINDOWS_SID_PATTERN = /^S-1-(?:\d+-)+\d+$/i;

/**
 * Extract the SID from `whoami /user` output. The header text is localized,
 * but the SID token itself is numeric, so a locale-independent scan is safe.
 * Returns the uppercase SID without the leading `*` (callers add icacls form).
 */
export function parseWindowsSidFromWhoami(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    // whoami prints `DOMAIN\user S-1-5-...`; the SID is the trailing token.
    const match = /S-1-(?:\d+-)+\d+/i.exec(line.trim());
    if (match) return match[0].toUpperCase();
  }
  return null;
}

export interface WhoamiResult {
  success: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

/** `whoami /user`, hidden, bounded by the caller's remaining deadline. */
export function runWhoamiSync(timeoutMs: number): WhoamiResult {
  const result = Bun.spawnSync(
    [resolveTrustedWindowsWhoamiExe(), "/user"],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: Math.max(1, timeoutMs),
      windowsHide: true,
    },
  );
  return {
    success: result.success,
    exitCode: result.exitCode,
    timedOut: result.exitedDueToTimeout ?? false,
    output: result.stdout ? result.stdout.toString() : "",
  };
}

/** Async counterpart of {@link runWhoamiSync} with the same hidden spawn. */
export async function runWhoamiAsync(timeoutMs: number): Promise<WhoamiResult> {
  const proc = Bun.spawn(
    [resolveTrustedWindowsWhoamiExe(), "/user"],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
    },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* already exited */ }
  }, Math.max(1, timeoutMs));
  let exitCode: number | null = null;
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timer);
  }
  const output = proc.stdout
    ? await new Response(proc.stdout).text().catch(() => "")
    : "";
  return {
    success: !timedOut && exitCode === 0,
    exitCode: timedOut ? null : exitCode,
    timedOut,
    output,
  };
}
