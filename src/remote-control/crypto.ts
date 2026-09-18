import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  REMOTE_CONTROL_MAX_RELAY_PAYLOAD_BYTES,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  isRemoteControlCommandProfile,
  isRemoteControlUuid,
  normalizeRemoteControlCapabilities,
  remoteControlUuidBytes,
  type RemoteControlCapability,
  type RemoteControlClientHello,
  type RemoteControlCommandProfile,
  type RemoteControlHostHello,
} from "./protocol";

const HELLO_MAX_BYTES = 16 * 1024;
const NONCE_BYTES = 32;
const GCM_TAG_BYTES = 16;
const COUNTER_BYTES = 8;
const MAX_COUNTER = 0xffff_ffff_ffff_ffffn;
const MAX_ENCRYPTED_PLAINTEXT_BYTES = REMOTE_CONTROL_MAX_RELAY_PAYLOAD_BYTES - GCM_TAG_BYTES - COUNTER_BYTES;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface RemoteControlIdentityKeyPair {
  publicKey: string;
  privateKey: string;
}

export interface CreateRemoteControlClientHandshakeOptions {
  sessionId: string;
  deviceId: string;
  commandProfile: RemoteControlCommandProfile;
  capabilities: readonly RemoteControlCapability[];
  accountPrivateKey: string;
}

export interface AcceptRemoteControlClientHelloOptions {
  expectedSessionId: string;
  expectedDeviceId: string;
  accountPublicKey: string;
  devicePrivateKey: string;
  allowedCapabilities: readonly RemoteControlCapability[];
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: unknown, label: string, maxBytes: number): Buffer {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value) || value.length > Math.ceil(maxBytes * 4 / 3) + 4) {
    throw new Error(`invalid ${label}`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength === 0 || decoded.byteLength > maxBytes || encode(decoded) !== value) throw new Error(`invalid ${label}`);
  return decoded;
}

