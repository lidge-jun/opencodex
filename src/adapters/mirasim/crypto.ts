import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";

export const MIRASIM_SIGNATURE_VERSION = "mrs-sig-v2";
export const MIRASIM_SEAL_VERSION = "mrs-seal-v1";
export const MIRASIM_DEFAULT_SEAL_PUBLIC_KEY_BASE64 = "HlyNMMeGXryasYLJuYQ/9ksCD4AYVVy1zXKAtJdpJn4=";

export const MIRASIM_HEADERS = {
  device: "x-mirasim-device",
  timestamp: "x-mirasim-ts",
  nonce: "x-mirasim-nonce",
  signature: "x-mirasim-sig",
  client: "x-mirasim-client",
  encryptedMetadata: "x-mirasim-enc",
  session: "x-mirasim-session",
  agent: "x-mirasim-agent",
  call: "x-mirasim-call",
} as const;

export interface MirasimDeviceIdentity {
  privateKeyPem: string;
  publicKeyBase64: string;
  deviceId: string;
}

export interface MirasimSigningInput {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  deviceId: string;
  clientVersion: string;
  credential: string;
  metadata?: Readonly<Record<string, string>>;
  body: Uint8Array;
}

export interface MirasimSignedRequest {
  canonicalPayload: string;
  signature: string;
  headers: Record<string, string>;
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function base64UrlNoPadding(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function rejectNul(label: string, value: string): void {
  if (value.includes("\0")) throw new Error(`Mirasim ${label} contains NUL`);
}

export function canonicalMirasimMetadata(metadata: Readonly<Record<string, string>> | undefined): string {
  if (!metadata) return "";
  const normalized = new Map<string, string>();
  for (const [rawKey, rawValue] of Object.entries(metadata)) {
    const key = rawKey.toLowerCase();
    if (!rawValue) continue;
    rejectNul("metadata key", key);
    rejectNul("metadata value", rawValue);
    normalized.set(key, rawValue);
  }
  return [...normalized.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("\n");
}

export function canonicalMirasimSignaturePayload(input: MirasimSigningInput): string {
  const method = input.method.trim().toUpperCase();
  const fields = [
    method,
    input.path,
    input.timestamp,
    input.nonce,
    input.deviceId,
    input.clientVersion,
    input.credential,
  ];
  for (const value of fields) rejectNul("signature field", value);

  const metadataCanonical = canonicalMirasimMetadata(input.metadata);
  const metadataDigest = metadataCanonical ? sha256Hex(metadataCanonical) : "";
  return [
    MIRASIM_SIGNATURE_VERSION,
    method,
    input.path,
    input.timestamp,
    input.nonce,
    input.deviceId,
    input.clientVersion,
    sha256Hex(input.credential),
    metadataDigest,
    sha256Hex(input.body),
  ].join("\n");
}

function loadEd25519PrivateKey(privateKeyPem: string): KeyObject {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Mirasim device private key is not Ed25519");
  }
  return privateKey;
}

function publicKeyFromPrivateKey(privateKey: KeyObject): KeyObject {
  const pkcs8Pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return createPublicKey(pkcs8Pem);
}

export function createMirasimDeviceIdentity(privateKeyPem?: string): MirasimDeviceIdentity {
  let key: KeyObject;
  if (privateKeyPem?.trim()) {
    key = loadEd25519PrivateKey(privateKeyPem.trim());
  } else {
    key = generateKeyPairSync("ed25519").privateKey;
  }
  const pem = key.export({ type: "pkcs8", format: "pem" }).toString().trim();
  const publicDer = publicKeyFromPrivateKey(key).export({ type: "spki", format: "der" }) as Buffer;
  const publicKeyBase64 = publicDer.toString("base64");
  const deviceId = createHash("sha256")
    .update(publicKeyBase64, "utf8")
    .digest("base64url")
    .slice(0, 22);
  return { privateKeyPem: pem, publicKeyBase64, deviceId };
}

export function signMirasimRequest(
  input: Omit<MirasimSigningInput, "timestamp" | "nonce"> & {
    privateKeyPem: string;
    timestamp?: string;
    nonce?: string;
  },
): MirasimSignedRequest {
  const timestamp = input.timestamp ?? String(Date.now());
  const nonce = input.nonce ?? base64UrlNoPadding(randomBytes(12));
  const canonicalPayload = canonicalMirasimSignaturePayload({
    ...input,
    timestamp,
    nonce,
  });
  const signature = sign(null, Buffer.from(canonicalPayload, "utf8"), loadEd25519PrivateKey(input.privateKeyPem)).toString("base64url");
  const headers: Record<string, string> = {
    ...(input.metadata ?? {}),
    [MIRASIM_HEADERS.device]: input.deviceId,
    [MIRASIM_HEADERS.timestamp]: timestamp,
    [MIRASIM_HEADERS.nonce]: nonce,
    [MIRASIM_HEADERS.signature]: signature,
  };
  if (input.clientVersion) headers[MIRASIM_HEADERS.client] = input.clientVersion;
  return { canonicalPayload, signature, headers };
}

const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function x25519PrivateKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.byteLength !== 32) throw new Error(`Mirasim X25519 private key must be 32 bytes, got ${raw.byteLength}`);
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(raw)]),
    type: "pkcs8",
    format: "der",
  });
}

