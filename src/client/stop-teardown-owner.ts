import { readlinkSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { NODE_LAUNCH_PROOF_PREFIX } from "../cli/launcher-context";
import { parseStopApproval } from "../cli/stop-approval";
import { readProcessCommandLine, type ClientStopOwner } from "../config/process-state";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";
import { windowsProcessNative } from "../service/windows-process-native";
import { readDarwinStopArgv, readDarwinStopCwd, readDarwinStopEnvironment, readDarwinStopStart } from "./stop-darwin-process";

const basename = (value: string) => value.toLowerCase().replace(/\\/g, "/").split("/").pop() ?? "";

/** Windows native argv rules: apostrophes are literal; only double quotes group arguments. */
function windowsArgv(commandLine: string): string[] {
  if (commandLine.length > 64 * 1024 || /[\0\r\n]/.test(commandLine)) return [];
  const argv: string[] = [];
  let offset = 0;
  while (offset < commandLine.length) {
    while (/[ \t]/.test(commandLine[offset] ?? "")) offset++;
    if (offset === commandLine.length) break;
    let value = "", quoted = false;
    while (offset < commandLine.length) {
      const character = commandLine[offset]!;
      if (!quoted && /[ \t]/.test(character)) break;
      // argv[0] is a pathname: its backslashes are literal, including before a closing quote.
      if (argv.length > 0 && character === "\\") {
        let count = 0;
        while (commandLine[offset] === "\\") { count++; offset++; }
        if (commandLine[offset] !== '"') { value += "\\".repeat(count); continue; }
        value += "\\".repeat(Math.floor(count / 2));
        if (count % 2) { value += '"'; offset++; continue; }
      } else if (character !== '"') { value += character; offset++; continue; }
      if (argv.length > 0 && quoted && commandLine[offset + 1] === '"') { value += '"'; offset += 2; }
      else { quoted = !quoted; offset++; }
    }
    argv.push(value);
  }
  return argv;
}

/** Recognize the invocation that sets the native Child's explicit-stop fence, not any ocx. */
export function isClientStopCommandLine(commandLine: string): boolean {
  if (commandLine.length > 64 * 1024) return false;
  return isClientStopArgv(windowsArgv(commandLine));
}

export function isClientStopArgv(argv: readonly string[]): boolean {
  const command = ocxCommandIndex(argv);
  return command !== undefined && argv[command] === "stop" && parseStopApproval(argv.slice(command + 1)).ok;
}

export function isLegacyWindowsStartCommandLine(commandLine: string): boolean {
  if (commandLine.length > 64 * 1024) return false;
  const argv = windowsArgv(commandLine);
  const command = ocxCommandIndex(argv);
  return command !== undefined && argv[command] === "start";
}

function ocxCommandIndex(argv: readonly string[]): number | undefined {
  let next = 1;
  if (/^bun(?:\.exe)?$/.test(basename(argv[0] ?? ""))) {
    if (argv[next] === "run") next++;
    const script = argv[next++]?.replace(/\\/g, "/");
    if (!script || !/(?:^|\/)src\/cli(?:\/index)?\.ts$/i.test(script)) return;
  } else if (!/^(?:ocx|opencodex)(?:\.exe)?$/.test(basename(argv[0] ?? ""))) return;
  // npm inserts this one token before the command. Its spelling is not proof of
  // launcher trust; the current runtime fence and same-user live owner are separate.
  if (argv[next]?.startsWith(NODE_LAUNCH_PROOF_PREFIX)) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(argv[next]!.slice(NODE_LAUNCH_PROOF_PREFIX.length))) return;
    next++;
  }
  return next;
}

/** Creation identity and same-user ownership, sampled freshly for each destructive boundary. */
export function readClientStopProcessStart(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return;
  try {
    if (process.platform === "darwin") return readDarwinStopStart(pid);
    if (process.platform === "linux") {
      const dir = `/proc/${pid}`;
      if (statSync(dir).uid !== process.geteuid?.()) return;
      const stat = readBoundedRegularFileSync(`${dir}/stat`, 4096).toString();
      const end = stat.lastIndexOf(") ");
      const ticks = end < 0 ? undefined : stat.slice(end + 2).trim().split(/\s+/)[19];
      const boot = readBoundedRegularFileSync("/proc/sys/kernel/random/boot_id", 64).toString().trim();
      if (ticks && /^\d+$/.test(ticks) && /^[a-f0-9-]{36}$/.test(boot)) return `linux:${boot}:${ticks}`;
    }
    if (process.platform === "win32") {
      const ticks = windowsProcessNative()?.sameUserStartTicks?.(pid);
      if (typeof ticks === "bigint" && ticks > 0n && ticks <= 3155378975999999999n) return `win32:${ticks}`;
    }
  } catch { /* unreadable ownership cannot authorize a native restoration handoff */ }
}

