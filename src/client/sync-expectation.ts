/**
 * #7694: a caller-supplied identity that `ocx sync` must find before it syncs anything.
 *
 * GOAT reads `ocx connect status --json` and then runs `ocx sync` in a separate process; between
 * the two the machine can be disconnected or relinked to another Home. The expectation closes that
 * gap by being checked inside the same locked block that selects the connected path
 * (`syncConnectedClient`), and every later write there is compare-and-swapped against the
 * connection that passed it. A mismatch writes nothing and never falls back to local providers.
 */
import type { DesktopDisconnectReceipt } from "../claude/desktop-remote-store";
import { readDesktopDisconnectReceipt } from "../claude/desktop-remote-store";
import { isLinkConnection, pendingClientConnectMayOwnToken, readClientConnectionState, type ClientConnectionState } from "./state";

export type ClientSyncExpectation =
  | { kind: "link"; linkId: string }
  | { kind: "hub"; apiKeyId: string };

export type ClientSyncMismatchPhase = "child_link_mismatch" | "hub_client_mismatch";

export type ClientSyncMismatchReason =
  | "disconnected"
  | "invalid_state"
  | "disconnect_pending"
  | "pending_operation"
  | "hub_client"
  | "link_client"
  | "other_link"
  | "other_key";

type DisconnectReceiptRead =
  | { kind: "absent" }
  | { kind: "valid"; value: Pick<DesktopDisconnectReceipt, "phase"> }
  | { kind: "unsafe" };

/** What a connect in flight leaves behind before it commits: nothing, its marker, or an unreadable one. */
export type PendingConnectRead = "absent" | "present" | "unsafe";

export class ClientSyncExpectationError extends Error {
  readonly phase: ClientSyncMismatchPhase;
  readonly reason: ClientSyncMismatchReason;

  constructor(expectation: ClientSyncExpectation, reason: ClientSyncMismatchReason) {
    const phase = mismatchPhase(expectation);
    super(`${phase}: ${reason}`);
    this.name = "ClientSyncExpectationError";
    this.phase = phase;
    this.reason = reason;
  }
}

export function mismatchPhase(expectation: ClientSyncExpectation): ClientSyncMismatchPhase {
  return expectation.kind === "link" ? "child_link_mismatch" : "hub_client_mismatch";
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : undefined;
}

/**
 * A lock the check needs is held: the apply lock by a link connect or another apply
 * (`link_apply_busy`), the client lifecycle lock (`client_lifecycle_busy`), or the config mutation
 * lock by another config writer. Only real contention counts for the config lock, classified as in
 * `src/config/mutation-lock.ts`; any other acquisition or storage failure stays itself. Before the
 * check ran, a pinned sync cannot know which connection it would serve, so it is refused as pending.
 */
export function isClientSyncLockBusy(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "link_apply_busy" || code === "client_lifecycle_busy") return true;
  if (code !== "CONFIG_MUTATION_LOCK_UNAVAILABLE") return false;
  const cause = (error as { cause?: unknown }).cause;
  const causeCode = errorCode(cause);
  return causeCode === "SQLITE_BUSY" || causeCode === "SQLITE_LOCKED"
    || (cause instanceof Error && /database (?:is|table is) locked/i.test(cause.message));
}

/**
 * Pure verdict: null when the expectation holds. An unfinished disconnect wins over everything,
 * because it is already tearing down whichever connection the state still names. A connect only
 * starts from a disconnected machine, so its marker is consulted only there.
 */
export function classifyClientSyncExpectation(
  state: ClientConnectionState,
  receipt: DisconnectReceiptRead,
  expectation: ClientSyncExpectation,
  pendingConnect: PendingConnectRead = "absent",
): ClientSyncMismatchReason | null {
  if (receipt.kind === "unsafe" || (receipt.kind === "valid" && receipt.value.phase !== "complete")) return "disconnect_pending";
  if (state.kind === "invalid" || state.kind === "mismatched") return "invalid_state";
  if (state.kind === "disconnected") {
    if (pendingConnect === "present") return "pending_operation";
    return pendingConnect === "unsafe" ? "invalid_state" : "disconnected";
  }
  const connection = state.value;
  if (connection.pendingOperation) return "pending_operation";
  if (expectation.kind === "link") {
    if (!isLinkConnection(connection)) return "hub_client";
    return connection.link?.linkId === expectation.linkId ? null : "other_link";
  }
  if (isLinkConnection(connection)) return "link_client";
  return connection.apiKeyId === expectation.apiKeyId ? null : "other_key";
}

function readPendingConnect(): PendingConnectRead {
  try { return pendingClientConnectMayOwnToken() ? "present" : "absent"; }
  catch { return "unsafe"; }
}

/** Read-only; the caller holds the client lifecycle and config mutation locks. */
export function assertClientSyncExpectation(expectation: ClientSyncExpectation): void {
  const state = readClientConnectionState();
  const reason = classifyClientSyncExpectation(
    state,
    readDesktopDisconnectReceipt(),
    expectation,
    state.kind === "disconnected" ? readPendingConnect() : "absent",
  );
  if (reason) throw new ClientSyncExpectationError(expectation, reason);
}
