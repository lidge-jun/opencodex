import { resolveTrustedWindowsPowerShellExe } from "./windows-elevation";
import { waitForSubprocessExit } from "./bounded-subprocess";

export interface WindowsPrivateEntry {
  path: string;
  directory: boolean;
}
/**
 * Per-entry verification policy for {@link windowsEntriesAclMatches}.
 *
 * - "private" (default): the exact hardened-object rule — protected DACL, owner is the
 *   serving token (or Administrators only for an enabled elevated owner), and the only
 *   grantees are the token user with Full Control plus SYSTEM/Administrators.
 * - "write-private": the POSIX mode&022==0 analog for objects we did NOT create — the
 *   serving token or a kernel-equivalent owner (SYSTEM, Administrators, TrustedInstaller)
 *   must own the object, and no grantee outside the trusted write set may hold write,
 *   create, delete or DACL/owner control. Read grants to anyone are fine.
 * - "trusted-ancestry": the POSIX uid∈{euid,0} + non-shared-writable ancestor analog.
 *   The owner must be the serving token or a kernel-equivalent owner (SYSTEM,
 *   Administrators, TrustedInstaller — each can already take ownership of any object,
 *   so an ACL entry grants them nothing they lack). Untrusted grantees get read access
 *   only, except that an admin-owned ancestor may grant broad create-only rights
 *   (FILE_ADD_FILE / FILE_ADD_SUBDIRECTORY without delete or write-existing): that is
 *   the closest NTFS analog of a root-owned sticky directory such as C:\, whose stock
 *   ACL grants Authenticated Users add-subdirectory while refusing every other write.
 */
export type WindowsAclPolicy = "private" | "write-private" | "trusted-ancestry";
export interface WindowsAclEntry extends WindowsPrivateEntry {
  readonly policy?: WindowsAclPolicy;
}
export interface WindowsOwnerAclResult {
  success: boolean;
  timedOut: boolean;
  stdout: string | Uint8Array;
}
export type WindowsOwnerAclRunner = (entries: readonly WindowsPrivateEntry[], timeoutMs: number) => WindowsOwnerAclResult;
export type WindowsOwnerAclAsyncRunner = (entries: readonly WindowsAclEntry[], timeoutMs: number) => Promise<WindowsOwnerAclResult>;

export const WINDOWS_OWNER_ACL_TIMEOUT_MS = 5_000;
const SID = /^S-1-\d+(?:-\d+)+$/i;
const ADMINISTRATORS = "S-1-5-32-544";
const PRIVILEGED_GRANTEES = new Set(["S-1-5-18", ADMINISTRATORS]); // LocalSystem, BUILTIN\Administrators
const PRIVATE_DACL_FLAGS = 0x1004; // DiscretionaryAclPresent | DiscretionaryAclProtected
const FULL_CONTROL = 2032127;
/** TrustedInstaller owns Windows component trees; it can already take ownership of any object. */
const TRUSTED_INSTALLER = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
/** Grantees a confined/ancestor policy treats as capable of anything already. */
const TRUSTED_WRITE_SIDS = new Set(["S-1-5-18", ADMINISTRATORS, TRUSTED_INSTALLER]);
/** Owners acceptable for an ancestor (POSIX uid 0 analogs). */
const TRUSTED_ANCESTOR_OWNERS = new Set(["S-1-5-18", ADMINISTRATORS, TRUSTED_INSTALLER]);
/** Admin-owned ancestors may carry broad create-only grants (the C:\ Authenticated-Users pattern). */
const STICKY_OWNERS = TRUSTED_ANCESTOR_OWNERS;

// Access-mask bits (unsigned 32-bit). Read-side grants any entry may hold without
// weakening confinement; create bits only a trusted-owner ancestor may share broadly;
// everything else counts as write and is confined to the trusted set.
const READ_MASK = 0x80000000 /* GENERIC_READ */ | 0x20000000 /* GENERIC_EXECUTE */
  | 0x100000 /* SYNCHRONIZE */ | 0x20000 /* READ_CONTROL */
  | 0x80 /* FILE_READ_ATTRIBUTES */ | 0x20 /* FILE_EXECUTE/TRAVERSE */
  | 0x8 /* FILE_READ_EA */ | 0x1 /* FILE_READ_DATA/LIST */;