function privateSigningKey(value: string): KeyObject {
  const key = createPrivateKey({ key: decode(value, "remote control private key", 256), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("remote control private key must be Ed25519");
  return key;
}

function publicSigningKey(value: string): KeyObject {
  const key = createPublicKey({ key: decode(value, "remote control public key", 256), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("remote control public key must be Ed25519");
  return key;
}

function publicEphemeralKey(value: string): KeyObject {
  const key = createPublicKey({ key: decode(value, "remote control ephemeral key", 256), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("remote control ephemeral key must use P-256");
  }
  return key;
}

function lengthPrefixed(value: Uint8Array): Buffer {
  if (value.byteLength > 0xffff) throw new Error("remote control transcript field is too large");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(value.byteLength);
  return Buffer.concat([length, Buffer.from(value)]);
}

function capabilityTranscript(capabilities: readonly RemoteControlCapability[]): Buffer {
  const normalized = normalizeRemoteControlCapabilities([...capabilities]);
  return Buffer.concat([
    Buffer.from([normalized.length]),
    ...normalized.map(capability => lengthPrefixed(Buffer.from(capability, "utf8"))),
  ]);
}

function clientTranscript(hello: Omit<RemoteControlClientHello, "signature">): Buffer {
  return Buffer.concat([
    Buffer.from("opencodex-remote-control-client-v1\0", "utf8"),
    Buffer.from([hello.version]),
    Buffer.from(remoteControlUuidBytes(hello.sessionId)),
    Buffer.from(remoteControlUuidBytes(hello.deviceId)),
    lengthPrefixed(Buffer.from(hello.commandProfile, "utf8")),
    capabilityTranscript(hello.capabilities),
    lengthPrefixed(decode(hello.ephemeralPublicKey, "remote control ephemeral key", 256)),
    decode(hello.nonce, "remote control client nonce", NONCE_BYTES),
  ]);
}

function hostTranscript(
  client: Buffer,
  hello: Omit<RemoteControlHostHello, "signature">,
): Buffer {
  return Buffer.concat([
    Buffer.from("opencodex-remote-control-host-v1\0", "utf8"),
    createHash("sha256").update(client).digest(),
    capabilityTranscript(hello.capabilities),
    lengthPrefixed(decode(hello.ephemeralPublicKey, "remote control ephemeral key", 256)),
    decode(hello.nonce, "remote control host nonce", NONCE_BYTES),
  ]);
}

function parseJsonObject(value: Uint8Array, label: string): Record<string, unknown> {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > HELLO_MAX_BYTES) {
    throw new Error(`invalid ${label}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
  } catch {
    throw new Error(`invalid ${label}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`invalid ${label}`);
  return parsed as Record<string, unknown>;
}

function validateCommonHello(raw: Record<string, unknown>, label: string): {
  sessionId: string;
  deviceId: string;
  capabilities: RemoteControlCapability[];
  ephemeralPublicKey: string;
  nonce: string;
  signature: string;
} {
  if (raw.version !== REMOTE_CONTROL_PROTOCOL_VERSION) throw new Error(`unsupported ${label} version`);
  if (!isRemoteControlUuid(raw.sessionId) || !isRemoteControlUuid(raw.deviceId)) throw new Error(`invalid ${label} identity`);
  const capabilities = normalizeRemoteControlCapabilities(raw.capabilities);
  if (typeof raw.ephemeralPublicKey !== "string" || typeof raw.nonce !== "string" || typeof raw.signature !== "string") {
    throw new Error(`invalid ${label} cryptographic fields`);
  }
  const ephemeralPublicKey = raw.ephemeralPublicKey;
  const encodedNonce = raw.nonce;
  const encodedSignature = raw.signature;
  decode(ephemeralPublicKey, `${label} ephemeral key`, 256);
  const nonce = decode(encodedNonce, `${label} nonce`, NONCE_BYTES);
  if (nonce.byteLength !== NONCE_BYTES) throw new Error(`invalid ${label} nonce`);
  const signature = decode(encodedSignature, `${label} signature`, 128);
  if (signature.byteLength !== 64) throw new Error(`invalid ${label} signature`);
  return {
    sessionId: raw.sessionId,
    deviceId: raw.deviceId,
    capabilities,
    ephemeralPublicKey,
    nonce: encodedNonce,
    signature: encodedSignature,
  };
}

export function parseRemoteControlClientHello(value: Uint8Array): RemoteControlClientHello {
  const raw = parseJsonObject(value, "remote control client hello");
  const common = validateCommonHello(raw, "remote control client hello");
  if (!isRemoteControlCommandProfile(raw.commandProfile)) throw new Error("invalid remote control command profile");
  return {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    ...common,
    commandProfile: raw.commandProfile,
  };
}

export function parseRemoteControlHostHello(value: Uint8Array): RemoteControlHostHello {
  const raw = parseJsonObject(value, "remote control host hello");
  return { version: REMOTE_CONTROL_PROTOCOL_VERSION, ...validateCommonHello(raw, "remote control host hello") };
}

export function serializeRemoteControlHello(value: RemoteControlClientHello | RemoteControlHostHello): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  if (encoded.byteLength > HELLO_MAX_BYTES) throw new Error("remote control hello is too large");
  return encoded;
}

export function generateRemoteControlIdentityKeyPair(): RemoteControlIdentityKeyPair {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicKey: encode(pair.publicKey.export({ format: "der", type: "spki" })),
    privateKey: encode(pair.privateKey.export({ format: "der", type: "pkcs8" })),
  };
}

function nonce(prefix: Buffer, counter: bigint): Buffer {
  const result = Buffer.alloc(12);
  prefix.copy(result, 0);
  result.writeBigUInt64BE(counter, 4);
  return result;
}

function frameAad(sessionId: string, direction: 0 | 1, counter: bigint): Buffer {
  const counterBytes = Buffer.alloc(COUNTER_BYTES);
  counterBytes.writeBigUInt64BE(counter);
  return Buffer.concat([
    Buffer.from("opencodex-remote-control-frame-v1\0", "utf8"),
    Buffer.from(remoteControlUuidBytes(sessionId)),
    Buffer.from([direction]),
    counterBytes,
  ]);
}

export class RemoteControlCipher {
  private sendCounter = 0n;
  private receiveCounter = 0n;
  private destroyed = false;

  constructor(
    private readonly sessionId: string,
    private readonly sendDirection: 0 | 1,
    private readonly sendKey: Buffer,
    private readonly receiveKey: Buffer,
    private readonly sendNoncePrefix: Buffer,
    private readonly receiveNoncePrefix: Buffer,
  ) {}

  encrypt(value: Uint8Array): Uint8Array {
    if (this.destroyed) throw new Error("remote control cipher is closed");
    if (!(value instanceof Uint8Array) || value.byteLength > MAX_ENCRYPTED_PLAINTEXT_BYTES) {
      throw new Error("remote control encrypted payload is too large");
    }
    if (this.sendCounter > MAX_COUNTER) throw new Error("remote control send counter exhausted");
    const counter = this.sendCounter;
    const cipher = createCipheriv("aes-256-gcm", this.sendKey, nonce(this.sendNoncePrefix, counter), { authTagLength: GCM_TAG_BYTES });
    cipher.setAAD(frameAad(this.sessionId, this.sendDirection, counter));
    const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
    const counterBytes = Buffer.alloc(COUNTER_BYTES);
    counterBytes.writeBigUInt64BE(counter);
    this.sendCounter += 1n;
    return Buffer.concat([counterBytes, ciphertext, cipher.getAuthTag()]);
  }

  decrypt(value: Uint8Array): Uint8Array {
    if (this.destroyed) throw new Error("remote control cipher is closed");
    if (
      !(value instanceof Uint8Array)
      || value.byteLength < COUNTER_BYTES + GCM_TAG_BYTES
      || value.byteLength > REMOTE_CONTROL_MAX_RELAY_PAYLOAD_BYTES
    ) throw new Error("invalid remote control encrypted frame");
    const bytes = Buffer.from(value);
    const counter = bytes.readBigUInt64BE(0);
    if (counter !== this.receiveCounter) throw new Error("replayed or out-of-order remote control frame");
    const ciphertextEnd = bytes.byteLength - GCM_TAG_BYTES;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.receiveKey,
      nonce(this.receiveNoncePrefix, counter),
      { authTagLength: GCM_TAG_BYTES },
    );
    decipher.setAAD(frameAad(this.sessionId, this.sendDirection === 0 ? 1 : 0, counter));
    decipher.setAuthTag(bytes.subarray(ciphertextEnd));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(COUNTER_BYTES, ciphertextEnd)), decipher.final()]);
    this.receiveCounter += 1n;
    return plaintext;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.sendKey.fill(0);
    this.receiveKey.fill(0);
    this.sendNoncePrefix.fill(0);
    this.receiveNoncePrefix.fill(0);
  }
}

