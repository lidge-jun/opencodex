import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTrustedWindowsPowerShellExe } from "../../lib/windows-elevation";
import {
  acceptsPickerAuthority,
  PICKER_CA_COMMON_NAME,
  PICKER_HOST,
  pickerCaFingerprints,
} from "./picker-ca";
import type { PickerTrustState, SecurityResult } from "./picker-trust";

/** powershell.exe argv result; alias so the two trust seams never drift apart. */
export type WindowsTrustResult = SecurityResult;
/** Per-script options; fakes may ignore them, so single-arg fakes stay portable. */
export interface WindowsTrustRunnerOptions { timeoutMs?: number }

/**
 * powershell.exe argv runner. A SecurityRunner satisfies this shape so macOS-style
 * fakes stay portable. The caller in picker-trust.ts only forwards an explicitly
 * injected runner and otherwise leaves this undefined for the Windows default.
 */
export type WindowsTrustRunner = (
  args: readonly string[],
  options?: WindowsTrustRunnerOptions,
) => Promise<WindowsTrustResult>;

/** Read-only argv prefix: no profile, no logo, no interaction. Used for inspection. */
export const WINDOWS_TRUST_POWERSHELL_PREFIX = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] as const;
/** Mutating argv prefix: the OS confirmation dialog must be able to appear. */
export const WINDOWS_TRUST_POWERSHELL_INTERACTIVE_PREFIX = ["-NoLogo", "-NoProfile", "-Command"] as const;

/** Read-only inspection budget: a hung store lookup must never stall status checks. */
export const WINDOWS_TRUST_INSPECT_TIMEOUT_MS = 10_000;
/** Interactive import budget: Root installs raise the OS confirmation dialog. */
export const WINDOWS_TRUST_IMPORT_TIMEOUT_MS = 120_000;
/**
 * Removal budget stays bounded: predecessor cleanup also runs in headless migration
 * and startup paths where an OS confirmation dialog cannot be answered. A timed-out or
 * declined removal reports failure and is retried on the next explicit activation.
 */
export const WINDOWS_TRUST_UNTRUST_TIMEOUT_MS = 30_000;

const OUTPUT_LIMIT = 64 * 1024;
const TRUST_MARKER = "OCX_PICKER_TRUST=";
const SHA1_PATTERN = /^[0-9A-F]{40}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/=]*$/;

/** Uppercase hex without separators, or null. Trust matches on this, never on the CN. */
export function normalizePickerTrustSha1(value: string): string | null {
  const normalized = value.replace(/[:\s]/g, "").toUpperCase();
  return SHA1_PATTERN.test(normalized) ? normalized : null;
}

/**
 * Copy the environment minus every PSModulePath entry (case-insensitive).
 * The trust scripts are .NET-only so module autoload is pure cost and shadowing
 * risk: a PSModulePath entry can shadow resolution and stall process start on
 * hosts with a cold module cache. Nothing here needs a module.
 */
export function sanitizeWindowsPowerShellEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === "psmodulepath") continue;
    out[key] = value;
  }
  return out;
}

/**
 * Production runner: trusted System32 powershell.exe, hidden window, sanitized
 * module path, bounded runtime. Timeout and output-read errors kill the child and report code null
 * so callers map it to unknown/declined instead of hanging periodic status.
 */
