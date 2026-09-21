import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { MASTER_KEY_ENV, MASTER_KEY_ID_ENV } from "./constants";
import type { EncryptedEnvelopeV1 } from "./types";

export class VaultUnavailableError extends Error {
  constructor(message = "Secret vault is unavailable.") {
    super(message);
    this.name = "VaultUnavailableError";
  }
}

export class VaultIntegrityError extends Error {
  constructor(message = "Encrypted envelope failed integrity check.") {
    super(message);
    this.name = "VaultIntegrityError";
  }
}

export interface VaultService {
  write(plaintext: string, keyId?: string): EncryptedEnvelopeV1;
  read(envelope: EncryptedEnvelopeV1): string;
  replace(envelope: EncryptedEnvelopeV1, plaintext: string): EncryptedEnvelopeV1;
  keyId(): string;
}

const LEGACY_SALT = "pao.credential.vault.v1";
const SALT_BYTES = 16;

function deriveKey(master: string, salt: string): Buffer {
  return scryptSync(master, salt, 32);
}

function resolveMaster(env: NodeJS.ProcessEnv = process.env): { raw: string; keyId: string } | null {
  const raw = env[MASTER_KEY_ENV]?.trim();
  if (!raw) return null;
  const keyId = env[MASTER_KEY_ID_ENV]?.trim() || "master-v1";
  return { raw, keyId };
}

function deriveKeyFromEnvelope(master: string, saltB64: string): Buffer {
  return deriveKey(master, saltB64);
}

export class AesGcmVault implements VaultService {
  /** Raw master key material, kept in memory only; never persisted or logged. */
  private readonly master: string;
  /** Key derived with the legacy fixed salt, used to read pre-salt envelopes. */
  private readonly legacyKey: Buffer;
  private readonly id: string;

  constructor(masterKey?: string, keyId = "master-v1") {
    const resolved = masterKey
      ? { raw: masterKey, keyId }
      : resolveMaster();
    if (!resolved) throw new VaultUnavailableError("CREDENTIAL_MASTER_KEY is not set.");
    this.master = resolved.raw;
    this.legacyKey = deriveKey(this.master, LEGACY_SALT);
    this.id = resolved.keyId;
  }

  public keyId(): string {
    return this.id;
  }

  public write(plaintext: string, keyId?: string): EncryptedEnvelopeV1 {
    // A fresh random salt is persisted per envelope so two envelopes holding the
    // same secret never share a scrypt-derived key; legacy envelopes without a
    // salt (pre-20.60-B) decrypt through the fixed legacy salt.
    const salt = randomBytes(SALT_BYTES).toString("base64");
    const key = deriveKeyFromEnvelope(this.master, salt);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      version: 1,
      algorithm: "aes-256-gcm",
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      auth_tag: tag.toString("base64"),
      key_id: keyId ?? this.id,
      salt,
    };
  }

  public read(envelope: EncryptedEnvelopeV1): string {
    if (envelope.algorithm !== "aes-256-gcm" || envelope.version !== 1) {
      throw new VaultIntegrityError("Unsupported envelope.");
    }
    if (envelope.key_id !== this.id) {
      throw new VaultIntegrityError("Envelope key id does not match the loaded master key.");
    }
    const key = envelope.salt
      ? deriveKeyFromEnvelope(this.master, envelope.salt)
      : this.legacyKey;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.auth_tag, "base64"));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
      return plain.toString("utf8");
    } catch {
      throw new VaultIntegrityError();
    }
  }

  public replace(envelope: EncryptedEnvelopeV1, plaintext: string): EncryptedEnvelopeV1 {
    this.read(envelope);
    return this.write(plaintext, envelope.key_id);
  }
}

export class MemoryVault implements VaultService {
  private readonly inner: AesGcmVault;
  constructor(masterKey = "test-master-key-do-not-use-in-prod") {
    this.inner = new AesGcmVault(masterKey, "master-v1");
  }
  public keyId(): string { return this.inner.keyId(); }
  public write(plaintext: string, keyId?: string): EncryptedEnvelopeV1 { return this.inner.write(plaintext, keyId); }
  public read(envelope: EncryptedEnvelopeV1): string { return this.inner.read(envelope); }
  public replace(envelope: EncryptedEnvelopeV1, plaintext: string): EncryptedEnvelopeV1 { return this.inner.replace(envelope, plaintext); }
}

export class UnavailableVault implements VaultService {
  public keyId(): string {
    throw new VaultUnavailableError("CREDENTIAL_MASTER_KEY is not set.");
  }
  public write(): EncryptedEnvelopeV1 {
    throw new VaultUnavailableError("CREDENTIAL_MASTER_KEY is not set.");
  }
  public read(): string {
    throw new VaultUnavailableError("CREDENTIAL_MASTER_KEY is not set.");
  }
  public replace(): EncryptedEnvelopeV1 {
    throw new VaultUnavailableError("CREDENTIAL_MASTER_KEY is not set.");
  }
}

export function createVault(env: NodeJS.ProcessEnv = process.env): VaultService {
  const master = env[MASTER_KEY_ENV]?.trim();
  if (master) return new AesGcmVault(master, env[MASTER_KEY_ID_ENV]?.trim() || "master-v1");
  if (process.env.NODE_ENV === "test" || Boolean(env.BUN_TEST)) return new MemoryVault();
  return new UnavailableVault();
}

export function envelopesEqual(a: EncryptedEnvelopeV1, b: EncryptedEnvelopeV1): boolean {
  const left = Buffer.from(JSON.stringify(a));
  const right = Buffer.from(JSON.stringify(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

