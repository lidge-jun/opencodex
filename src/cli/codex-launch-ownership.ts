import { closeSync, fstatSync, lstatSync, openSync, readlinkSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { resolveTrustedWindowsPowerShellExe } from "../lib/windows-elevation";
import type { CodexTokenRefusal, CodexTokenRefusalReporter } from "./codex-launch-diagnostics";

type OwnershipStat = Pick<Stats, "uid" | "mode" | "isFile" | "isDirectory" | "isSymbolicLink"> & {
  dev: number | bigint; ino: number | bigint;
};

function ownershipStat(path: string): OwnershipStat {
  if (process.platform !== "darwin") return lstatSync(path);
  // Keep 64-bit object identities exact; ownership and permission fields fit u32.
  const stat = lstatSync(path, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, uid: Number(stat.uid), mode: Number(stat.mode),
    isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory(), isSymbolicLink: () => stat.isSymbolicLink() };
}

// Paths are environment data, never interpolated PowerShell source. The token is
// not read until this read-only subprocess and the config checks have succeeded.
const SCRIPT = String.raw`
$ErrorActionPreference='Stop'
try {
  $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $trusted=@($user,'S-1-5-18','S-1-5-32-544')
  $installer='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
  $sections=[System.Security.AccessControl.AccessControlSections]'Owner,Access'
  $paths=@($env:OCX_CODEX_OWNED_HOME,[System.IO.Path]::Combine($env:OCX_CODEX_OWNED_HOME,'config.toml'))
  $exactOwners=2
  $chain=$env:OCX_CODEX_PATH_CHAIN -eq '1'
  if ($chain) {
    $paths=ConvertFrom-Json -InputObject $env:OCX_CODEX_OWNED_PATHS
    if ($paths.Count -eq 0) { exit 1 }
    $exactOwners=0
  }
  if ($env:OCX_CODEX_NAMESPACE_CHECK -eq '1') {
    $systemDir=$env:OCX_CODEX_NAMESPACE_FIXTURE
    if ([string]::IsNullOrEmpty($systemDir)) {
      $programData=[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
      if ([string]::IsNullOrEmpty($programData)) { exit 1 }
      $systemDir=[System.IO.Path]::Combine($programData,'OpenAI','Codex')
    }
    foreach ($file in @('config.toml','requirements.toml','managed_config.toml')) {
      try { $null=[System.IO.File]::GetAttributes([System.IO.Path]::Combine($systemDir,$file)); exit 3 }
      catch [System.IO.FileNotFoundException] { }
      catch [System.IO.DirectoryNotFoundException] { }
    }
    $existing=$systemDir
    while ($true) {
      try { $attributes=[System.IO.File]::GetAttributes($existing); break }
      catch [System.IO.FileNotFoundException] { }
      catch [System.IO.DirectoryNotFoundException] { }
      $existing=[System.IO.Path]::GetDirectoryName($existing)
      if ([string]::IsNullOrEmpty($existing)) { exit 1 }
    }
    if (($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) { exit 1 }
    $paths=@($existing)
    $exactOwners=0
  }
  $parent=[System.IO.Directory]::GetParent($paths[0])
  while ($null -ne $parent) { $paths+= $parent.FullName; $parent=$parent.Parent }
  for ($i=0;$i -lt $paths.Count;$i++) {
    $path=$paths[$i]
    $reparse=([System.IO.File]::GetAttributes($path) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    if (!$chain -and $reparse) { exit 1 }
    if ([System.IO.Directory]::Exists($path)) { $acl=[System.Security.AccessControl.DirectorySecurity]::new($path,$sections) }
    else { $acl=[System.Security.AccessControl.FileSecurity]::new($path,$sections) }
    $raw=[System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
    if ($i -lt $exactOwners -and $raw.Owner.Value -ne $user) { exit 1 }
    if ($i -ge $exactOwners -and $trusted -notcontains $raw.Owner.Value -and $raw.Owner.Value -ne $installer) { exit 1 }
    if ($null -eq $raw.DiscretionaryAcl -or ([int]$raw.ControlFlags -band 4) -eq 0) { exit 1 }
    foreach ($ace in $raw.DiscretionaryAcl) {
      if ($ace -isnot [System.Security.AccessControl.CommonAce] -or $ace.IsCallback) { exit 1 }
      if (([int]$ace.AceFlags -band 8) -ne 0) { continue }
      if ([int]$ace.AceType -eq 1) { continue }
      if ([int]$ace.AceType -ne 0) { exit 1 }
      $sid=$ace.SecurityIdentifier.Value
      if ($trusted -contains $sid) { continue }
      # TrustedInstaller is an OS authority on ancestors only, never on the two owned entries.
      if ($i -ge $exactOwners -and $sid -eq $installer) { continue }
      # Include generic writes/all, DELETE, WRITE_DAC, WRITE_OWNER, and directory DELETE_CHILD.
      $mask=[int64]$ace.AccessMask -band 4294967295
      $mutation=1343029590
      if (($chain -and $i -gt 0 -and !$reparse) -or
        (!$chain -and ($i -ge 2 -or ($exactOwners -eq 0 -and $i -ge 1)))) { $mutation=1343029312 }
      if (($mask -band $mutation) -ne 0) {
        if ($exactOwners -eq 0) { exit 2 }
        exit 1
      }
    }
  }
  exit 0
} catch { exit 1 }
`;
const ENCODED_SCRIPT = Buffer.from(SCRIPT, "utf16le").toString("base64");

function windowsOwnershipCheck(home: string, namespace: boolean, fixtureDirectory?: string, report?: CodexTokenRefusalReporter, paths?: readonly string[]): boolean {
  // Remove case aliases before constructing a Windows environment block. These
  // private protocol inputs must come from this call, never the caller's shell.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:OCX_CODEX_OWNED_HOME|OCX_CODEX_NAMESPACE_CHECK|OCX_CODEX_NAMESPACE_FIXTURE|OCX_CODEX_PATH_CHAIN|OCX_CODEX_OWNED_PATHS)$/i.test(key)));
  const result = Bun.spawnSync([
    resolveTrustedWindowsPowerShellExe(), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_SCRIPT,
  ], { env: { ...inherited, OCX_CODEX_OWNED_HOME: home, OCX_CODEX_NAMESPACE_CHECK: namespace ? "1" : "0",
    OCX_CODEX_NAMESPACE_FIXTURE: fixtureDirectory, OCX_CODEX_PATH_CHAIN: paths ? "1" : "0",
    OCX_CODEX_OWNED_PATHS: JSON.stringify(paths) }, stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 5_000, windowsHide: true });
  const safe = result.success && !result.exitedDueToTimeout;
  if (!safe && namespace) report?.(result.exitCode === 2 ? "systemNamespaceWritable" : result.exitCode === 3 ? "systemConfig" : "systemNamespace");
  return safe;
}

/** Inspect lexical entries as well as every link target; realpath alone loses replacement authority. */
export function codexLaunchProjectAliasIsOwned(path: string): boolean {
  try {
    const paths = new Map<string, OwnershipStat>(), uid = process.getuid?.();
    const inspect = (entry: string): boolean => {
      if (paths.has(entry)) return true;
      const stat = ownershipStat(entry), parent = dirname(entry);
      paths.set(entry, stat);
      if (!stat.isSymbolicLink() && !stat.isDirectory() && !stat.isFile()) return false;
      if (process.platform !== "win32") {
        if (uid === undefined || (stat.uid !== uid && stat.uid !== 0)) return false;
        // Symlink modes are not access controls; their owner and parent protect the entry.
        if (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0
          && (!stat.isDirectory() || (stat.mode & 0o1000) === 0)) return false;
        const container = lstatSync(parent);
        if ((container.mode & 0o022) !== 0 && (container.mode & 0o1000) !== 0 && stat.uid !== uid) return false;
      }
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(entry);
        // Keep dot segments: collapsing link/../target could hide the link that redirects it.
        if (!inspect(isAbsolute(target) ? target : parent + sep + target)) return false;
      }
      return parent === entry || inspect(parent);
    };
    if (!inspect(resolve(path))) return false;
    if (process.platform === "win32") return windowsOwnershipCheck("", false, undefined, undefined, [...paths.keys()]);
    return process.platform !== "darwin" || macHasNoManagedCodexPreferences(paths);
  } catch { return false; }
}

