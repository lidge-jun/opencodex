import {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const REMOTE_E2EE_VERSION = "ocx-e2ee-v1" as const;
export const REMOTE_E2EE_KDF = Object.freeze({
  algorithm: "argon2id" as const,
  memoryKiB: 65_536,
  iterations: 3,
  parallelism: 1,
  outputLength: 32,
});

export interface RemoteE2eeEnvelope {
  version: typeof REMOTE_E2EE_VERSION;
  salt: string;
  nonce: string;
  ciphertext: string;
  rootPublicKey: string;
  kdf: typeof REMOTE_E2EE_KDF;
}

interface RemoteVaultPayload {
  version: 1;
  vaultKey: string;
  rootPrivateKeyPem: string;
}

const encoder = new TextEncoder();

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function aad(accountBinding: string): Buffer {
  return Buffer.from(`${REMOTE_E2EE_VERSION}\0${accountBinding}`, "utf8");
}

async function derive(password: string, salt: Uint8Array): Promise<{ authSecret: Buffer; wrapKey: Buffer }> {
  if (password.length < 10 || password.length > 128) throw new Error("remote password must be 10 to 128 characters");
  if (salt.length !== 16) throw new Error("remote vault salt must be 16 bytes");
  const root = Buffer.from(await argon2idAsync(encoder.encode(password), salt, {
    t: REMOTE_E2EE_KDF.iterations,
    m: REMOTE_E2EE_KDF.memoryKiB,
    p: REMOTE_E2EE_KDF.parallelism,
    dkLen: REMOTE_E2EE_KDF.outputLength,
    maxmem: 72 * 1024 * 1024,
    asyncTick: 10,
  }));
  try {
    return {
      authSecret: Buffer.from(hkdf(sha256, root, salt, encoder.encode("opencodex remote auth v1"), 32)),
      wrapKey: Buffer.from(hkdf(sha256, root, salt, encoder.encode("opencodex remote vault wrap v1"), 32)),
    };
  } finally {
    root.fill(0);
  }
}

function encryptPayload(payload: RemoteVaultPayload, wrapKey: Buffer, nonce: Buffer, accountBinding: string): Buffer {
  const cipher = createCipheriv("aes-256-gcm", wrapKey, nonce, { authTagLength: 16 });
  cipher.setAAD(aad(accountBinding));
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  try {
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  } finally {
    plaintext.fill(0);
  }
}

function decryptPayload(envelope: RemoteE2eeEnvelope, wrapKey: Buffer, accountBinding: string): RemoteVaultPayload {
  if (envelope.version !== REMOTE_E2EE_VERSION) throw new Error("unsupported remote vault version");
  const nonce = decode(envelope.nonce);
  const sealed = decode(envelope.ciphertext);
  if (nonce.length !== 12 || sealed.length < 17 || sealed.length > 4096) throw new Error("invalid remote vault envelope");
  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", wrapKey, nonce, { authTagLength: 16 });
  decipher.setAAD(aad(accountBinding));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  try {
    const parsed = JSON.parse(plaintext.toString("utf8")) as Partial<RemoteVaultPayload>;
    if (parsed.version !== 1 || typeof parsed.vaultKey !== "string" || typeof parsed.rootPrivateKeyPem !== "string") {
      throw new Error("invalid remote vault payload");
    }
    if (decode(parsed.vaultKey).length !== 32 || parsed.rootPrivateKeyPem.length > 2048) {
      throw new Error("invalid remote vault key material");
    }
    return parsed as RemoteVaultPayload;
  } finally {
    plaintext.fill(0);
  }
}

export async function createRemoteE2eeProfile(password: string, accountBinding: string): Promise<{
  authSecret: string;
  envelope: RemoteE2eeEnvelope;
}> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const vaultKey = randomBytes(32);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload: RemoteVaultPayload = {
    version: 1,
    vaultKey: encode(vaultKey),
    rootPrivateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  const derived = await derive(password, salt);
  try {
    const ciphertext = encryptPayload(payload, derived.wrapKey, nonce, accountBinding);
    return {
      authSecret: encode(derived.authSecret),
      envelope: {
        version: REMOTE_E2EE_VERSION,
        salt: encode(salt),
        nonce: encode(nonce),
        ciphertext: encode(ciphertext),
        rootPublicKey: encode(publicKey.export({ type: "spki", format: "der" })),
        kdf: REMOTE_E2EE_KDF,
      },
    };
  } finally {
    vaultKey.fill(0);
    derived.authSecret.fill(0);
    derived.wrapKey.fill(0);
  }
}

export async function unlockRemoteE2eeProfile(password: string, accountBinding: string, envelope: RemoteE2eeEnvelope): Promise<{
  authSecret: string;
  vault: RemoteVaultPayload;
}> {
  const salt = decode(envelope.salt);
  const derived = await derive(password, salt);
  try {
    return {
      authSecret: encode(derived.authSecret),
      vault: decryptPayload(envelope, derived.wrapKey, accountBinding),
    };
  } finally {
    derived.authSecret.fill(0);
    derived.wrapKey.fill(0);
  }
}

export async function rewrapRemoteE2eeProfile(
  oldPassword: string,
  newPassword: string,
  accountBinding: string,
  envelope: RemoteE2eeEnvelope,
): Promise<{ oldAuthSecret: string; newAuthSecret: string; envelope: RemoteE2eeEnvelope }> {
  const unlocked = await unlockRemoteE2eeProfile(oldPassword, accountBinding, envelope);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const derived = await derive(newPassword, salt);
  try {
    const ciphertext = encryptPayload(unlocked.vault, derived.wrapKey, nonce, accountBinding);
    return {
      oldAuthSecret: unlocked.authSecret,
      newAuthSecret: encode(derived.authSecret),
      envelope: {
        version: REMOTE_E2EE_VERSION,
        salt: encode(salt),
        nonce: encode(nonce),
        ciphertext: encode(ciphertext),
        rootPublicKey: envelope.rootPublicKey,
        kdf: REMOTE_E2EE_KDF,
      },
    };
  } finally {
    derived.authSecret.fill(0);
    derived.wrapKey.fill(0);
  }
}

/**
 * [Decision Log]
 * - 목적과 의도: 중앙 서버가 사용자의 원문 비밀번호나 vault 복호화 키를 보지 못하게 하면서 GitHub 외 별도 지식요소를 유지한다.
 * - 기존 구현 및 제약 조건: 중앙 Argon2id password hash는 인증은 제공하지만 서버가 입력 비밀번호를 직접 받고 E2EE 키 봉투가 없었다.
 * - 검토한 주요 대안: 서버측 password hash만 유지, 브라우저 PBKDF2, OPAQUE PAKE, client Argon2id와 HKDF domain separation.
 * - 선택한 방식: 로컬에서 Argon2id root를 만들고 인증용 secret과 AES-GCM wrapping key를 서로 다른 HKDF info로 분리한다.
 * - 다른 대안 대신 이 방식을 선택한 이유: 현재 Bun/브라우저에서 상호운용 가능하고 서버가 받은 인증 secret으로 vault key를 유도할 수 없다.
 * - 장점, 단점 및 영향: DB 유출의 오프라인 대입 비용과 저장 데이터 기밀성이 개선되지만 auth secret 자체는 password-equivalent이므로 TLS, rate limit, session revocation이 계속 필요하다. OPAQUE는 후속 강화 후보다.
 */
