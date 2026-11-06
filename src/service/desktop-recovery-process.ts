/** OS evidence for native recovery. Names and discovery records never select a trusted image. */
import { dlopen, ptr } from "bun:ffi";
import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, posix, win32 } from "node:path";
import { isStandaloneBinary } from "../lib/standalone";
import { resolveTrustedWindowsPowerShellExe } from "../lib/windows-elevation";

export interface RecoveryImage { app: string; cli: string; image: string; trusted: boolean; unsupported?: boolean; macRequirement?: string }
export interface RecoveryProcess { pid: number; born: string; image: string; app: string }
export interface RecoveryConnection { serverPort: number; clientPort: number }
export type RecoveryExecute = (command: string, args: string[], env?: Record<string, string>, captureStderr?: boolean) => string;

function executeRecovery(command: string, args: string[], env: Record<string, string> | undefined, captureStderr: boolean | undefined, timeout: number): string {
  const result = spawnSync(command, args, {
    encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true,
    stdio: ["ignore", "pipe", captureStderr ? "pipe" : "ignore"], env: { ...process.env, LC_ALL: "C", ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("OS recovery observation failed");
  return (result.stdout + (captureStderr ? result.stderr : "")).trim();
}

const run: RecoveryExecute = (command, args, env, captureStderr) => executeRecovery(command, args, env, captureStderr, 2_000);

/** All synchronous OS commands share the caller's remaining proof/connection deadline. */
export function recoveryExecuteUntil(deadline: () => number, now: () => number): RecoveryExecute {
  return (command, args, env, captureStderr) => {
    const remaining = Math.floor(deadline() - now());
    if (remaining <= 0) throw new Error("native recovery deadline elapsed");
    return executeRecovery(command, args, env, captureStderr, Math.min(2_000, remaining));
  };
}

/** Bind dynamic validation to the selected sealed executable, including universal binaries. */
export function macRecoveryRequirement(path: string, execute: RecoveryExecute = run): string {
  const hashes = new Set<string>();
  for (const arch of ["arm64", "x86_64"]) {
    try {
      // codesign writes its signature display to stderr. This is data, never shell source.
      const output = execute("/usr/bin/codesign", ["--display", "--verbose=4", "--arch", arch, path], undefined, true);
      const matches = [...output.matchAll(/^CDHash=([0-9a-f]{40})$/gmi)];
      if (matches.length === 1) hashes.add(matches[0]![1]!.toLowerCase());
    } catch { /* A thin binary has only one of the supported architecture slices. */ }
  }
  if (!hashes.size) throw new Error("native code identity unavailable");
  return `=${[...hashes].map(hash => `cdhash H"${hash}"`).join(" or ")}`;
}

export function verifyMacRecoveryImage(pid: number, requirement: string | undefined, execute: RecoveryExecute = run): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !requirement
    || !/^=cdhash H"[0-9a-f]{40}"(?: or cdhash H"[0-9a-f]{40}")?$/.test(requirement)) throw new Error("native code identity unavailable");
  execute("/usr/bin/codesign", ["--verify", "--strict", "-R", requirement, String(pid)]);
}

export function parseMacRecoveryPath(bytes: Uint8Array, length: number): string {
  if (!Number.isInteger(length) || length <= 0 || length >= bytes.length || bytes.indexOf(0) !== length) throw new Error("unverified kernel image path");
  const path = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  if (!posix.isAbsolute(path)) throw new Error("unverified kernel image path");
  return path;
}

interface MacRecoveryLibrary {
  symbols: {
    proc_pidpath(pid: number, buffer: ReturnType<typeof ptr>, length: number): number;
  };
  close(): void;
}

/** Kernel path reads and process probes are separate observations, never name-based evidence. */
export function macRecoveryPaths(
  library: MacRecoveryLibrary = dlopen("/usr/lib/libproc.dylib", {
    proc_pidpath: { args: ["i32", "ptr", "u32"], returns: "i32" },
  }),
  probe: (pid: number, signal: 0) => unknown = process.kill,
) {
  return {
    read(pid: number): string | null {
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) throw new Error("unverified process PID");
      const buffer = new Uint8Array(4096);
      const count = library.symbols.proc_pidpath(pid, ptr(buffer), buffer.length);
      if (count <= 0) {
        // Do not recover an earlier errno through a second FFI call. Only a fresh ESRCH
        // proves that the enumerated PID is gone; alive or inaccessible remains unknown.
        try { probe(pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException | null)?.code === "ESRCH") return null; }
        throw new Error("kernel image path unavailable");
      }
      return parseMacRecoveryPath(buffer, count);
    },
    close() { library.close(); },
  };
}

