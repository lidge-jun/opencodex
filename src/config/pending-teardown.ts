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
  /**
   * How the endpoint was obtained.
   *
   * `exact` came from the runtime record or a successful liveness probe — the address the
   * stop actually contacted. `guessed` is the configured listen address, recorded because
   * an obligation with a weak address beats no obligation at all, but it is NOT evidence:
   * a proxy on an explicit `--port` can be respawned there while the configured port
   * refuses, and treating that refusal as proof would restore under a live proxy. A
   * guessed receipt therefore fails closed into manual recovery.
   */
  endpointSource: "exact" | "guessed";
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

/**
 * The home itself could not be listed.
 *
 * Distinct from an invalid receipt: there is no file to quarantine and no nonce to name,
 * so it must never be fed to the receipt machinery. It blocks like any obligation, but the
 * remedy is to fix the directory and retry, not to remove something.
 */
export type TeardownScanFailure = { state: "unscannable"; detail: string };

import {
  isPendingTeardownFileName,
  isAnyTeardownObligationFileName,
  PENDING_TEARDOWN_PREFIX as PREFIX,
  PENDING_TEARDOWN_SUFFIX as SUFFIX,
  PENDING_TEARDOWN_UNREADABLE_SUFFIX as UNREADABLE_SUFFIX,
  pendingTeardownNonceFromFileName,
} from "./pending-teardown-names.mjs";

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
    && (receipt.endpointSource === "exact" || receipt.endpointSource === "guessed")
    && endpointOk;
}

/** Claim a deferred teardown for this process. Returns the receipt that was written. */
export function claimPendingTeardown(
  endpoint: { hostname: string; port: number },
  endpointSource: "exact" | "guessed",
  ownerPid: number = process.pid,
): PendingTeardownReceipt {
  const dir = getConfigDir();
  assertNotRealHomeUnderTest(dir);
  const nonce = randomBytes(16).toString("hex");
  const receipt: PendingTeardownReceipt = { ownerPid, nonce, createdAt: new Date().toISOString(), endpoint, endpointSource };
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
export type OutstandingTeardown = Exclude<PendingTeardownRead, { state: "missing" }> | TeardownScanFailure;

/**
 * Every obligation currently on disk, attributable or not.
 *
 * A scan that FAILS is not an empty scan. Swallowing a permission or I/O error into `[]`
 * would let `handleStop` restore client config with an unread obligation sitting right
 * there, so anything but a missing home surfaces as one unreadable obligation the caller
 * must treat like any other: blocking, and needing a human.
 */
export function listPendingTeardowns(): OutstandingTeardown[] {
  let names: string[];
  try {
    names = readdirSync(getConfigDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    // Not an invalid RECEIPT: there is no file here and no nonce to name. Synthesizing one
    // would hand a fabricated identity to the quarantine and clear paths, which could then
    // rename or delete a real receipt that happened to carry it.
    return [{ state: "unscannable", detail: `the opencodex home could not be listed (${(error as NodeJS.ErrnoException).code ?? "unknown"})` }];
  }
  const out: OutstandingTeardown[] = [];
  for (const name of names) {
    // One naming rule, shared with the npm launcher: the two lanes drifting apart is
    // exactly how the Node updater stopped seeing receipts at all.
    if (!isPendingTeardownFileName(name)) continue;
    const nonce = pendingTeardownNonceFromFileName(name)!;
    const read = readPendingTeardown(nonce);
    if (read.state !== "missing") out.push(read);
  }
  return out;
}

/**
 * Is any obligation outstanding, whether or not it can still be attributed?
 *
 * Quarantined receipts count. Filing an unreadable one away must not let the next update
 * install over a teardown that never ran — that would turn "we could not tell" into "it
 * is fine", which is the failure this whole mechanism exists to prevent.
 */
export function pendingTeardownOutstanding(): boolean {
  try {
    return readdirSync(getConfigDir()).some(isAnyTeardownObligationFileName);
  } catch (error) {
    // Only a missing home is empty. Any other scan failure may be hiding an obligation,
    // and reporting "none" would unblock an update over a teardown that never ran.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Paths of quarantined obligations awaiting a human. */
export function listQuarantinedTeardowns(): string[] {
  try {
    return readdirSync(getConfigDir())
      .filter(name => name.startsWith(PREFIX) && name.endsWith(UNREADABLE_SUFFIX))
      .map(name => join(getConfigDir(), name));
  } catch {
    return [];
  }
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
 * Renaming stops the recovery loop from re-reading garbage on every stop, but it
 * deliberately does NOT stop the obligation from counting: `pendingTeardownOutstanding`
 * still sees it, so both updaters keep refusing to install over a teardown that never
 * ran. Only a human removing the file ends the enforcement.
 *
 * Returns the path it was moved to, or null when it could not be moved.
 */
export function quarantinePendingTeardown(nonce: string): string | null {
  const from = pendingTeardownPathFor(nonce);
  if (!existsSync(from)) return null;
  const to = join(getConfigDir(), `${PREFIX}${nonce}${UNREADABLE_SUFFIX}`);
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
  read: PendingTeardownRead | TeardownScanFailure,
  isAlive: (pid: number) => boolean,
  selfPid: number = process.pid,
): boolean {
  if (read.state === "missing") return false;
  // A home that cannot be listed may be hiding an obligation. It is not recoverable and
  // not removable; the caller blocks on it and asks for the directory to be fixed.
  if (read.state === "unscannable") return true;
  if (read.state === "invalid") return true;
  if (read.receipt.ownerPid === selfPid) return false;
  return !isAlive(read.receipt.ownerPid);
}

/** Does this request name an obligation that exists and is readable? */
export function deferralMatchesReceipt(nonce: string | null): boolean {
  if (!nonce || !NONCE_RE.test(nonce)) return false;
  return readPendingTeardown(nonce).state === "valid";
}
