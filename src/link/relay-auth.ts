import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const LINK_RELAY_AUTH_PATH = "/.well-known/opencodex/link-relay-auth";
export const LINK_RELAY_SESSION_HEADER = "x-opencodex-link-session";
export const LINK_RELAY_AUTH_VERSION = "2";
export const LINK_RELAY_AUTH_TIMEOUT_MS = 5_000;

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
