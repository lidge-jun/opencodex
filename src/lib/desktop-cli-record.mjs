import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export const DESKTOP_CLI_RECORD_MAX_BYTES = 64 * 1024;

export function desktopCliRecordPath(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? (platform === "win32" ? env.USERPROFILE || homedir() : homedir());
  return (platform === "win32" ? win32 : posix).join(home, ".opencodex-desktop", "cli.json");
}

// Keep these lexical rules aligned with Rust's absolute_for in cli_command_record.rs.
function validTargetPath(path, platform) {
  if ([...path].length > 4096 || /[\x00\r\n]/.test(path)) return false;
  const absolute = platform === "win32"
    ? /^[A-Za-z]:[/\\]/.test(path) || path.startsWith("\\\\") || path.startsWith("//")
    : path.startsWith("/");
  return absolute && !path.split(platform === "win32" ? /[/\\]/ : /\//)
    .some(part => part === "." || part === "..");
}

export function readDesktopCliRecord(options = {}) {
  const platform = options.platform ?? process.platform;
  const path = options.recordPath ?? desktopCliRecordPath(options);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY);
    const info = fstatSync(fd);
    if (!info.isFile()) return { state: "invalid", path, issue: "record-invalid" };
    if (info.size > DESKTOP_CLI_RECORD_MAX_BYTES) {
      return { state: "invalid", path, issue: "record-too-large" };
    }
    const bytes = Buffer.alloc(DESKTOP_CLI_RECORD_MAX_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const n = readSync(fd, bytes, used, bytes.length - used, null);
      if (n === 0) break;
      used += n;
    }
    if (used > DESKTOP_CLI_RECORD_MAX_BYTES) {
      return { state: "invalid", path, issue: "record-too-large" };
    }
    let value;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used))); }
    catch { return { state: "invalid", path, issue: "record-invalid" }; }
    if (!value || typeof value !== "object" || Array.isArray(value)
      || value.version !== 1 || typeof value.enabled !== "boolean") {
      return { state: "invalid", path, issue: "record-invalid" };
    }
    if (!value.enabled) return { state: "disabled", path, cleanupPending: value.pending != null };
    if (value.pending != null) return { state: "invalid", path, issue: "record-pending" };
    const bundle = value.bundle;
    const kind = { darwin: "macos-app", win32: "windows-install", linux: "linux-deb" }[platform];
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)
      || !kind || bundle.platform !== platform || bundle.kind !== kind
      || typeof bundle.cliExecutable !== "string" || !validTargetPath(bundle.cliExecutable, platform)) {
      return { state: "invalid", path, issue: "record-invalid" };
    }
    return { state: "ready", path, record: {
      platform, kind, cliExecutable: bundle.cliExecutable,
    } };
  } catch (error) {
    return error?.code === "ENOENT"
      ? { state: "missing", path }
      : { state: "unreadable", path, issue: "record-unreadable" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
