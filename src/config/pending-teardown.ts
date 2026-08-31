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
  /** ISO timestamp, for diagnostics only; recovery is decided by liveness, not by age. */
  createdAt: string;
};

export function getPendingTeardownPath(): string {
  return join(getConfigDir(), "pending-teardown.json");
}

function isReceipt(value: unknown): value is PendingTeardownReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  return Number.isSafeInteger(receipt.ownerPid)
    && Number(receipt.ownerPid) > 0
    && typeof receipt.createdAt === "string";
}

/** Claim the deferred teardown for this process. Returns the receipt that was written. */
export function claimPendingTeardown(ownerPid: number = process.pid): PendingTeardownReceipt {
  const dir = getConfigDir();
  assertNotRealHomeUnderTest(dir);
  const receipt: PendingTeardownReceipt = { ownerPid, createdAt: new Date().toISOString() };
  atomicWriteFile(getPendingTeardownPath(), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

export function readPendingTeardown(): PendingTeardownReceipt | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getPendingTeardownPath(), "utf-8"));
    return isReceipt(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Clear the receipt.
 *
 * Guarded by the owner pid so a concurrent `ocx stop` cannot delete an obligation it did
 * not accept — the same snapshot discipline the pid/runtime purges use.
 */
export function clearPendingTeardown(ownerPid: number = process.pid): void {
  const path = getPendingTeardownPath();
  if (!existsSync(path)) return;
  const current = readPendingTeardown();
  if (current !== null && current.ownerPid !== ownerPid) return;
  try { unlinkSync(path); } catch { /* ignore */ }
}

/**
 * True when a previous deferred stop left its obligation unfinished.
 *
 * A receipt whose owner is still alive belongs to a stop that is still running: leave it
 * alone. Only an abandoned receipt is recoverable, and the caller must still prove no
 * proxy is live before acting on it — restoring client config under a running proxy is
 * the failure the deferral exists to prevent.
 */
export function isPendingTeardownAbandoned(
  receipt: PendingTeardownReceipt | null,
  isAlive: (pid: number) => boolean,
  selfPid: number = process.pid,
): boolean {
  if (!receipt) return false;
  if (receipt.ownerPid === selfPid) return false;
  return !isAlive(receipt.ownerPid);
}
