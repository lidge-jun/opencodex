import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const LINK_RELAY_AUTH_PATH = "/.well-known/opencodex/link-relay-auth";
export const LINK_RELAY_SESSION_HEADER = "x-opencodex-link-session";
/**
 * Marks a challenge that only asks whether the Home answers (the Child's readiness preflight): the
 * Home proves itself without reserving a session, so no data request can follow it and it holds
 * neither session capacity nor a drain lease. An older Home ignores it and reserves as before.
 */
export const LINK_RELAY_PROBE_HEADER = "x-opencodex-link-probe";
export const LINK_RELAY_AUTH_VERSION = "2";
export const LINK_RELAY_AUTH_TIMEOUT_MS = 5_000;
/**
 * An additive part of a Home's relay-auth answer: which tunnel connection the proof crossed, as
 * `<Home runtime instance>:<tunnel generation>`, bound to the same nonce and link key by its own
 * proof. A Child that cannot verify it, or an older Home that never sends it, leaves it unknown.
 */
export const LINK_RELAY_CONNECTION_HEADER = "x-opencodex-link-connection";
export const LINK_RELAY_CONNECTION_PROOF_HEADER = "x-opencodex-link-connection-proof";
/** Chosen once per process, so a runtime restart always changes every connection generation. */
export const LINK_RUNTIME_INSTANCE = randomUUID();
const CONNECTION_GENERATION = /^[\x21-\x7e]{1,256}$/;

export function isLinkConnectionGeneration(value: unknown): value is string {
  return typeof value === "string" && CONNECTION_GENERATION.test(value);
}

/** This process's name for a tunnel connection; the counter advances on every connect. */
export function linkConnectionGeneration(counter: number): string {
  return `${LINK_RUNTIME_INSTANCE}:${counter}`;
}

let connectionSequence = 0;

/**
 * A fresh connection name from one process-wide sequence, shared by the Home and Child
 * supervisors. A supervisor rebuilt in the same process (a restart rollback, a listener restart)
 * therefore never repeats a name an earlier one handed out.
 */
export function nextLinkConnectionGeneration(): string {
  connectionSequence += 1;
  return linkConnectionGeneration(connectionSequence);
}

export function linkConnectionProof(fingerprint: string, keyId: string, linkId: string, nonce: string, generation: string): string | null {
  if (!isLinkConnectionGeneration(generation) || !linkRelayProof(fingerprint, "listener", keyId, linkId, nonce)) return null;
  return createHmac("sha256", Buffer.from(fingerprint, "hex"))
    .update(`opencodex-link-connection-v1\0${keyId}\0${linkId}\0${nonce}\0${generation}`).digest("hex");
}

/** The direction and both identities are covered; a caller proof is never a listener proof. */
export function linkRelayProof(
  fingerprint: string, direction: "caller" | "listener", keyId: string, linkId: string, nonce: string,
): string | null {
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || !/^lnk_[a-f0-9]{16}$/.test(linkId)
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(keyId) || !/^[a-f0-9]{64}$/.test(nonce)) return null;
  return createHmac("sha256", Buffer.from(fingerprint, "hex"))
    .update(`opencodex-link-relay-v2\0${direction}\0${keyId}\0${linkId}\0${nonce}`).digest("hex");
}

export function linkRelayChallenge(fingerprint: string, keyId: string, linkId: string) {
  const nonce = randomBytes(32).toString("hex");
  const caller = linkRelayProof(fingerprint, "caller", keyId, linkId, nonce);
  const expected = linkRelayProof(fingerprint, "listener", keyId, linkId, nonce);
  if (!caller || !expected) throw new Error("invalid link relay identity");
  return { nonce, caller, expected };
}

export function linkRelayProofMatches(actual: string | null, expected: string | null): boolean {
  return !!actual && !!expected && /^[a-f0-9]{64}$/.test(actual) && /^[a-f0-9]{64}$/.test(expected)
    && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}
