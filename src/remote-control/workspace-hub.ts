import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  atomicWriteFile,
  getConfigDir,
  hardenConfigDir,
  hardenExistingSecret,
} from "../config";
import {
  generateRemoteControlIdentityKeyPair,
  type RemoteControlIdentityKeyPair,
} from "./crypto";
import type { RemoteWorkspaceHubAgentConnection } from "./workspace-agent-connection";
import {
  parseRemoteWorkspaceCapabilities,
  type RemoteWorkspaceCapability,
} from "./workspace-tools";

export const REMOTE_WORKSPACE_HUB_STATE_VERSION = 1 as const;
export const REMOTE_WORKSPACE_MAX_DEVICES = 32;
export const REMOTE_WORKSPACE_MAX_ROOTS_PER_DEVICE = 32;
const PAIRING_LIFETIME_MS = 10 * 60_000;
const MAX_PAIRING_GRANTS = 16;
const MAX_HUB_STATE_BYTES = 1024 * 1024;
const TOKEN_PREFIX = "ocxrw_";
const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PAIRING_SOURCE_WINDOW_MS = 10 * 60_000;
const PAIRING_SOURCE_FAILURE_LIMIT = 10;
const PAIRING_SOURCE_LIMIT = 1_024;

export interface RemoteWorkspaceRootAdvertisement {
  id: string;
  label: string;
}

export interface RemoteWorkspaceStoredDevice {
  id: string;
  name: string;
  platform: string;
  publicKey: string;
  tokenHash: string;
  capabilities: RemoteWorkspaceCapability[];
  roots: RemoteWorkspaceRootAdvertisement[];
  createdAt: string;
  lastSeenAt: string | null;
}

export interface RemoteWorkspaceHubState {
  version: typeof REMOTE_WORKSPACE_HUB_STATE_VERSION;
  identity: RemoteControlIdentityKeyPair;
  devices: RemoteWorkspaceStoredDevice[];
}

export interface RemoteWorkspaceHubStateStore {
  load(): RemoteWorkspaceHubState | null;
  save(state: RemoteWorkspaceHubState): void;
}

