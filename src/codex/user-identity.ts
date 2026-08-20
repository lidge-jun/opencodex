/**
 * Environment-independent identity and namespace resolution for Codex writes.
 *
 * Bun 1.3.14 made the obvious implementation unsafe: both `os.homedir()` and
 * `os.userInfo().homedir` follow HOME. A service and CLI for the same account
 * could therefore coordinate through different databases. The namespace is
 * keyed only by the effective uid/SID and the canonical CODEX_HOME.
 *
 * Design record: devlog/_fin/260804_codex_write_substrate/005_contract.md §7.
 */
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { resolveTrustedWindowsPowerShellExe } from "../lib/windows-elevation";

import type {
  ResolveCodexCoordinatorDatabasePath,
  ResolveCodexCatalogSerializationDatabasePath,
  ResolveCodexHistorySerializationDatabasePath,
  ResolveEffectiveUserIdentity,
  UserIdentity,
} from "./convergence-types";

const POSIX_PRIVATE_MODE = 0o700;
const POSIX_TMP_REQUIRED_MODE = 0o1003;
const POSIX_TMP_PATH = "/tmp";
const SID_PATTERN = /^S-1-(?:\d+-)+\d+$/i;

/**
 * Hard budget for the Windows identity-lookup PowerShell child. These lookups
 * run at startup and on config writes; a hung child must fail the lookup
 * (recoverable — the caller refuses) rather than wedge the proxy indefinitely.
 */
const WINDOWS_POWERSHELL_LOOKUP_TIMEOUT_MS = 8_000;

/**
 * The same budget, widened for a contended CI runner.
 *
 * 8s is a generous ceiling for `powershell.exe -Command` on a real desktop and is not one
 * on a GitHub Windows runner executing a quarter of this suite: the composed-acceptance
 * cases fail there with "Windows effective-account lookup timed out" while the child is
 * still starting. That is runner contention, not a hung lookup, and the budget exists to
 * bound the latter.
 *
 * Gated on `CI` alone. A user's machine keeps the 8s ceiling exactly as before, so the
 * recoverable-refusal contract this budget protects is unchanged where it matters.
 */
const WINDOWS_POWERSHELL_LOOKUP_TIMEOUT_CI_MS = 30_000;

function windowsIdentityLookupTimeoutMs(): number {
  return process.env.CI === "true"
    ? WINDOWS_POWERSHELL_LOOKUP_TIMEOUT_CI_MS
    : WINDOWS_POWERSHELL_LOOKUP_TIMEOUT_MS;
}

/**
 * FOLDERID_LocalAppData, and the flag that makes the lookup ignore the caller's
 * environment.
 *
 * The obvious spelling, .NET's
 * `GetFolderPath(SpecialFolder.LocalApplicationData)`, is unusable here: on
* Windows it resolves through `USERPROFILE`, and when the profile named there has
 * no local AppData directory on disk it returns an EMPTY STRING rather than an
 * error. Any
* caller that redirected `USERPROFILE` (the test sandbox does, and so does a
 * service account whose profile has not been materialized) therefore refused every
 * coordinator lookup with "returned an empty value", which is the exact
 * environment dependence this module exists to eliminate.
 *
 * `SHGetKnownFolderPath` with a null token and `KF_FLAG_DEFAULT_PATH` reads the
 * known-folder registration for the effective token instead: it returns the real
 * per-user path whether or not the directory exists, and it is unaffected by
 * `USERPROFILE`, `LOCALAPPDATA`, `HOMEDRIVE`, or `HOMEPATH`. A non-null token argument
* is NOT equivalent: passing (HANDLE)-1 resolves the DEFAULT USER profile
 * (the built-in "Default" profile), which would key coordination to a namespace
 * no real account writes to.
*/
const WINDOWS_LOCAL_APPDATA_FOLDER_ID = "F1B32785-6FBA-4FCF-9D55-7B8E7F157091";
const WINDOWS_KF_FLAG_DEFAULT_PATH = "0x00000400";

export class CodexUserIdentityRefusal extends Error {
  readonly code = "CODEX_USER_IDENTITY_REFUSED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexUserIdentityRefusal";
  }
}

function refuse(message: string, cause?: unknown): never {
  throw new CodexUserIdentityRefusal(message, cause === undefined ? undefined : { cause });
}

