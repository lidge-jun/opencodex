import { describe, expect, test } from "bun:test";
import {
  createLocalAttestationChallenge,
  createLocalAttestationProof,
  createLocalAttestationSecret,
  verifyLocalAttestationProof,
} from "../src/lib/local-management-attestation";

describe("local management listener attestation", () => {
  test("a proof authenticates one challenge, pid, and port", () => {
    const secret = createLocalAttestationSecret();
    const challenge = createLocalAttestationChallenge();
    const proof = createLocalAttestationProof(secret, challenge, 4242, 19191);
    expect(proof).not.toBeNull();
    expect(verifyLocalAttestationProof(secret, challenge, 4242, 19191, proof)).toBe(true);
    expect(verifyLocalAttestationProof(secret, challenge, 4243, 19191, proof)).toBe(false);
    expect(verifyLocalAttestationProof(secret, challenge, 4242, 19192, proof)).toBe(false);
    expect(verifyLocalAttestationProof(secret, createLocalAttestationChallenge(), 4242, 19191, proof)).toBe(false);
  });

  test("malformed secrets, challenges, and proofs fail closed", () => {
    const secret = createLocalAttestationSecret();
    const challenge = createLocalAttestationChallenge();
    expect(createLocalAttestationProof("short", challenge, 4242, 19191)).toBeNull();
    expect(createLocalAttestationProof(secret, "short", 4242, 19191)).toBeNull();
    expect(verifyLocalAttestationProof(secret, challenge, 4242, 19191, null)).toBe(false);
    expect(verifyLocalAttestationProof(secret, challenge, 4242, 19191, "not-a-proof")).toBe(false);
  });
});