const CREATE_MASK = 0x4 /* FILE_APPEND_DATA/ADD_SUBDIRECTORY */ | 0x2 /* FILE_WRITE_DATA/ADD_FILE */;
const INHERIT_ONLY_ACE = 0x8;

// This script is constant. Literal paths are environment data, never PowerShell source.
// Read the descriptor through .NET (Owner, Group and Access, as Get-Acl does). Get-Acl is a module-autoloaded
// cmdlet: PowerShell 5.1 resolves it through the per-profile module analysis cache, and with a fresh or
// redirected LOCALAPPDATA that rebuild scans every PSModulePath module and can outlast the inspection budget
// (hosted Windows runners: the pairing CLI timed out at 30 s). Every call below is a .NET member, so nothing
// autoloads and no module on PSModulePath can shadow the read. GetAccessRules projects away unsupported ACE details, so the
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
  $sections=[System.Security.AccessControl.AccessControlSections]'Owner,Group,Access'
  for ($i=0; $i -lt $count; $i++) {
    if ([Environment]::GetEnvironmentVariable('OCX_ACL_STDIN') -eq '1') {
      $path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))
    } else { $path=[Environment]::GetEnvironmentVariable(('OCX_ACL_PATH_{0}' -f $i)) }
    if ([string]::IsNullOrEmpty($path)) { throw 'path' }
    if ([System.IO.Directory]::Exists($path)) { $acl=[System.Security.AccessControl.DirectorySecurity]::new($path, $sections) }
    else { $acl=[System.Security.AccessControl.FileSecurity]::new($path, $sections) }
    $acls=@($acl)
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
  const env: Record<string, string | undefined> = { ...process.env, OCX_ACL_COUNT: String(entries.length), OCX_ACL_STDIN: "0" };
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

/** Parsed ACE record; opaque marks the four-field non-CommonAce marker the policy cannot evaluate. */
interface ParsedAce {
  readonly opaque: boolean;
  readonly type: number | null;
  readonly flags: number | null;
  readonly mask: number | null;
  readonly sid: string | null;
  readonly callback: boolean | null;
  readonly malformed: boolean;
  readonly raw: readonly string[];
}
interface ParsedEntry {
  readonly owner: string;
  readonly controlFlags: number;
  /** null when the object reported a NULL DACL, which grants Everyone full access. */
  readonly aces: readonly ParsedAce[] | null;
}
interface ParsedAclRun {
  readonly user: string;
  readonly acceptsAdministrators: boolean;
  readonly entries: readonly (ParsedEntry | null)[];
}