/** A missing system layer is safe only if another user cannot create it later. */
export function codexPosixSystemNamespace(platform: NodeJS.Platform = process.platform): string {
  // Darwin's /etc is a standard root-owned symlink; inspect its physical namespace.
  return platform === "darwin" ? "/private/etc/codex" : "/etc/codex";
}

export function codexLaunchSystemNamespaceIsSafe(fixtureDirectory?: string, report?: CodexTokenRefusalReporter): boolean {
  const refuse = (reason: CodexTokenRefusal): false => { report?.(reason); return false; };
  try {
    if (process.platform === "win32") return windowsOwnershipCheck("", true, fixtureDirectory, report);
    let path = fixtureDirectory ?? codexPosixSystemNamespace();
    for (const file of ["config.toml", "requirements.toml", "managed_config.toml"]) {
      try { lstatSync(join(path, file)); return refuse("systemConfig"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return refuse("systemNamespace"); }
    }
    for (;;) {
      try { lstatSync(path); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return refuse("systemNamespace"); }
      if (dirname(path) === path) return refuse("systemNamespace");
      path = dirname(path);
    }
    const paths = new Map<string, OwnershipStat>();
    for (;;) {
      const stat = ownershipStat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== process.getuid?.() && stat.uid !== 0)
        || ((stat.mode & 0o022) !== 0 && (paths.size === 0 || (stat.mode & 0o1000) === 0))) return refuse("systemNamespace");
      paths.set(path, stat);
      if (dirname(path) === path) break;
      path = dirname(path);
    }
    return process.platform !== "darwin" || macHasNoManagedCodexPreferences(paths) || refuse("systemNamespace");
  } catch { return refuse("systemNamespace"); }
}