function windowsIdentityPowerShellCommand(expression: string): string[] {
  // PowerShell 5.1 can encode redirected native/host output with the active
  // Windows code page. Base64 contains ASCII only, while the payload is
  // explicitly UTF-16LE, so Korean and Western profile paths arrive unchanged.
  const deterministicOutput = [
    "$ErrorActionPreference = 'Stop'",
    `$ocxValue = [string](${expression})`,
    "$ocxBytes = [System.Text.Encoding]::Unicode.GetBytes($ocxValue)",
    "[Console]::Out.Write([Convert]::ToBase64String($ocxBytes))",
  ].join("; ");
  return [
    resolveTrustedWindowsPowerShellExe(),
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    deterministicOutput,
  ];
}

function windowsIdentityPowerShellSpawnOptions(): {
  stdin: "ignore";
  stdout: "pipe";
  stderr: "pipe";
  timeout: number;
  windowsHide: boolean;
} {
  return {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: windowsIdentityLookupTimeoutMs(),
    windowsHide: true,
  };
}

/** Test-only readback of the trusted executable and static arguments (#1278). */
export function windowsIdentityPowerShellCommandForTests(expression: string): string[] {
  return windowsIdentityPowerShellCommand(expression);
}

/**
 * PowerShell expression yielding the effective account's local AppData path.
 *
 * P/Invoke rather than a .NET convenience wrapper, for the reason recorded on
 * WINDOWS_LOCAL_APPDATA_FOLDER_ID: the wrapper follows `USERPROFILE` and answers
 * an empty string for a profile whose directory is absent, which is precisely
 * the environment dependence this module refuses to inherit. The type is added
 * under a unique name per process because `Add-Type` cannot redefine one.
 *
 * The whole sequence is wrapped in one `$(...)` subexpression because the caller
 * substitutes this text into `[string](<expression>)`; several statements
 * spliced in bare would close that cast's parenthesis early and fail to parse.
 */
function windowsLocalAppDataExpression(): string {
  const signature =
    '[DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern int '
    + 'SHGetKnownFolderPath(ref System.Guid id, uint flags, System.IntPtr token, out System.IntPtr path);';
  const statements = [
    `$ocxShell = Add-Type -MemberDefinition '${signature}'`
      + " -Name OcxKnownFolder -Namespace OcxIdentity -PassThru",
    `$ocxFolderId = [System.Guid]'${WINDOWS_LOCAL_APPDATA_FOLDER_ID}'`,
    "$ocxPathPtr = [System.IntPtr]::Zero",
    "$ocxHr = $ocxShell::SHGetKnownFolderPath([ref]$ocxFolderId, "
      + `${WINDOWS_KF_FLAG_DEFAULT_PATH}, [System.IntPtr]::Zero, [ref]$ocxPathPtr)`,
    "if ($ocxHr -ne 0) { throw 'SHGetKnownFolderPath failed' }",
    "try { [System.Runtime.InteropServices.Marshal]::PtrToStringUni($ocxPathPtr) }"
      + " finally { [System.Runtime.InteropServices.Marshal]::FreeCoTaskMem($ocxPathPtr) }",
  ];
  return `$(${statements.join("; ")})`;
}

/** Test-only readback of the environment-independent known-folder expression. */
export function windowsLocalAppDataExpressionForTests(): string {
  return windowsLocalAppDataExpression();
}

/** Test-only readback of the spawn options shared by the identity lookups (#1278). */
export function windowsIdentityPowerShellSpawnOptionsForTests(): ReturnType<
  typeof windowsIdentityPowerShellSpawnOptions
> {
  return windowsIdentityPowerShellSpawnOptions();
}