/** Shared strict line-protocol parser; per-entry ACE semantics live in the policies. */
function parseAclProtocol(stdout: string | Uint8Array, count: number): ParsedAclRun | null {
  if (count <= 0) return null;
  // The script emits ASCII only. Reject BOMs, NULs, non-ASCII bytes and replacement decoding.
  if (typeof stdout !== "string" && stdout.some(byte => byte > 127)) return null;
  const text = typeof stdout === "string" ? stdout : Buffer.from(stdout).toString("ascii");
  if (/[^\x20-\x7e\r\n]/.test(text)) return null;
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.includes("\r")) return null;
  const lines = (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
  if (lines.at(-1) !== "END") return null;
  const token = lines[0]!.split("|");
  if (token.length !== 4 || token[0] !== "U" || !SID.test(token[1]!) || !SID.test(token[2]!)
    || (token[3] !== "True" && token[3] !== "False")) return null;
  const entries: (ParsedEntry | null)[] = [];
  let at = 1;
  for (let i = 0; i < count; i++) {
    const entry = (lines[at++] ?? "").split("|");
    // ACE count is unbounded for confined policies: ancestors legitimately carry many entries.
    // -1 is the NULL-DACL marker (no ACE lines follow); the private policy still refuses it below.
    if (entry.length !== 5 || entry[0] !== "E" || entry[1] !== String(i) || !SID.test(entry[2]!)
      || !/^(0|[1-9]\d{0,4})$/.test(entry[3]!) || !/^(-1|0|[1-9]\d{0,3})$/.test(entry[4]!)) return null;
    const owner = entry[2]!.toUpperCase();
    const controlFlags = Number(entry[3]);
    const aceCount = Number(entry[4]);
    if (aceCount === -1) {
      // NULL DACL: the script emits count -1 and no ACE lines. It grants Everyone full access.
      entries.push({ owner, controlFlags, aces: null });
      continue;
    }
    const aces: ParsedAce[] = [];
    for (let k = 0; k < aceCount; k++) {
      const raw = (lines[at++] ?? "").split("|");
      if (raw.length === 4 && raw[0] === "A" && raw[1] === String(i) && raw[3] === "X" && /^\d+$/.test(raw[2]!)) {
        aces.push({ opaque: true, type: Number(raw[2]), flags: null, mask: null, sid: null, callback: null, malformed: false, raw });
      } else if (raw.length === 7 && raw[0] === "A" && raw[1] === String(i) && /^-?\d+$/.test(raw[2]!)
        && /^\d+$/.test(raw[3]!) && /^-?\d+$/.test(raw[4]!) && SID.test(raw[5]!)
        && (raw[6] === "True" || raw[6] === "False")) {
        aces.push({ opaque: false, type: Number(raw[2]), flags: Number(raw[3]), mask: Number(raw[4]),
          sid: raw[5]!.toUpperCase(), callback: raw[6] === "True", malformed: false, raw });
      } else {
        aces.push({ opaque: false, type: null, flags: null, mask: null, sid: null, callback: null, malformed: true, raw });
      }
    }
    entries.push({ owner, controlFlags, aces });
  }
  if (at !== lines.length - 1) return null;
  return { user: token[1]!.toUpperCase(),
    acceptsAdministrators: token[2]!.toUpperCase() === ADMINISTRATORS && token[3] === "True",
    entries };
}

/** The exact hardened-object policy; unchanged by the shared parser. */
function privateEntryOk(entry: ParsedEntry | null, directory: boolean, run: ParsedAclRun): boolean {
  if (!entry || entry.aces === null) return false;
  const flags = entry.controlFlags;
  if (flags > 0xffff || (flags & PRIVATE_DACL_FLAGS) !== PRIVATE_DACL_FLAGS) return false;
  const owner = entry.owner;
  const user = run.user;
  if (owner !== user && !(owner === ADMINISTRATORS && run.acceptsAdministrators)) return false;
  // The serving account needs its own Full Control entry. SYSTEM and Administrators may also hold plain
  // allow entries: LocalSystem and an elevated administrator can already take ownership of any object, and a
  // filtered administrator token holds Administrators only as deny-only, so the allow entry grants it nothing.
  const grantees = new Set<string>();
  for (const ace of entry.aces) {
    if (ace.opaque || ace.malformed || ace.raw.length !== 7 || ace.raw[2] !== "0"
      || ace.raw[3] !== (directory ? "3" : "0") || !/^[1-9]\d{0,9}$/.test(ace.raw[4]!)
      || ace.callback !== false) return false;
    const grantee = ace.sid!;
    if (grantees.has(grantee)) return false;
    grantees.add(grantee);
    if (grantee === user ? ace.raw[4] !== String(FULL_CONTROL) : !PRIVILEGED_GRANTEES.has(grantee)) return false;
  }
  return grantees.has(user);
}

/**
 * Confined-write and trusted-ancestry policies for objects this process did not create.
 *
 * Deny ACEs are permitted because they can only remove access; allow ACEs must be
 * ordinary non-callback CommonAce entries. Inherit-only ACEs are skipped: they are
 * templates for children, and every object this module protects carries its own
 * hardened protected DACL, so an ancestor's template cannot grant anything inside it.
 */
