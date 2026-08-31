import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
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
 * stop and removes it only after its own restore, so a later `ocx stop`/`ocx update` can
 * see the abandoned obligation and finish it once that proxy is proven down.
 *
 * ## Why the nonce is the FILENAME
 *
 * One shared file cannot be cleared safely. Read-compare-unlink is three syscalls, and a
 * concurrent stop replacing the file between the compare and the unlink means this run
 * deletes an obligation it never owned — the check passed against bytes that are already
 * gone. Giving each claim its own path removes the race rather than serializing it:
 * `unlink` names one specific obligation, so it can only ever delete that one. Two
 * concurrent stops hold two receipts, which is the truth of the situation.
 */
export type PendingTeardownReceipt = {
  /** Process that accepted the obligation, so a live owner is distinguishable from a dead one. */
  ownerPid: number;
  /** Identity of this claim; also its filename, which is what makes a clear a single-syscall delete. */
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

/**
 * What is on disk, kept distinct from what it means.
 *
 * Collapsing a malformed file into "no receipt" loses the one fact recovery needs: an
 * obligation may still be outstanding, and its owner can no longer be identified. That
 * state must not silently authorize a deferral, and it must not wedge every later stop
 * either — see {@link quarantinePendingTeardown}.
 */
export type PendingTeardownRead =
  | { state: "missing" }
  | { state: "valid"; receipt: PendingTeardownReceipt }
  | { state: "invalid"; nonce: string; detail: string };

const PREFIX = "pending-teardown-";
const SUFFIX = ".json";
const NONCE_RE = /^[0-9a-f]{32}$/;

export function pendingTeardownPathFor(nonce: string): string {
  return join(getConfigDir(), `${PREFIX}${nonce}${SUFFIX}`);
}

function isReceipt(value: unknown, nonce: string): value is PendingTeardownReceipt {
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
    // The body must agree with the name: a receipt whose nonce was edited to name a
    // different claim would let a request authorize a deferral it does not own.
    && receipt.nonce === nonce
    && typeof receipt.createdAt === "string"
    && endpointOk;
}

/** Claim a deferred teardown for this process. Returns the receipt that was written. */
export function claimPendingTeardown(
  endpoint: { hostname: string; port: number },
  ownerPid: number = process.pid,
): PendingTeardownReceipt {
  const dir = getConfigDir();
  assertNotRealHomeUnderTest(dir);
  const nonce = randomBytes(16).toString("hex");
  const receipt: PendingTeardownReceipt = { ownerPid, nonce, createdAt: new Date().toISOString(), endpoint };
  atomicWriteFile(pendingTeardownPathFor(nonce), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

export function readPendingTeardown(nonce: string): PendingTeardownRead {
  if (!NONCE_RE.test(nonce)) return { state: "missing" };
  let raw: string;
  try {
    raw = readFileSync(pendingTeardownPathFor(nonce), "utf-8");
  } catch (error) {
    // Only "there is no file" is absence. A permission error, or a directory sitting where
    // the receipt belongs, means something IS there and cannot be read; calling that
    // missing hides an obligation that may still be outstanding.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "missing" };
    return { state: "invalid", nonce, detail: `unreadable (${code ?? "unknown"})` };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isReceipt(parsed, nonce)) return { state: "valid", receipt: parsed };
    const digest = createHash("sha256").update(raw).digest("hex").slice(0, 12);
    return { state: "invalid", nonce, detail: `malformed receipt (sha256 ${digest})` };
  } catch {
    return { state: "invalid", nonce, detail: "unparseable JSON" };
  }
}

/** An obligation that exists on disk — the "missing" case cannot occur in a listing. */
export type OutstandingTeardown = Exclude<PendingTeardownRead, { state: "missing" }>;

/** Every obligation currently on disk, attributable or not. */
export function listPendingTeardowns(): OutstandingTeardown[] {
  let names: string[];
  try {
    names = readdirSync(getConfigDir());
  } catch {
    return [];
  }
  const out: OutstandingTeardown[] = [];
  for (const name of names) {
    if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) continue;
    const nonce = name.slice(PREFIX.length, name.length - SUFFIX.length);
    if (!NONCE_RE.test(nonce)) continue;
    const read = readPendingTeardown(nonce);
    if (read.state !== "missing") out.push(read);
  }
  return out;
}

/** Is any obligation outstanding, whether or not it can still be attributed? */
export function pendingTeardownOutstanding(): boolean {
  return listPendingTeardowns().length > 0;
}

/**
 * Remove exactly one obligation.
 *
 * The nonce is the filename, so this is a compare-and-delete in one syscall: it can never
 * remove a receipt another process wrote, because that receipt lives at a different path.
 * Returns whether the obligation is gone — a failed unlink is reported rather than
 * swallowed, since a receipt that survives its discharge re-triggers recovery forever.
 */
export function clearPendingTeardown(nonce: string): boolean {
  try {
    unlinkSync(pendingTeardownPathFor(nonce));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * Move an unattributable obligation aside.
 *
 * An invalid receipt names no endpoint, so nothing can prove its proxy is down, so it can
 * never be discharged the normal way. Left in place it is not merely useless: both
 * updater gates treat an outstanding receipt as a reason to run the stop, and that stop
 * would fail on the same receipt every time — an update that can never proceed.
 *
 * Quarantining keeps the evidence under a name the scan ignores, so the operator can look
 * at it, while letting the stop that found it perform the restore the receipt stood for.
 * Returns the path it was moved to, or null when it could not be moved.
 */
export function quarantinePendingTeardown(nonce: string): string | null {
  const from = pendingTeardownPathFor(nonce);
  if (!existsSync(from)) return null;
  const to = join(getConfigDir(), `pending-teardown-unreadable-${nonce}-${Date.now()}.bak`);
  try {
    renameSync(from, to);
    return to;
  } catch {
    return null;
  }
}

/**
 * True when a previous deferred stop left its obligation unfinished.
 *
 * A receipt whose owner is still alive belongs to a stop that is still running: leave it
 * alone. Only an abandoned obligation is a candidate, and a VALID one still has to prove
 * its endpoint is down before anything is restored — an invalid one never can, which is
 * what {@link quarantinePendingTeardown} exists for.
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

/** Does this request name an obligation that exists and is readable? */
export function deferralMatchesReceipt(nonce: string | null): boolean {
  if (!nonce || !NONCE_RE.test(nonce)) return false;
  return readPendingTeardown(nonce).state === "valid";
}
