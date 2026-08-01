import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

export interface RemoteE2eeEnvelope {
  version: "ocx-e2ee-v1";
  salt: string;
  nonce: string;
  ciphertext: string;
  rootPublicKey: string;
  kdf: {
    algorithm: "argon2id";
    memoryKiB: number;
    iterations: number;
    parallelism: number;
    outputLength: 32;
  };
}

export interface RemoteVault {
  version: 1;
  vaultKey: string;
  rootPrivateKeyPem: string;
}

export interface RemoteDeviceIdentity {
  id: string;
  signingPublicKey: string;
}

export type CommandProfile = "shell" | "codex" | "claude";

const encoder = new TextEncoder();

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("invalid base64url data");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function concat(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

function pemDer(value: string, label: string): Uint8Array {
  const match = value.match(new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`));
  if (!match) throw new Error(`invalid ${label.toLowerCase()}`);
  return Uint8Array.from(atob(match[1].replace(/\s/g, "")), character => character.charCodeAt(0));
}

function accountAad(githubNumericId: string): Uint8Array {
  return encoder.encode(`ocx-e2ee-v1\0github:${githubNumericId}`);
}

export async function unlockRemoteEnvelope(
  password: string,
  githubNumericId: string,
  envelope: RemoteE2eeEnvelope,
): Promise<{ authSecret: string; vault: RemoteVault }> {
  if (password.length < 10 || password.length > 128) throw new Error("Remote password must be 10 to 128 characters");
  if (
    envelope.version !== "ocx-e2ee-v1"
    || envelope.kdf.algorithm !== "argon2id"
    || envelope.kdf.outputLength !== 32
    || envelope.kdf.memoryKiB !== 65_536
    || envelope.kdf.iterations !== 3
    || envelope.kdf.parallelism !== 1
  ) throw new Error("Unsupported Remote encryption profile");
  const salt = base64UrlDecode(envelope.salt);
  const nonce = base64UrlDecode(envelope.nonce);
  const ciphertext = base64UrlDecode(envelope.ciphertext);
  if (salt.length !== 16 || nonce.length !== 12 || ciphertext.length < 17 || ciphertext.length > 4096) {
    throw new Error("Invalid Remote encryption envelope");
  }
  const root = await argon2idAsync(encoder.encode(password), salt, {
    t: envelope.kdf.iterations,
    m: envelope.kdf.memoryKiB,
    p: envelope.kdf.parallelism,
    dkLen: 32,
    maxmem: 72 * 1024 * 1024,
    asyncTick: 10,
  });
  try {
    const authSecret = hkdf(sha256, root, salt, encoder.encode("opencodex remote auth v1"), 32);
    const wrapKey = hkdf(sha256, root, salt, encoder.encode("opencodex remote vault wrap v1"), 32);
    try {
      const aes = await crypto.subtle.importKey("raw", arrayBuffer(wrapKey), "AES-GCM", false, ["decrypt"]);
      const plaintext = new Uint8Array(await crypto.subtle.decrypt({
        name: "AES-GCM",
        iv: arrayBuffer(nonce),
        additionalData: arrayBuffer(accountAad(githubNumericId)),
        tagLength: 128,
      }, aes, arrayBuffer(ciphertext)));
      try {
        const vault = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<RemoteVault>;
        if (
          vault.version !== 1
          || typeof vault.vaultKey !== "string"
          || base64UrlDecode(vault.vaultKey).length !== 32
          || typeof vault.rootPrivateKeyPem !== "string"
          || vault.rootPrivateKeyPem.length > 2048
        ) throw new Error("Invalid Remote vault");
        return { authSecret: base64UrlEncode(authSecret), vault: vault as RemoteVault };
      } finally {
        plaintext.fill(0);
      }
    } finally {
      wrapKey.fill(0);
    }
  } catch {
    throw new Error("Remote password is incorrect or the encrypted vault is damaged");
  } finally {
    root.fill(0);
  }
}

function uuidBytes(value: string): Uint8Array {
  const hex = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("invalid terminal session ID");
  return Uint8Array.from(hex.match(/.{2}/g)!, byte => Number.parseInt(byte, 16));
}

function clientTranscript(
  sessionId: string,
  deviceId: string,
  profile: CommandProfile,
  publicKey: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  return concat(
    encoder.encode("ocx-terminal-client-v1\0"),
    uuidBytes(sessionId),
    uuidBytes(deviceId),
    encoder.encode(profile),
    Uint8Array.of(0),
    publicKey,
    nonce,
  );
}

function agentTranscript(client: Uint8Array, publicKey: Uint8Array, nonce: Uint8Array): Uint8Array {
  return concat(encoder.encode("ocx-terminal-agent-v1\0"), client, publicKey, nonce);
}

function nonce(prefix: Uint8Array, counter: bigint): Uint8Array {
  const result = new Uint8Array(12);
  result.set(prefix, 0);
  new DataView(result.buffer).setBigUint64(4, counter, false);
  return result;
}

function aad(sessionId: string, direction: number, counter: bigint): Uint8Array {
  const counterBytes = new Uint8Array(8);
  new DataView(counterBytes.buffer).setBigUint64(0, counter, false);
  return concat(
    encoder.encode("ocx-terminal-frame-v1\0"),
    uuidBytes(sessionId),
    Uint8Array.of(direction),
    counterBytes,
  );
}

export class BrowserTerminalCipher {
  private sendCounter = 0n;
  private receiveCounter = 0n;

  private constructor(
    private readonly sessionId: string,
    private readonly sendKey: CryptoKey,
    private readonly receiveKey: CryptoKey,
    private readonly sendNoncePrefix: Uint8Array,
    private readonly receiveNoncePrefix: Uint8Array,
  ) {}

  static async handshake(
    socket: WebSocket,
    sessionId: string,
    profile: CommandProfile,
    device: RemoteDeviceIdentity,
    vault: RemoteVault,
  ): Promise<BrowserTerminalCipher> {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
    const clientNonce = crypto.getRandomValues(new Uint8Array(32));
    const transcript = clientTranscript(sessionId, device.id, profile, publicKey, clientNonce);
    const rootPrivateKey = await crypto.subtle.importKey(
      "pkcs8",
      arrayBuffer(pemDer(vault.rootPrivateKeyPem, "PRIVATE KEY")),
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", rootPrivateKey, arrayBuffer(transcript)));
    const response = await new Promise<ArrayBuffer>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => reject(new Error("Remote computer handshake timed out")), 15_000);
      const onMessage = (event: MessageEvent) => {
        globalThis.clearTimeout(timeout);
        socket.removeEventListener("close", onClose);
        if (event.data instanceof ArrayBuffer) resolve(event.data);
        else reject(new Error("Remote computer sent an invalid handshake"));
      };
      const onClose = () => {
        globalThis.clearTimeout(timeout);
        socket.removeEventListener("message", onMessage);
        reject(new Error("Remote computer disconnected during handshake"));
      };
      socket.addEventListener("message", onMessage, { once: true });
      socket.addEventListener("close", onClose, { once: true });
      socket.send(encoder.encode(JSON.stringify({
        commandProfile: profile,
        ephemeralPublicKey: base64UrlEncode(publicKey),
        clientNonce: base64UrlEncode(clientNonce),
        signature: base64UrlEncode(signature),
      })));
    });
    const hello = JSON.parse(new TextDecoder().decode(response)) as {
      ephemeralPublicKey?: unknown; serverNonce?: unknown; signature?: unknown;
    };
    if (typeof hello.ephemeralPublicKey !== "string" || typeof hello.serverNonce !== "string" || typeof hello.signature !== "string") {
      throw new Error("Remote computer sent an invalid handshake");
    }
    const agentPublicBytes = base64UrlDecode(hello.ephemeralPublicKey);
    const serverNonce = base64UrlDecode(hello.serverNonce);
    if (serverNonce.length !== 32) throw new Error("Remote computer sent an invalid nonce");
    const deviceSigningKey = await crypto.subtle.importKey(
      "spki",
      arrayBuffer(base64UrlDecode(device.signingPublicKey)),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    if (!await crypto.subtle.verify(
      "Ed25519",
      deviceSigningKey,
      arrayBuffer(base64UrlDecode(hello.signature)),
      arrayBuffer(agentTranscript(transcript, agentPublicBytes, serverNonce)),
    )) throw new Error("Remote computer identity verification failed");
    const agentPublicKey = await crypto.subtle.importKey(
      "spki",
      arrayBuffer(agentPublicBytes),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const shared = new Uint8Array(await crypto.subtle.deriveBits({
      name: "ECDH",
      public: agentPublicKey,
    }, pair.privateKey, 256));
    const salt = sha256(concat(clientNonce, serverNonce));
    const sendKey = hkdf(sha256, shared, salt, encoder.encode("ocx terminal browser to agent key v1"), 32);
    const receiveKey = hkdf(sha256, shared, salt, encoder.encode("ocx terminal agent to browser key v1"), 32);
    const sendNoncePrefix = hkdf(sha256, shared, salt, encoder.encode("ocx terminal browser to agent nonce v1"), 4);
    const receiveNoncePrefix = hkdf(sha256, shared, salt, encoder.encode("ocx terminal agent to browser nonce v1"), 4);
    shared.fill(0);
    return new BrowserTerminalCipher(
      sessionId,
      await crypto.subtle.importKey("raw", arrayBuffer(sendKey), "AES-GCM", false, ["encrypt"]),
      await crypto.subtle.importKey("raw", arrayBuffer(receiveKey), "AES-GCM", false, ["decrypt"]),
      sendNoncePrefix,
      receiveNoncePrefix,
    );
  }

  async encrypt(plaintext: Uint8Array): Promise<ArrayBuffer> {
    const counter = this.sendCounter;
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
      name: "AES-GCM",
      iv: arrayBuffer(nonce(this.sendNoncePrefix, counter)),
      additionalData: arrayBuffer(aad(this.sessionId, 0, counter)),
      tagLength: 128,
    }, this.sendKey, arrayBuffer(plaintext)));
    this.sendCounter += 1n;
    const result = new Uint8Array(8 + ciphertext.length);
    new DataView(result.buffer).setBigUint64(0, counter, false);
    result.set(ciphertext, 8);
    return result.buffer;
  }

  async decrypt(encrypted: ArrayBuffer): Promise<Uint8Array> {
    const bytes = new Uint8Array(encrypted);
    if (bytes.length < 24) throw new Error("Encrypted terminal frame is too short");
    const counter = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, false);
    if (counter !== this.receiveCounter) throw new Error("Replayed or out-of-order terminal frame");
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: arrayBuffer(nonce(this.receiveNoncePrefix, counter)),
      additionalData: arrayBuffer(aad(this.sessionId, 1, counter)),
      tagLength: 128,
    }, this.receiveKey, arrayBuffer(bytes.subarray(8))));
    this.receiveCounter += 1n;
    return plaintext;
  }
}
