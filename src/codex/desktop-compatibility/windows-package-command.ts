import type { DesktopAppInstall, DesktopExec, DesktopProcess } from "../desktop-app/types";
import { resolveTrustedWindowsPowerShellExe } from "../../lib/windows-elevation";
import { WINDOWS_ACTIVATION_SOURCE } from "./windows-activation-source";

/** Only the feature's loopback PAC endpoint may become a launch argument. */
export function validatedCompatibilityPacUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("desktop_compatibility_invalid_pac_url"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || Number(url.port) < 1
    || url.username || url.password || url.search || url.hash
    || !/^\/[a-zA-Z0-9-]{16,80}\/proxy\.pac$/.test(url.pathname)
    || value !== url.href) throw new Error("desktop_compatibility_invalid_pac_url");
  return url.href;
}

function literal(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

export function compatibilityActivationScript(install: DesktopAppInstall, pacUrl: string): string {
  const pac = validatedCompatibilityPacUrl(pacUrl);
  if (!/^OpenAI\.Codex(?:Beta)?_[A-Za-z0-9]+$/.test(install.id) || install.relaunch !== `${install.id}!App`) {
    throw new Error("desktop_compatibility_invalid_package");
  }
  return [
    "$ErrorActionPreference='Stop'",
    `$family=${literal(install.id)}; $root=${literal(install.root)}; $pac=${literal(pac)}`,
    `$p=Get-AppxPackage -Name ${literal(install.id.split("_")[0]!)}`,
    "$p=@($p|Where-Object {$_.PackageFamilyName -eq $family -and $_.InstallLocation -ieq $root})",
    "if($p.Count -ne 1){throw 'Package changed'}; $p=$p[0]",
    "$manifest=Get-AppxPackageManifest -Package $p.PackageFullName",
    "$entry=@($manifest.Package.Applications.Application|Where-Object {$_.Id -eq 'App' -and $_.Executable.Replace('/','\\') -ieq 'app\\ChatGPT.exe'})",
    "if($entry.Count -ne 1){throw 'Application entry changed'}",
    "Add-Type -TypeDefinition @'", WINDOWS_ACTIVATION_SOURCE, "'@",
    "$pidValue=[OpenCodexPackageActivation]::Activate($family+'!App','--proxy-pac-url='+$pac)",
    "if([OpenCodexPackageActivation]::PackageOf($pidValue) -ne $p.PackageFullName){throw 'Package identity missing'}",
    "$running=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pidValue)",
    "$expected=Join-Path $p.InstallLocation 'app\\ChatGPT.exe'",
    "if(-not $running -or $running.ExecutablePath -ine $expected -or $running.CommandLine -notmatch ('(?:^|[\\s\"])--proxy-pac-url='+[regex]::Escape($pac)+'(?:$|[\\s\"])')){throw 'Launch arguments not observed'}",
    "[pscustomobject]@{pid=[int]$pidValue;packageFullName=$p.PackageFullName;verified=$true}|ConvertTo-Json -Compress",
  ].join("\n");
}


/** Preserve only an already active managed-shape PAC, never arbitrary launch flags. */
export function captureWindowsCompatibilityContext(processes: readonly DesktopProcess[]): Record<string, string> {
  const members = new Set(processes.map(entry => entry.pid));
  const urls = new Set<string>();
  for (const entry of processes.filter(value => !members.has(value.parentPid))) {
    for (const match of (entry.commandLine ?? "").matchAll(/(?:^|\s)"?--proxy-pac-url=([^"\s]+)"?/g)) {
      const url = match[1]!;
      if (url.startsWith("http://127.0.0.1:")) urls.add(validatedCompatibilityPacUrl(url));
    }
  }
  if (urls.size > 1) throw new Error("desktop_compatibility_conflicting_launch_context");
  return urls.size === 1 ? { codexCompatibilityPacUrl: [...urls][0]! } : {};
}

export function activateWindowsCodexCompatibility(exec: DesktopExec, install: DesktopAppInstall, pacUrl: string): { pid: number; packageFullName: string } {
  const script = compatibilityActivationScript(install, pacUrl);
  const text = exec(resolveTrustedWindowsPowerShellExe(), ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 15_000, windowsHide: true });
  const result = JSON.parse(text);
  if (result.verified !== true || !Number.isSafeInteger(result.pid) || result.pid <= 0
    || typeof result.packageFullName !== "string" || !result.packageFullName.startsWith(install.id.split("_")[0]! + "_")
    || !result.packageFullName.endsWith("_" + install.id.split("_")[1]!)) throw new Error("desktop_compatibility_activation_unverified");
  return { pid: result.pid, packageFullName: result.packageFullName };
}