function x25519PublicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.byteLength !== 32) throw new Error(`Mirasim X25519 public key must be 32 bytes, got ${raw.byteLength}`);
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]),
    type: "spki",
    format: "der",
  });
}

function rawX25519PublicKey(privateKey: KeyObject): Buffer {
  const der = publicKeyFromPrivateKey(privateKey).export({ type: "spki", format: "der" }) as Buffer;
  if (der.length < 32) throw new Error("Mirasim X25519 public key export is malformed");
  return der.subarray(der.length - 32);
}

function decodeRelayPublicKey(encoded: string): Buffer {
  const trimmed = encoded.trim();
  if (!trimmed) throw new Error("Mirasim relay seal public key is empty");
  let decoded: Buffer;
  try {
    decoded = Buffer.from(trimmed, "base64");
  } catch {
    throw new Error("Mirasim relay seal public key is not valid base64");
  }
  if (decoded.length !== 32) {
    throw new Error(`Mirasim relay seal public key must decode to 32 bytes, got ${decoded.length}`);
  }
  return decoded;
}

function stableMetadataJson(metadata: Readonly<Record<string, string>>): string {
  const ordered: Record<string, string> = {};
  for (const key of Object.keys(metadata).sort()) {
    const value = metadata[key];
    if (value !== undefined) ordered[key] = value;
  }
  return JSON.stringify(ordered);
}

function rotateLeft32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function quarterRound(state: Uint32Array, a: number, b: number, c: number, d: number): void {
  state[a] = (state[a]! + state[b]!) >>> 0;
  state[d] = rotateLeft32(state[d]! ^ state[a]!, 16);
  state[c] = (state[c]! + state[d]!) >>> 0;
  state[b] = rotateLeft32(state[b]! ^ state[c]!, 12);
  state[a] = (state[a]! + state[b]!) >>> 0;
  state[d] = rotateLeft32(state[d]! ^ state[a]!, 8);
  state[c] = (state[c]! + state[d]!) >>> 0;
  state[b] = rotateLeft32(state[b]! ^ state[c]!, 7);
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]!
    | (bytes[offset + 1]! << 8)
    | (bytes[offset + 2]! << 16)
    | (bytes[offset + 3]! << 24)
  ) >>> 0;
}

function chacha20Block(key: Uint8Array, counter: number, nonce: Uint8Array): Buffer {
  if (key.length !== 32) throw new Error("ChaCha20 key must be 32 bytes");
  if (nonce.length !== 12) throw new Error("ChaCha20 nonce must be 12 bytes");
  const initial = new Uint32Array(16);
  initial[0] = 0x61707865;
  initial[1] = 0x3320646e;
  initial[2] = 0x79622d32;
  initial[3] = 0x6b206574;
  for (let index = 0; index < 8; index++) initial[4 + index] = readU32LE(key, index * 4);
  initial[12] = counter >>> 0;
  initial[13] = readU32LE(nonce, 0);
  initial[14] = readU32LE(nonce, 4);
  initial[15] = readU32LE(nonce, 8);

  const state = new Uint32Array(initial);
  for (let round = 0; round < 10; round++) {
    quarterRound(state, 0, 4, 8, 12);
    quarterRound(state, 1, 5, 9, 13);
    quarterRound(state, 2, 6, 10, 14);
    quarterRound(state, 3, 7, 11, 15);
    quarterRound(state, 0, 5, 10, 15);
    quarterRound(state, 1, 6, 11, 12);
    quarterRound(state, 2, 7, 8, 13);
    quarterRound(state, 3, 4, 9, 14);
  }

  const out = Buffer.allocUnsafe(64);
  for (let index = 0; index < 16; index++) {
    out.writeUInt32LE((state[index]! + initial[index]!) >>> 0, index * 4);
  }
  return out;
}

function chacha20Xor(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(plaintext.length);
  let counter = 1;
  for (let offset = 0; offset < plaintext.length; offset += 64, counter++) {
    const block = chacha20Block(key, counter, nonce);
    const take = Math.min(64, plaintext.length - offset);
    for (let index = 0; index < take; index++) {
      out[offset + index] = plaintext[offset + index]! ^ block[index]!;
    }
  }
  return out;
}

function littleEndianBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index--) {
    value = (value << 8n) | BigInt(bytes[index]!);
  }
  return value;
}

function bigIntLittleEndian(value: bigint, length: number): Buffer {
  const out = Buffer.alloc(length);
  let remaining = value;
  for (let index = 0; index < length; index++) {
    out[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

function poly1305(message: Uint8Array, oneTimeKey: Uint8Array): Buffer {
  if (oneTimeKey.length !== 32) throw new Error("Poly1305 key must be 32 bytes");
  const rBytes = Buffer.from(oneTimeKey.subarray(0, 16));
  rBytes[3] &= 15;
  rBytes[7] &= 15;
  rBytes[11] &= 15;
  rBytes[15] &= 15;
  rBytes[4] &= 252;
  rBytes[8] &= 252;
  rBytes[12] &= 252;
  const r = littleEndianBigInt(rBytes);
  const s = littleEndianBigInt(oneTimeKey.subarray(16, 32));
  const prime = (1n << 130n) - 5n;
  let accumulator = 0n;
  for (let offset = 0; offset < message.length; offset += 16) {
    const block = message.subarray(offset, Math.min(offset + 16, message.length));
    const n = littleEndianBigInt(block) + (1n << BigInt(block.length * 8));
    accumulator = ((accumulator + n) * r) % prime;
  }
  return bigIntLittleEndian((accumulator + s) & ((1n << 128n) - 1n), 16);
}

function u64le(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("AEAD length is out of range");
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function pad16(length: number): Buffer {
  const remainder = length % 16;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(16 - remainder);
}

/**
 * RFC 8439 ChaCha20-Poly1305 implemented here rather than via node:crypto:
 * Bun 1.3/1.4 does not expose the chacha20-poly1305 cipher through createCipheriv.
 */
function chacha20Poly1305Seal(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Buffer {
  const oneTimeKey = chacha20Block(key, 0, nonce).subarray(0, 32);
  const ciphertext = chacha20Xor(key, nonce, plaintext);
  const macInput = Buffer.concat([
    Buffer.from(aad),
    pad16(aad.length),
    ciphertext,
    pad16(ciphertext.length),
    u64le(aad.length),
    u64le(ciphertext.length),
  ]);
  return Buffer.concat([ciphertext, poly1305(macInput, oneTimeKey)]);
}

export interface MirasimSealOptions {
  recipientPublicKeyBase64?: string;
  ephemeralSecret?: Uint8Array;
  nonce?: Uint8Array;
}

export function sealMirasimRelayMetadata(
  metadata: Readonly<Record<string, string>>,
  method: string,
  path: string,
  options: MirasimSealOptions = {},
): string {
  const recipientRaw = decodeRelayPublicKey(
    options.recipientPublicKeyBase64
      ?? process.env.MIRASIM_SEAL_PUBKEY
      ?? MIRASIM_DEFAULT_SEAL_PUBLIC_KEY_BASE64,
  );
  const ephemeralPrivate = x25519PrivateKeyFromRaw(options.ephemeralSecret ?? randomBytes(32));
  const ephemeralPublic = rawX25519PublicKey(ephemeralPrivate);
  const recipientPublic = x25519PublicKeyFromRaw(recipientRaw);
  const sharedSecret = diffieHellman({ privateKey: ephemeralPrivate, publicKey: recipientPublic });
  const key = Buffer.from(hkdfSync(
    "sha256",
    sharedSecret,
    ephemeralPublic,
    Buffer.from(MIRASIM_SEAL_VERSION, "utf8"),
    32,
  ));
  const nonce = Buffer.from(options.nonce ?? randomBytes(12));
  if (nonce.length !== 12) throw new Error(`Mirasim seal nonce must be 12 bytes, got ${nonce.length}`);

  const aad = Buffer.from(
    [MIRASIM_SEAL_VERSION, method.trim().toUpperCase(), path].join("\n"),
    "utf8",
  );
  const sealed = chacha20Poly1305Seal(
    key,
    nonce,
    Buffer.from(stableMetadataJson(metadata), "utf8"),
    aad,
  );
  return Buffer.concat([ephemeralPublic, nonce, sealed]).toString("base64url");
}

export function sealedMirasimHeaders(
  headers: Readonly<Record<string, string>>,
  method: string,
  path: string,
  options: MirasimSealOptions = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      lower.startsWith("x-mirasim-")
      && lower !== MIRASIM_HEADERS.client
      && lower !== MIRASIM_HEADERS.encryptedMetadata
    ) {
      if (value) metadata[lower] = value;
      continue;
    }
    out[lower] = value;
  }
  if (Object.keys(metadata).length > 0) {
    out[MIRASIM_HEADERS.encryptedMetadata] = sealMirasimRelayMetadata(metadata, method, path, options);
  }
  return out;
}