function fileIdentity(path: string): string {
  const info = statSync(path, { bigint: true });
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

/** The selected image is a sibling of the executable actually running this compiled CLI. */
export function recoverySibling(execPath: string, platform: NodeJS.Platform): string | null {
  const path = platform === "win32" ? win32 : posix;
  if (!path.isAbsolute(execPath) || path.basename(execPath).toLowerCase() !== (platform === "win32" ? "ocx.exe" : "ocx")) return null;
  const directory = path.dirname(execPath);
  if (platform === "darwin" && (path.basename(directory) !== "MacOS"
    || path.basename(path.dirname(directory)) !== "Contents" || !path.dirname(path.dirname(directory)).endsWith(".app"))) return null;
  return path.join(directory, platform === "win32" ? "opencodex-desktop.exe" : "opencodex-desktop");
}

function protectedPosix(path: string, rootOnly = false): boolean {
  const info = lstatSync(path);
  return !info.isSymbolicLink() && (info.isFile() || info.isDirectory()) && (info.mode & 0o022) === 0
    && (info.uid === 0 || (!rootOnly && info.uid === process.geteuid?.()));
}

function powershell(): string {
  // The established system-directory resolver does not take powershell.exe from PATH.
  return resolveTrustedWindowsPowerShellExe();
}

function windowsRun(script: string, env: Record<string, string>, execute: RecoveryExecute): string {
  const utf8 = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ";
  return execute(powershell(), ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", utf8 + script], env);
}

/** No record, argv or environment variable can nominate an installation. */
export function recoveryImages(execute: RecoveryExecute = run): RecoveryImage[] {
  const platform = process.platform;
  if (!["linux", "darwin", "win32"].includes(platform)) return [];
  const candidates: { cli: string; app: string; rootOnly: boolean }[] = [];
  if (isStandaloneBinary()) {
    const cli = realpathSync(process.execPath);
    if (platform === "linux" && fileIdentity("/proc/self/exe") !== fileIdentity(cli)) throw new Error("running CLI image changed");
    const app = recoverySibling(cli, platform);
    if (app) candidates.push({ cli, app, rootOnly: false });
  }
  // An npm/source CLI can also credit the admin-installed Debian image. Every parent is
  // checked below; a per-user file or registry entry cannot invent this system installation.
  if (platform === "linux" && !candidates.some(c => c.app === "/usr/bin/opencodex-desktop")) {
    candidates.push({ cli: "/usr/bin/ocx", app: "/usr/bin/opencodex-desktop", rootOnly: true });
  }
  const images: RecoveryImage[] = [];
  for (const candidate of candidates) images.push(recoveryImageCandidate(candidate, platform, execute));
  return images;
}

/** The OS/path observations a candidate needs; only the derivations, never the decisions. */
export interface RecoveryImageIo {
  sibling?: (execPath: string, platform: NodeJS.Platform) => string | null;
  identify?: (path: string) => string;
}

/**
 * Observe one anchored candidate. `unsupported` is earned only by a fully observed and
 * unchanged Windows candidate: unavailable files, thrown observations and identity drift are
 * conflicting evidence, never a platform limitation.
 */
export function recoveryImageCandidate(
  candidate: { cli: string; app: string; rootOnly: boolean },
  platform: NodeJS.Platform,
  execute: RecoveryExecute = run,
  io: RecoveryImageIo = {},
): RecoveryImage {
  const sibling = io.sibling ?? recoverySibling;
  const identify = io.identify ?? fileIdentity;
  const unavailable: RecoveryImage = { app: candidate.app, cli: candidate.cli, image: "unavailable", trusted: false };
  try {
    const app = realpathSync(candidate.app), cli = realpathSync(candidate.cli);
    if (app !== candidate.app || dirname(app) !== dirname(cli) || sibling(cli, platform) !== app
      || !statSync(app).isFile() || !statSync(cli).isFile()) return unavailable;
    accessSync(app, constants.X_OK); accessSync(cli, constants.X_OK);
    const before = `${identify(app)}|${identify(cli)}`;
    let trusted = false;
    let macRequirement: string | undefined;
    if (platform !== "win32") {
      trusted = protectedPosix(app, candidate.rootOnly) && protectedPosix(cli, candidate.rootOnly)
        && protectedPosix(dirname(app), candidate.rootOnly);
      if (candidate.rootOnly) {
        for (let directory = dirname(app); directory !== "/"; directory = dirname(directory)) trusted &&= protectedPosix(directory, true);
      }
      if (platform === "darwin" && trusted) {
        const bundle = dirname(dirname(dirname(app)));
        const info = JSON.parse(execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(bundle, "Contents", "Info.plist")]));
        trusted = info.CFBundleIdentifier === "com.opencodex.desktop" && info.CFBundleExecutable === "opencodex-desktop";
        if (trusted) {
          execute("/usr/bin/codesign", ["--verify", "--strict", "--deep", bundle]);
          verifyMacRecoveryImage(process.pid, macRecoveryRequirement(cli, execute), execute);
          macRequirement = macRecoveryRequirement(app, execute);
        }
      }
    }
    // Windows path/Authenticode observations cannot bind a live mapped process image to
    // the current file. A running independently selected sibling remains unknown there.
    // The recorded identity is the exact value the stability check compared; a fresh read
    // here could adopt a post-check replacement as verified.
    const afterApp = identify(app), afterCli = identify(cli);
    const unchanged = before === `${afterApp}|${afterCli}`;
    if (!unchanged) trusted = false;
    return { app, cli, image: afterApp, trusted,
      ...(platform === "win32" && unchanged ? { unsupported: true } : {}), ...(macRequirement ? { macRequirement } : {}) };
  } catch {
    // A missing/unreadable image can still be mapped by a live process. Preserve the
    // independently derived path for OS exclusion/unknown; it never gets positive credit.
    try { return { ...unavailable, image: identify(candidate.app) }; }
    catch { return unavailable; }
  }
}