function confinedEntryOk(entry: ParsedEntry | null, run: ParsedAclRun, policy: WindowsAclPolicy): boolean {
  if (!entry || entry.aces === null || (entry.controlFlags & 0x4 /* SE_DACL_PRESENT */) === 0) return false;
  const owner = entry.owner;
  // Trusted ownership is independent of this token's elevation state: the owner
  // controls the DACL, and a kernel-equivalent owner can already take ownership of
  // any object, so accepting it grants nothing. A filtered token must still pass
  // an Administrators-owned profile parent — gating on acceptsAdministrators
  // would refuse the identical, legitimate directory when run non-elevated.
  const owned = owner === run.user || TRUSTED_ANCESTOR_OWNERS.has(owner);
  if (!owned) return false;
  for (const ace of entry.aces) {
    if (ace.malformed || ace.opaque || ace.callback === true || ace.type === null) return false;
    if (ace.type === 1) continue; // ACCESS_DENIED: removes access, never grants it.
    if (ace.type !== 0) return false; // only ACCESS_ALLOWED records can be evaluated.
    if (ace.flags === null || ace.mask === null || ace.sid === null) return false;
    if ((ace.flags & INHERIT_ONLY_ACE) !== 0) continue;
    if (ace.sid === run.user || TRUSTED_WRITE_SIDS.has(ace.sid)) continue;
    const createOk = policy === "trusted-ancestry" && STICKY_OWNERS.has(owner) ? CREATE_MASK : 0;
    const allowed = (READ_MASK | createOk) >>> 0;
    if (((ace.mask >>> 0) & ~allowed) !== 0) return false;
  }
  return true;
}

/** Pure, strict line-protocol parser and owner/effective-DACL policy. No account names or SDDL. */
export function windowsPrivateEntriesAclMatches(stdout: string | Uint8Array, entries: readonly WindowsPrivateEntry[]): boolean {
  if (entries.length === 0) return false;
  const run = parseAclProtocol(stdout, entries.length);
  if (!run) return false;
  return entries.every((entry, index) => privateEntryOk(run.entries[index] ?? null, entry.directory, run));
}

/**
 * Mixed-policy evaluation for a batch of entries, each defaulting to "private".
 * One PowerShell read covers the whole chain (ancestors, config root, store objects)
 * so the ACL snapshot is taken once per operation phase, not per path.
 */
export function windowsEntriesAclMatches(stdout: string | Uint8Array, entries: readonly WindowsAclEntry[]): boolean {
  if (entries.length === 0) return false;
  const run = parseAclProtocol(stdout, entries.length);
  if (!run) return false;
  return entries.every((entry, index) => {
    const policy = entry.policy ?? "private";
    return policy === "private" ? privateEntryOk(run.entries[index] ?? null, entry.directory, run)
      : confinedEntryOk(run.entries[index] ?? null, run, policy);
  });
}

