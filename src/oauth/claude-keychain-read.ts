/**
 * Claude Code Keychain reads that never kill a blocked `security` child.
 *
 * With a locked login keychain, `security find-generic-password -w` blocks on the
 * SecurityAgent unlock prompt. Killing it while that prompt is pending hits a race in
 * Apple's `securityd`, which aborts and re-locks the keychain, so the next read prompts
 * again (#8161). This reader gives up on a slow read without signalling the child, keeps
 * at most one child per process, and backs off after a timeout so a locked keychain does
 * not get one prompt per request.
 */
import { spawn } from "node:child_process";

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
export const CLAUDE_KEYCHAIN_TIMEOUT_MS = 5_000;
export const CLAUDE_KEYCHAIN_BACKOFF_MS = 60_000;
/** The credential is a small JSON blob; anything larger is not a credential. */
const MAX_STDOUT_BYTES = 1024 * 1024;

interface UnrefHandle { unref?(): unknown }

/** The subset of a spawned child the reader relies on. */
export interface KeychainChild extends UnrefHandle {
  stdout: (UnrefHandle & { on(event: "data", listener: (chunk: Buffer | string) => void): unknown }) | null;
  once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface ClaudeKeychainReaderDeps {
  platform: string;
  spawn(command: string, args: readonly string[]): KeychainChild;
  now(): number;
  /** Runs `fn` after `ms`; returns a cancel function. */
  schedule(ms: number, fn: () => void): () => void;
  timeoutMs?: number;
  backoffMs?: number;
}

export interface ClaudeKeychainReader {
  /** Resolves the item's secret, or null on absence, failure, timeout, backoff or a non-darwin host. */
  readAsync(): Promise<string | null>;
  /** True while a child is still running or a timeout backoff is active; sync readers must not spawn. */
  syncReadBlocked(): boolean;
  /** Records a timeout from a synchronous reader, which cannot time out without killing its child. */
  noteSyncTimeout(): void;
}

export function createClaudeKeychainReader(deps: ClaudeKeychainReaderDeps): ClaudeKeychainReader {
  const timeoutMs = deps.timeoutMs ?? CLAUDE_KEYCHAIN_TIMEOUT_MS;
  const backoffMs = deps.backoffMs ?? CLAUDE_KEYCHAIN_BACKOFF_MS;
  let backoffUntil = 0;
  // Held until the child exits, not until the caller's promise settles: a child that
  // outlives its deadline is still blocked on the prompt and must not get a sibling.
  let childRunning = false;
  let pending: Promise<string | null> | undefined;

  const backingOff = (): boolean => deps.now() < backoffUntil;
  const startBackoff = (): void => { backoffUntil = deps.now() + backoffMs; };

  function readAsync(): Promise<string | null> {
    if (deps.platform !== "darwin") return Promise.resolve(null);
    if (pending) return pending;
    if (childRunning || backingOff()) return Promise.resolve(null);

    let child: KeychainChild;
    try {
      child = deps.spawn("security", ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"]);
    } catch {
      return Promise.resolve(null);
    }
    childRunning = true;
    const read = new Promise<string | null>(resolve => {
      let settled = false;
      let stdout = "";
      let stdoutBytes = 0;
      const settle = (value: string | null): void => {
        if (settled) return;
        settled = true;
        cancelDeadline();
        pending = undefined;
        resolve(value);
      };
      const cancelDeadline = deps.schedule(timeoutMs, () => {
        // Give up without signalling the child, and let it exit on its own once the
        // prompt is answered or dismissed. Unref it so it cannot hold this process open.
        startBackoff();
        child.unref?.();
        child.stdout?.unref?.();
        settle(null);
      });
      child.stdout?.on("data", chunk => {
        stdoutBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
        if (stdoutBytes <= MAX_STDOUT_BYTES) stdout += chunk.toString();
      });
      child.once("error", () => {
        childRunning = false;
        settle(null);
      });
      child.once("exit", code => {
        childRunning = false;
        if (code !== 0 || stdoutBytes > MAX_STDOUT_BYTES) return settle(null);
        settle(stdout.trim() || null);
      });
    });
    pending = read;
    return read;
  }

  return {
    readAsync,
    syncReadBlocked: () => childRunning || backingOff(),
    noteSyncTimeout: startBackoff,
  };
}

/** `execSync` reports its own timeout as ETIMEDOUT or a kill signal; a nonzero exit is not one. */
export function isSyncTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, signal } = error as { code?: unknown; signal?: unknown };
  return code === "ETIMEDOUT" || (typeof signal === "string" && signal.length > 0);
}

/** The process-wide reader: one Keychain child and one backoff window per process. */
export const claudeKeychainReader = createClaudeKeychainReader({
  platform: process.platform,
  spawn: (command, args) => spawn(command, [...args], { stdio: ["ignore", "pipe", "ignore"] }),
  now: () => Date.now(),
  schedule(ms, fn) {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
});
