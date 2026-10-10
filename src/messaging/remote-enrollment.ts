import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExecArgv, buildFingerprintArgv, buildProbeArgv, remoteOcxArgv, isSshAlias } from "../link/ssh-argv";
import { parseFingerprintLine } from "../link/fingerprint";
import { MessageBudget } from "./budget";
import { capability, exactRecord, RemoteCapacity, REMOTE_PROTOCOL, remoteError, validAlias,
  validCapability, validMachine, validPort, REMOTE_LIMITS, type RemoteState } from "./remote-contract";
import { readRemoteFile, withRemoteLock, writeRemoteFile } from "./remote-files";
import { runRemoteHelper } from "./remote-process";
import { RemoteMessageStore } from "./remote-store";
import { isThreadId } from "./types";

export type RemoteControlRunner = (argv: readonly string[], budget: MessageBudget, capacity: RemoteCapacity,
  stdin?: string) => Promise<string>;

/** Forget only the revoked transaction, while the state mutation lock is still owned. */
function forgetPendingTransaction(store: RemoteMessageStore, transaction: string, removeJournal = unlinkSync): void {
  const path = join(store.directory, "enrollment.json"), text = readRemoteFile(path);
  if (text === null) return;
  const saved = exactRecord(JSON.parse(text), ["alias", "ssh", "fingerprint", "generation", "request"]);
  const request = exactRecord(saved.request, ["protocol", "action", "params"]);
  const params = exactRecord(request.params, ["machine", "transaction", "returnCapability", "port"]);
  if (params.transaction === transaction) removeJournal(path);
}
/** Offer one host fingerprint without enrollment or persistent state; clean only this probe's scratch directory. */
export async function probeRemoteHost(ssh: string, budget: MessageBudget, capacity: RemoteCapacity,
  runner: RemoteControlRunner = runRemoteHelper) {
  if (!isSshAlias(ssh)) throw remoteError("invalid_ssh_alias", "Choose a valid SSH destination.");
  const root = mkdtempSync(join(tmpdir(), "ocx-message-probe-")), path = join(root, "known_hosts");
  try {
    writeRemoteFile(path, "");
    await runner(buildProbeArgv({ alias: ssh, tempKnownHostsFile: path }), budget, capacity);
    const fingerprint = parseFingerprintLine((await runner(buildFingerprintArgv(path), budget, capacity)).trim()).fingerprint;
    const hostKey = readRemoteFile(path);
    if (!hostKey || hostKey.length > 8192 || hostKey.trim().split("\n").length !== 1
      || !hostKey.startsWith(`${ssh} `)) throw remoteError("invalid_host_key", "SSH probe did not return one bounded alias-bound host key.");
    return { fingerprint, hostKey };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
/** Versioned private stdio control: invoked over confirmed SSH, never the network messaging gateway. */
export function handleEnrollmentControl(store: RemoteMessageStore, input: unknown, removeJournal = unlinkSync): unknown {
  const raw = exactRecord(input, ["protocol", "action", "params"]);
  if (raw.protocol !== REMOTE_PROTOCOL) throw remoteError("remote_incompatible", "Remote messaging protocol versions differ.");
  const state = store.requireEnabled();
  if (raw.action === "enroll") {
    const params = exactRecord(raw.params, ["machine", "transaction", "returnCapability", "port"]);
    if (!validMachine(params.machine) || params.machine.id === state.machine.id || !isThreadId(params.transaction)
      || !validCapability(params.returnCapability) || !validPort(params.port)) throw remoteError("invalid_enrollment", "Invalid messaging enrollment contract.");
    const machine = params.machine, transaction = params.transaction, returnCapability = params.returnCapability, port = params.port;
    let incoming = "", full = false;
    const committed = store.mutate(current => {
      const existing = current.peers.find(peer => peer.machine.id === machine.id || peer.transaction === transaction);
      if (existing) {
        if (existing.transaction !== transaction || existing.machine.id !== machine.id || existing.outgoing !== returnCapability
          || existing.port !== port) throw remoteError("enrollment_conflict", "An existing enrollment cannot be silently replaced.");
        incoming = existing.incoming; return;
      }
      if (current.peers.length >= REMOTE_LIMITS.peers) { full = true; return; }
      incoming = capability();
      current.peers.push({ alias: `peer-${machine.id}`, machine, transaction, incoming, outgoing: returnCapability,
        port, ssh: null, hostKey: null, fingerprint: null });
    });
    if (full) return { protocol: REMOTE_PROTOCOL, transaction, rejected: "peer_capacity" };
    return { protocol: REMOTE_PROTOCOL, transaction, machine: committed.machine, port: committed.port, capability: incoming };
  }
  if (raw.action === "remove") {
    const params = exactRecord(raw.params, ["machineId", "transaction"]);
    if (!isThreadId(params.machineId) || !isThreadId(params.transaction)) throw new Error();
    store.mutate(current => {
      // Invalidate recovery before publishing absence, including an enrollment not yet locally published.
      forgetPendingTransaction(store, params.transaction as string, removeJournal);
      current.peers = current.peers.filter(peer => peer.machine.id !== params.machineId || peer.transaction !== params.transaction);
    });
    return { protocol: REMOTE_PROTOCOL, removed: true };
  }
  throw remoteError("invalid_control", "Unsupported messaging enrollment control operation.");
}
/** Enroll both directions without auto-enabling either node; retain one recoverable transaction on uncertainty. */
export async function enrollRemoteHost(store: RemoteMessageStore, alias: string, ssh: string, fingerprint: string,
  budget: MessageBudget, capacity: RemoteCapacity, runner: RemoteControlRunner = runRemoteHelper) {
  const state = store.requireEnabled();
  if (!validAlias(alias) || !isSshAlias(ssh) || !/^SHA256:[A-Za-z0-9+/=]{1,64}$/.test(fingerprint)) throw remoteError("invalid_enrollment", "Alias, SSH destination and confirmed fingerprint are required.");
  const offered = await probeRemoteHost(ssh, budget, capacity, runner);
  if (offered.fingerprint !== fingerprint) throw remoteError("host_key_changed", "The offered SSH key differs from the explicitly confirmed fingerprint.");
  const pendingPath = join(store.directory, "enrollment.json"), hostsPath = join(store.directory, "enrollment_known_hosts");
  const pending = withRemoteLock(store.directory, () => {
    const existing = readRemoteFile(pendingPath);
    if (existing !== null) {
      const saved = exactRecord(JSON.parse(existing), ["alias", "ssh", "fingerprint", "generation", "request"]);
      if (saved.alias !== alias || saved.ssh !== ssh || saved.fingerprint !== fingerprint) throw remoteError("enrollment_pending", "Reconcile the existing messaging enrollment before starting another.");
      return saved;
    }
    const current = store.requireEnabled();
    if (current.generation !== state.generation) throw remoteError("enrollment_pending", "Local configuration changed during the probe; repeat explicitly.");
    if (current.peers.some(peer => peer.alias === alias)) throw remoteError("enrollment_conflict", "This messaging alias is already enrolled.");
    if (current.peers.length >= REMOTE_LIMITS.peers) throw remoteError("peer_capacity", "Remove an enrolled peer before adding another.");
    const saved = { alias, ssh, fingerprint, generation: current.generation, request: { protocol: REMOTE_PROTOCOL, action: "enroll",
      params: { machine: state.machine, transaction: crypto.randomUUID(), returnCapability: capability(), port: state.port } } };
    budget.throwIfEnded(); writeRemoteFile(pendingPath, JSON.stringify(saved)); return saved;
  });
  const request = exactRecord(pending.request, ["protocol", "action", "params"]);
  const params = exactRecord(request.params, ["machine", "transaction", "returnCapability", "port"]);
  if (pending.generation !== state.generation || request.protocol !== REMOTE_PROTOCOL || request.action !== "enroll" || !validMachine(params.machine)
    || params.machine.id !== state.machine.id || !isThreadId(params.transaction) || !validCapability(params.returnCapability)
    || params.port !== state.port) throw remoteError("enrollment_pending", "Pending enrollment no longer matches this node; reconcile it explicitly.");
  writeRemoteFile(hostsPath, offered.hostKey);
  let reply: Record<string, unknown>;
  try {
    const value = JSON.parse(await runner(buildExecArgv({ alias: ssh, knownHostsFile: hostsPath,
      argv: remoteOcxArgv(["message", "_control"]) }), budget, capacity, JSON.stringify(request)));
    reply = exactRecord(value, value?.rejected !== undefined ? ["protocol", "transaction", "rejected"]
      : ["protocol", "transaction", "machine", "port", "capability"]);
    if (reply.protocol !== REMOTE_PROTOCOL || reply.transaction !== params.transaction) throw new Error();
    if (reply.rejected !== undefined) { if (reply.rejected !== "peer_capacity") throw new Error(); }
    else if (!validMachine(reply.machine)
      || reply.machine.id === state.machine.id || !validPort(reply.port) || !validCapability(reply.capability)) throw new Error();
  } catch { throw remoteError("enrollment_unknown", "Remote enrollment may have committed. Reconcile the retained transaction, if present; do not create a replacement automatically."); }
  if (reply.rejected === "peer_capacity") throw remoteError("peer_capacity", "The remote node has no free messaging peer slot. Retry the same transaction after freeing a slot, or explicitly abandon it.");
  const machine = reply.machine as RemoteState["machine"];
  try {
    budget.throwIfEnded();
    const savedText = JSON.stringify(pending);
    let ownsJournal = false;
    store.mutate(current => {
      if (current.generation !== state.generation) throw remoteError("enrollment_unknown", "Local configuration changed during enrollment; the remote transaction is retained.");
      ownsJournal = readRemoteFile(pendingPath) === savedText;
      const existing = current.peers.find(peer => peer.alias === alias || peer.machine.id === machine.id);
      if (existing) {
        if (existing.alias !== alias || existing.machine.id !== machine.id || existing.transaction !== params.transaction
          || existing.incoming !== params.returnCapability || existing.outgoing !== reply.capability
          || existing.port !== reply.port || existing.ssh !== ssh || existing.fingerprint !== fingerprint
          || existing.hostKey !== offered.hostKey) throw remoteError("enrollment_conflict", "The remote identity is already enrolled differently.");
        return;
      }
      if (!ownsJournal) throw remoteError("enrollment_unknown", "This enrollment no longer owns the saved transaction.");
      current.peers.push({ alias, machine, transaction: params.transaction as string, incoming: params.returnCapability as string,
        outgoing: reply.capability as string, port: reply.port as number, ssh, hostKey: offered.hostKey, fingerprint });
    }, () => { if (ownsJournal) forgetPendingTransaction(store, params.transaction as string); });
  } catch {
    throw remoteError("enrollment_unknown", "Remote enrollment committed, but local completion is uncertain. Inspect current enrollment and any retained transaction before an explicit retry.");
  }
  return { protocol: REMOTE_PROTOCOL, alias, machine, enrolled: true };
}
/** Revoke locally first, then attempt exact remote revocation; unknown cleanup never restores local admission. */
export async function removeRemoteHost(store: RemoteMessageStore, selector: string, budget: MessageBudget,
  capacity: RemoteCapacity, runner: RemoteControlRunner = runRemoteHelper, removeJournal = unlinkSync) {
  const state = store.requireEnabled(), peer = store.peer(selector);
  store.mutate(current => {
    forgetPendingTransaction(store, peer.transaction, removeJournal);
    current.peers = current.peers.filter(item => item.transaction !== peer.transaction);
  });
  let remote: "removed" | "unconfirmed" = "unconfirmed";
  if (peer.ssh) {
    const path = join(store.directory, "revocation_known_hosts"); writeRemoteFile(path, peer.hostKey!);
    try {
      const reply = exactRecord(JSON.parse(await runner(buildExecArgv({ alias: peer.ssh, knownHostsFile: path,
        argv: remoteOcxArgv(["message", "_control"]) }), budget, capacity, JSON.stringify({ protocol: REMOTE_PROTOCOL,
        action: "remove", params: { machineId: state.machine.id, transaction: peer.transaction } }))), ["protocol", "removed"]);
      if (reply.protocol === REMOTE_PROTOCOL && reply.removed === true) remote = "removed";
    } catch { /* Receipt explicitly preserves unconfirmed remote cleanup. */ }
  }
  return { protocol: REMOTE_PROTOCOL, machine: peer.machine, locallyRemoved: true, remote,
    ...(remote === "unconfirmed" ? { remoteCleanupCommand: `ocx message hosts remove ${state.machine.id} --json` } : {}) };
}
