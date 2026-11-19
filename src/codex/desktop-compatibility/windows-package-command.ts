import type { DesktopAppInstall, DesktopAsyncExec, DesktopExec, DesktopProcess } from "../desktop-app/types";
import { READ_WINDOWS_DESKTOP_PAYLOAD, windowsDesktopPayloadEnv } from "../desktop-app/windows-command-payload";
import { resolveTrustedWindowsPowerShellExe } from "../../lib/windows-elevation";
import { WINDOWS_ACTIVATION_SOURCE } from "./windows-activation-source";
import { readDesktopCompatibilityLaunch } from "./runtime-ownership";
import type { VerifiedDesktopPackage } from "./installed-build";
import { CLOSE_WINDOWS_PACKAGE_FILES, CODEX_PACKAGE_FAMILY, MEASURE_WINDOWS_PACKAGE_FILES,
  OPEN_WINDOWS_PACKAGE_FILES, WINDOWS_PACKAGE_PROOF_FUNCTIONS } from "./windows-package-proof";

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

export const WINDOWS_COMPATIBILITY_ACTIVATION_SCRIPT = [
    WINDOWS_PACKAGE_PROOF_FUNCTIONS,
    READ_WINDOWS_DESKTOP_PAYLOAD,
    "Add-Type -TypeDefinition @'", WINDOWS_ACTIVATION_SOURCE, "'@",
    "$family=$payload.family; $root=$payload.root; $pac=$payload.pac; $fullName=$payload.fullName",
    "$hash=$payload.hash; $manifestHash=$payload.manifestHash; $ancestryHash=$payload.ancestryHash; $thumbprint=$payload.thumbprint",
    "$imageIdentity=$payload.imageIdentity",
    "$p=Get-DesktopPackage",
    "if($p.PackageFullName -cne $fullName -or $p.InstallLocation -ine $root){throw 'Verified package changed before launch'}",
    "try {",
    OPEN_WINDOWS_PACKAGE_FILES,
    MEASURE_WINDOWS_PACKAGE_FILES,
    "if($executableHash -cne $hash -or $executableIdentity -cne $imageIdentity -or $digest -cne $manifestHash -or $ancestry -cne $ancestryHash -or $signature.SignerCertificate.Thumbprint -cne $thumbprint){throw 'Verified package files changed before launch'}",
    "$pidValue=[OpenCodexPackageActivation]::Activate($family+'!App','--proxy-pac-url='+$pac)",
    "$processHandle=[OpenCodexPackageActivation]::OpenActivatedProcess($pidValue)",
    "try {",
    "$image=[OpenCodexPackageActivation]::ImageOf($processHandle,$fullName)",
    "$running=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pidValue)",
    String.raw`if(-not $running -or $image -ine $exePath -or $running.ExecutablePath -ine $image -or $running.CommandLine -notmatch ('(?:^|[\s"])--proxy-pac-url='+[regex]::Escape($pac)+'(?:$|[\s"])')){throw 'Launch arguments or image not observed'}`,
    "Assert-DesktopPackageFiles",
    // The process's kernel-reported image path must name the still-held, verified file.
    "$imageHash=Get-DesktopPackageHash $exeStream",
    "if($imageHash -cne $hash){throw 'Activated image digest changed'}",
    "[pscustomobject]@{pid=[int]$pidValue;packageFullName=$fullName;executableHash=$imageHash;verified=$true}|ConvertTo-Json -Compress",
    "} finally {$processHandle.Dispose()}",
    "} finally {", CLOSE_WINDOWS_PACKAGE_FILES, "}",
  ].join("\n");

function matchesInstall(build: VerifiedDesktopPackage, install: DesktopAppInstall): boolean {
  return build.id === install.id && build.relaunch === install.relaunch && build.root.toLowerCase() === install.root.toLowerCase();
}