function decodeWindowsIdentityPowerShellOutput(output: Uint8Array): string {
  let encoded: string;
  try {
    encoded = new TextDecoder("utf-8", { fatal: true }).decode(output).trim();
  } catch (cause) {
    refuse("Windows effective-account lookup returned a malformed value.", cause);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    refuse("Windows effective-account lookup returned a malformed value.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length % 2 !== 0 || bytes.toString("base64") !== encoded) {
    refuse("Windows effective-account lookup returned a malformed value.");
  }
  return bytes.toString("utf16le").trim();
}

/** Test-only decode seam for the deterministic PowerShell output contract. */
export function decodeWindowsIdentityPowerShellOutputForTests(output: Uint8Array): string {
  return decodeWindowsIdentityPowerShellOutput(output);
}

/**
 * Per-process memo for the Windows lookups.
 *
 * Both values -- the effective token's SID and its known-folder local AppData --
 * are fixed for the lifetime of a process: neither can change without a new logon
 * token, and the lookups deliberately ignore the environment, so nothing a caller
 * does between two calls can alter the answer. Each call otherwise spawns a fresh
 * PowerShell, roughly 150ms for the SID and 310ms for the folder, and the
 * coordinator asks for both on every config write and lock acquisition. That cost
 * pushed real multi-process injection tests past their budget while proving
 * nothing: the second spawn re-derives what the first already established.
 *
 * Only successful lookups are memoized, so a transient failure cannot pin the
 * process into a permanently refusing state.
 */
const windowsIdentityValueCache = new Map<string, string>();

/** Test-only reset so a suite can force a fresh lookup. */
export function resetWindowsIdentityValueCacheForTests(): void {
  windowsIdentityValueCache.clear();
}

function powershellValue(expression: string): string {
  const memoized = windowsIdentityValueCache.get(expression);
  if (memoized !== undefined) return memoized;
  let command: string[];
  try {
    command = windowsIdentityPowerShellCommand(expression);
  } catch (cause) {
    refuse("Windows effective-account lookup could not start.", cause);
  }
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    // `windowsHide` is the popup fix (#1278): the desktop proxy parent runs
    // without a console, so a console-subsystem child spawned without
    // CREATE_NO_WINDOW gets a fresh visible console window at startup and on
    // every config write. Do not add PowerShell's `-WindowStyle Hidden` here:
    // Bun 1.3.14 can fail that direct CLI combination before the SID command
    // executes (#1589); the process-level `windowsHide` flag is sufficient.
    result = Bun.spawnSync(command, windowsIdentityPowerShellSpawnOptions());
  } catch (cause) {
    refuse("Windows effective-account lookup could not start.", cause);
  }
  if (result.exitedDueToTimeout) refuse("Windows effective-account lookup timed out.");
  if (result.exitCode !== 0) refuse("Windows effective-account lookup failed.");
  const value = decodeWindowsIdentityPowerShellOutput(result.stdout ?? Buffer.alloc(0));
  if (!value) refuse("Windows effective-account lookup returned an empty value.");
  windowsIdentityValueCache.set(expression, value);
  return value;
}

function resolveWindowsSid(): string {
  const sid = powershellValue(
    "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  );
  if (!SID_PATTERN.test(sid)) refuse("Windows effective-account lookup returned an invalid SID.");
  return sid.toUpperCase();
}

export const resolveEffectiveUserIdentity: ResolveEffectiveUserIdentity = () => {
  if (process.platform === "win32") {
    return { platform: "win32", sid: resolveWindowsSid() };
  }

  const getuid = process.getuid;
  if (typeof getuid !== "function") {
    refuse("The runtime does not expose the effective POSIX uid.");
  }
  let uid: number;
  try {
    uid = getuid.call(process);
  } catch (cause) {
    refuse("The effective POSIX uid lookup failed.", cause);
  }
  if (!Number.isSafeInteger(uid) || uid < 0) {
    refuse("The runtime returned an invalid effective POSIX uid.");
  }
  return { platform: "posix", uid };
};

function assertPrivatePosixDirectory(path: string, uid: number): void {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (cause) {
    refuse("The Codex coordinator namespace cannot be inspected.", cause);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    refuse("The Codex coordinator namespace is not a real directory.");
  }
  if (entry.uid !== uid || (entry.mode & 0o777) !== POSIX_PRIVATE_MODE) {
    refuse("The Codex coordinator namespace has unsafe ownership or permissions.");
  }
}

function ensurePrivatePosixDirectory(path: string, uid: number): void {
  try {
    mkdirSync(path, { mode: POSIX_PRIVATE_MODE });
  } catch (cause) {
    const code = cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code)
      : "";
    if (code !== "EEXIST") refuse("The Codex coordinator namespace cannot be created.", cause);
  }
  assertPrivatePosixDirectory(path, uid);
}

function resolveTrustedPosixTmp(): string {
  let realTmp: string;
  try {
    realTmp = realpathSync.native(POSIX_TMP_PATH);
    const entry = statSync(realTmp);
    if (!entry.isDirectory() || entry.uid !== 0) {
      refuse("The system temporary directory has unsafe ownership.");
    }
    if ((entry.mode & POSIX_TMP_REQUIRED_MODE) !== POSIX_TMP_REQUIRED_MODE) {
      refuse("The system temporary directory lacks sticky world write/search permissions.");
    }
  } catch (cause) {
    if (cause instanceof CodexUserIdentityRefusal) throw cause;
    refuse("The system temporary directory cannot be trusted.", cause);
  }
  return realTmp;
}

