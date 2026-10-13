/**
 * The user's login-shell PATH, for installers the dashboard runs under OpenCodex Desktop (#6971).
 *
 * A Finder or login launch gives the Desktop app, and so its proxy sidecar, only the system PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`). `ocx codex-shim install` scans PATH for the native Codex
 * launcher, so from the dashboard it reported "Native Codex launcher not found" for Homebrew, npm,
 * bun, nvm, fnm, volta and mise installs, and an npm launcher had no `node` for its probe.
 *
 * This asks the user's shell once, as an interactive login shell would start, and keeps only PATH:
 * the value is framed by markers so startup-file output cannot leak into it. The read has a
 * deadline, runs in its own process group so a hung startup file is killed with all of its
 * children, and its result, including failure, is cached so repeated dashboard actions do not
 * spawn shells. It is scoped to the shim installer's child environment; the service definition's
 * PATH has its own policy.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { userInfo } from "node:os";
import { basename, isAbsolute } from "node:path";

const BEGIN = "__OCX_LOGIN_PATH_BEGIN__";
const END = "__OCX_LOGIN_PATH_END__";
export const LOGIN_SHELL_PATH_TIMEOUT_MS = 5_000;
export const LOGIN_SHELL_PATH_CACHE_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
/** After the shell exits, how long its stdout may stay open before a background job is assumed to hold it. */
const STDOUT_DRAIN_MS = 500;

export function loginShellPathArgs(shell: string): string[] {
  const print = basename(shell) === "fish"
    ? `printf '%s%s%s\\n' ${BEGIN} (string join : $PATH) ${END}`
    : `printf '%s%s%s\\n' ${BEGIN} "$PATH" ${END}`;
  return ["-l", "-i", "-c", print];
}

/** The framed PATH, only when every entry is absolute. */
export function parseLoginShellPath(output: string): string | null {
  const start = output.lastIndexOf(BEGIN);
  if (start < 0) return null;
  const end = output.indexOf(END, start + BEGIN.length);
  if (end < 0) return null;
  const value = output.slice(start + BEGIN.length, end);
  if (!value || /[\r\n\0]/.test(value)) return null;
  const entries = value.split(":").filter(Boolean);
  return entries.length > 0 && entries.every(entry => isAbsolute(entry)) ? entries.join(":") : null;
}

/** Ordered union: the shell's entries first, then any the process had that the shell did not. */
export function mergePathLists(preferred: string, fallback: string | undefined): string {
  // POSIX only: the login shell runs on macOS and Linux, where PATH is colon-separated.
  return [...new Set([...preferred.split(":"), ...(fallback ?? "").split(":")].filter(Boolean))].join(":");
}

export interface LoginShellPathDeps {
  platform?: NodeJS.Platform;
  shell?: string | null;
  env?: NodeJS.ProcessEnv;
  spawn?: (command: string, args: string[], options: Parameters<typeof nodeSpawn>[2]) => ChildProcess;
  killGroup?: (pid: number) => void;
  timeoutMs?: number;
  now?: () => number;
}

let cached: { at: number; value: string | null } | null = null;

export function resetLoginShellPathCacheForTests(): void {
  cached = null;
}

function defaultShell(env: NodeJS.ProcessEnv): string | null {
  const fromEnv = env.SHELL?.trim();
  if (fromEnv && isAbsolute(fromEnv)) return fromEnv;
  try {
    const shell = userInfo().shell;
    return shell && isAbsolute(shell) ? shell : null;
  } catch { return null; }
}

function killProcessGroup(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
}

export async function readLoginShellPath(deps: LoginShellPathDeps = {}): Promise<string | null> {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return null;
  const now = deps.now ?? Date.now;
  if (cached && now() - cached.at < LOGIN_SHELL_PATH_CACHE_MS) return cached.value;
  const env = deps.env ?? process.env;
  const shell = deps.shell === undefined ? defaultShell(env) : deps.shell;
  const value = shell ? await probe(shell, env, deps) : null;
  cached = { at: now(), value };
  return value;
}

function probe(shell: string, env: NodeJS.ProcessEnv, deps: LoginShellPathDeps): Promise<string | null> {
  const spawn = deps.spawn ?? nodeSpawn;
  const killGroup = deps.killGroup ?? killProcessGroup;
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawn(shell, loginShellPathArgs(shell), {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
        // Only what a login shell needs to find its startup files; no proxy or credential state.
        env: Object.fromEntries(Object.entries({
          HOME: env.HOME, USER: env.USER, LOGNAME: env.LOGNAME, SHELL: shell, LANG: env.LANG,
          PATH: env.PATH, TERM: "dumb",
        }).filter(([, value]) => value !== undefined)) as NodeJS.ProcessEnv,
      });
    } catch { resolve(null); return; }
    let output = "";
    let settled = false;
    let exitCode: number | null = null;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | null, killGroupMembers: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      // A hung startup file, or a background job still holding the pipe, is killed with its group.
      // A shell that exited and closed its output is left alone: its group id may already be free.
      if (killGroupMembers && child.pid) killGroup(child.pid);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null, true), deps.timeoutMs ?? LOGIN_SHELL_PATH_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > MAX_OUTPUT_BYTES) finish(null, true);
    });
    const parsed = () => exitCode === 0 ? parseLoginShellPath(output) : null;
    child.once("error", () => finish(null, true));
    // Parse only after stdout closes: `exit` can arrive before the last chunk.
    child.once("close", code => { exitCode ??= code; finish(parsed(), false); });
    child.once("exit", code => {
      exitCode = code;
      drain = setTimeout(() => finish(parsed(), true), STDOUT_DRAIN_MS);
    });
  });
}

/** `env` with the login-shell PATH in front, or unchanged when it cannot be read. */
export async function withLoginShellPath(env: NodeJS.ProcessEnv, deps: LoginShellPathDeps = {}): Promise<NodeJS.ProcessEnv> {
  const loginPath = await readLoginShellPath({ ...deps, env });
  return loginPath ? { ...env, PATH: mergePathLists(loginPath, env.PATH) } : env;
}