function deriveCipher(options: {
  sessionId: string;
  shared: Buffer;
  clientNonce: Buffer;
  hostNonce: Buffer;
  role: "client" | "host";
}): RemoteControlCipher {
  const salt = createHash("sha256").update(options.clientNonce).update(options.hostNonce).digest();
  const expand = (info: string, length: number): Buffer => Buffer.from(hkdfSync(
    "sha256",
    options.shared,
    salt,
    Buffer.from(info, "utf8"),
    length,
  ));
  const clientToHostKey = expand("opencodex remote control client to host key v1", 32);
  const hostToClientKey = expand("opencodex remote control host to client key v1", 32);
  const clientToHostNonce = expand("opencodex remote control client to host nonce v1", 4);
  const hostToClientNonce = expand("opencodex remote control host to client nonce v1", 4);
  options.shared.fill(0);
  return options.role === "client"
    ? new RemoteControlCipher(options.sessionId, 0, clientToHostKey, hostToClientKey, clientToHostNonce, hostToClientNonce)
    : new RemoteControlCipher(options.sessionId, 1, hostToClientKey, clientToHostKey, hostToClientNonce, clientToHostNonce);
}

export class RemoteControlClientHandshake {
  readonly hello: RemoteControlClientHello;
  private completed = false;

  private constructor(
    hello: RemoteControlClientHello,
    private readonly ephemeralPrivateKey: KeyObject,
    private readonly transcript: Buffer,
  ) {
    this.hello = hello;
  }

  static create(options: CreateRemoteControlClientHandshakeOptions): RemoteControlClientHandshake {
    if (!isRemoteControlUuid(options.sessionId) || !isRemoteControlUuid(options.deviceId)) {
      throw new Error("invalid remote control handshake identity");
    }
    if (!isRemoteControlCommandProfile(options.commandProfile)) throw new Error("invalid remote control command profile");
    const capabilities = normalizeRemoteControlCapabilities([...options.capabilities]);
    const ephemeral = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const unsigned: Omit<RemoteControlClientHello, "signature"> = {
      version: REMOTE_CONTROL_PROTOCOL_VERSION,
      sessionId: options.sessionId,
      deviceId: options.deviceId,
      commandProfile: options.commandProfile,
      capabilities,
      ephemeralPublicKey: encode(ephemeral.publicKey.export({ format: "der", type: "spki" })),
      nonce: encode(randomBytes(NONCE_BYTES)),
    };
    const transcript = clientTranscript(unsigned);
    const hello: RemoteControlClientHello = {
      ...unsigned,
      signature: encode(sign(null, transcript, privateSigningKey(options.accountPrivateKey))),
    };
    return new RemoteControlClientHandshake(hello, ephemeral.privateKey, transcript);
  }

