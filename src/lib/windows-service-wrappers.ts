/**
 * Shared termination of surviving Windows scheduler launcher/wrapper processes.
 *
 * `schtasks /end` ends the task instance but often leaves wscript/cmd running the
 * `:loop` batch, which brings the proxy back during a stop, a restart, or
 * post-update reclaim. Both the service teardown path and the update job need
 * that guarantee, and they used to carry a copy each.
 *
 * The copies drifted in both directions, which is why this module exists rather
 * than a second careful implementation: the updater received the #1589 argv
 * cleanup that service.ts missed, and service.ts received the canonical-path
 * scoping the updater missed. One of those gaps could force-terminate a wrapper
 * belonging to a DIFFERENT OpenCodex home.
 *
 * Matching is scoped to the CANONICAL paths of one installation, never a bare
 * filename, and the path must appear as a COMPLETE command-line token
 * (wscript.exe spawns the .vbs as an argument; cmd.exe /c runs the .cmd). A
 * substring match is excluded: an unrelated process whose command line merely
 * contains the filename, and a wrapper under another home whose path ends with
 * the same name, must both survive.
 */
import { spawnSync } from "node:child_process";

import { resolveTrustedWindowsPowerShellExe } from "./windows-elevation";

/** Quote for PowerShell: single-quote the value and double any embedded quote. */
function quoteForPowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The PowerShell that finds and stops the wrappers for exactly these paths.
 * Exported for tests: the matching rule is the whole point of this module, and
 * the spawn itself is best-effort and unobservable.
 */
export function windowsWrapperKillScript(paths: readonly string[]): string {
  return [
    `$pats = @(${paths.map(quoteForPowerShell).join(", ")});`,
    "Get-CimInstance Win32_Process | Where-Object {",
    "  if ($_.ProcessId -eq $PID) { return $false };",
    "  $c = $_.CommandLine; if (-not $c) { return $false };",
    "  foreach ($p in $pats) {",
    "    $i = $c.IndexOf($p, [System.StringComparison]::OrdinalIgnoreCase);",
    "    if ($i -lt 0) { continue };",
    "    $before = if ($i -gt 0) { $c.Substring($i - 1, 1) } else { ' ' };",
    "    $end = $i + $p.Length;",
    "    $after = if ($end -lt $c.Length) { $c.Substring($end, 1) } else { ' ' };",
    "    if ($before -match '[\\s\"'']' -and $after -match '[\\s\"'']') { return $true };",
    "  };",
    "  $false",
    "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join(" ");
}

/**
 * Best-effort: never throws, never reports. A wrapper that survives is handled
 * by the caller's own stop verification.
 */
export function killWindowsSchedulerWrappers(paths: {
  scriptPath: string;
  launcherPath: string;
}): void {
  if (process.platform !== "win32") return;
  try {
    spawnSync(resolveTrustedWindowsPowerShellExe(), [
      // No `-WindowStyle Hidden` here: Bun 1.3.14 can fail that direct CLI pair
      // before the command runs (#1589). `windowsHide` below is sufficient.
      "-NoProfile", "-NoLogo", "-NonInteractive",
      "-Command", windowsWrapperKillScript([paths.scriptPath, paths.launcherPath]),
    ], { stdio: "ignore", timeout: 5000, windowsHide: true });
  } catch { /* best-effort */ }
}
