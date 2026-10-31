/** Remote platform is discovered only through the link's pinned SSH host key. */
import { buildExecArgv, buildWindowsProbeArgv, REMOTE_COMMAND_NOT_FOUND, REMOTE_PLATFORM_UNSUPPORTED } from "./ssh-argv";
import type { SshRunner, SshRunResult } from "./ssh-runner";

export type RemotePlatform = "windows" | "posix" | "unknown";

const WINDOWS_UNAME = /^(?:Windows|MSYS|MINGW|CYGWIN)/i;
const POSIX_UNAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
// Windows PowerShell says "the name of a cmdlet", PowerShell 7 "a name of a cmdlet". Localized
// installs say neither, which is what confirmWindowsShell is for.
const WINDOWS_SHELL_REFUSAL = /is not recognized as (?:an internal or external command|(?:the|a) name of a cmdlet)/i;
/** ssh's own failure status: the remote shell never ran, so there is nothing to ask. */
const SSH_TRANSPORT_FAILURE = 255;

/** Remote argv that prints the kernel name; under cmd or PowerShell, `sh` itself is refused. */
export const REMOTE_UNAME_ARGV: readonly string[] = ["sh", "-c", "uname -s 2>/dev/null", "ocx-platform"];

/** Does this output come from cmd.exe or PowerShell refusing a POSIX command? */
export function isWindowsShellRefusal(output: string): boolean {
  return WINDOWS_SHELL_REFUSAL.test(output);
}

/** Classify one remote command result. Transport failures and odd output stay unknown. */
export function classifyRemotePlatform(result: SshRunResult): RemotePlatform {
  if (result.code === REMOTE_PLATFORM_UNSUPPORTED) return "windows";
  if (isWindowsShellRefusal(result.stderr) || isWindowsShellRefusal(result.stdout)) return "windows";
  if (result.code !== 0) return "unknown";
  const name = result.stdout.trim().split(/\r?\n/)[0] ?? "";
  if (WINDOWS_UNAME.test(name)) return "windows";
  return POSIX_UNAME.test(name) ? "posix" : "unknown";
}

/**
 * Could this failure be a Windows shell whose refusal text is localized? Success, the prelude's own
 * 125/127 answers and ssh transport failures are already explained, so they never cost another call.
 */
export function mayBeWindowsShell(result: SshRunResult): boolean {
  return result.code !== 0 && result.code !== REMOTE_PLATFORM_UNSUPPORTED
    && result.code !== REMOTE_COMMAND_NOT_FOUND && result.code !== SSH_TRANSPORT_FAILURE;
}

/** Ask the host the fixed, locale-independent WINDOWS_OS_PROBE. Any failure answers false. */
export async function confirmWindowsShell(runner: SshRunner, alias: string, knownHostsFile: string, timeoutMs = 30_000): Promise<boolean> {
  try {
    const result = await runner.run(buildWindowsProbeArgv({ alias, knownHostsFile }), { timeoutMs });
    return result.code === 0 && result.stdout.trim().split(/\r?\n/)[0]?.trim() === "Windows_NT";
  } catch { return false; }
}

/** classifyRemotePlatform, plus the locale-independent follow-up when the answer could be Windows. */
export async function detectRemotePlatform(runner: SshRunner, alias: string, knownHostsFile: string, result: SshRunResult): Promise<RemotePlatform> {
  const platform = classifyRemotePlatform(result);
  if (platform !== "unknown" || !mayBeWindowsShell(result)) return platform;
  return await confirmWindowsShell(runner, alias, knownHostsFile) ? "windows" : "unknown";
}

/** Windows when the fixed %OS% probe answers Windows_NT, otherwise POSIX from uname; never a guess. */
export async function requireRemotePlatform(runner: Pick<SshRunner, "run">, alias: string, knownHostsFile: string): Promise<"posix" | "windows"> {
  const windows = await runner.run(buildWindowsProbeArgv({ alias, knownHostsFile }), { timeoutMs: 10_000 });
  if (windows.code === 255) throw new Error("SSH platform discovery failed");
  if (windows.code === 0 && windows.stdout.trim() === "Windows_NT") return "windows";
  const result = await runner.run(buildExecArgv({ alias, knownHostsFile, argv: REMOTE_UNAME_ARGV }), { timeoutMs: 10_000 });
  const platform = classifyRemotePlatform(result);
  if (platform === "unknown") throw new Error("Remote platform could not be determined");
  return platform;
}
