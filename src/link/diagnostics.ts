import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDirAsync, hardenSecretPathAsync, reattributeHardenedSecretPath, windowsSecretAclApplies } from "../lib/windows-secret-acl";
import { linkDir } from "./paths";
import type { TunnelState } from "./tunnel-state";

export type LinkDiagnosticRecord = {
  event: "owner_lookup" | "relay_retry" | "relay_failure" | "relay_recovered" | "tunnel_transition";
  outcome: "match" | "mismatch" | "lookup_error" | "deadline" | "stale" | "unavailable"
    | "identity_unknown" | "identity_mismatch" | "auth_timeout" | "auth_failed"
    | "transport_error" | "client_abort" | "header_timeout" | "recovered"
    // tunnel_transition: the Home's -R tunnel changed state, and why (src/link/tunnel-history.ts).
    | "connected" | "spawned" | "stopped" | "auth" | "hostkey" | "forward" | "remote_forward_conflict"
    | "timeout" | "network" | "unknown" | "spawn_failed" | "listener_unavailable";
  requestId?: string;
  checkId?: string;
  generation?: number;
  state?: string;
  previousState?: string;
  elapsedMs?: number;
  attempt?: number;
  tunnelPort?: number;
  retryAfterMs?: number;
};
export type LinkDiagnosticSink = (record: LinkDiagnosticRecord) => void;

const EVENTS = new Set(["owner_lookup", "relay_retry", "relay_failure", "relay_recovered", "tunnel_transition"]);
const OUTCOMES = new Set([
  "match", "mismatch", "lookup_error", "deadline", "stale", "unavailable", "identity_unknown",
  "identity_mismatch", "auth_timeout", "auth_failed", "transport_error", "client_abort", "header_timeout", "recovered",
  "connected", "spawned", "stopped", "auth", "hostkey", "forward", "remote_forward_conflict", "timeout", "network",
  "unknown", "spawn_failed", "listener_unavailable",
]);
const STATES = new Set<TunnelState["kind"]>(["idle", "connecting", "connected", "reconnecting", "failed"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 256 * 1024;

/** Copy only bounded enum, UUID and numeric fields; unknown fields never reach disk. */
function metadata(record: LinkDiagnosticRecord): LinkDiagnosticRecord | null {
  if (!record) return null;
  const { event, outcome, state, previousState } = record;
  if (!EVENTS.has(event) || !OUTCOMES.has(outcome)) return null;
  const result: LinkDiagnosticRecord = { event, outcome };
  for (const key of ["requestId", "checkId"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.length === 36 && UUID.test(value)) result[key] = value;
  }
  if (typeof state === "string" && STATES.has(state as TunnelState["kind"])) result.state = state;
  if (typeof previousState === "string" && STATES.has(previousState as TunnelState["kind"])) result.previousState = previousState;
  for (const key of ["generation", "elapsedMs", "attempt", "retryAfterMs"] as const) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
      && (key === "elapsedMs" || key === "retryAfterMs" || Number.isSafeInteger(value))) result[key] = value;
  }
  const { tunnelPort } = record;
  if (typeof tunnelPort === "number" && Number.isInteger(tunnelPort) && tunnelPort >= 1 && tunnelPort <= 65_535) result.tunnelPort = tunnelPort;
  return result;
}

/** Append through a private no-follow handle, keeping at most one 256 KiB rotated backup. */
async function append(dir: string, line: string): Promise<void> {
  assertNotRealHomeUnderTest(dirname(dir));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const directory = await lstat(dir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) return;
  const windows = windowsSecretAclApplies();
  if (windows) await hardenSecretDirAsync(dir, { required: true });
  else await chmod(dir, 0o700);
  const path = join(dir, "diagnostics.jsonl");
  const backup = `${path}.1`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // No read of log contents, and no following a file symlink or writing to a pipe.
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    file = await open(path, flags, 0o600);
    const current = await file.stat();
    if (!current.isFile() || current.nlink !== 1) return;
    if (windows) await hardenSecretPathAsync(path, { required: true });
    else await file.chmod(0o600);
    const previous = await lstat(backup).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return null;
    });
    if (previous) {
      if (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1) return;
      if (previous.size > MAX_BYTES) await unlink(backup);
      else if (windows) await hardenSecretPathAsync(backup, { required: true });
      else await chmod(backup, 0o600);
    }
    if (current.size > MAX_BYTES) await file.truncate(0);
    else if (current.size + Buffer.byteLength(line) > MAX_BYTES) {
      await file.close();
      file = undefined;
      await rename(path, backup);
      file = await open(path, flags, 0o600);
      const fresh = await file.stat();
      if (!fresh.isFile() || fresh.nlink !== 1 || fresh.size + Buffer.byteLength(line) > MAX_BYTES) return;
      if (windows) await hardenSecretPathAsync(path, { required: true });
      else await file.chmod(0o600);
    }
    await file.write(line);
    if (windows) {
      const written = await file.stat({ bigint: true });
      const named = await lstat(path, { bigint: true });
      if (!named.isSymbolicLink() && named.dev === written.dev && named.ino === written.ino) {
        // Windows publishes content-write ChangeTime on close; retain only the same object's ACL memo.
        await file.close();
        file = undefined;
        reattributeHardenedSecretPath(path);
      }
    }
  } finally {
    await file?.close();
  }
}