/** Preserve only the current runtime's PAC and lifetime, never trust a URL shape alone. */
export function captureWindowsCompatibilityContext(processes: readonly DesktopProcess[], install: DesktopAppInstall): Record<string, string> {
  const members = new Set(processes.map(entry => entry.pid));
  const urls = new Set<string>();
  for (const entry of processes.filter(value => !members.has(value.parentPid))) {
    if (entry.commandLine !== undefined && entry.commandLine.trim() === "") {
      throw new Error("desktop_compatibility_launch_context_unavailable");
    }
    for (const match of (entry.commandLine ?? "").matchAll(/(?:^|\s)"?--proxy-pac-url=([^"\s]+)"?/g)) {
      const url = match[1]!;
      if (url.startsWith("http://127.0.0.1:")) urls.add(validatedCompatibilityPacUrl(url));
    }
  }
  if (urls.size > 1) throw new Error("desktop_compatibility_conflicting_launch_context");
  if (urls.size === 0) return {};
  const pacUrl = [...urls][0]!, owner = readDesktopCompatibilityLaunch();
  if (!owner || owner.pacUrl !== pacUrl || !matchesInstall(owner.build, install)) {
    throw new Error("desktop_compatibility_launch_owner_unverified");
  }
  return { codexCompatibilityPacUrl: pacUrl, codexCompatibilityGeneration: owner.generation, codexCompatibilityBuildRevision: String(owner.revision) };
}

/** Recheck after the asynchronous stop ladder: identical endpoints can belong to a new runtime. */
export function assertWindowsCompatibilityContext(context: Record<string, string>, install: DesktopAppInstall) {
  const owner = readDesktopCompatibilityLaunch();
  if (!owner || owner.pacUrl !== context.codexCompatibilityPacUrl || owner.generation !== context.codexCompatibilityGeneration
    || String(owner.revision) !== context.codexCompatibilityBuildRevision || !matchesInstall(owner.build, install)) {
    throw new Error("desktop_compatibility_launch_owner_unverified");
  }
  return owner;
}

function activationEnvironment(build: VerifiedDesktopPackage, pacUrl: string) {
  const pac = validatedCompatibilityPacUrl(pacUrl);
  if (build.id !== CODEX_PACKAGE_FAMILY || build.relaunch !== `${build.id}!App`) {
    throw new Error("desktop_compatibility_invalid_package");
  }
  return windowsDesktopPayloadEnv({ family: build.id, root: build.root, pac, fullName: build.packageFullName,
    hash: build.executableHash, manifestHash: build.manifestDigest, ancestryHash: build.ancestryIdentity,
    thumbprint: build.signerThumbprint, imageIdentity: build.executableIdentity });
}

export function activateWindowsCodexCompatibility(exec: DesktopExec, build: VerifiedDesktopPackage, pacUrl: string): { pid: number; packageFullName: string } {
  const env = activationEnvironment(build, pacUrl);
  let text: string;
  try { text = exec(resolveTrustedWindowsPowerShellExe(), ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_COMPATIBILITY_ACTIVATION_SCRIPT],
    { timeout: 15_000, windowsHide: true, env }); }
  catch { throw new Error("desktop_compatibility_activation_unverified"); }
  return parseActivationResult(text, build);
}

export async function activateWindowsCodexCompatibilityAsync(exec: DesktopAsyncExec, build: VerifiedDesktopPackage,
  pacUrl: string, signal?: AbortSignal): Promise<{ pid: number; packageFullName: string }> {
  const env = activationEnvironment(build, pacUrl);
  let text: string;
  try { text = await exec(resolveTrustedWindowsPowerShellExe(), ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_COMPATIBILITY_ACTIVATION_SCRIPT],
    { timeout: 15_000, windowsHide: true, env, signal }); }
  catch { throw new Error("desktop_compatibility_activation_unverified"); }
  if (signal?.aborted) throw new Error("desktop_compatibility_activation_unverified");
  return parseActivationResult(text, build);
}

function parseActivationResult(text: string, build: VerifiedDesktopPackage): { pid: number; packageFullName: string } {
  let result: unknown;
  try { result = JSON.parse(text.trim().split(/\r?\n/).at(-1) ?? ""); }
  catch { throw new Error("desktop_compatibility_activation_unverified"); }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("desktop_compatibility_activation_unverified");
  const value = result as Record<string, unknown>;
  if (value.verified !== true || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
    || value.packageFullName !== build.packageFullName || value.executableHash !== build.executableHash) {
    throw new Error("desktop_compatibility_activation_unverified");
  }
  return { pid: Number(value.pid), packageFullName: build.packageFullName };
}