export const defaultWindowsPowerShellRunner: WindowsTrustRunner = async (args, options) => {
  const timeoutMs = options?.timeoutMs ?? WINDOWS_TRUST_INSPECT_TIMEOUT_MS;
  let exe: string;
  try {
    exe = resolveTrustedWindowsPowerShellExe();
  } catch (error) {
    return { code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
  let child: { kill(): void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn([exe, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: sanitizeWindowsPowerShellEnv(),
    });
    child = proc;
    const pending = (async () => {
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { out, err, code };
    })();
    const settled = await new Promise<{ out: string; err: string; code: number } | null>((resolve, reject) => {
      timer = setTimeout(() => {
        try { child?.kill(); } catch { /* already gone */ }
        resolve(null);
      }, timeoutMs);
      pending.then(resolve, reject);
    });
    if (timer !== undefined) clearTimeout(timer);
    if (settled === null) {
      return { code: null, stdout: "", stderr: `powershell trust script timed out after ${timeoutMs}ms` };
    }
    return { code: settled.code, stdout: settled.out.slice(-OUTPUT_LIMIT), stderr: settled.err.slice(-OUTPUT_LIMIT) };
  } catch (error) {
    if (timer !== undefined) clearTimeout(timer);
    try { child?.kill(); } catch { /* already gone */ }
    return { code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
};

function base64Utf8(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/** A filesystem path carried as data, never as PowerShell syntax. */
function encodedPathExpression(path: string): string {
  const encoded = base64Utf8(path);
  if (!BASE64_PATTERN.test(encoded)) throw new Error("path encoding failed");
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`;
}

/** Interpolated constants must not carry a quote or wildcard that changes the script. */
function psLiteral(value: string, label: string): string {
  if (value.includes("'") || /[*?[\]]/.test(value)) throw new Error(`unsafe ${label} for script literal`);
  return `'${value}'`;
}

function markerOf(stdout: string): string | null {
  const line = stdout
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .find(entry => entry.startsWith(TRUST_MARKER));
  return line === undefined ? null : line.slice(TRUST_MARKER.length);
}

function currentUserRootStore(): string {
  return "New-Object Security.Cryptography.X509Certificates.X509Store('Root','CurrentUser')";
}

function subjectLikePattern(): string {
  if (PICKER_CA_COMMON_NAME.length === 0 || /['*?[\]]/.test(PICKER_CA_COMMON_NAME)) {
    throw new Error("unsafe picker CA common name for script literal");
  }
  return `'*CN=${PICKER_CA_COMMON_NAME}*'`;
}

/**
 * Inspect script: exact SHA-1 lookup in CurrentUser Root, persisted-leaf chain build
 * against that root, plus DNS-name and validity checks. Emits exactly one marker
 * line and exits 0 (trusted), 1 (untrusted) or 2 (error). Read-only: trust is never
 * added or removed here; installation happens only on explicit activation via trust.
 */
export function buildWindowsTrustInspectScript(leafPath: string, wantSha1: string): string {
  const want = normalizePickerTrustSha1(wantSha1);
  if (want === null) throw new Error("picker trust fingerprint must be 40 hex characters");
  if (leafPath.length === 0) throw new Error("picker trust leaf path must not be empty");
  const host = psLiteral(PICKER_HOST, "picker host");
  return [
    "$ErrorActionPreference='Stop'",
    `$leafFile=${encodedPathExpression(leafPath)}`,
    `$want=${psLiteral(want, "picker CA fingerprint")}`,
    `$store=${currentUserRootStore()}`,
    "$store.Open('ReadOnly')",
    "try {",
    "$found=@($store.Certificates | Where-Object { $_.Thumbprint -eq $want })",
    `if($found.Count -eq 0) { Write-Output '${TRUST_MARKER}UNTRUSTED'; exit 1 }`,
    "$ca=$found[0]",
    `if($ca.Subject -notlike ${subjectLikePattern()}) { Write-Output '${TRUST_MARKER}UNTRUSTED'; exit 1 }`,
    "$leaf=New-Object Security.Cryptography.X509Certificates.X509Certificate2($leafFile)",
    "$dns=$leaf.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::DnsName,$false)",
    `if($dns -ne ${host}) { Write-Output '${TRUST_MARKER}UNTRUSTED'; exit 1 }`,
    "$now=Get-Date",
    `if($leaf.NotBefore -gt $now -or $leaf.NotAfter -lt $now) { Write-Output '${TRUST_MARKER}UNTRUSTED'; exit 1 }`,
    `if($leaf.Issuer -ne $ca.Subject) { Write-Output '${TRUST_MARKER}UNTRUSTED'; exit 1 }`,
    "$chain=New-Object Security.Cryptography.X509Certificates.X509Chain",
    "$chain.ChainPolicy.RevocationMode=[Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck",
    "$chain.ChainPolicy.VerificationFlags=[Security.Cryptography.X509Certificates.X509VerificationFlags]::AllowUnknownCertificateAuthority",
    "$chain.ChainPolicy.ExtraStore.Add($ca) | Out-Null",
    "$built=$chain.Build($leaf)",
    "$root=$null",
    "if($chain.ChainElements.Count -gt 0) { $root=$chain.ChainElements[$chain.ChainElements.Count-1].Certificate }",
    `if($built -and ($null -ne $root) -and ($root.Thumbprint -eq $want)) { Write-Output '${TRUST_MARKER}TRUSTED'; exit 0 }`,
    `Write-Output '${TRUST_MARKER}UNTRUSTED'`,
    "exit 1",
    `} catch { Write-Output '${TRUST_MARKER}ERROR'; exit 2 } finally { $store.Close() }`,
  ].join(";");
}

/**
 * Install script: imports the snapshot file into CurrentUser Root after re-checking
 * its thumbprint inside the script. Adding to Root raises the OS confirmation
 * dialog and that user approval is the install gate; the powershell.exe process
 * itself stays hidden and only the OS dialog is ever visible.
 */
export function buildWindowsTrustInstallScript(caPath: string, wantSha1: string): string {
  const want = normalizePickerTrustSha1(wantSha1);
  if (want === null) throw new Error("picker trust fingerprint must be 40 hex characters");
  if (caPath.length === 0) throw new Error("picker trust CA path must not be empty");
  return [
    "$ErrorActionPreference='Stop'",
    `$caFile=${encodedPathExpression(caPath)}`,
    `$want=${psLiteral(want, "picker CA fingerprint")}`,
    "$cert=New-Object Security.Cryptography.X509Certificates.X509Certificate2($caFile)",
    `if($cert.Thumbprint -ne $want) { Write-Output '${TRUST_MARKER}ERROR'; exit 2 }`,
    `$store=${currentUserRootStore()}`,
    "$store.Open('ReadWrite')",
    "try {",
    "$found=@($store.Certificates | Where-Object { $_.Thumbprint -eq $want })",
    "if($found.Count -eq 0) { $store.Add($cert) }",
    `Write-Output '${TRUST_MARKER}INSTALLED'`,
    "exit 0",
    `} catch { Write-Output '${TRUST_MARKER}ERROR'; exit 2 } finally { $store.Close() }`,
  ].join(";");
}

/**
 * Remove script: deletes every Root entry with the exact thumbprint, then re-checks.
 * Removal from Root raises OS confirmation like an install, so this runs on the
 * interactive prefix with a bounded 30s budget: predecessor cleanup also runs in headless
 * removal may prompt, mirroring the macOS keychain prompt on migration cleanup.
 */
export function buildWindowsTrustRemoveScript(wantSha1: string): string {
  const want = normalizePickerTrustSha1(wantSha1);
  if (want === null) throw new Error("picker trust fingerprint must be 40 hex characters");
  return [
    "$ErrorActionPreference='Stop'",
    `$want=${psLiteral(want, "picker CA fingerprint")}`,
    "try {",
    `$store=${currentUserRootStore()}`,
    "$store.Open('ReadWrite')",
    "try { $found=@($store.Certificates | Where-Object { $_.Thumbprint -eq $want }); foreach($c in $found) { $store.Remove($c) } } finally { $store.Close() }",
    `$check=${currentUserRootStore()}`,
    "$check.Open('ReadOnly')",
    "try { $left=@($check.Certificates | Where-Object { $_.Thumbprint -eq $want });",
    `if($left.Count -eq 0) { Write-Output '${TRUST_MARKER}REMOVED'; exit 0 }`,
    `Write-Output '${TRUST_MARKER}ERROR'; exit 1 } finally { $check.Close() }`,
    `} catch { Write-Output '${TRUST_MARKER}ERROR'; exit 2 }`,
  ].join(";");
}

function powershellArgs(script: string, interactive: boolean): string[] {
  const prefix = interactive ? WINDOWS_TRUST_POWERSHELL_INTERACTIVE_PREFIX : WINDOWS_TRUST_POWERSHELL_PREFIX;
  return [...prefix, script];
}

export async function inspectPickerTrustWindows(
  leafPath: string,
  caSha1: string,
  run?: WindowsTrustRunner,
): Promise<PickerTrustState> {
  if (normalizePickerTrustSha1(caSha1) === null || leafPath.length === 0) return "untrusted";
  const exec = run ?? defaultWindowsPowerShellRunner;
  try {
    const result = await exec(powershellArgs(buildWindowsTrustInspectScript(leafPath, caSha1), false), {
      timeoutMs: WINDOWS_TRUST_INSPECT_TIMEOUT_MS,
    });
    if (result.code === 0 && markerOf(result.stdout) === "TRUSTED") return "trusted";
    if (result.code === 1 && markerOf(result.stdout) === "UNTRUSTED") return "untrusted";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function trustPickerCaWindows(
  caPath: string,
  run?: WindowsTrustRunner,
  cert?: { pem?: string },
): Promise<{ ok: boolean; reason?: "unsupported" | "declined_or_failed" }> {
  // The caller gates this on explicit activation; status and restart paths never call it.
  // The installed bytes are always a private snapshot of the authority authorized here,
  // never the shared ca.pem a same-user process could swap mid-flight.
  const exec = run ?? defaultWindowsPowerShellRunner;
  let privateDir: string | undefined;
  try {
    let pem = cert?.pem;
    if (pem === undefined) pem = readFileSync(caPath, "utf8");
    if (!acceptsPickerAuthority(pem)) return { ok: false, reason: "declined_or_failed" };
    const { sha1 } = pickerCaFingerprints(pem);
    privateDir = mkdtempSync(join(tmpdir(), "ocx-picker-ca-win-"));
    const snapshot = join(privateDir, "ca.pem");
    writeFileSync(snapshot, pem, { mode: 0o600 });
    const result = await exec(powershellArgs(buildWindowsTrustInstallScript(snapshot, sha1), true), {
      timeoutMs: WINDOWS_TRUST_IMPORT_TIMEOUT_MS,
    });
    return result.code === 0 && markerOf(result.stdout) === "INSTALLED"
      ? { ok: true }
      : { ok: false, reason: "declined_or_failed" };
  } catch {
    return { ok: false, reason: "declined_or_failed" };
  } finally {
    if (privateDir !== undefined) rmSync(privateDir, { recursive: true, force: true });
  }
}

export async function untrustPickerCaWindows(
  fingerprintSha1: string,
  run?: WindowsTrustRunner,
): Promise<{ ok: boolean }> {
  const exec = run ?? defaultWindowsPowerShellRunner;
  if (normalizePickerTrustSha1(fingerprintSha1) === null) return { ok: false };
  try {
    const result = await exec(powershellArgs(buildWindowsTrustRemoveScript(fingerprintSha1), true), {
      timeoutMs: WINDOWS_TRUST_UNTRUST_TIMEOUT_MS,
    });
    return result.code === 0 && markerOf(result.stdout) === "REMOVED" ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}