function resolvePosixRuntimeRoot(uid: number): string {
  const realTmp = resolveTrustedPosixTmp();
  const root = join(realTmp, `opencodex-runtime-v1-${uid}`);
  ensurePrivatePosixDirectory(root, uid);
  return root;
}

export type CoordinatorNamespaceProbe =
  | { readonly status: "ok"; readonly root: string }
  | { readonly status: "missing" };

/**
 * Read-only namespace probe for diagnostics (`ocx doctor`).
 *
 * Unlike the runtime resolvers, this never creates the root or the lock
 * directories: a doctor run must observe the namespace, not initialize it.
 * A missing namespace is reported as `missing` instead of refused, so a fresh
 * machine does not read as a broken one; an existing but unsafe namespace is
 * refused exactly like the creating path would refuse it.
 */
export function probeCodexCoordinatorNamespace(identity: UserIdentity): CoordinatorNamespaceProbe {
  if (identity.platform === "posix") {
    const root = join(resolveTrustedPosixTmp(), `opencodex-runtime-v1-${identity.uid}`);
    let entry;
    try {
      entry = lstatSync(root);
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause
        ? String((cause as { code?: unknown }).code)
        : "";
      if (code === "ENOENT") return { status: "missing" };
      refuse("The Codex coordinator namespace cannot be inspected.", cause);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      refuse("The Codex coordinator namespace is not a real directory.");
    }
    if (entry.uid !== identity.uid || (entry.mode & 0o777) !== POSIX_PRIVATE_MODE) {
      refuse("The Codex coordinator namespace has unsafe ownership or permissions.");
    }
    return { status: "ok", root };
  }

  if (!SID_PATTERN.test(identity.sid)) refuse("The coordinator identity contains an invalid SID.");
  const localAppData = powershellValue(windowsLocalAppDataExpression());
  if (!isAbsolute(localAppData)) refuse("Windows LocalAppData resolution returned a relative path.");
  const root = resolve(localAppData, "OpenCodex", "Runtime", "v1", identity.sid.toUpperCase());
  let entry;
  try {
    entry = lstatSync(root);
  } catch (cause) {
    const code = cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code)
      : "";
    if (code === "ENOENT") return { status: "missing" };
    refuse("The Windows coordinator namespace cannot be inspected.", cause);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    refuse("The Windows coordinator namespace is not a real directory.");
  }
  try {
    const real = realpathSync.native(root);
    if (!samePathIdentity(real, root, "win32")) {
      refuse("The Windows coordinator namespace is redirected by a junction or reparse point.");
    }
    return { status: "ok", root: real };
  } catch (cause) {
    if (cause instanceof CodexUserIdentityRefusal) throw cause;
    refuse("The Windows coordinator namespace cannot be resolved.", cause);
  }
}

function resolveWindowsRuntimeRoot(identity: Extract<UserIdentity, { platform: "win32" }>): string {
  if (!SID_PATTERN.test(identity.sid)) refuse("The coordinator identity contains an invalid SID.");
  const localAppData = powershellValue(windowsLocalAppDataExpression());
  if (!isAbsolute(localAppData)) refuse("Windows LocalAppData resolution returned a relative path.");

  // The SID and known-folder values come from the effective token/.NET OS APIs,
  // never USERPROFILE or LOCALAPPDATA. WP11 adds descriptor/reparse/ACL checks at
  // the stable-database open boundary where those checks can cover SQLite too.
  const root = resolve(localAppData, "OpenCodex", "Runtime", "v1", identity.sid.toUpperCase());
  try {
    mkdirSync(root, { recursive: true });
  } catch (cause) {
    refuse("The Windows coordinator namespace cannot be created.", cause);
  }
  // Canonicalize before anything is keyed on the path: a junctioned or
  // differently-cased LocalAppData must land on ONE namespace, or two processes
  // that share the real directory would build different lock paths and never
  // contend. The lock modules also compare this path against realpath, so a
  // non-canonical spelling here would read as "unsafe" on every acquisition.
  //
  // Canonicalizing must only ever fold spelling (case, separators). If the
  // realpath lands somewhere else entirely, a component of the namespace is a
  // junction/reparse redirect; accepting the target would convert the old
  // refusal into silently opening the redirected location, so refuse instead.
  try {
    const real = realpathSync.native(root);
    if (!samePathIdentity(real, root, "win32")) {
      refuse("The Windows coordinator namespace is redirected by a junction or reparse point.");
    }
    return real;
  } catch (cause) {
    if (cause instanceof CodexUserIdentityRefusal) throw cause;
    refuse("The Windows coordinator namespace cannot be resolved.", cause);
  }
}