/** Only for a descriptor-bound ACL query: absent FILESEC_ACL reports ENOENT. */
export function darwinAclDescriptorIsAbsent(descriptor: number | bigint | null, errorNumber: number): boolean {
  return !descriptor && errorNumber === 2;
}

/** Darwin's successful end-of-enumeration differs from POSIX. */
export function darwinAclInspectionIsEmpty(validResult: number, entryResult: number, errorNumber: number): boolean {
  // Darwin differs from POSIX: found entry => 0; a valid empty ACL => -1/EINVAL.
  return validResult === 0 && entryResult === -1 && errorNumber === 22;
}

// Tags, permission bits and enumeration constants: Apple's sys/acl.h
// https://github.com/apple-oss-distributions/Libc/blob/main/include/sys/acl.h
// WRITE_DATA/APPEND_DATA are also ADD_FILE/ADD_SUBDIRECTORY, respectively.
const DARWIN_ACL_MUTATION_PERMISSIONS = [2, 4, 5, 6, 8, 10, 12, 13].map(bit => 1 << bit);
const DARWIN_ACL_MUTATION_MASK = DARWIN_ACL_MUTATION_PERMISSIONS.reduce((mask, permission) => mask | permission, 0);

/** null means incomplete/unreadable enumeration; DENYs never conceal later ALLOWs. */
export function darwinAclEntriesAreSafe(entries: readonly { tag: number; perms: number }[] | null): boolean {
  return entries !== null && entries.every(({ tag, perms }) =>
    tag === 2 || (tag === 1 && (perms & DARWIN_ACL_MUTATION_MASK) === 0));
}

