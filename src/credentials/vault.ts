import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
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

function deriveKey(master: string): Buffer {
  return createHash("sha256").update(`pao.credential.vault.v1:${master}`).digest();
}

function resolveMaster(env: NodeJS.ProcessEnv = process.env): { key: Buffer; keyId: string } | null {
  const raw = env[MASTER_KEY_ENV]?.trim();
  if (!raw) return null;
  const keyId = env[MASTER_KEY_ID_ENV]?.trim() || "master-v1";
  return { key: deriveKey(raw), keyId };
}

export class AesGcmVault implements VaultService {
  private readonly key: Buffer;
  private readonly id: string;

  constructor(masterKey?: string, keyId = "master-v1") {
    const resolved = masterKey
      ? { key: deriveKey(masterKey), keyId }
      : resolveMaster();
    if (!resolved) throw new VaultUnavailableError("CREDENTIAL_MASTER_KEY is not set.");
    this.key = resolved.key;
    this.id = resolved.keyId;
  }

  public keyId(): string {
    return this.id;
  }

  public write(plaintext: string, keyId?: string): EncryptedEnvelopeV1 {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      version: 1,
      algorithm: "aes-256-gcm",
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      auth_tag: tag.toString("base64"),
      key_id: keyId ?? this.id,
    };
  }

  public read(envelope: EncryptedEnvelopeV1): string {
    if (envelope.algorithm !== "aes-256-gcm" || envelope.version !== 1) {
      throw new VaultIntegrityError("Unsupported envelope.");
    }
    if (envelope.key_id !== this.id) {
      throw new VaultIntegrityError("Envelope key id does not match the loaded master key.");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
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