  complete(hostHello: RemoteControlHostHello, devicePublicKey: string): RemoteControlCipher {
    if (this.completed) throw new Error("remote control client handshake already completed");
    const validated = parseRemoteControlHostHello(serializeRemoteControlHello(hostHello));
    if (validated.sessionId !== this.hello.sessionId || validated.deviceId !== this.hello.deviceId) {
      throw new Error("remote control host hello identity mismatch");
    }
    const requested = new Set(this.hello.capabilities);
    if (validated.capabilities.some(capability => !requested.has(capability))) {
      throw new Error("remote control host granted an unrequested capability");
    }
    const unsigned: Omit<RemoteControlHostHello, "signature"> = {
      version: validated.version,
      sessionId: validated.sessionId,
      deviceId: validated.deviceId,
      capabilities: validated.capabilities,
      ephemeralPublicKey: validated.ephemeralPublicKey,
      nonce: validated.nonce,
    };
    if (!verify(
      null,
      hostTranscript(this.transcript, unsigned),
      publicSigningKey(devicePublicKey),
      decode(validated.signature, "remote control host signature", 128),
    )) throw new Error("remote control host identity verification failed");
    const cipher = deriveCipher({
      sessionId: this.hello.sessionId,
      shared: Buffer.from(diffieHellman({
        privateKey: this.ephemeralPrivateKey,
        publicKey: publicEphemeralKey(validated.ephemeralPublicKey),
      })),
      clientNonce: decode(this.hello.nonce, "remote control client nonce", NONCE_BYTES),
      hostNonce: decode(validated.nonce, "remote control host nonce", NONCE_BYTES),
      role: "client",
    });
    this.completed = true;
    return cipher;
  }
}

export function acceptRemoteControlClientHello(
  clientHello: RemoteControlClientHello,
  options: AcceptRemoteControlClientHelloOptions,
): { hello: RemoteControlHostHello; cipher: RemoteControlCipher } {
  const validated = parseRemoteControlClientHello(serializeRemoteControlHello(clientHello));
  if (validated.sessionId !== options.expectedSessionId || validated.deviceId !== options.expectedDeviceId) {
    throw new Error("remote control client hello identity mismatch");
  }
  const allowed = new Set(normalizeRemoteControlCapabilities([...options.allowedCapabilities]));
  const capabilities = validated.capabilities.filter(capability => allowed.has(capability));
  const unsignedClient: Omit<RemoteControlClientHello, "signature"> = {
    version: validated.version,
    sessionId: validated.sessionId,
    deviceId: validated.deviceId,
    commandProfile: validated.commandProfile,
    capabilities: validated.capabilities,
    ephemeralPublicKey: validated.ephemeralPublicKey,
    nonce: validated.nonce,
  };
  const transcript = clientTranscript(unsignedClient);
  if (!verify(
    null,
    transcript,
    publicSigningKey(options.accountPublicKey),
    decode(validated.signature, "remote control client signature", 128),
  )) throw new Error("remote control account identity verification failed");

  const ephemeral = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const unsignedHost: Omit<RemoteControlHostHello, "signature"> = {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    sessionId: validated.sessionId,
    deviceId: validated.deviceId,
    capabilities,
    ephemeralPublicKey: encode(ephemeral.publicKey.export({ format: "der", type: "spki" })),
    nonce: encode(randomBytes(NONCE_BYTES)),
  };
  const hello: RemoteControlHostHello = {
    ...unsignedHost,
    signature: encode(sign(null, hostTranscript(transcript, unsignedHost), privateSigningKey(options.devicePrivateKey))),
  };
  return {
    hello,
    cipher: deriveCipher({
      sessionId: validated.sessionId,
      shared: Buffer.from(diffieHellman({
        privateKey: ephemeral.privateKey,
        publicKey: publicEphemeralKey(validated.ephemeralPublicKey),
      })),
      clientNonce: decode(validated.nonce, "remote control client nonce", NONCE_BYTES),
      hostNonce: decode(hello.nonce, "remote control host nonce", NONCE_BYTES),
      role: "host",
    }),
  };
}