/** Parse the kernel start-time field after comm, which can itself contain spaces and ')'. */
export function linuxRecoveryBirth(stat: string): string {
  const value = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (!value || !/^\d+$/.test(value)) throw new Error("unverified process birth");
  return value;
}

export function recoveryProcesses(images: readonly RecoveryImage[], execute: RecoveryExecute = run): RecoveryProcess[] {
  if (!images.length) return [];
  if (process.platform === "linux") {
    const result: RecoveryProcess[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        if (statSync(`/proc/${entry}`).uid !== process.getuid?.()) continue;
        const app = readlinkSync(`/proc/${entry}/exe`);
        const image = images.find(image => image.app === app || `${image.app} (deleted)` === app);
        if (!image) continue;
        if (app.endsWith(" (deleted)") || fileIdentity(`/proc/${entry}/exe`) !== image.image) throw new Error("native image changed");
        result.push({ pid: Number(entry), born: linuxRecoveryBirth(readFileSync(`/proc/${entry}/stat`, "utf8")), image: image.image, app });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ESRCH") continue;
        if (code === "EACCES" || code === "EPERM") {
          // Match the existing process inspector: an inaccessible unrelated comm can be
          // excluded; a hidden possible Desktop is an actual unverified OS observation.
          try { if (readFileSync(`/proc/${entry}/comm`, "utf8").trim() !== "opencodex-desktop".slice(0, 15)) continue; } catch { /* unknown */ }
        }
        throw error;
      }
    }
    return result;
  }
  if (process.platform === "darwin") {
    const output = execute("/bin/ps", ["-U", String(process.getuid!()), "-o", "pid=,lstart="]);
    const result: RecoveryProcess[] = [];
    const paths = macRecoveryPaths();
    try {
      for (const line of output.split("\n")) {
        const row = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(line);
        if (!row) { if (line.trim()) throw new Error("unverified process row"); continue; }
        // ps comm is argv[0], so it cannot identify even a candidate executable.
        const path = paths.read(Number(row[1]));
        const image = images.find(image => image.app === path);
        if (image) {
          if (fileIdentity(image.app) !== image.image) throw new Error("native image changed");
          if (image.trusted) verifyMacRecoveryImage(Number(row[1]), image.macRequirement, execute);
          result.push({ pid: Number(row[1]), born: row[2]!, app: image.app, image: image.image });
        }
      }
    } finally { paths.close(); }
    return result;
  }
  if (process.platform === "win32") {
    const output = windowsRun("$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rows=@(Get-CimInstance Win32_Process -Filter \"Name='opencodex-desktop.exe'\" | ForEach-Object { $owner=Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid; if ($owner.ReturnValue -ne 0) { throw 'owner unavailable' }; if ($owner.Sid -eq $sid) { [ordered]@{pid=$_.ProcessId; app=$_.ExecutablePath; born=[string]$_.CreationDate.ToUniversalTime().Ticks} } }); ConvertTo-Json -Compress -InputObject $rows", {}, execute);
    const rows: unknown = JSON.parse(output);
    if (!Array.isArray(rows)) throw new Error("unverified process rows");
    return rows.flatMap(row => {
      if (!row || !Number.isSafeInteger(row.pid) || row.pid <= 0 || typeof row.app !== "string" || !/^[1-9]\d{0,19}$/.test(row.born)) throw new Error("unverified process row");
      const image = images.find(image => image.app.toLowerCase() === row.app.toLowerCase());
      if (image && fileIdentity(image.app) !== image.image) throw new Error("native image changed");
      return image ? [{ pid: row.pid, born: row.born, app: image.app, image: image.image }] : [];
    });
  }
  return [];
}

