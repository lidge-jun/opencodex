import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import type { PlatformConfig } from "./config";

export const GATEWAY_ASSERTION_HEADER = "x-opencodex-remote-assertion";
export const GATEWAY_ASSERTION_AUDIENCE = "opencodex-management";
const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function issueOpaqueToken(prefix: "ocxr_" | "ocxr_session_" | "ocxr_agent_" | "ocxr_device_"): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function issueShortCode(length = 12): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, byte => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]).join("");
}

export function normalizedPathHash(input: URL | string): string {
  const url = input instanceof URL ? new URL(input) : new URL(input, "https://instance.invalid");
  url.searchParams.sort();
  return createHash("sha256").update(`${url.pathname}${url.search}`).digest("hex");
}

export function encryptSecret(value: string, key: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(value: Buffer, key: Buffer): string {
  if (value[0] !== 1 || value.length < 30) throw new Error("unsupported encrypted secret envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(1, 13));
  decipher.setAuthTag(value.subarray(13, 29));
  return Buffer.concat([decipher.update(value.subarray(29)), decipher.final()]).toString("utf8");
}

export function networkSignalHmac(value: string, key: Buffer): string {
  return createHmac("sha256", key).update(value).digest("base64url");
}

export function gatewayPublicKeyPem(config: PlatformConfig): string {
  return createPublicKey(createPrivateKey(config.gatewayPrivateKeyPem))
    .export({ type: "spki", format: "pem" }).toString();
}

export function signGatewayAssertion(
  config: PlatformConfig,
  input: { instanceId: string; userId: string; method: string; url: URL },
  now = Date.now(),
): string {
  const iat = Math.floor(now / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: config.PLATFORM_GATEWAY_KID })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: config.PLATFORM_GATEWAY_ISSUER,
    aud: GATEWAY_ASSERTION_AUDIENCE,
    instance_id: input.instanceId,
    user_id: input.userId,
    method: input.method.toUpperCase(),
    path_sha256: normalizedPathHash(input.url),
    iat,
    exp: iat + 30,
    jti: randomUUID(),
  })).toString("base64url");
  const signingInput = `${header}.${claims}`;
  const signature = sign(null, Buffer.from(signingInput), config.gatewayPrivateKeyPem).toString("base64url");
  return `${signingInput}.${signature}`;
}