export interface RemoteWorkspacePublicDevice {
  id: string;
  name: string;
  platform: string;
  capabilities: RemoteWorkspaceCapability[];
  roots: RemoteWorkspaceRootAdvertisement[];
  online: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface RemoteWorkspacePairingGrant {
  code: string;
  expiresAt: string;
}

export interface RemoteWorkspacePairDeviceInput {
  code: string;
  name: string;
  platform: string;
  publicKey: string;
  capabilities?: RemoteWorkspaceCapability[];
  roots: RemoteWorkspaceRootAdvertisement[];
}

export interface RemoteWorkspacePairDeviceResult {
  device: RemoteWorkspacePublicDevice;
  deviceToken: string;
  hubPublicKey: string;
}

interface PendingPairingGrant {
  hash: Buffer;
  expiresAt: number;
}

interface PairingSourceFailureRecord {
  failures: number;
  windowStartedAt: number;
}

export class RemoteWorkspacePairingRateLimitError extends Error {
  constructor(
    readonly retryAfterSeconds: number,
    readonly reason: "source" | "capacity",
  ) {
    super("remote workspace pairing rate limit exceeded");
    this.name = "RemoteWorkspacePairingRateLimitError";
  }
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function encodeHash(value: Buffer): string {
  return value.toString("base64url");
}

function parseHash(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("invalid remote workspace token hash");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32) throw new Error("invalid remote workspace token hash");
  return decoded;
}

function normalizeCode(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

function newPairingCode(): string {
  const bytes = randomBytes(12);
  let code = "";
  for (let index = 0; index < bytes.length; index += 1) {
    code += PAIRING_ALPHABET[bytes[index]! % PAIRING_ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`invalid remote workspace ${label}`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > max || /[\x00-\x1f\x7f]/.test(normalized)) {
    throw new Error(`invalid remote workspace ${label}`);
  }
  return normalized;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid remote workspace device metadata");
  }
  return value as Record<string, unknown>;
}

function exactPairingFields(value: Record<string, unknown>): void {
  const required = ["code", "name", "platform", "publicKey", "roots"] as const;
  const allowed = new Set<string>([...required, "capabilities"]);
  if (required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !allowed.has(key))) {
    throw new Error("invalid remote workspace device metadata");
  }
}

function validUuid(value: unknown, label: string): string {
  const normalized = boundedText(value, label, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new Error(`invalid remote workspace ${label}`);
  }
  return normalized;
}

function validatePublicKey(value: unknown): string {
  const encoded = boundedText(value, "device public key", 1024);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("invalid remote workspace device public key");
  const key = createPublicKey({ key: Buffer.from(encoded, "base64url"), type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("remote workspace device key must use Ed25519");
  return encoded;
}

function validateIdentity(value: unknown): RemoteControlIdentityKeyPair {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid remote workspace hub identity");
  const raw = value as Record<string, unknown>;
  const publicKey = validatePublicKey(raw.publicKey);
  const privateKey = boundedText(raw.privateKey, "hub private key", 2048);
  const privateDer = Buffer.from(privateKey, "base64url");
  const parsed = createPrivateKey({ key: privateDer, type: "pkcs8", format: "der" });
  if (parsed.asymmetricKeyType !== "ed25519") throw new Error("remote workspace hub key must use Ed25519");
  const challenge = Buffer.from("opencodex remote workspace hub identity v1", "utf8");
  const signature = sign(null, challenge, parsed);
  const verifier = createPublicKey({ key: Buffer.from(publicKey, "base64url"), type: "spki", format: "der" });
  if (!verify(null, challenge, verifier, signature)) {
    throw new Error("remote workspace hub identity key pair does not match");
  }
  return { publicKey, privateKey };
}

function validateRoots(value: unknown): RemoteWorkspaceRootAdvertisement[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > REMOTE_WORKSPACE_MAX_ROOTS_PER_DEVICE) {
    throw new Error("remote workspace device needs one to 32 roots");
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid remote workspace root");
    const raw = item as Record<string, unknown>;
    const id = validUuid(raw.id, "root ID");
    const label = boundedText(raw.label, "root label", 80);
    const folded = label.toLocaleLowerCase("en-US");
    if (ids.has(id) || labels.has(folded)) throw new Error("duplicate remote workspace root");
    ids.add(id);
    labels.add(folded);
    return { id, label };
  });
}

function validateDate(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("invalid remote workspace timestamp");
  return value;
}

export function parseRemoteWorkspaceHubState(value: unknown): RemoteWorkspaceHubState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid remote workspace hub state");
  const raw = value as Record<string, unknown>;
  if (raw.version !== REMOTE_WORKSPACE_HUB_STATE_VERSION || !Array.isArray(raw.devices)) {
    throw new Error("unsupported remote workspace hub state");
  }
  if (raw.devices.length > REMOTE_WORKSPACE_MAX_DEVICES) throw new Error("remote workspace device limit exceeded");
  const ids = new Set<string>();
  const names = new Set<string>();
  const devices = raw.devices.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid remote workspace device state");
    const device = item as Record<string, unknown>;
    const id = validUuid(device.id, "device ID");
    const name = boundedText(device.name, "device name", 80);
    const folded = name.toLocaleLowerCase("en-US");
    if (ids.has(id) || names.has(folded)) throw new Error("duplicate remote workspace device identity");
    ids.add(id);
    names.add(folded);
    if (typeof device.tokenHash !== "string") throw new Error("invalid remote workspace token hash");
    parseHash(device.tokenHash);
    const tokenHash = device.tokenHash;
    return {
      id,
      name,
      platform: boundedText(device.platform, "device platform", 80),
      publicKey: validatePublicKey(device.publicKey),
      tokenHash,
      capabilities: parseRemoteWorkspaceCapabilities(device.capabilities),
      roots: validateRoots(device.roots),
      createdAt: validateDate(device.createdAt)!,
      lastSeenAt: validateDate(device.lastSeenAt, true),
    };
  });
  return {
    version: REMOTE_WORKSPACE_HUB_STATE_VERSION,
    identity: validateIdentity(raw.identity),
    devices,
  };
}

export class RemoteWorkspaceHubFileStore implements RemoteWorkspaceHubStateStore {
  constructor(private readonly path = join(getConfigDir(), "remote-workspace-hub.json")) {}

  load(): RemoteWorkspaceHubState | null {
    hardenConfigDir();
    if (!existsSync(this.path)) return null;
    hardenExistingSecret(this.path);
    const metadata = statSync(this.path);
    if (!metadata.isFile() || metadata.size > MAX_HUB_STATE_BYTES) {
      throw new Error("remote workspace hub state is too large");
    }
    return parseRemoteWorkspaceHubState(JSON.parse(readFileSync(this.path, "utf8")));
  }

  save(state: RemoteWorkspaceHubState): void {
    const directory = getConfigDir();
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    hardenConfigDir();
    atomicWriteFile(this.path, `${JSON.stringify(parseRemoteWorkspaceHubState(state), null, 2)}\n`);
  }
}

export class RemoteWorkspaceHub {
  private state: RemoteWorkspaceHubState;
  private readonly grants = new Map<string, PendingPairingGrant>();
  private readonly pairingSourceFailures = new Map<string, PairingSourceFailureRecord>();
  private readonly connections = new Map<string, RemoteWorkspaceHubAgentConnection>();