/** Match Codex's CFPreferencesAppValueIsForced test without reading preference contents. */
function macHasNoManagedCodexPreferences(paths: ReadonlyMap<string, OwnershipStat>): boolean {
  let library: { close(): void } | undefined;
  let aclLibrary: { close(): void } | undefined;
  try {
    const { dlopen, FFIType, ptr, read } = require("bun:ffi") as typeof import("bun:ffi");
    const acl = dlopen("/usr/lib/libSystem.B.dylib", {
      acl_get_fd_np: { args: [FFIType.i32, FFIType.i32], returns: FFIType.ptr },
      acl_get_entry: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      acl_get_tag_type: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      acl_get_permset: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      acl_get_perm_np: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      acl_valid: { args: [FFIType.ptr], returns: FFIType.i32 },
      acl_free: { args: [FFIType.ptr], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });
    aclLibrary = acl;
    for (const [path, expected] of paths) {
      // Apple bsd/sys/fcntl.h: O_RDONLY=0, O_NONBLOCK=4, O_NOFOLLOW=0x100,
      // O_DIRECTORY=0x100000, O_SYMLINK=0x200000, O_CLOEXEC=0x1000000.
      // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h
      // O_NOFOLLOW rejects final links even with O_SYMLINK; select one by type.
      // O_SYMLINK opens a link itself; fstat below rejects non-link replacements.
      // Nonblocking open prevents a replaced regular file/FIFO from stalling admission.
      const fd = openSync(path, 0x1000004 | (expected.isSymbolicLink() ? 0x200000 : 0x100 | (expected.isDirectory() ? 0x100000 : 0)));
      try {
        const actual = fstatSync(fd, { bigint: true });
        if (actual.dev !== expected.dev || actual.ino !== expected.ino
          || Number(actual.mode & 0o170000n) !== (expected.mode & 0o170000)) return false;
        const entry = Buffer.alloc(8), tag = Buffer.alloc(4), permset = Buffer.alloc(8);
        const descriptor = acl.symbols.acl_get_fd_np(fd, 0x100); // ACL_TYPE_EXTENDED
        if (!descriptor) {
          // Read errno immediately. acl_get_fd_np uses fstatx_np on this open fd,
          // with no pathname lookup that could fail ENOENT after a rename/unlink.
          // Only filesec_get_property(FILESEC_ACL) can report absence as ENOENT.
          // https://github.com/apple-oss-distributions/Libc/blob/main/posix1e/acl_file.c
          // https://github.com/apple-oss-distributions/Libc/blob/main/sys/statx_np.c
          // https://github.com/apple-oss-distributions/Libc/blob/main/gen/filesec.c
          const errno = acl.symbols.__error();
          if (!errno || !darwinAclDescriptorIsAbsent(descriptor, read.i32(errno))) return false;
          continue;
        }
        try {
          const valid = acl.symbols.acl_valid(descriptor);
          if (valid !== 0) return false;
          const entries: { tag: number; perms: number }[] = [];
          for (let id = 0; ; id = -1) { // ACL_FIRST_ENTRY=0, ACL_NEXT_ENTRY=-1
            const found = acl.symbols.acl_get_entry(descriptor, id, ptr(entry));
            if (found !== 0) {
              const errno = acl.symbols.__error();
              if (!errno || !darwinAclInspectionIsEmpty(valid, found, read.i32(errno))) return false;
              break;
            }
            const entryPointer = read.ptr(ptr(entry)) as import("bun:ffi").Pointer;
            if (!entryPointer || acl.symbols.acl_get_tag_type(entryPointer, ptr(tag)) !== 0
              || acl.symbols.acl_get_permset(entryPointer, ptr(permset)) !== 0) return false;
            const permissions = read.ptr(ptr(permset)) as import("bun:ffi").Pointer;
            if (!permissions) return false;
            let perms = 0;
            for (const permission of DARWIN_ACL_MUTATION_PERMISSIONS) {
              const granted = acl.symbols.acl_get_perm_np(permissions, permission);
              if (granted !== 0 && granted !== 1) return false;
              if (granted === 1) perms |= permission;
            }
            entries.push({ tag: tag.readInt32LE(), perms });
          }
          if (!darwinAclEntriesAreSafe(entries)) return false;
        } finally { if (acl.symbols.acl_free(descriptor) !== 0) return false; }
      } finally { closeSync(fd); }
    }
    const core = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
      CFStringCreateWithCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
      CFPreferencesAppValueIsForced: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
    });
    library = core;
    const strings = ["com.openai.codex", "config_toml_base64", "requirements_toml_base64"].map(value => Buffer.from(value + "\0"));
    const refs = strings.map(value => core.symbols.CFStringCreateWithCString(null, ptr(value), 0x08000100));
    try {
      if (refs.some(value => !value)) return false;
      return !core.symbols.CFPreferencesAppValueIsForced(refs[1]!, refs[0]!)
        && !core.symbols.CFPreferencesAppValueIsForced(refs[2]!, refs[0]!);
    } finally { for (const ref of refs) if (ref) core.symbols.CFRelease(ref); }
  } catch { return false; }
  finally { library?.close(); aclLibrary?.close(); }
}

/** Excludes other-user writers; it cannot isolate processes with the same user identity. */
export function codexLaunchHomeIsOwned(home: string): boolean {
  try {
    const directory = ownershipStat(home), config = ownershipStat(join(home, "config.toml"));
    if (!directory.isDirectory() || directory.isSymbolicLink() || !config.isFile() || config.isSymbolicLink()) return false;
    if (process.platform === "win32") {
      return windowsOwnershipCheck(home, false);
    }
    const uid = process.getuid?.();
    if (uid === undefined || [directory, config].some(stat => stat.uid !== uid || (stat.mode & 0o022) !== 0)) return false;
    const paths = new Map<string, OwnershipStat>([[home, directory], [join(home, "config.toml"), config]]);
    for (let parent = dirname(home); ; parent = dirname(parent)) {
      const stat = ownershipStat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      if (stat.uid !== uid && stat.uid !== 0) return false;
      // Sticky directories (e.g. /tmp) protect entries owned by this user.
      if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) return false;
      paths.set(parent, stat);
      if (dirname(parent) === parent) break;
    }
    return process.platform !== "darwin" || macHasNoManagedCodexPreferences(paths);
  } catch { return false; }
}