/**
 * Create a best-effort metadata sink with one-second event/outcome buckets and a bounded queue.
 * File and ACL work starts on the first eligible record and never blocks admission. flush() waits
 * at most one second; its timeout does not cancel the writer or guarantee durable storage.
 */
export function createLinkDiagnosticSink(
  { configDir, now = Date.now }: { configDir?: string; now?: () => number } = {},
): LinkDiagnosticSink & { flush: (timeoutMs?: number) => Promise<void> } {
  // At most 56 buckets; correlation IDs never become keys or retained memory.
  const buckets = new Map<string, { at: number; suppressed: number }>();
  const queue: Array<{ dir: string; line: string }> = [];
  let flight: Promise<void> | undefined;
  const drain = async () => {
    while (queue.length) {
      const record = queue.shift()!;
      try { await append(record.dir, record.line); } catch { /* Best effort; never publish raw errors. */ }
    }
  };
  const startWriter = () => {
    if (flight) return;
    flight = drain().finally(() => {
      flight = undefined;
      if (queue.length) startWriter();
    });
  };
  const sink: LinkDiagnosticSink = record => {
    try {
      const safe = metadata(record);
      if (!safe) return;
      const at = now();
      if (!Number.isSafeInteger(at) || at < 0) return;
      const key = `${safe.event}:${safe.outcome}`;
      const bucket = buckets.get(key);
      // Wall-clock rollback starts a new window, even when the writer is backed up.
      if (bucket && at >= bucket.at && at - bucket.at < 1_000) {
        bucket.suppressed = Math.min(Number.MAX_SAFE_INTEGER, bucket.suppressed + 1);
        return;
      }
      if (queue.length >= 56) {
        buckets.set(key, { at: Math.min(bucket?.at ?? at, at),
          suppressed: Math.min(Number.MAX_SAFE_INTEGER, (bucket?.suppressed ?? 0) + 1) });
        return;
      }
      const suppressed = bucket?.suppressed ?? 0;
      // Failed writes are rate-limited too; diagnostics cannot hammer an unavailable disk.
      buckets.set(key, { at, suppressed: 0 });
      queue.push({ dir: linkDir(configDir), line: `${JSON.stringify({ ...safe, timestamp: at, ...(suppressed ? { suppressed } : {}) })}\n` });
      startWriter();
    } catch { /* Diagnostics must never change request admission or expose raw errors. */ }
  };
  return Object.assign(sink, { flush: async (timeoutMs = 1_000) => {
    if (!flight) return;
    // Keep shutdown bounded even if an asynchronous filesystem or ACL operation stalls.
    // Timeout leaves the existing writer alone; it may still finish before process exit.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => { while (flight) await flight; })(),
        new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(1_000, Math.max(0, timeoutMs))); }),
      ]);
    } catch { /* Best effort; never publish raw errors. */ }
    finally { clearTimeout(timer); }
  } });
}

let defaultSink: ReturnType<typeof createLinkDiagnosticSink> | undefined;
/** Lazily enqueue sanitized evidence in the default sink without propagating diagnostic failures. */
export function recordLinkDiagnostic(record: LinkDiagnosticRecord): void {
  try { (defaultSink ??= createLinkDiagnosticSink())(record); } catch { /* Best effort. */ }
}

/** Drain existing diagnostics for at most one second without activating an unused sink. */
export async function flushLinkDiagnostics(): Promise<void> {
  await defaultSink?.flush();
}
