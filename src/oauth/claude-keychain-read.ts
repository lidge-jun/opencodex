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
import { execFileSync, spawn } from "node:child_process";

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
export const CLAUDE_KEYCHAIN_TIMEOUT_MS = 5_000;
export const CLAUDE_KEYCHAIN_BACKOFF_MS = 60_000;
const SECURITY_ARGS = ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"] as const;
/** The credential is a small JSON blob; anything larger is not a credential. */
const MAX_STDOUT_BYTES = 1024 * 1024;

interface UnrefHandle { unref?(): unknown }

/** The subset of a spawned child the reader relies on. */
export interface KeychainChild extends UnrefHandle {
  /** Set once the process exists; undefined when the spawn itself failed. */
  pid?: number | undefined;
  stdout: (UnrefHandle & { on(event: "data", listener: (chunk: Buffer | string) => void): unknown }) | null;
  once(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface ClaudeKeychainReaderDeps {
  platform: string;
  spawn(command: string, args: readonly string[]): KeychainChild;
  /** Synchronous run with a timeout; returns stdout and throws on a nonzero exit or a timeout. */
  execSync(command: string, args: readonly string[], timeoutMs: number): string;
  now(): number;
  /** Runs `fn` after `ms`; returns a cancel function. */
  schedule(ms: number, fn: () => void): () => void;
  timeoutMs?: number;
  backoffMs?: number;
}

export interface ClaudeKeychainReader {
  /** Resolves the item's secret, or null on absence, failure, timeout, backoff or a non-darwin host. */
  readAsync(): Promise<string | null>;
  /**
   * Synchronous read. It cannot time out without killing its child, so it does not run while a
   * child is still running or a backoff is active, and its own timeout starts the backoff.
   */
  readSync(): string | null;
  /** True while a child is still running or a timeout backoff is active. */
  syncReadBlocked(): boolean;
  /**
   * Record a timeout of another synchronous Keychain lookup (the metadata probe), so it starts
   * the same backoff and no read or probe spawns again inside that window.
   */
  noteSyncTimeout(): void;
}

export function createClaudeKeychainReader(deps: ClaudeKeychainReaderDeps): ClaudeKeychainReader {
  const timeoutMs = deps.timeoutMs ?? CLAUDE_KEYCHAIN_TIMEOUT_MS;
  const backoffMs = deps.backoffMs ?? CLAUDE_KEYCHAIN_BACKOFF_MS;
  let backoffUntil = 0;
  // Held until the child exits, not until the caller's promise settles: a child that
  // outlives its deadline is still blocked on the prompt and must not get a sibling. Only the
  // owning child may release it, so a late event from an earlier child cannot free the slot.
  let runningChild: KeychainChild | undefined;
  let pending: Promise<string | null> | undefined;

  const backingOff = (): boolean => deps.now() < backoffUntil;
  const startBackoff = (): void => { backoffUntil = deps.now() + backoffMs; };

  function readAsync(): Promise<string | null> {
    if (deps.platform !== "darwin") return Promise.resolve(null);
    if (pending) return pending;
    if (runningChild || backingOff()) return Promise.resolve(null);

    let child: KeychainChild;
    try {
      child = deps.spawn("security", SECURITY_ARGS);
    } catch {
      return Promise.resolve(null);
    }
    runningChild = child;
    const release = (): void => { if (runningChild === child) runningChild = undefined; };
    const read = new Promise<string | null>(resolve => {
      let settled = false;
      const chunks: Buffer[] = [];
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
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        stdoutBytes += bytes.length;
        if (stdoutBytes <= MAX_STDOUT_BYTES) chunks.push(bytes);
      });
      child.once("error", () => {
        // Once a process exists, an error event does not prove it ended; only its own close may
        // release the slot, or a second child could start beside one still blocked on the prompt.
        if (child.pid === undefined) release();
        settle(null);
      });
      // `close`, not `exit`: `exit` can fire before stdout is drained, which would truncate
      // the credential. Decode once so a multi-byte character split across chunks survives.
      child.once("close", code => {
        release();
        if (code !== 0 || stdoutBytes > MAX_STDOUT_BYTES) return settle(null);
        settle(Buffer.concat(chunks).toString("utf8").trim() || null);
      });
    });
    pending = read;
    return read;
  }

  function readSync(): string | null {
    if (deps.platform !== "darwin" || runningChild || backingOff()) return null;
    try {
      return deps.execSync("security", SECURITY_ARGS, timeoutMs).trim() || null;
    } catch (error) {
      if (isSyncTimeout(error)) startBackoff();
      return null;
    }
  }

  return {
    readAsync,
    readSync,
    syncReadBlocked: () => runningChild !== undefined || backingOff(),
    noteSyncTimeout: startBackoff,
  };
}

/** `execFileSync` reports its own timeout as ETIMEDOUT or a kill signal; a nonzero exit is not one. */
export function isSyncTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, signal } = error as { code?: unknown; signal?: unknown };
  return code === "ETIMEDOUT" || (typeof signal === "string" && signal.length > 0);
}

/** The process-wide reader: one Keychain child and one backoff window per process. */
export const claudeKeychainReader = createClaudeKeychainReader({
  platform: process.platform,
  spawn: (command, args) => spawn(command, [...args], { stdio: ["ignore", "pipe", "ignore"] }),
  execSync: (command, args, timeoutMs) =>
    execFileSync(command, [...args], { encoding: "utf8", timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"] }),
  now: () => Date.now(),
  schedule(ms, fn) {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
});
