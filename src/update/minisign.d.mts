import type { KeyObject } from "node:crypto";

export interface MinisignKey {
  keyId: string;
  publicKey: KeyObject;
  fingerprint: string;
}

export interface MinisignVerification {
  keyId: string;
  fingerprint: string;
  trustedComment: string;
}

export function decodePublicKey(text: string): MinisignKey;
export function verifyMinisignBytes(bytes: Uint8Array, signatureBox: string, key: MinisignKey): MinisignVerification;
export function verifyLegacyMinisignBytes(bytes: Uint8Array, signatureBox: string, key: Pick<MinisignKey, "keyId" | "publicKey">): Omit<MinisignVerification, "fingerprint">;
