import { hostname } from "node:os";
import { join } from "node:path";
import { isSshAlias } from "../link/ssh-argv";
import { isThreadId } from "./types";
import { capability, exactRecord, REMOTE_LIMITS, REMOTE_PROTOCOL, remoteError, validAlias,
  validCapability, validMachine, validPort, type RemotePeer, type RemoteState } from "./remote-contract";
import { createRemoteDirectory, readRemoteFile, withRemoteLock, writeRemoteFile } from "./remote-files";

/** Strict versioned state; neither unknown fields nor duplicate aliases/identities are ignored. */
export function parseRemoteState(value: unknown): RemoteState {
  const raw = exactRecord(value, ["protocol", "machine", "enabled", "port", "controlKey", "generation", "peers"]);
  if (raw.protocol !== REMOTE_PROTOCOL || !validMachine(raw.machine) || typeof raw.enabled !== "boolean"
    || !validPort(raw.port) || !validCapability(raw.controlKey) || !isThreadId(raw.generation)
    || !Array.isArray(raw.peers) || raw.peers.length > REMOTE_LIMITS.peers) throw remoteError("invalid_remote_state", "Messaging state has an invalid schema.");
  const aliases = new Set<string>(), ids = new Set<string>(), transactions = new Set<string>();
  for (const item of raw.peers) {
    const peer = exactRecord(item, ["alias", "machine", "transaction", "incoming", "outgoing", "port", "ssh", "hostKey", "fingerprint"]);
    if (!validAlias(peer.alias) || !validMachine(peer.machine) || peer.machine.id === raw.machine.id
      || !isThreadId(peer.transaction) || !validCapability(peer.incoming) || !validCapability(peer.outgoing)
      || peer.incoming === peer.outgoing || !validPort(peer.port)
      || (peer.ssh !== null && (typeof peer.ssh !== "string" || !isSshAlias(peer.ssh)))
      || (peer.hostKey !== null && (typeof peer.hostKey !== "string" || peer.hostKey.length > 8192))
      || (peer.fingerprint !== null && (typeof peer.fingerprint !== "string" || !/^SHA256:[A-Za-z0-9+/=]{1,64}$/.test(peer.fingerprint)))
      || (peer.ssh === null) !== (peer.hostKey === null) || (peer.ssh === null) !== (peer.fingerprint === null)
      || aliases.has(peer.alias) || ids.has(peer.machine.id) || transactions.has(peer.transaction)) throw remoteError("invalid_remote_state", "Messaging peer state is invalid or ambiguous.");
    aliases.add(peer.alias); ids.add(peer.machine.id); transactions.add(peer.transaction);
  }
  return raw as unknown as RemoteState;
}

/** Messaging owns a small separate private JSON store, never Remote Link/provider state. */
export class RemoteMessageStore {
  readonly directory: string;
  readonly path: string;
  /** Select an explicit configuration home without reading or creating it. */
  constructor(home: string) { this.directory = join(home, "messaging-remote"); this.path = join(this.directory, "state.json"); }
  /** Absent state stays absent; malformed or unsafe state does not become a default. */
  read(): RemoteState | null {
    const text = readRemoteFile(this.path);
    if (text === null) return null;
    try { return parseRemoteState(JSON.parse(text)); }
    catch { throw remoteError("invalid_remote_state", "Messaging state cannot be safely interpreted."); }
  }
  /** Enable explicitly, retaining stable identity and existing peer capabilities. */
  enable(port = 39176): RemoteState {
    if (!validPort(port)) throw remoteError("invalid_port", "Choose an unprivileged messaging port.");
    createRemoteDirectory(this.directory);
    return withRemoteLock(this.directory, () => {
      const state = this.read() ?? { protocol: REMOTE_PROTOCOL, machine: { id: crypto.randomUUID(),
        name: hostname().replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 128) || "node" }, enabled: false,
        port, controlKey: capability(), generation: crypto.randomUUID(), peers: [] };
      if (!state.enabled || state.port !== port) state.generation = crypto.randomUUID();
      state.enabled = true; state.port = port;
      writeRemoteFile(this.path, JSON.stringify(parseRemoteState(state)));
      return state;
    });
  }
  /** Publish under one lock, then complete related journal cleanup before releasing ownership. */
  mutate(action: (state: RemoteState) => void, afterPublish?: () => void): RemoteState {
    this.requireEnabled();
    return withRemoteLock(this.directory, () => {
      const state = this.requireEnabled(); action(state);
      writeRemoteFile(this.path, JSON.stringify(parseRemoteState(state))); afterPublish?.(); return state;
    });
  }
  /** Disabling revokes current admission and invalidates every owner generation. */
  disable(): void { this.mutate(state => { state.enabled = false; state.generation = crypto.randomUUID(); }); }
  /** Require deliberate enablement rather than repairing or creating state on reads. */
  requireEnabled(): RemoteState {
    const state = this.read();
    if (!state?.enabled) throw remoteError("remote_disabled", "Explicitly enable messaging on this node first.");
    return state;
  }
  /** Select only one exact enrolled alias or machine UUID. */
  peer(selector: string): RemotePeer {
    const peers = this.requireEnabled().peers.filter(peer => peer.alias === selector || peer.machine.id === selector);
    if (peers.length !== 1) throw remoteError("unknown_peer", "No unique enrolled messaging peer matches this exact host.");
    return peers[0]!;
  }
  /** Revalidate captured route authority after awaits without retiring unrelated peer routes. */
  requireCurrentPeer(state: RemoteState, peer: RemotePeer): void {
    const current = this.requireEnabled();
    const enrolled = current.peers.find(item => item.machine.id === peer.machine.id);
    if (current.generation !== state.generation || current.machine.id !== state.machine.id
      || current.controlKey !== state.controlKey || current.port !== state.port || !enrolled
      || enrolled.transaction !== peer.transaction || enrolled.incoming !== peer.incoming
      || enrolled.outgoing !== peer.outgoing || enrolled.port !== peer.port) {
      throw remoteError("peer_revoked", "Messaging route authority changed before dispatch; no new work was sent.");
    }
  }
  /** Listings never include capabilities, known-hosts records or private configuration paths. */
  publicState() {
    const state = this.read();
    return state ? { protocol: state.protocol, machine: state.machine, enabled: state.enabled, port: state.port,
      peers: state.peers.map(peer => ({ alias: peer.alias, machine: peer.machine, direction: peer.ssh ? "initiating" : "return-only",
        fingerprint: peer.fingerprint })) } : { protocol: REMOTE_PROTOCOL, enabled: false, peers: [] };
  }
}
