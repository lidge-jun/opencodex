/**
 * Claude Code Keychain lookups that never kill a blocked `security` child.
 *
 * With a locked login keychain, `security find-generic-password` blocks on the SecurityAgent
 * unlock prompt. Killing it while that prompt is pending hits a race in Apple's `securityd`,
 * which aborts and re-locks the keychain, so the next lookup prompts again (#8161). Every lookup
 * here is asynchronous: a slow one is given up without signalling its child, at most one child
 * runs per process, and a timeout backs off so a locked keychain does not get one prompt per
 * request. A synchronous lookup cannot be bounded without killing its child, so there is none.
 */
import { spawn } from "node:child_process";

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
export const CLAUDE_KEYCHAIN_TIMEOUT_MS = 5_000;
/** The metadata probe answers a settings page and a launch, so it waits less than a read. */
export const CLAUDE_KEYCHAIN_PROBE_TIMEOUT_MS = 1_500;
export const CLAUDE_KEYCHAIN_BACKOFF_MS = 60_000;
const READ_ARGS = ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"] as const;
/** Metadata only: no `-w` and no `-g`, because those print the secret. Only the exit code matters. */
const PROBE_ARGS = ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE] as const;
/** `security` exit code for "the item does not exist": a real absent, not a failure. */
const ITEM_NOT_FOUND = 44;
/** The credential is a small JSON blob; anything larger is not a credential. */
const MAX_STDOUT_BYTES = 1024 * 1024;

/** present/absent from the exit code; unknown when the lookup did not answer. Never absent on doubt. */
export type ClaudeKeychainPresence = "present" | "absent" | "unknown";

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
  /** `captureStdout` is false for the metadata probe: its stdout and stderr are discarded. */
  spawn(command: string, args: readonly string[], captureStdout: boolean): KeychainChild;
  now(): number;
  /** Runs `fn` after `ms`; returns a cancel function. */
  schedule(ms: number, fn: () => void): () => void;
  timeoutMs?: number;
  probeTimeoutMs?: number;
  backoffMs?: number;
}

export interface ClaudeKeychainReader {
  /** Resolves the item's secret, or null on absence, failure, timeout, backoff or a non-darwin host. */
  readAsync(): Promise<string | null>;
  /**
   * Whether the item exists, from `security`'s exit code alone: absent on a non-darwin host,
   * unknown on a timeout, a busy slot, an active backoff or any other failure.
   */
  probe(): Promise<ClaudeKeychainPresence>;
}

type LookupOutcome = { code: number | null; stdout: Buffer | null } | null;

export function createClaudeKeychainReader(deps: ClaudeKeychainReaderDeps): ClaudeKeychainReader {
  const timeoutMs = deps.timeoutMs ?? CLAUDE_KEYCHAIN_TIMEOUT_MS;
  const probeTimeoutMs = deps.probeTimeoutMs ?? CLAUDE_KEYCHAIN_PROBE_TIMEOUT_MS;
  const backoffMs = deps.backoffMs ?? CLAUDE_KEYCHAIN_BACKOFF_MS;
  let backoffUntil = 0;
  // The one admission slot for reads and probes alike. Held until the child exits, not until the
  // caller's promise settles: a child that outlives its deadline is still blocked on the prompt
  // and must not get a sibling. Only the owning child may release it, so a late event from an
  // earlier child cannot free the slot.
  let runningChild: KeychainChild | undefined;
  let pendingRead: Promise<string | null> | undefined;
  let pendingProbe: Promise<ClaudeKeychainPresence> | undefined;

  const backingOff = (): boolean => deps.now() < backoffUntil;

  /** One lookup under the slot; null when it was not admitted, failed to start, or timed out. */
  function lookup(args: readonly string[], captureStdout: boolean, deadlineMs: number): Promise<LookupOutcome> {
    if (runningChild || backingOff()) return Promise.resolve(null);
    let child: KeychainChild;
    try {
      child = deps.spawn("security", args, captureStdout);
    } catch {
      return Promise.resolve(null);
    }
    runningChild = child;
    const release = (): void => { if (runningChild === child) runningChild = undefined; };
    return new Promise<LookupOutcome>(resolve => {
      let settled = false;
      const chunks: Buffer[] = [];
      let stdoutBytes = 0;
      const settle = (value: LookupOutcome): void => {
        if (settled) return;
        settled = true;
        cancelDeadline();
        resolve(value);
      };
      const cancelDeadline = deps.schedule(deadlineMs, () => {
        // Give up without signalling the child, and let it exit on its own once the prompt is
        // answered or dismissed. Unref it so it cannot hold this process open.
        backoffUntil = deps.now() + backoffMs;
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
      // `close`, not `exit`: `exit` can fire before stdout is drained, which would truncate the
      // credential. Decode once so a multi-byte character split across chunks survives.
      child.once("close", code => {
        release();
        settle({ code, stdout: !captureStdout || stdoutBytes > MAX_STDOUT_BYTES ? null : Buffer.concat(chunks) });
      });
    });
  }

  function readAsync(): Promise<string | null> {
    if (deps.platform !== "darwin") return Promise.resolve(null);
    if (pendingRead) return pendingRead;
    // A probe holding the slot is waited out (it settles within its own deadline) instead of
    // making this read look like an absent credential; a probe that timed out leaves its child
    // running and the backoff active, so the read then declines exactly as it would under backoff.
    // Do not wait for that child too: it may be blocked on an unlock prompt indefinitely, and a
    // second child beside it is what the single slot exists to prevent.
    const started = pendingProbe
      ? pendingProbe.then(() => lookup(READ_ARGS, true, timeoutMs))
      : lookup(READ_ARGS, true, timeoutMs);
    const read = started.then(outcome => {
      pendingRead = undefined;
      if (outcome?.code !== 0 || !outcome.stdout) return null;
      return outcome.stdout.toString("utf8").trim() || null;
    });
    pendingRead = read;
    return read;
  }

  function probe(): Promise<ClaudeKeychainPresence> {
    if (deps.platform !== "darwin") return Promise.resolve("absent");
    if (pendingProbe) return pendingProbe;
    const probed = lookup(PROBE_ARGS, false, probeTimeoutMs).then((outcome): ClaudeKeychainPresence => {
      pendingProbe = undefined;
      if (outcome?.code === 0) return "present";
      if (outcome?.code === ITEM_NOT_FOUND) return "absent";
      return "unknown";
    });
    pendingProbe = probed;
    return probed;
  }

  return { readAsync, probe };
}

/** The process-wide reader: one Keychain child and one backoff window per process. */
export const claudeKeychainReader = createClaudeKeychainReader({
  platform: process.platform,
  spawn: (command, args, captureStdout) =>
    spawn(command, [...args], { stdio: ["ignore", captureStdout ? "pipe" : "ignore", "ignore"] }),
  now: () => Date.now(),
  schedule(ms, fn) {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
});
