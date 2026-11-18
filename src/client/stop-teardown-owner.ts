import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { NODE_LAUNCH_PROOF_PREFIX } from "../cli/launcher-context";
import { parseStopApproval } from "../cli/stop-approval";
import { tokenizeCommandLine } from "../codex/app-server-processes";
import { readProcessCommandLine } from "../config/process-state";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";
import { isProcessAlive } from "../lib/process-control";
import { resolveTrustedWindowsPowerShellExe } from "../lib/windows-elevation";

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

function sameProcessUser(pid: number): boolean {
  try {
    const uid = process.getuid?.();
    if (process.platform === "linux") return uid !== undefined && statSync(`/proc/${pid}`).uid === uid;
    const options = { encoding: "utf8" as const, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"], timeout: 3000, windowsHide: true };
    if (process.platform === "darwin") {
      return uid !== undefined && execFileSync("/bin/ps", ["-p", String(pid), "-o", "uid="], options).trim() === String(uid);
    }
    if (process.platform === "win32") {
      const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; $owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { 'same-user' }`;
      return execFileSync(resolveTrustedWindowsPowerShellExe(), ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", script], options).trim() === "same-user";
    }
  } catch { /* unreadable ownership cannot authorize a native restoration handoff */ }
  return false;
}

/** Fresh observations, never the start-process cache or a bare PID liveness claim. */
export function isLiveClientStopOwner(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || !isProcessAlive(pid) || !sameProcessUser(pid)) return false;
  let stop = false;
  if (process.platform === "linux") {
    try {
      // /proc exposes argv, not a quoted command line. Preserve NUL boundaries:
      // install paths and approval values can legitimately contain spaces.
      const raw = new TextDecoder("utf8", { fatal: true }).decode(readBoundedRegularFileSync(`/proc/${pid}/cmdline`, 64 * 1024));
      if (raw.endsWith("\0")) stop = isClientStopArgv(raw.slice(0, -1).split("\0"));
    } catch { /* unreadable argv cannot identify a parent stop */ }
  } else {
    const commandLine = readProcessCommandLine(pid);
    stop = commandLine !== undefined && isClientStopCommandLine(commandLine);
  }
  return stop && sameProcessUser(pid) && isProcessAlive(pid);
}