/**
 * Windows path identity is case-insensitive; everywhere else it is exact.
 *
 * The lock modules compare a requested lock path against its own realpath, and
 * byte equality refuses legitimate Windows spellings (drive-letter case, mixed
 * component casing) as "unsafe". This is the same semantics
 * `history-provider.ts` already applies to manifest paths; the platform
 * argument exists so both branches are testable on any host.
 */
export function samePathIdentity(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export const resolveCodexCoordinatorDatabasePath: ResolveCodexCoordinatorDatabasePath = (
  identity,
  canonicalCodexHome,
) => {
  if (!isAbsolute(canonicalCodexHome)) {
    refuse("The canonical CODEX_HOME must be an absolute path.");
  }
  const root = identity.platform === "posix"
    ? resolvePosixRuntimeRoot(identity.uid)
    : resolveWindowsRuntimeRoot(identity);
  const locks = join(root, "native-write-locks");
  if (identity.platform === "posix") ensurePrivatePosixDirectory(locks, identity.uid);
  else {
    try {
      mkdirSync(locks, { recursive: true });
    } catch (cause) {
      refuse("The Windows coordinator lock directory cannot be created.", cause);
    }
  }

  const homeDigest = createHash("sha256").update(canonicalCodexHome).digest("hex");
  return join(locks, `${homeDigest}.sqlite`);
};

/**
 * K's FINAL database path. Never the native coordinator path.
 *
 * Catalog serialization is a different ownership surface from the native
 * coordinator N: `K -> C` is a legal order and `N -> K` nests, so sharing one
 * database would make the required nesting self-contend. The two live in
 * sibling directories under the same per-user runtime root — same identity
 * namespace, same environment-independent parent, distinct exclusion.
 *
 * Consumers use the returned path verbatim and append nothing
 * (`005_contract.md:1256-1330`).
 */
export const resolveCodexCatalogSerializationDatabasePath:
  ResolveCodexCatalogSerializationDatabasePath = (identity, canonicalCodexHome) => {
    if (!isAbsolute(canonicalCodexHome)) {
      refuse("The canonical CODEX_HOME must be an absolute path.");
    }
    const root = identity.platform === "posix"
      ? resolvePosixRuntimeRoot(identity.uid)
      : resolveWindowsRuntimeRoot(identity);
    const locks = join(root, "catalog-write-locks");
    if (identity.platform === "posix") ensurePrivatePosixDirectory(locks, identity.uid);
    else {
      try {
        mkdirSync(locks, { recursive: true });
      } catch (cause) {
        refuse("The Windows catalog serialization directory cannot be created.", cause);
      }
    }

    const homeDigest = createHash("sha256").update(canonicalCodexHome).digest("hex");
    return join(locks, `${homeDigest}.sqlite`);
  };

/**
 * H's FINAL database path.
 *
 * Keyed by the canonical state DB in addition to the canonical home, unlike N and
 * K. One `CODEX_HOME` can name a different `state_5.sqlite` — `model_catalog_json`
 * has the same shape of indirection for catalogs — and two operations against
 * different history databases are not the same exclusion. Hashing only the home
 * would serialize them together, and hashing the raw request path would let two
 * spellings of one database take different locks.
 */
export const resolveCodexHistorySerializationDatabasePath:
  ResolveCodexHistorySerializationDatabasePath = (
    identity,
    canonicalCodexHome,
    canonicalStateDbPath,
  ) => {
    if (!isAbsolute(canonicalCodexHome)) {
      refuse("The canonical CODEX_HOME must be an absolute path.");
    }
    if (!isAbsolute(canonicalStateDbPath)) {
      refuse("The canonical Codex state database must be an absolute path.");
    }
    const root = identity.platform === "posix"
      ? resolvePosixRuntimeRoot(identity.uid)
      : resolveWindowsRuntimeRoot(identity);
    const locks = join(root, "history-write-locks");
    if (identity.platform === "posix") ensurePrivatePosixDirectory(locks, identity.uid);
    else {
      try {
        mkdirSync(locks, { recursive: true });
      } catch (cause) {
        refuse("The Windows history serialization directory cannot be created.", cause);
      }
    }

    // Both components are length-prefixed so no pair of (home, stateDb) values can
    // collide by concatenation.
    const digest = createHash("sha256")
      .update(`${canonicalCodexHome.length}:${canonicalCodexHome}`)
      .update(`${canonicalStateDbPath.length}:${canonicalStateDbPath}`)
      .digest("hex");
    return join(locks, `${digest}.sqlite`);
  };