/** Match an established IPv4 connection, then require the target process to hold its inode. */
export function linuxRecoverySocket(table: string, connection: RecoveryConnection): string | null {
  const address = (port: number) => `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  const rows = table.split("\n").map(line => line.trim().split(/\s+/)).filter(row => row[1] === address(connection.serverPort)
    && row[2] === address(connection.clientPort) && row[3] === "01");
  return rows.length === 1 && /^\d+$/.test(rows[0]![9] ?? "") ? rows[0]![9]! : null;
}

function linuxHeldSockets(pid: number): Set<string> {
  const inodes = new Set<string>();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
      if (match) inodes.add(match[1]!);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return inodes;
}

/** Discovery comes from the target's actual loopback listening sockets, never a locator file. */
export function linuxRecoveryListeners(table: string, heldInodes: ReadonlySet<string>): number[] {
  const ports = new Set<number>();
  for (const line of table.split("\n")) {
    const row = line.trim().split(/\s+/);
    const address = /^0100007F:([0-9A-F]{4})$/.exec(row[1] ?? "");
    if (address && row[2] === "00000000:0000" && row[3] === "0A" && heldInodes.has(row[9]!)) {
      const port = Number.parseInt(address[1]!, 16);
      if (port > 0) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

export function recoveryListenerPorts(process: RecoveryProcess, execute: RecoveryExecute = run): number[] {
  if (globalThis.process.platform === "linux") {
    return linuxRecoveryListeners(readFileSync(`/proc/${process.pid}/net/tcp`, "utf8"), linuxHeldSockets(process.pid));
  }
  if (globalThis.process.platform === "darwin") {
    const output = execute("/usr/sbin/lsof", ["-nP", "-a", "-p", String(process.pid), "-iTCP", "-sTCP:LISTEN", "-FfnT"]);
    const ports = output.split(/\nf/).slice(1).flatMap(record => {
      const port = /^n127\.0\.0\.1:(\d+)$/m.exec(record);
      return port && record.split("\n").includes("TST=LISTEN") ? [Number(port[1])] : [];
    });
    return [...new Set(ports)].sort((a, b) => a - b);
  }
  throw new Error("OS listener observation unavailable");
}

/** The socket stays open during both observations; a listener on the same port is insufficient. */
export function recoveryConnectionOwner(process: RecoveryProcess, connection: RecoveryConnection, execute: RecoveryExecute = run): string {
  if (globalThis.process.platform === "linux") {
    const inode = linuxRecoverySocket(readFileSync(`/proc/${process.pid}/net/tcp`, "utf8"), connection);
    if (!inode) throw new Error("accepted socket unavailable");
    if (!linuxHeldSockets(process.pid).has(inode)) throw new Error("accepted socket belongs to another process");
    return inode;
  }
  if (globalThis.process.platform === "darwin") {
    const output = execute("/usr/sbin/lsof", ["-nP", "-a", "-p", String(process.pid), "-iTCP", "-sTCP:ESTABLISHED", "-FfnT"]);
    const target = `127.0.0.1:${connection.serverPort}->127.0.0.1:${connection.clientPort}`;
    const records = output.split(/\nf/).slice(1).filter(record => record.split("\n").includes(`n${target}`)
      && record.split("\n").includes("TST=ESTABLISHED"));
    if (records.length !== 1 || !/^\d+[rwu]?(?:\n|$)/.test(records[0]!)) throw new Error("accepted socket unavailable");
    return records[0]!.split("\n")[0]!;
  }
  throw new Error("OS connection observation unavailable");
}
