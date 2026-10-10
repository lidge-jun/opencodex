import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isRecord, isThreadId, LocalMessagingError } from "./types";

export const REMOTE_PROTOCOL = "ocx-message-remote/1";
export const REMOTE_LIMITS = Object.freeze({ peers: 4, connections: 16, requests: 32, helpers: 10,
  persistentHelpers: 8, transientHelpers: 2,
  outputBytes: 2 * 1024 * 1024, frameBytes: 1024 * 1024, storeBytes: 128 * 1024, authMs: 5000,
  leaseMs: 25000, shutdownMs: 3000 });
export interface MessageMachine { id: string; name: string }
export interface RemotePeer {
  alias: string; machine: MessageMachine; transaction: string; incoming: string; outgoing: string;
  port: number; ssh: string | null; hostKey: string | null; fingerprint: string | null;
}
export interface RemoteState {
  protocol: typeof REMOTE_PROTOCOL; machine: MessageMachine; enabled: boolean; port: number;
  controlKey: string; generation: string; peers: RemotePeer[];
}

/** Fail closed with authored diagnostics rather than untrusted transport/configuration output. */
export function remoteError(code: string, message: string): LocalMessagingError {
  return new LocalMessagingError(code, message);
}
/** Accept an exact bounded object schema, including rejection of unknown fields. */
export function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw remoteError("invalid_remote_contract", "Messaging peer returned an invalid protocol object.");
  }
  return value;
}
/** Validate the stable machine identity; names are display metadata, never route authority. */
export function validMachine(value: unknown): value is MessageMachine {
  return isRecord(value) && Object.keys(value).length === 2 && isThreadId(value.id)
    && typeof value.name === "string" && value.name.length > 0 && value.name.length <= 128
    && !/[\x00-\x1f\x7f-\x9f]/.test(value.name);
}
/** Permit exact CLI aliases, not names containing shell syntax or fuzzy selectors. */
export function validAlias(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}
/** Messaging listeners and both forward directions use unprivileged ports only. */
export function validPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1024 && Number(value) <= 65535;
}
/** Generate a receiver-issued 256-bit capability; never print it in ordinary CLI output. */
export function capability(): string { return randomBytes(32).toString("hex"); }
/** Validate protocol capability/nonces before any keyed proof calculation. */
export function validCapability(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
/** Direction-separated proofs bind both identities, enrollment and fresh nonces on one socket. */
export function peerProof(key: string, direction: "server" | "client", from: string, to: string,
  transaction: string, clientNonce: string, serverNonce: string): string {
  return createHmac("sha256", key).update(JSON.stringify([
    REMOTE_PROTOCOL, direction, from, to, transaction, clientNonce, serverNonce,
  ])).digest("hex");
}
/** Fixed-size comparison refuses malformed proofs rather than comparing secret strings. */
export function matchesProof(actual: unknown, expected: string): boolean {
  return validCapability(actual) && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

/** One foreground owner's reservations are shared across peers and both tunnel directions. */
export class RemoteCapacity {
  private used = { connections: 0, requests: 0, helpers: 0, outputBytes: 0 };
  private helperSlots = { persistent: 0, transient: 0 };
  /** Keep transient inspectors/control commands available alongside all eight tunnel children. */
  reserveHelper(purpose: "persistent" | "transient"): () => void {
    const limit = purpose === "persistent" ? REMOTE_LIMITS.persistentHelpers : REMOTE_LIMITS.transientHelpers;
    if (this.helperSlots[purpose] >= limit) {
      throw remoteError("remote_capacity", "The messaging owner's aggregate helper purpose limit was reached.");
    }
    const free = this.reserve("helpers"); this.helperSlots[purpose]++;
    let released = false;
    return () => { if (!released) { released = true; this.helperSlots[purpose]--; free(); } };
  }
  /** Reserve before allocating/spawning; overload creates no hidden waiting queue. */
  reserve(kind: keyof RemoteCapacity["used"], amount = 1): () => void {
    if (!Number.isSafeInteger(amount) || amount < 1 || this.used[kind] + amount > REMOTE_LIMITS[kind]) {
      throw remoteError("remote_capacity", "The messaging owner's aggregate resource limit was reached.");
    }
    this.used[kind] += amount;
    let released = false;
    return () => { if (!released) { released = true; this.used[kind] -= amount; } };
  }
  /** Safe counters for tests/status: no identities, capabilities or message bodies. */
  snapshot() { return { ...this.used }; }
}
