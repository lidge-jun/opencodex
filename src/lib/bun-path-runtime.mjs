import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { isRealBunBinary } from "./bun-binary-validator.mjs";

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_VERSION_BYTES = 4096;
const MAX_SYMLINK_EXPANSIONS = 40;
const IDENTITY_PROBE = "process.stdout.write(String(typeof Bun==='object'&&Bun.version))";

function stableVersion(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = STABLE.exec(value);
  if (!match) return null;
  const numbers = match.slice(1, 4).map(Number);
  return numbers.every(Number.isSafeInteger) ? numbers : null;
}

function trustedPosixCandidate(candidate, canonical, io) {
  const lstat = io.lstat ?? lstatSync;
  const readlink = io.readlink ?? readlinkSync;
  const uid = io.geteuid?.() ?? process.geteuid?.();
  if (!Number.isSafeInteger(uid) || uid < 0) return false;

  const walk = path => {
    let pending = path.slice(1).split("/");
    let current = "/";
    let expansions = 0;
    while (pending.length) {
      const [component, ...remaining] = pending;
      pending = remaining;
      if (!component || component === ".") continue;
      if (component === "..") {
        current = posix.dirname(current);
        continue;
      }
      const entry = posix.join(current, component);
      const info = lstat(entry);
      if (!Number.isSafeInteger(info.uid) || (info.uid !== 0 && info.uid !== uid)) return null;
      if (info.isSymbolicLink()) {
        if (++expansions > MAX_SYMLINK_EXPANSIONS) return null;
        const target = readlink(entry);
        pending = target.startsWith("/")
          ? [...target.slice(1).split("/"), ...pending]
          : [
            ...(current === "/" ? [] : current.slice(1).split("/")),
            ...target.split("/"),
            ...pending,
          ];
        current = "/";
        continue;
      }
      if (remaining.length || pending.length) {
        // No writable-ancestor exemption: a shared sticky directory passes its own
        // ownership check but lets another user replace a child entry between the
        // ancestry walk and the exec probe, substituting an unvalidated binary.
        if (!info.isDirectory() || (info.mode & 0o022) !== 0) return null;
      } else if (!info.isFile() || (info.mode & 0o022) !== 0) {
        return null;
      }
      current = entry;
    }
    return current;
  };

  const resolved = walk(candidate);
  if (!resolved || (io.realpath ?? realpathSync.native)(resolved) !== canonical) return false;
  const parent = lstat(posix.dirname(canonical));
  return parent.isDirectory()
    && Number.isSafeInteger(parent.uid)
    && (parent.uid === 0 || parent.uid === uid)
    && (parent.mode & 0o022) === 0;
}

/** Discover the first absolute PATH Bun passing version-policy and identity checks. */
export function findPathBun({
  env = process.env, platform = process.platform, pinnedVersion,
  deadlineMs = 750, io = {},
}) {
  const pin = stableVersion(pinnedVersion);
  if (!pin || !Number.isFinite(deadlineMs) || deadlineMs <= 0) return null;
  const paths = platform === "win32" ? win32 : posix;
  const absolute = value => paths.isAbsolute(value)
    && (platform !== "win32" || /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value));
  const now = io.now ?? (() => performance.now());
  const end = now() + deadlineMs;
  const realpath = io.realpath ?? realpathSync.native;
  const stat = io.stat ?? statSync;
  const access = io.access ?? accessSync;
  const validate = io.isRealBunBinary ?? isRealBunBinary;
  const spawn = io.spawnSync ?? spawnSync;
  const key = platform === "win32"
    ? Object.keys(env).find(name => name.toLowerCase() === "path") : "PATH";
  const directories = (env[key ?? "PATH"] ?? "").split(platform === "win32" ? ";" : ":");
  const seen = new Set();
  const probe = (path, args) => {
    const remaining = Math.floor(end - now());
    if (remaining <= 0) return null;
    const result = spawn(path, args, {
      env, encoding: "utf8", timeout: remaining, maxBuffer: MAX_VERSION_BYTES,
      killSignal: "SIGKILL", shell: false, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (now() >= end || result.error || result.signal || result.status !== 0
      || typeof result.stdout !== "string" || result.stdout.length > MAX_VERSION_BYTES) return null;
    return result.stdout.trim();
  };
  for (const directory of directories) {
    if (now() >= end) break;
    if (!directory || !absolute(directory)) continue;
    try {
      const candidatePath = paths.join(directory, platform === "win32" ? "bun.exe" : "bun");
      const path = realpath(candidatePath);
      if (!absolute(path)) continue;
      if (platform !== "win32" && !trustedPosixCandidate(candidatePath, path, io)) continue;
      const identity = platform === "win32" ? path.toLowerCase() : path;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const file = stat(path);
      if (!file.isFile()) continue;
      if (platform !== "win32" && (file.mode & 0o022)) continue;
      access(path, constants.X_OK);
      if (!validate(path)) continue;
      const version = probe(path, ["--version"]);
      const candidate = stableVersion(version);
      if (!candidate || candidate[0] !== pin[0] || candidate[1] < pin[1]) continue;
      if (probe(path, ["-e", IDENTITY_PROBE]) !== version) continue;
      return { path, version };
    } catch {
      // Unreadable, unexecutable, vanished or invalid: try the next absolute candidate.
    }
  }
  return null;
}

/** Failure-text pointer only. Never execute or delegate to this binary. */
export function findDesktopCli({ platform = process.platform, home = homedir(), io = {} } = {}) {
  if (platform !== "darwin") return null;
  const stat = io.stat ?? statSync;
  const access = io.access ?? accessSync;
  for (const path of [
    "/Applications/OpenCodex.app/Contents/MacOS/ocx",
    posix.join(home, "Applications/OpenCodex.app/Contents/MacOS/ocx"),
  ]) {
    try {
      if (!stat(path).isFile()) continue;
      access(path, constants.X_OK);
      return path;
    } catch { /* Missing or not executable: no pointer for this candidate. */ }
  }
  return null;
}
