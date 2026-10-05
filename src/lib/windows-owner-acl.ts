import { resolveTrustedWindowsPowerShellExe } from "./windows-elevation";

export interface WindowsPrivateEntry {
  path: string;
  directory: boolean;
}
export interface WindowsOwnerAclResult {
  success: boolean;
  timedOut: boolean;
  stdout: string | Uint8Array;
}
export type WindowsOwnerAclRunner = (entries: readonly WindowsPrivateEntry[], timeoutMs: number) => WindowsOwnerAclResult;

export const WINDOWS_OWNER_ACL_TIMEOUT_MS = 5_000;
const SID = /^S-1-\d+(?:-\d+)+$/i;
const ADMINISTRATORS = "S-1-5-32-544";
const PRIVILEGED_GRANTEES = new Set(["S-1-5-18", ADMINISTRATORS]); // LocalSystem, BUILTIN\Administrators
const PRIVATE_DACL_FLAGS = 0x1004; // DiscretionaryAclPresent | DiscretionaryAclProtected
const FULL_CONTROL = 2032127;

// This script is constant. Literal paths are environment data, never PowerShell source.
// Enumerate the descriptor Get-Acl reports. GetAccessRules projects away unsupported ACE details, so the
// ACEs are read from the serialized descriptor instead. .NET canonicalizes it first: compatible entries for the
// same principal merge and entries that grant nothing drop, but another principal's entry is never folded into
// the user's, and the owner is untouched. The policy is therefore the effective DACL, not the on-disk bytes.
const ACL_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
try {
  # ASCII has no preamble, so a UTF-8 console code page cannot prefix the protocol with a BOM.
  try { [Console]::OutputEncoding=[System.Text.Encoding]::ASCII } catch { $encodingUnchanged=$true }
  $countText=[Environment]::GetEnvironmentVariable('OCX_ACL_COUNT')
  if ($countText -notmatch '^[1-9][0-9]*$') { throw 'count' }
  $count=[int]$countText
  $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal=[System.Security.Principal.WindowsPrincipal]::new($identity)
  $administrators=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $enabled=$principal.IsInRole($administrators)
  [Console]::WriteLine(('U|{0}|{1}|{2}' -f $identity.User.Value,$identity.Owner.Value,$enabled))
  for ($i=0; $i -lt $count; $i++) {
    $path=[Environment]::GetEnvironmentVariable(('OCX_ACL_PATH_{0}' -f $i))
    if ([string]::IsNullOrEmpty($path)) { throw 'path' }
    $acls=@(Get-Acl -LiteralPath $path)
    if ($acls.Count -ne 1) { throw 'acl' }
    $bytes=$acls[0].GetSecurityDescriptorBinaryForm()
    $raw=[System.Security.AccessControl.RawSecurityDescriptor]::new([byte[]]$bytes, 0)
    $aceCount=-1
    if ($null -ne $raw.DiscretionaryAcl) { $aceCount=$raw.DiscretionaryAcl.Count }
    [Console]::WriteLine(('E|{0}|{1}|{2}|{3}' -f $i,$raw.Owner.Value,[int]$raw.ControlFlags,$aceCount))
    if ($null -ne $raw.DiscretionaryAcl) {
      foreach ($ace in $raw.DiscretionaryAcl) {
        if ($ace -is [System.Security.AccessControl.CommonAce]) {
          [Console]::WriteLine(('A|{0}|{1}|{2}|{3}|{4}|{5}' -f $i,[int]$ace.AceType,[int]$ace.AceFlags,[int]$ace.AccessMask,$ace.SecurityIdentifier.Value,$ace.IsCallback))
        } else {
          [Console]::WriteLine(('A|{0}|{1}|X' -f $i,[int]$ace.AceType))
        }
      }
    }
  }
  [Console]::WriteLine('END')
  exit 0
} catch { exit 3 }
`;
const ENCODED_ACL_SCRIPT = Buffer.from(ACL_SCRIPT, "utf16le").toString("base64");

function defaultWindowsOwnerAclRunner(entries: readonly WindowsPrivateEntry[], timeoutMs: number): WindowsOwnerAclResult {
  const env: Record<string, string | undefined> = { ...process.env, OCX_ACL_COUNT: String(entries.length) };
  for (let i = 0; i < entries.length; i++) env[`OCX_ACL_PATH_${i}`] = entries[i]!.path;
  const result = Bun.spawnSync([
    resolveTrustedWindowsPowerShellExe(), "-NoLogo", "-NoProfile", "-NonInteractive",
    "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED_ACL_SCRIPT,
  ], {
    env, stdin: "ignore", stdout: "pipe", stderr: "ignore",
    timeout: timeoutMs, windowsHide: true,
  });
  return { success: result.success, timedOut: result.exitedDueToTimeout ?? false, stdout: result.stdout ?? new Uint8Array() };
}
let ownerAclRunner: WindowsOwnerAclRunner = defaultWindowsOwnerAclRunner;
/** Test-only access to the real subprocess runner, for native diagnostics. */
export const windowsOwnerAclDefaultRunnerForTests: WindowsOwnerAclRunner = defaultWindowsOwnerAclRunner;

export function setWindowsOwnerAclRunnerForTests(runner: WindowsOwnerAclRunner | null): void {
  ownerAclRunner = runner ?? defaultWindowsOwnerAclRunner;
}

/** Pure, strict line-protocol parser and owner/effective-DACL policy. No account names or SDDL. */
export function windowsPrivateEntriesAclMatches(stdout: string | Uint8Array, entries: readonly WindowsPrivateEntry[]): boolean {
  if (entries.length === 0) return false;
  // The script emits ASCII only. Reject BOMs, NULs, non-ASCII bytes and replacement decoding.
  if (typeof stdout !== "string" && stdout.some(byte => byte > 127)) return false;
  const text = typeof stdout === "string" ? stdout : Buffer.from(stdout).toString("ascii");
  if (/[^\x20-\x7e\r\n]/.test(text)) return false;
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.includes("\r")) return false;
  const lines = (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
  if (lines.at(-1) !== "END") return false;
  const token = lines[0]!.split("|");
  if (token.length !== 4 || token[0] !== "U" || !SID.test(token[1]!) || !SID.test(token[2]!)
    || (token[3] !== "True" && token[3] !== "False")) return false;
  const user = token[1]!.toUpperCase();
  const acceptsAdministrators = token[2]!.toUpperCase() === ADMINISTRATORS && token[3] === "True";
  let at = 1;
  for (let i = 0; i < entries.length; i++) {
    const entry = (lines[at++] ?? "").split("|");
    if (entry.length !== 5 || entry[0] !== "E" || entry[1] !== String(i) || !SID.test(entry[2]!)
      || !/^(0|[1-9]\d{0,4})$/.test(entry[3]!) || !/^[1-3]$/.test(entry[4]!)) return false;
    const flags = Number(entry[3]);
    if (flags > 0xffff || (flags & PRIVATE_DACL_FLAGS) !== PRIVATE_DACL_FLAGS) return false;
    const owner = entry[2]!.toUpperCase();
    if (owner !== user && !(owner === ADMINISTRATORS && acceptsAdministrators)) return false;
    // The serving account needs its own Full Control entry. SYSTEM and Administrators may also hold plain
    // allow entries: LocalSystem and an elevated administrator can already take ownership of any object, and a
    // filtered administrator token holds Administrators only as deny-only, so the allow entry grants it nothing.
    const grantees = new Set<string>();
    for (let k = Number(entry[4]); k > 0; k--) {
      const ace = (lines[at++] ?? "").split("|");
      if (ace.length !== 7 || ace[0] !== "A" || ace[1] !== String(i) || ace[2] !== "0"
        || ace[3] !== (entries[i]!.directory ? "3" : "0") || !/^[1-9]\d{0,9}$/.test(ace[4]!)
        || !SID.test(ace[5]!) || ace[6] !== "False") return false;
      const grantee = ace[5]!.toUpperCase();
      if (grantees.has(grantee)) return false;
      grantees.add(grantee);
      if (grantee === user ? ace[4] !== String(FULL_CONTROL) : !PRIVILEGED_GRANTEES.has(grantee)) return false;
    }
    if (!grantees.has(user)) return false;
  }
  return at === lines.length - 1;
}

/** Fresh, read-only verification; runner failures never disclose paths, SIDs or ACL output. */
export function verifyWindowsPrivateEntries(entries: readonly WindowsPrivateEntry[], timeoutMs: number): boolean {
  if (entries.length === 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
  try {
    const result = ownerAclRunner(entries, Math.max(1, Math.min(WINDOWS_OWNER_ACL_TIMEOUT_MS, Math.floor(timeoutMs))));
    return result.success && !result.timedOut && windowsPrivateEntriesAclMatches(result.stdout, entries);
  } catch { return false; }
}