/** Fresh, read-only verification; runner failures never disclose paths, SIDs or ACL output. */
export function verifyWindowsPrivateEntries(entries: readonly WindowsPrivateEntry[], timeoutMs: number): boolean {
  if (entries.length === 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
  try {
    const result = ownerAclRunner(entries, Math.max(1, Math.min(WINDOWS_OWNER_ACL_TIMEOUT_MS, Math.floor(timeoutMs))));
    return result.success && !result.timedOut && windowsPrivateEntriesAclMatches(result.stdout, entries);
  } catch { return false; }
}

/**
 * Async counterpart of the sync runner: the PowerShell read is identical, but the
 * caller's event loop is not held while waiting. This read-only lookup opts out of the
 * post-kill reap wait (`waitForSubprocessExit(..., 0)`: see the helper contract below):
 * on timeout it requests termination and returns `timedOut` without waiting for the
 * kernel to release the child's handles. The late exit/result is ignored and stdout is
 * not read. A stalled Get-Acl child may transiently touch owner, lock or ledger files
 * and keep them busy (for example, causing a markDelete to fail) until the OS reaps it.
 * This bounded availability risk avoids an unbounded caller stall; verification fails
 * closed.
 */
async function defaultWindowsOwnerAclAsyncRunner(
  entries: readonly WindowsAclEntry[],
  timeoutMs: number,
): Promise<WindowsOwnerAclResult> {
  // Whole-tree batches must not overflow Windows' environment block with paths.
  // Base64 lines are data on stdin; no candidate text is PowerShell source.
  const env: Record<string, string | undefined> = { ...process.env, OCX_ACL_COUNT: String(entries.length), OCX_ACL_STDIN: "1" };
  const input = Buffer.from(entries.map(entry => Buffer.from(entry.path, "utf8").toString("base64")).join("\n") + "\n");
  let proc;
  try {
    proc = Bun.spawn([
      resolveTrustedWindowsPowerShellExe(), "-NoLogo", "-NoProfile", "-NonInteractive",
      "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED_ACL_SCRIPT,
    ], {
      env, stdin: input, stdout: "pipe", stderr: "ignore", windowsHide: true,
    });
  } catch {
    return { success: false, timedOut: false, stdout: new Uint8Array() };
  }
  // No post-kill reap wait: that wait exists for children whose still-open handles
  // gate a later removal (the icacls hardening case). This lookup holds no path it
  // must release for the caller's own writes, but its transient Get-Acl handle can
  // touch the verified owner, lock or ledger files, so abandoning a stalled child
  // is not free: while it lingers it can refuse a markDelete and leave the lock
  // busy until the kernel reaps it. That residual availability cost beats an
  // unbounded caller stall — the verdict stays timedOut, the late result is never
  // read, and the runner fails closed. windows-user-principal.ts opts out the
  // same way for its read-only lookup.
  // Drain while the verifier runs. A whole npm tree can fill the pipe before
  // exit; waiting for exit first turns a valid batch into an artificial timeout.
  const reading = proc.stdout ? new Response(proc.stdout).text().catch(() => "") : Promise.resolve("");
  const { exitCode, timedOut } = await waitForSubprocessExit(proc, timeoutMs, 0);
  const stdout = !timedOut ? await reading : "";
  return { success: !timedOut && exitCode === 0, timedOut, stdout };
}
let ownerAclAsyncRunner: WindowsOwnerAclAsyncRunner = defaultWindowsOwnerAclAsyncRunner;

export function setWindowsOwnerAclAsyncRunnerForTests(runner: WindowsOwnerAclAsyncRunner | null): void {
  ownerAclAsyncRunner = runner ?? defaultWindowsOwnerAclAsyncRunner;
}

/** Async mixed-policy verification; runner failures never disclose paths, SIDs or ACL output. */
export async function verifyWindowsEntriesAclAsync(entries: readonly WindowsAclEntry[], timeoutMs: number): Promise<boolean> {
  if (entries.length === 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
  try {
    const result = await ownerAclAsyncRunner(entries, Math.max(1, Math.min(WINDOWS_OWNER_ACL_TIMEOUT_MS, Math.floor(timeoutMs))));
    return result.success && !result.timedOut && windowsEntriesAclMatches(result.stdout, entries);
  } catch { return false; }
}
/** Async private-only verification for hardening paths that must yield; every entry uses the "private" policy. */
export async function verifyWindowsPrivateEntriesAsync(entries: readonly WindowsPrivateEntry[], timeoutMs: number): Promise<boolean> {
  return verifyWindowsEntriesAclAsync(entries.map(({ path, directory }) => ({ path, directory, policy: "private" as const })), timeoutMs);
}

/** Synchronous admission/commit boundaries use the identical mixed-policy parser. */
export function verifyWindowsEntriesAcl(entries: readonly WindowsAclEntry[], timeoutMs: number): boolean {
  if (entries.length === 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
  try {
    const result = ownerAclRunner(entries, Math.max(1, Math.min(WINDOWS_OWNER_ACL_TIMEOUT_MS, Math.floor(timeoutMs))));
    return result.success && !result.timedOut && windowsEntriesAclMatches(result.stdout, entries);
  } catch { return false; }
}
