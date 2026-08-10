import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const LOCAL_ATTESTATION_CHALLENGE_HEADER = "x-opencodex-attestation-challenge";
export const LOCAL_ATTESTATION_PROOF_HEADER = "x-opencodex-attestation-proof";

const BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/;

export function isLocalAttestationSecret(value: unknown): value is string {
  return typeof value === "string" && BASE64URL_256.test(value);
}

export function createLocalAttestationSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function createLocalAttestationChallenge(): string {
  return randomBytes(32).toString("base64url");
}

function attestationPayload(challenge: string, pid: number, port: number): string | null {
  if (!BASE64URL_256.test(challenge)) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return `opencodex-local-management-v1\n${challenge}\n${pid}\n${port}`;
}

export function createLocalAttestationProof(
  secret: string,
  challenge: string,
  pid: number,
  port: number,
): string | null {
  if (!isLocalAttestationSecret(secret)) return null;
  const payload = attestationPayload(challenge, pid, port);
  if (!payload) return null;
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function verifyLocalAttestationProof(
  secret: string,
  challenge: string,
  pid: number,
  port: number,
  proof: string | null,
): boolean {
  const expected = createLocalAttestationProof(secret, challenge, pid, port);
  if (!expected || !proof || !BASE64URL_256.test(proof)) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(proof);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
