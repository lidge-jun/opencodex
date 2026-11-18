export interface SignatureThresholdKey {
  keyId: string;
  algorithm: string;
  publicKey: string;
}

export interface SignatureThresholdEnvelope {
  signatures: { keyFingerprint: string; signatureBox: string }[];
}

/** Cryptographic checking only: the caller establishes key authority and policy. */
export function verifySignatureThreshold(bytes: Uint8Array, envelope: SignatureThresholdEnvelope, keys: SignatureThresholdKey[], threshold: number): void;
