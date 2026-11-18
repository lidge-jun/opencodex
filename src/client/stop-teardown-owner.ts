import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { NODE_LAUNCH_PROOF_PREFIX } from "../cli/launcher-context";
import { parseStopApproval } from "../cli/stop-approval";
import { tokenizeCommandLine } from "../codex/app-server-processes";
import { readProcessCommandLine, type ClientStopOwner } from "../config/process-state";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";
import { resolveTrustedWindowsPowerShellExe } from "../lib/windows-elevation";
import { readDarwinStopArgv, readDarwinStopStart } from "./stop-darwin-process";

const basename = (value: string) => value.toLowerCase().replace(/\\/g, "/").split("/").pop() ?? "";

/** Recognize the invocation that sets the native Child's explicit-stop fence, not any ocx. */
export function isClientStopCommandLine(commandLine: string): boolean {
  if (commandLine.length > 64 * 1024) return false;
  return isClientStopArgv(tokenizeCommandLine(commandLine));
}

export function isClientStopArgv(argv: readonly string[]): boolean {
  let next = 1;
  if (/^bun(?:\.exe)?$/.test(basename(argv[0] ?? ""))) {
    if (argv[next] === "run") next++;
    const script = argv[next++]?.replace(/\\/g, "/");
    if (!script || !/(?:^|\/)src\/cli(?:\/index)?\.ts$/i.test(script)) return false;
  } else if (!/^(?:ocx|opencodex)(?:\.exe)?$/.test(basename(argv[0] ?? ""))) return false;
  // npm inserts this one token before the command. Its spelling is not proof of
  // launcher trust; the current runtime fence and same-user live owner are separate.
  if (argv[next]?.startsWith(NODE_LAUNCH_PROOF_PREFIX)) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(argv[next]!.slice(NODE_LAUNCH_PROOF_PREFIX.length))) return false;
    next++;
  }
  return argv[next] === "stop" && parseStopApproval(argv.slice(next + 1)).ok;
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
      const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; $owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value -and $p.CreationDate) { $p.CreationDate.ToUniversalTime().Ticks }`;
      const ticks = execFileSync(resolveTrustedWindowsPowerShellExe(), ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", script], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000, maxBuffer: 1024, windowsHide: true,
      }).trim();
      if (/^\d{1,20}$/.test(ticks)) return `win32:${ticks}`;
    }
  } catch { /* unreadable ownership cannot authorize a native restoration handoff */ }
}

/** Bracket argv with creation/UID reads so a recycled PID cannot inherit the fence. */
export function isLiveClientStopOwner({ pid, startTime }: ClientStopOwner): boolean {
  if (pid === process.pid || readClientStopProcessStart(pid) !== startTime) return false;
  try {
    let stop: boolean;
    if (process.platform === "linux") {
      // /proc exposes argv, not a quoted command line. Preserve NUL boundaries:
      // install paths and approval values can legitimately contain spaces.
      const raw = new TextDecoder("utf8", { fatal: true }).decode(readBoundedRegularFileSync(`/proc/${pid}/cmdline`, 64 * 1024));
      stop = raw.endsWith("\0") && isClientStopArgv(raw.slice(0, -1).split("\0"));
    } else if (process.platform === "darwin") {
      const argv = readDarwinStopArgv(pid);
      stop = argv !== undefined && isClientStopArgv(argv);
    } else {
      const commandLine = readProcessCommandLine(pid);
      stop = commandLine !== undefined && isClientStopCommandLine(commandLine);
    }
    return stop && readClientStopProcessStart(pid) === startTime;
  } catch { return false; }
}