  constructor(
    private readonly store: RemoteWorkspaceHubStateStore,
    private readonly now: () => number = Date.now,
  ) {
    const loaded = store.load();
    this.state = loaded ?? {
      version: REMOTE_WORKSPACE_HUB_STATE_VERSION,
      identity: generateRemoteControlIdentityKeyPair(),
      devices: [],
    };
    if (loaded === null) this.store.save(this.state);
  }

  identity(): RemoteControlIdentityKeyPair {
    return { ...this.state.identity };
  }

  createPairingGrant(): RemoteWorkspacePairingGrant {
    this.pruneGrants();
    if (this.grants.size >= MAX_PAIRING_GRANTS) throw new Error("remote workspace pairing capacity reached");
    let code: string;
    let digest: Buffer;
    do {
      code = newPairingCode();
      digest = sha256(normalizeCode(code));
    } while (this.grants.has(encodeHash(digest)));
    const expiresAt = this.now() + PAIRING_LIFETIME_MS;
    this.grants.set(encodeHash(digest), { hash: digest, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  private pairingSourceKey(source: string): string {
    return encodeHash(sha256(`remote-workspace-pairing-source\0${source}`));
  }

  private prunePairingSourceFailures(now: number): void {
    // Records never extend their original fixed window, so insertion order is expiry order. Stop
    // at the first live entry instead of making every unauthenticated request scan the full cap.
    for (const [key, record] of this.pairingSourceFailures) {
      if (record.windowStartedAt + PAIRING_SOURCE_WINDOW_MS > now) break;
      this.pairingSourceFailures.delete(key);
    }
  }

  private pairingSourceRecord(source: string, now: number): [string, PairingSourceFailureRecord | undefined] {
    this.prunePairingSourceFailures(now);
    const key = this.pairingSourceKey(source);
    return [key, this.pairingSourceFailures.get(key)];
  }

  private admitPairingSource(source: string, now: number): string {
    const [key, record] = this.pairingSourceRecord(source, now);
    if (record && record.failures >= PAIRING_SOURCE_FAILURE_LIMIT) {
      const remaining = Math.max(1, record.windowStartedAt + PAIRING_SOURCE_WINDOW_MS - now);
      throw new RemoteWorkspacePairingRateLimitError(Math.ceil(remaining / 1000), "source");
    }
    return key;
  }

  assertPairingSourceAllowed(source = "anonymous"): void {
    this.admitPairingSource(source, this.now());
  }

  private recordPairingSourceFailure(key: string, now: number): void {
    let record = this.pairingSourceFailures.get(key);
    if (!record) {
      if (this.pairingSourceFailures.size >= PAIRING_SOURCE_LIMIT) {
        throw new RemoteWorkspacePairingRateLimitError(1, "capacity");
      }
      record = { failures: 0, windowStartedAt: now };
      this.pairingSourceFailures.set(key, record);
    }
    record.failures += 1;
    if (record.failures >= PAIRING_SOURCE_FAILURE_LIMIT) {
      const remaining = Math.max(1, record.windowStartedAt + PAIRING_SOURCE_WINDOW_MS - now);
      throw new RemoteWorkspacePairingRateLimitError(Math.ceil(remaining / 1000), "source");
    }
  }

  pairDevice(input: unknown, source = "anonymous"): RemoteWorkspacePairDeviceResult {
    this.pruneGrants();
    const nowMs = this.now();
    const sourceKey = this.admitPairingSource(source, nowMs);
    const raw = objectRecord(input);
    const normalizedCode = normalizeCode(typeof raw.code === "string" ? raw.code : "");
    if (normalizedCode.length !== 12 || ![...normalizedCode].every(character => PAIRING_ALPHABET.includes(character))) {
      this.recordPairingSourceFailure(sourceKey, nowMs);
      throw new Error("invalid or expired remote workspace pairing code");
    }
    const digest = sha256(normalizedCode);
    const key = encodeHash(digest);
    const grant = this.grants.get(key);
    if (!grant || grant.expiresAt <= nowMs || !timingSafeEqual(grant.hash, digest)) {
      this.recordPairingSourceFailure(sourceKey, nowMs);
      throw new Error("invalid or expired remote workspace pairing code");
    }
    this.pairingSourceFailures.delete(sourceKey);
    // A valid grant is one-shot even when the submitted device metadata is rejected. Keeping it
    // alive after a conflict would let the same copied secret authorize repeated enrollment tries.
    this.grants.delete(key);
    exactPairingFields(raw);
    if (this.state.devices.length >= REMOTE_WORKSPACE_MAX_DEVICES) throw new Error("remote workspace device limit reached");
    const name = boundedText(raw.name, "device name", 80);
    const folded = name.toLocaleLowerCase("en-US");
    if (this.state.devices.some(device => device.name.toLocaleLowerCase("en-US") === folded)) {
      throw new Error("remote workspace device name is already in use");
    }
    const now = new Date(nowMs).toISOString();
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const device: RemoteWorkspaceStoredDevice = {
      id: randomUUID(),
      name,
      platform: boundedText(raw.platform, "device platform", 80),
      publicKey: validatePublicKey(raw.publicKey),
      tokenHash: encodeHash(sha256(token)),
      capabilities: parseRemoteWorkspaceCapabilities(raw.capabilities),
      roots: validateRoots(raw.roots),
      createdAt: now,
      lastSeenAt: null,
    };
    this.state = { ...this.state, devices: [...this.state.devices, device] };
    this.store.save(this.state);
    return {
      device: this.publicDevice(device),
      deviceToken: token,
      hubPublicKey: this.state.identity.publicKey,
    };
  }

  authenticateDeviceToken(token: string): RemoteWorkspaceStoredDevice | null {
    if (!token.startsWith(TOKEN_PREFIX) || token.length !== TOKEN_PREFIX.length + 43) return null;
    const digest = sha256(token);
    for (const device of this.state.devices) {
      const stored = parseHash(device.tokenHash);
      if (timingSafeEqual(stored, digest)) {
        return { ...device, capabilities: [...device.capabilities], roots: device.roots.map(root => ({ ...root })) };
      }
    }
    return null;
  }

  attachConnection(deviceId: string, connection: RemoteWorkspaceHubAgentConnection): void {
    const index = this.state.devices.findIndex(device => device.id === deviceId);
    if (index < 0) throw new Error("unknown remote workspace device");
    const previous = this.connections.get(deviceId);
    if (previous && previous !== connection) previous.close("remote workspace executor reconnected");
    this.connections.set(deviceId, connection);
    const seen = new Date(this.now()).toISOString();
    this.state = {
      ...this.state,
      devices: this.state.devices.map((device, deviceIndex) => (
        deviceIndex === index ? { ...device, lastSeenAt: seen } : device
      )),
    };
    this.store.save(this.state);
  }

  updateDeviceCapabilities(deviceId: string, capabilities: readonly RemoteWorkspaceCapability[]): void {
    const normalized = parseRemoteWorkspaceCapabilities(capabilities);
    const index = this.state.devices.findIndex(device => device.id === deviceId);
    if (index < 0) throw new Error("unknown remote workspace device");
    const current = this.state.devices[index]!;
    if (current.capabilities.length === normalized.length
      && current.capabilities.every((capability, capabilityIndex) => capability === normalized[capabilityIndex])) return;
    this.state = {
      ...this.state,
      devices: this.state.devices.map((device, deviceIndex) => (
        deviceIndex === index ? { ...device, capabilities: normalized } : device
      )),
    };
    this.store.save(this.state);
  }

  detachConnection(deviceId: string, connection: RemoteWorkspaceHubAgentConnection): void {
    if (this.connections.get(deviceId) !== connection) return;
    this.connections.delete(deviceId);
    connection.close();
  }

  connection(deviceId: string): RemoteWorkspaceHubAgentConnection | null {
    const connection = this.connections.get(deviceId);
    return connection?.isOnline() ? connection : null;
  }

  listDevices(): RemoteWorkspacePublicDevice[] {
    return this.state.devices.map(device => this.publicDevice(device));
  }

  revokeDevice(deviceId: string): boolean {
    const before = this.state.devices.length;
    this.state = { ...this.state, devices: this.state.devices.filter(device => device.id !== deviceId) };
    if (this.state.devices.length === before) return false;
    const connection = this.connections.get(deviceId);
    this.connections.delete(deviceId);
    connection?.close("remote workspace device was revoked");
    this.store.save(this.state);
    return true;
  }

  closeAllConnections(reason = "remote workspace hub stopped"): void {
    const connections = [...this.connections.values()];
    this.connections.clear();
    for (const connection of connections) connection.close(reason);
  }

  private publicDevice(device: RemoteWorkspaceStoredDevice): RemoteWorkspacePublicDevice {
    return {
      id: device.id,
      name: device.name,
      platform: device.platform,
      capabilities: [...device.capabilities],
      roots: device.roots.map(root => ({ ...root })),
      online: this.connections.get(device.id)?.isOnline() ?? false,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
    };
  }

  private pruneGrants(): void {
    const now = this.now();
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(key);
    }
  }
}
