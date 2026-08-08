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
import { dlopen, ptr, type Pointer } from "bun:ffi";

import { resolveTrustedWindowsWhoamiExe } from "../lib/windows-elevation";
import { parseWindowsSidFromWhoami } from "../lib/windows-whoami";

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

function whoamiValue(): string {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync([resolveTrustedWindowsWhoamiExe(), "/user"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
  } catch (cause) {
    refuse("Windows effective-account lookup could not start.", cause);
  }
  if (result.exitCode !== 0) refuse("Windows effective-account lookup failed.");
  const output = new TextDecoder().decode(result.stdout);
  const sid = parseWindowsSidFromWhoami(output);
  if (!sid) refuse("Windows effective-account lookup returned an invalid SID.");
  return sid;
}

function resolveWindowsSid(): string {
  const sid = whoamiValue();
  if (!SID_PATTERN.test(sid)) refuse("Windows effective-account lookup returned an invalid SID.");
  return sid;
}

/**
 * Resolve LocalAppData from the effective TOKEN's profile directory
 * (OpenProcessToken + GetUserProfileDirectoryW) and never from the
 * environment: LOCALAPPDATA and USERPROFILE are writable by whatever launched
 * us, and the coordinator namespace must not follow them. The known-folder
 * APIs are not usable here — on hosts whose `User Shell Folders` registry
 * value embeds `%USERPROFILE%` they expand the variable from the CALLER'S
 * environment (verified: SHGetFolderPathW and SHGetKnownFolderPath both fail
 * or follow a faked USERPROFILE, even with an explicit token), so they are
 * neither environment-independent nor fail-consistent. The token profile
 * directory is. Folder redirection is deliberately not honored: a redirected
 * path is only reachable through those environment-shaped lookups.
 *
 * FFI instead of a PowerShell child keeps the lookup window-free (the v2.11.0
 * popup bug), fast on the uncached hot path, and free of PATH trust questions.
 */
type WindowsProfileLibraries = {
  getCurrentProcess: () => Pointer;
  closeHandle: (handle: number) => number;
  openProcessToken: (process: Pointer, desiredAccess: number, tokenOut: Pointer) => number;
  getUserProfileDirectoryW: (token: number, buffer: Pointer, size: Pointer) => number;
};

let windowsProfileLibrariesCache: WindowsProfileLibraries | null | undefined;

function loadWindowsProfileLibraries(): WindowsProfileLibraries | null {
  if (windowsProfileLibrariesCache !== undefined) return windowsProfileLibrariesCache;
  if (process.platform !== "win32") {
    windowsProfileLibrariesCache = null;
    return null;
  }
  try {
    const kernel32 = dlopen("kernel32.dll", {
      GetCurrentProcess: { args: [], returns: "ptr" },
      // Handles travel as pointer-sized integers.
      CloseHandle: { args: ["u64"], returns: "i32" },
    });
    const advapi32 = dlopen("advapi32.dll", {
      OpenProcessToken: { args: ["ptr", "u32", "ptr"], returns: "i32" },
    });
    const userenv = dlopen("userenv.dll", {
      GetUserProfileDirectoryW: { args: ["u64", "ptr", "ptr"], returns: "i32" },
    });
    windowsProfileLibrariesCache = {
      getCurrentProcess: () => kernel32.symbols.GetCurrentProcess() as Pointer,
      closeHandle: handle => kernel32.symbols.CloseHandle(handle) as number,
      openProcessToken: (process, desiredAccess, tokenOut) =>
        advapi32.symbols.OpenProcessToken(process, desiredAccess, tokenOut) as number,
      getUserProfileDirectoryW: (token, buffer, size) =>
        userenv.symbols.GetUserProfileDirectoryW(token, buffer, size) as number,
    };
  } catch {
    windowsProfileLibrariesCache = null;
  }
  return windowsProfileLibrariesCache;
}

function windowsProfileDirectory(): string {
  const libraries = loadWindowsProfileLibraries();
  if (!libraries) {
    refuse("Windows profile resolution could not load system libraries.");
  }
  let token = 0;
  let profile = "";
  try {
    const TOKEN_QUERY = 0x0008;
    const tokenOut = new BigUint64Array(1);
    const opened = libraries.openProcessToken(libraries.getCurrentProcess(), TOKEN_QUERY, ptr(tokenOut));
    if (opened === 0 || tokenOut[0] === 0n) {
      refuse("Windows profile resolution could not open the process token.");
    }
    token = Number(tokenOut[0]);
    // Profile paths fit MAX_PATH; retry once with the reported size otherwise.
    let buffer = new Uint16Array(512);
    let size = new Uint32Array([buffer.length]);
    let ok = libraries.getUserProfileDirectoryW(token, ptr(buffer), ptr(size));
    if (ok === 0) {
      const required = size[0];
      if (!Number.isSafeInteger(required) || required <= 0 || required > 32_768) {
        refuse("Windows profile resolution reported an invalid profile directory size.");
      }
      buffer = new Uint16Array(required);
      size = new Uint32Array([buffer.length]);
      ok = libraries.getUserProfileDirectoryW(token, ptr(buffer), ptr(size));
    }
    if (ok === 0) refuse("Windows profile resolution could not read the profile directory.");
    const length = buffer.indexOf(0);
    profile = String.fromCharCode(...buffer.subarray(0, length < 0 ? buffer.length : length));
  } catch (cause) {
    if (cause instanceof CodexUserIdentityRefusal) throw cause;
    refuse("Windows profile resolution failed.", cause);
  } finally {
    if (token !== 0) {
      try { libraries.closeHandle(token); } catch { /* best-effort handle close */ }
    }
  }
  if (!profile) refuse("Windows profile resolution returned an empty profile directory.");
  return profile;
}

function localAppDataValue(): string {
  const localAppData = join(windowsProfileDirectory(), "AppData", "Local");
  if (!isAbsolute(localAppData)) refuse("Windows LocalAppData resolution returned a relative path.");
  return localAppData;
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
  const localAppData = localAppDataValue();
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
  const localAppData = localAppDataValue();
  if (!isAbsolute(localAppData)) refuse("Windows LocalAppData resolution returned a relative path.");

  // The SID comes from the effective token via whoami and the known-folder
  // value from the token's profile directory — never USERPROFILE or
  // LOCALAPPDATA. WP11 adds descriptor/reparse/ACL checks at the
  // stable-database open boundary where those checks can cover SQLite too.
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