/** Read only the home settings needed to bind a legacy record to its invoking process. */
export function readLegacyStopProcessHome(pid: number): string | undefined {
  try {
    const environment = process.platform === "linux" ? readBoundedRegularFileSync(`/proc/${pid}/environ`, 1024 * 1024)
      : process.platform === "darwin" ? readDarwinStopEnvironment(pid) : undefined;
    if (!environment?.length || environment[environment.length - 1] !== 0) return;
    const setting = (name: string) => {
      const prefix = Buffer.from(`${name}=`);
      for (let offset = 0; offset < environment.length;) {
        const end = environment.indexOf(0, offset);
        if (end < 0) break;
        if (offset + prefix.length <= end && environment.subarray(offset, offset + prefix.length).equals(prefix)) {
          return new TextDecoder("utf-8", { fatal: true }).decode(environment.subarray(offset + prefix.length, end)).trim();
        }
        offset = end + 1;
      }
    };
    const override = setting("OPENCODEX_HOME");
    if (override && isAbsolute(override)) return resolve(override);
    if (override && override !== "~" && !override.startsWith("~/") && !override.startsWith("~\\")) {
      const cwd = process.platform === "linux"
        ? new TextDecoder("utf-8", { fatal: true }).decode(readlinkSync(`/proc/${pid}/cwd`, { encoding: "buffer" }))
        : readDarwinStopCwd(pid);
      // procfs appends this marker when the working directory has been removed.
      if (cwd && isAbsolute(cwd) && !(process.platform === "linux" && cwd.endsWith(" (deleted)"))) return resolve(cwd, override);
      return;
    }
    const home = setting("HOME");
    if (!home || !isAbsolute(home)) return;
    if (!override) return join(home, ".opencodex");
    return override === "~" ? resolve(home) : join(home, override.slice(2));
  } catch { /* An unreadable home cannot bind a legacy record. */ }
}

export type ClientStopOwnerStatus = "active" | "confirmed-stale" | "unverified";

const creationIdentity: Partial<Record<NodeJS.Platform, RegExp>> = {
  darwin: /^darwin:([1-9]\d{0,19}):(?:0|[1-9]\d{0,5})$/,
  linux: /^linux:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:(0|[1-9]\d{0,19})$/,
  win32: /^win32:([1-9]\d{0,18})$/,
};

function validCreationIdentity(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 80) return false;
  const ticks = creationIdentity[process.platform]?.exec(value)?.[1];
  return ticks !== undefined && BigInt(ticks) <= (process.platform === "win32" ? 3155378975999999999n : 0xffffffffffffffffn);
}

/** Bracket argv with creation/UID reads so a recycled PID cannot inherit the fence. */
export function observeClientStopOwner({ pid, startTime, nonce }: ClientStopOwner): ClientStopOwnerStatus {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff
    || !validCreationIdentity(startTime)
    || typeof nonce !== "string" || !/^[a-f0-9]{32}$/.test(nonce)) return "unverified";
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "confirmed-stale" : "unverified"; }
  const before = readClientStopProcessStart(pid);
  if (before === undefined) return "unverified";
  if (before !== startTime) return "confirmed-stale";
  if (pid === process.pid) return "unverified";
  try {
    let stop: boolean;
    if (process.platform === "linux") {
      // /proc exposes argv, not a quoted command line. Preserve NUL boundaries:
      // install paths and approval values can legitimately contain spaces.
      const raw = new TextDecoder("utf8", { fatal: true }).decode(readBoundedRegularFileSync(`/proc/${pid}/cmdline`, 64 * 1024));
      if (raw.length <= 1 || !raw.endsWith("\0")) return "unverified";
      stop = isClientStopArgv(raw.slice(0, -1).split("\0"));
    } else if (process.platform === "darwin") {
      const argv = readDarwinStopArgv(pid);
      if (!argv?.length) return "unverified";
      stop = isClientStopArgv(argv);
    } else {
      const commandLine = readProcessCommandLine(pid);
      if (!commandLine?.trim() || commandLine.length > 64 * 1024) return "unverified";
      stop = isClientStopCommandLine(commandLine);
    }
    const after = readClientStopProcessStart(pid);
    if (after === undefined) return "unverified";
    if (after !== startTime) return "confirmed-stale";
    return stop ? "active" : "unverified";
  } catch { return "unverified"; }
}
