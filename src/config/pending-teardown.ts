import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { atomicWriteFile } from "./atomic-write";
import { getConfigDir } from "./paths";

/**
 * Ownership receipt for a deferred shared teardown (#3008).
 *
 * `ocx stop` asks the proxy NOT to restore native Codex and the Grok fence, because a
 * stopped Task Scheduler can respawn the proxy and a survivor must keep its client
 * config. That hands one obligation to the parent — and a bare query flag cannot express
 * an obligation: if the parent dies between the child's exit and its own restore, the
 * shared config keeps pointing at a proxy that is gone, with nothing on disk saying so.
 *
 * The receipt is that missing state. The parent writes it BEFORE asking for a deferred
 * stop and clears it only after its own restore, so any later `ocx stop`/`ocx update`
 * can see the abandoned obligation and finish it once no live proxy remains.
 */
export type PendingTeardownReceipt = {
  /** Process that accepted the obligation, so a live owner is distinguishable from a dead one. */
  ownerPid: number;
  /**
   * Unguessable identity for THIS claim.
   *
   * A pid is neither secret nor stable: it is guessable by any local caller, and it is
   * reused after the owner exits. The nonce is what makes "the caller that asked for the
   * deferral is the caller that claimed it" checkable, and what makes a clear safe — a
   * recovery run deletes the exact receipt it read, never whatever happens to be on disk
   * by the time it finishes.
   */
  nonce: string;
  /** ISO timestamp, for diagnostics only; recovery is decided by liveness, not by age. */
  createdAt: string;
  /**
   * Endpoint the owner was stopping.
   *
   * Recovery has to prove THAT proxy is down, and after a crash the runtime-port record
   * is usually gone. Falling back to the configured port asks the wrong question for a
   * proxy started with an explicit `--port`: the configured port refuses while the live
   * one keeps serving, and its client config gets torn out from under it.
   */
  endpoint: { hostname: string; port: number };
};

export function getPendingTeardownPath(): string {
  return join(getConfigDir(), "pending-teardown.json");
}

function isReceipt(value: unknown): value is PendingTeardownReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  const endpoint = receipt.endpoint as Record<string, unknown> | undefined;
  const endpointOk = !!endpoint
    && typeof endpoint === "object"
    && typeof endpoint.hostname === "string"
    && endpoint.hostname.trim() !== ""
    && Number.isInteger(endpoint.port)
    && Number(endpoint.port) > 0
    && Number(endpoint.port) <= 65535;
  return Number.isSafeInteger(receipt.ownerPid)
    && Number(receipt.ownerPid) > 0
    && typeof receipt.nonce === "string"
    && /^[0-9a-f]{32}$/.test(receipt.nonce)
    && typeof receipt.createdAt === "string"
    && endpointOk;
}

/** Identity for a file we cannot attribute: its exact bytes. */
function fingerprintOf(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * What is on disk, kept distinct from what it means.
 *
 * Collapsing a malformed file into "no receipt" loses the one fact recovery needs: an
 * obligation may still be outstanding, and its owner can no longer be identified. That
 * state must not silently authorize either a deferral or a clear.
 */
export type PendingTeardownRead =
  | { state: "missing" }
  | { state: "valid"; receipt: PendingTeardownReceipt }
  | { state: "invalid"; fingerprint: string };

/** Claim the deferred teardown for this process. Returns the receipt that was written. */
export function claimPendingTeardown(
  endpoint: { hostname: string; port: number },
  ownerPid: number = process.pid,
): PendingTeardownReceipt {
  const dir = getConfigDir();
  assertNotRealHomeUnderTest(dir);
  const receipt: PendingTeardownReceipt = {
    ownerPid,
    nonce: randomBytes(16).toString("hex"),
    createdAt: new Date().toISOString(),
    endpoint,
  };
  atomicWriteFile(getPendingTeardownPath(), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

export function readPendingTeardownState(): PendingTeardownRead {
  let raw: string;
  try {
    raw = readFileSync(getPendingTeardownPath(), "utf-8");
  } catch (error) {
    // Only "there is no file" is absence. A permission error, or a directory sitting where
    // the receipt belongs, means something IS there and cannot be read; calling that
    // missing hides an obligation that may still be outstanding.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "missing" };
    return { state: "invalid", fingerprint: `unreadable:${code ?? "unknown"}` };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isReceipt(parsed)
      ? { state: "valid", receipt: parsed }
      : { state: "invalid", fingerprint: fingerprintOf(raw) };
  } catch {
    return { state: "invalid", fingerprint: fingerprintOf(raw) };
  }
}

export function readPendingTeardown(): PendingTeardownReceipt | null {
  const read = readPendingTeardownState();
  return read.state === "valid" ? read.receipt : null;
}

/** Is an obligation outstanding on disk, whether or not it can still be attributed? */
export function pendingTeardownOutstanding(): boolean {
  return readPendingTeardownState().state !== "missing";
}

/**
 * Clear exactly the state that was read.
 *
 * Identity is the whole point. Clearing "whatever is there now" lets a recovery run
 * delete an obligation a different stop wrote while this one was restoring — silently,
 * and it puts the config back in the state the receipt existed to prevent. That applies
 * to an unparseable file too: its bytes are hashed at read time, so even an
 * unattributable obligation is deleted only when it is still the same one.
 */
export function clearPendingTeardown(read: PendingTeardownRead): void {
  if (read.state === "missing") return;
  const path = getPendingTeardownPath();
  if (!existsSync(path)) return;
  const current = readPendingTeardownState();
  if (read.state === "valid") {
    if (current.state !== "valid" || current.receipt.nonce !== read.receipt.nonce) return;
  } else if (current.state !== "invalid" || current.fingerprint !== read.fingerprint) return;
  try { unlinkSync(path); } catch { /* ignore */ }
}

/**
 * True when a previous deferred stop left its obligation unfinished.
 *
 * A receipt whose owner is still alive belongs to a stop that is still running: leave it
 * alone. An invalid receipt is also outstanding — it names no live owner, so it cannot be
 * waited on, and leaving it forever would strand the restore it represents.
 *
 * Only an abandoned obligation is recoverable, and the caller must still prove no proxy
 * is live before acting on it: restoring client config under a running proxy is the
 * failure the deferral exists to prevent.
 */
export function isPendingTeardownAbandoned(
  read: PendingTeardownRead,
  isAlive: (pid: number) => boolean,
  selfPid: number = process.pid,
): boolean {
  if (read.state === "missing") return false;
  if (read.state === "invalid") return true;
  if (read.receipt.ownerPid === selfPid) return false;
  return !isAlive(read.receipt.ownerPid);
}

/** Does this request name the receipt it claims to own? */
export function deferralMatchesReceipt(nonce: string | null, read: PendingTeardownRead): boolean {
  if (!nonce) return false;
  return read.state === "valid" && read.receipt.nonce === nonce;
}
