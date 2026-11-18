import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isPendingTeardownAbandoned, isValidPendingTeardownReceipt, type OutstandingTeardown, type PendingTeardownReceipt } from "../config/pending-teardown";
import { isAnyTeardownObligationFileName, pendingTeardownNonceFromFileName } from "../config/pending-teardown-names.mjs";
import { getConfigDir } from "../config/paths";
import { isLikelyOcxProcess, type ClientStopOwner, type RuntimePortState } from "../config/process-state";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";
import { isProcessAlive } from "../lib/process-control";
import { readSyncRuntime } from "./sync-runtime";
import { isLiveClientStopOwner, readClientStopProcessStart } from "./stop-teardown-owner";

export type LinkStopRuntime = Required<Pick<RuntimePortState, "pid" | "port" | "attestationSecret">>;
export type NativeTeardownDecision = "restore" | "defer" | "refuse";
const host = (value: string) => value.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");

type NativeTeardownEvidence =
  | { state: "valid"; path: string; bytes: Buffer; receipt: PendingTeardownReceipt }
  | { state: "invalid"; nonce: string; detail: string }
  | { state: "quarantined" }
  | { state: "unscannable"; detail: string };

/** The signal and parent preflight use the same bounded, no-follow disk evidence. */
export function readLinkNativeTeardownEvidence(): NativeTeardownEvidence[] {
  let names: string[];
  try { names = readdirSync(getConfigDir()).filter(isAnyTeardownObligationFileName); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : [{ state: "unscannable", detail: "the opencodex home could not be listed" }]; }
  return names.map(name => {
    const nonce = pendingTeardownNonceFromFileName(name);
    if (!nonce) return { state: "quarantined" };
    try {
      const path = join(getConfigDir(), name);
      const bytes = readBoundedRegularFileSync(path, 4 * 1024);
      const receipt: unknown = JSON.parse(bytes.toString("utf8"));
      return isValidPendingTeardownReceipt(receipt, nonce) ? { state: "valid", path, bytes, receipt } : { state: "invalid", nonce, detail: "malformed receipt" };
    } catch { return { state: "invalid", nonce, detail: "receipt is not bounded regular JSON" }; }
  });
}

/** Preserve the parent's recovery ownership rules and use one snapshot before/after stop. */
export function readLinkInheritedTeardowns(): OutstandingTeardown[] {
  return readLinkNativeTeardownEvidence().flatMap<OutstandingTeardown>(read => {
    if (read.state === "quarantined") return [];
    if (read.state === "valid" && read.receipt.ownerStartTime) {
      const { ownerPid: pid, ownerStartTime: startTime, nonce } = read.receipt;
      const ours = pid === process.pid && readClientStopProcessStart(pid) === startTime;
      return ours || isLiveClientStopOwner({ pid, startTime, nonce }) ? [] : [read];
    }
    return isPendingTeardownAbandoned(read, pid => isProcessAlive(pid) && isLikelyOcxProcess(pid)) ? [read] : [];
  });
}

/** Before a receipt is issued, the bound owner already excludes concurrent recycle. */
export function activeClientStopOwner(runtime: RuntimePortState): ClientStopOwner | undefined {
  const owner = runtime.clientStopOwner;
  if (runtime.clientStopping && runtime.clientStopRequested && owner && /^[a-f0-9]{32}$/.test(owner.nonce)
    && typeof owner.startTime === "string" && owner.startTime.length > 0
    && owner.startTime.length <= 80 && isLiveClientStopOwner(owner)) return owner;
}

/** Receipts alone never release a socket still named by native loopback routing. */
export function linkNativeTeardownDecision(expected?: LinkStopRuntime): NativeTeardownDecision {
  const evidence = readLinkNativeTeardownEvidence();
  if (evidence.length === 0) return "restore";
  try {
    const runtime = readSyncRuntime();
    if (!expected || expected.pid !== process.pid || !runtime || runtime.pid !== expected.pid
      || runtime.port !== expected.port || runtime.attestationSecret !== expected.attestationSecret
      || host(runtime.hostname ?? "127.0.0.1") !== "127.0.0.1"
      || runtime.clientStopping !== true || runtime.clientStopRequested !== true) return "refuse";
    // A malformed/guessed inherited obligation blocks the parent's restore too.
    // Other endpoints cannot be proved down synchronously by this Child.
    if (evidence.some(read => read.state === "invalid" || read.state === "unscannable"
      || read.state === "valid" && (read.receipt.endpointSource !== "exact"
        || read.receipt.endpoint.port !== expected.port || host(read.receipt.endpoint.hostname) !== "127.0.0.1"))) return "refuse";
    const owner = activeClientStopOwner(runtime);
    const claim = owner && evidence.find(read => read.state === "valid"
      && read.receipt.nonce === owner.nonce && read.receipt.ownerPid === owner.pid
      && read.receipt.ownerStartTime === owner.startTime);
    if (claim?.state === "valid" && readBoundedRegularFileSync(claim.path, 4 * 1024).equals(claim.bytes)
      && Bun.deepEquals(readSyncRuntime(), runtime, true)) return "defer";
  } catch { /* unreadable or replaced runtime evidence is not an active parent */ }
  return "refuse";
}
