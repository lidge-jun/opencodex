import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { arch, hostname, platform } from "node:os";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
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
import { RemoteWorkspaceExecutor } from "./workspace-executor";
import { RemoteWorkspaceExecutorAgentConnection } from "./workspace-agent-connection";
import {
  createPlatformRemoteWorkspaceCommandRunner,
  discoverRemoteWorkspaceNativeHelper,
  parseRemoteWorkspaceNativeHelperDescriptor,
  pinRemoteWorkspaceNativeHelper,
  type RemoteWorkspaceNativeHelperDescriptor,
} from "./workspace-command-runner";
import type { RemoteWorkspaceCommandRunner } from "./workspace-executor";
import {
  REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
  serializeRemoteWorkspaceAgentMessage,
} from "./workspace-agent-protocol";
import {
  parseRemoteWorkspaceCapabilities,
  type RemoteWorkspaceCapability,
} from "./workspace-tools";

export const REMOTE_WORKSPACE_DEVICE_STATE_VERSION = 1 as const;
const DEVICE_TOKEN_PATTERN = /^ocxrw_[A-Za-z0-9_-]{43}$/;
const MAX_PAIR_RESPONSE_BYTES = 64 * 1024;
const MAX_DEVICE_STATE_BYTES = 1024 * 1024;
const PAIR_TIMEOUT_MS = 15_000;

export interface RemoteWorkspaceDeviceRoot {
  id: string;
  label: string;
  path: string;
}

export interface RemoteWorkspaceDeviceState {
  version: typeof REMOTE_WORKSPACE_DEVICE_STATE_VERSION;
  hubUrl: string;
  agentUrl: string;
  deviceId: string;
  deviceName: string;
  devicePlatform: string;
  capabilities: RemoteWorkspaceCapability[];
  deviceToken: string;
  deviceIdentity: RemoteControlIdentityKeyPair;
  hubPublicKey: string;
  roots: RemoteWorkspaceDeviceRoot[];
  toolchainRoots: string[];
  nativeHelper?: RemoteWorkspaceNativeHelperDescriptor;
}

export interface RemoteWorkspaceDeviceStateStore {
  load(): RemoteWorkspaceDeviceState | null;
  save(state: RemoteWorkspaceDeviceState): void;
}

export interface PairRemoteWorkspaceDeviceOptions {
  hubUrl: string;
  pairingCode: string;
  name?: string;
  roots: Array<{ path: string; label?: string }>;
  fetchImpl?: typeof fetch;
  store?: RemoteWorkspaceDeviceStateStore;
  devicePlatform?: string;
  capabilities?: RemoteWorkspaceCapability[];
  toolchainRoots?: string[];
  nativeHelperPath?: string;
}

export interface RemoteWorkspaceWebSocketLike {
  readyState: number;
  send(value: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: Event | MessageEvent) => void): void;
}

export type RemoteWorkspaceWebSocketFactory = (
  url: string,
  headers: Record<string, string>,
) => RemoteWorkspaceWebSocketLike;

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`invalid remote workspace ${label}`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > max || /[\x00-\x1f\x7f]/.test(normalized)) {
    throw new Error(`invalid remote workspace ${label}`);
  }
  return normalized;
}

function uuid(value: unknown, label: string): string {
  const text = boundedText(value, label, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
    throw new Error(`invalid remote workspace ${label}`);
  }
  return text;
}

function publicKey(value: unknown, label: string): string {
  const encoded = boundedText(value, label, 1024);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error(`invalid remote workspace ${label}`);
  const key = createPublicKey({ key: Buffer.from(encoded, "base64url"), type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`remote workspace ${label} must use Ed25519`);
  return encoded;
}

function identity(value: unknown): RemoteControlIdentityKeyPair {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid remote workspace device identity");
  const raw = value as Record<string, unknown>;
  const pub = publicKey(raw.publicKey, "device public key");
  const priv = boundedText(raw.privateKey, "device private key", 2048);
  const privateKey = createPrivateKey({ key: Buffer.from(priv, "base64url"), type: "pkcs8", format: "der" });
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("remote workspace device key must use Ed25519");
  const challenge = Buffer.from("opencodex remote workspace device identity v1", "utf8");
  if (!verify(
    null,
    challenge,
    createPublicKey({ key: Buffer.from(pub, "base64url"), type: "spki", format: "der" }),
    sign(null, challenge, privateKey),
  )) throw new Error("remote workspace device identity key pair does not match");
  return { publicKey: pub, privateKey: priv };
}

export function normalizeRemoteWorkspaceHubUrl(value: string): string {
  const url = new URL(value);
  const local = (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.protocol === "http:";
  if (url.protocol !== "https:" && !local) throw new Error("remote workspace hub must use HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("remote workspace hub URL must not contain credentials or fragments");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function agentUrlForHub(hubUrl: string): string {
  const url = new URL("/remote-workspace/agent", `${hubUrl}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function validateRootInputs(values: Array<{ path: string; label?: string }>): RemoteWorkspaceDeviceRoot[] {
  if (values.length < 1 || values.length > 32) throw new Error("remote workspace device needs one to 32 roots");
  const paths = new Set<string>();
  const labels = new Set<string>();
  return values.map(value => {
    if (!isAbsolute(value.path) || value.path.includes("\0")) throw new Error("remote workspace root must be an absolute path");
    const metadata = lstatSync(value.path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("remote workspace root must be a real directory");
    const path = realpathSync(value.path);
    const label = boundedText(value.label ?? basename(path), "root label", 80);
    const folded = label.toLocaleLowerCase("en-US");
    if (paths.has(path) || labels.has(folded)) throw new Error("duplicate remote workspace root");
    paths.add(path);
    labels.add(folded);
    return { id: randomUUID(), label, path };
  });
}

function parseRoots(value: unknown): RemoteWorkspaceDeviceRoot[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error("invalid remote workspace device roots");
  const paths = new Set<string>();
  const ids = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid remote workspace device root");
    const raw = item as Record<string, unknown>;
    const id = uuid(raw.id, "root ID");
    const label = boundedText(raw.label, "root label", 80);
    const path = boundedText(raw.path, "root path", 4096);
    if (!isAbsolute(path) || ids.has(id) || paths.has(path)) throw new Error("invalid remote workspace device root");
    ids.add(id);
    paths.add(path);
    return { id, label, path };
  });
}

function validateToolchainRoots(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) throw new Error("invalid remote workspace toolchain roots");
  const paths = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string" || !isAbsolute(candidate) || candidate.includes("\0")) {
      throw new Error("remote workspace toolchain root must be an absolute directory");
    }
    const metadata = lstatSync(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("remote workspace toolchain root must be a real directory");
    }
    paths.add(realpathSync(candidate));
  }
  return [...paths];
}

export function parseRemoteWorkspaceDeviceState(value: unknown): RemoteWorkspaceDeviceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid remote workspace device state");
  const raw = value as Record<string, unknown>;
  if (raw.version !== REMOTE_WORKSPACE_DEVICE_STATE_VERSION) throw new Error("unsupported remote workspace device state");
  const hubUrl = normalizeRemoteWorkspaceHubUrl(boundedText(raw.hubUrl, "hub URL", 2048));
  const agentUrl = boundedText(raw.agentUrl, "agent URL", 2048);
  if (agentUrl !== agentUrlForHub(hubUrl)) throw new Error("remote workspace agent URL does not match its hub");
  const deviceToken = boundedText(raw.deviceToken, "device token", 128);
  if (!DEVICE_TOKEN_PATTERN.test(deviceToken)) throw new Error("invalid remote workspace device token");
  return {
    version: REMOTE_WORKSPACE_DEVICE_STATE_VERSION,
    hubUrl,
    agentUrl,
    deviceId: uuid(raw.deviceId, "device ID"),
    deviceName: boundedText(raw.deviceName, "device name", 80),
    devicePlatform: boundedText(raw.devicePlatform, "device platform", 80),
    capabilities: parseRemoteWorkspaceCapabilities(raw.capabilities),
    deviceToken,
    deviceIdentity: identity(raw.deviceIdentity),
    hubPublicKey: publicKey(raw.hubPublicKey, "hub public key"),
    roots: parseRoots(raw.roots),
    toolchainRoots: validateToolchainRoots(raw.toolchainRoots),
    ...(raw.nativeHelper === undefined
      ? {}
      : { nativeHelper: parseRemoteWorkspaceNativeHelperDescriptor(raw.nativeHelper) }),
  };
}

export class RemoteWorkspaceDeviceFileStore implements RemoteWorkspaceDeviceStateStore {
  constructor(private readonly path = join(getConfigDir(), "remote-workspace-device.json")) {}

  load(): RemoteWorkspaceDeviceState | null {
    hardenConfigDir();
    if (!existsSync(this.path)) return null;
    hardenExistingSecret(this.path);
    const metadata = statSync(this.path);
    if (!metadata.isFile() || metadata.size > MAX_DEVICE_STATE_BYTES) {
      throw new Error("remote workspace device state is too large");
    }
    return parseRemoteWorkspaceDeviceState(JSON.parse(readFileSync(this.path, "utf8")));
  }

  save(state: RemoteWorkspaceDeviceState): void {
    const directory = getConfigDir();
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    hardenConfigDir();
    atomicWriteFile(this.path, `${JSON.stringify(parseRemoteWorkspaceDeviceState(state), null, 2)}\n`);
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_PAIR_RESPONSE_BYTES) throw new Error("remote workspace hub response is too large");
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > MAX_PAIR_RESPONSE_BYTES) {
          await reader.cancel("remote workspace hub response is too large").catch(() => {});
          throw new Error("remote workspace hub response is too large");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  try { return text ? JSON.parse(text) : {}; }
  catch { throw new Error(`remote workspace hub returned HTTP ${response.status}`); }
}

export async function pairRemoteWorkspaceDevice(options: PairRemoteWorkspaceDeviceOptions): Promise<RemoteWorkspaceDeviceState> {
  const hubUrl = normalizeRemoteWorkspaceHubUrl(options.hubUrl);
  const roots = validateRootInputs(options.roots);
  const deviceName = boundedText(options.name ?? hostname(), "device name", 80);
  const devicePlatform = boundedText(options.devicePlatform ?? `${platform()}-${arch()}`, "device platform", 80);
  const toolchainRoots = validateToolchainRoots(options.toolchainRoots);
  const nativeHelper = options.nativeHelperPath
    ? pinRemoteWorkspaceNativeHelper(options.nativeHelperPath)
    : discoverRemoteWorkspaceNativeHelper();
  const commandRunner = createPlatformRemoteWorkspaceCommandRunner({
    linux: { toolchainRoots, writableRoots: roots.map(root => root.path) },
    ...(nativeHelper ? { native: {
      helper: nativeHelper,
      toolchainRoots,
      writableRoots: roots.map(root => root.path),
    } } : {}),
  });
  const capabilities = remoteWorkspaceCapabilitiesForCommandRunner(commandRunner, options.capabilities);
  const deviceIdentity = generateRemoteControlIdentityKeyPair();
  const response = await (options.fetchImpl ?? fetch)(new URL("/remote-workspace/pair", `${hubUrl}/`), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(PAIR_TIMEOUT_MS),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      code: options.pairingCode,
      name: deviceName,
      platform: devicePlatform,
      publicKey: deviceIdentity.publicKey,
      capabilities,
      roots: roots.map(root => ({ id: root.id, label: root.label })),
    }),
  });
  const body = await boundedJson(response);
  if (!response.ok || !body || typeof body !== "object" || Array.isArray(body)) {
    const error = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `remote workspace pairing failed (${response.status})`;
    throw new Error(error);
  }
  const raw = body as Record<string, unknown>;
  const device = raw.device && typeof raw.device === "object" && !Array.isArray(raw.device)
    ? raw.device as Record<string, unknown>
    : null;
  if (!device) throw new Error("remote workspace hub returned an invalid device");
  const state = parseRemoteWorkspaceDeviceState({
    version: REMOTE_WORKSPACE_DEVICE_STATE_VERSION,
    hubUrl,
    agentUrl: agentUrlForHub(hubUrl),
    deviceId: device.id,
    deviceName,
    devicePlatform,
    capabilities,
    deviceToken: raw.deviceToken,
    deviceIdentity,
    hubPublicKey: raw.hubPublicKey,
    roots,
    toolchainRoots,
    ...(nativeHelper ? { nativeHelper } : {}),
  });
  (options.store ?? new RemoteWorkspaceDeviceFileStore()).save(state);
  return state;
}

function defaultWebSocketFactory(url: string, headers: Record<string, string>): RemoteWorkspaceWebSocketLike {
  return new WebSocket(url, { headers } as unknown as string[]) as unknown as RemoteWorkspaceWebSocketLike;
}

async function messageBytes(event: MessageEvent): Promise<string | Uint8Array> {
  if (typeof event.data === "string") return event.data;
  if (event.data instanceof ArrayBuffer) return new Uint8Array(event.data);
  if (ArrayBuffer.isView(event.data)) return new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
  if (event.data instanceof Blob) return new Uint8Array(await event.data.arrayBuffer());
  throw new Error("remote workspace agent received an unsupported frame");
}

export interface RemoteWorkspaceAgentHandle {
  connected: Promise<void>;
  closed: Promise<void>;
  stop(): void;
}

export interface RemoteWorkspaceAgentRunStatus {
  state: "connecting" | "online" | "reconnecting" | "stopped";
  attempt: number;
  message?: string;
}

/** Never advertise more authority than both local support and the pairing-time grant allow. */
export function remoteWorkspaceCapabilitiesForCommandRunner(
  commandRunner: RemoteWorkspaceCommandRunner | undefined,
  approved?: readonly RemoteWorkspaceCapability[],
): RemoteWorkspaceCapability[] {
  const available = parseRemoteWorkspaceCapabilities([
    "workspace.read",
    "workspace.write",
    ...(commandRunner ? ["workspace.exec" as const] : []),
  ]);
  const requested = parseRemoteWorkspaceCapabilities(approved ?? available);
  const allowed = new Set(available);
  return parseRemoteWorkspaceCapabilities(requested.filter(capability => allowed.has(capability)));
}

export function connectRemoteWorkspaceAgent(options: {
  state: RemoteWorkspaceDeviceState;
  webSocketFactory?: RemoteWorkspaceWebSocketFactory;
  commandRunner?: RemoteWorkspaceCommandRunner | null;
}): RemoteWorkspaceAgentHandle {
  const state = parseRemoteWorkspaceDeviceState(options.state);
  const commandRunner = options.commandRunner === undefined
    ? createPlatformRemoteWorkspaceCommandRunner({
      linux: {
        toolchainRoots: state.toolchainRoots,
        writableRoots: state.roots.map(root => root.path),
      },
      ...(state.nativeHelper ? { native: {
        helper: state.nativeHelper,
        toolchainRoots: state.toolchainRoots,
        writableRoots: state.roots.map(root => root.path),
      } } : {}),
    })
    : options.commandRunner ?? undefined;
  const capabilities = remoteWorkspaceCapabilitiesForCommandRunner(commandRunner, state.capabilities);
  const executor = new RemoteWorkspaceExecutor({
    deviceId: state.deviceId,
    roots: state.roots.map(root => ({ id: root.id, path: root.path })),
    commandRunner,
  });
  const socket = (options.webSocketFactory ?? defaultWebSocketFactory)(state.agentUrl, {
    authorization: `Bearer ${state.deviceToken}`,
  });
  let agent: RemoteWorkspaceExecutorAgentConnection | null = null;
  let opened = false;
  let presenceAccepted = false;
  let stopped = false;
  let settleConnected!: () => void;
  let rejectConnected!: (error: Error) => void;
  let settleClosed!: () => void;
  const connected = new Promise<void>((resolve, reject) => {
    settleConnected = resolve;
    rejectConnected = reject;
  });
  const closed = new Promise<void>(resolve => { settleClosed = resolve; });
  let queue = Promise.resolve();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let presenceTimer: ReturnType<typeof setTimeout> | null = null;
  const acceptPresence = () => {
    if (stopped) return;
    if (presenceAccepted) return;
    presenceAccepted = true;
    if (presenceTimer) clearTimeout(presenceTimer);
    presenceTimer = null;
    settleConnected();
  };

  socket.addEventListener("open", () => {
    if (stopped) {
      try { socket.close(1000, "remote workspace agent stopped"); } catch { /* already closed */ }
      return;
    }
    opened = true;
    presenceTimer = setTimeout(() => {
      rejectConnected(new Error("remote workspace Hub did not acknowledge executor capabilities"));
      socket.close(1008, "remote workspace presence timed out");
    }, 10_000);
    agent = new RemoteWorkspaceExecutorAgentConnection({
      deviceId: state.deviceId,
      deviceIdentity: state.deviceIdentity,
      hubPublicKey: state.hubPublicKey,
      executor,
      capabilities,
      onPresenceAccepted: acceptPresence,
      socket: {
        send: value => socket.send(value),
        close: (code, reason) => socket.close(code, reason),
      },
    });
    socket.send(serializeRemoteWorkspaceAgentMessage({
      version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
      type: "presence",
      capabilities,
    }));
    heartbeat = setInterval(() => {
      if (socket.readyState !== 1) return;
      socket.send(serializeRemoteWorkspaceAgentMessage({
        version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
        type: "heartbeat",
        nonce: randomUUID(),
      }));
    }, 20_000);
  });
  socket.addEventListener("message", event => {
    if (stopped || !(event instanceof MessageEvent) || !agent) return;
    queue = queue.then(async () => agent?.receive(await messageBytes(event))).catch(() => {
      socket.close(1008, "remote workspace protocol error");
    });
  });
  socket.addEventListener("error", () => {
    if (!stopped && !presenceAccepted) rejectConnected(new Error("remote workspace agent connection failed"));
  });
  socket.addEventListener("close", () => {
    stopped = true;
    if (presenceTimer) clearTimeout(presenceTimer);
    presenceTimer = null;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    const currentAgent = agent;
    agent = null;
    currentAgent?.close();
    if (!presenceAccepted) rejectConnected(new Error(
      opened
        ? "remote workspace agent connection closed before presence acknowledgement"
        : "remote workspace agent connection closed before opening",
    ));
    settleClosed();
  });
  return {
    connected,
    closed,
    stop() {
      if (stopped) return;
      stopped = true;
      if (presenceTimer) clearTimeout(presenceTimer);
      presenceTimer = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      const currentAgent = agent;
      agent = null;
      currentAgent?.close();
      if (!presenceAccepted) rejectConnected(new Error("remote workspace agent stopped"));
      settleClosed();
      try { socket.close(1000, "remote workspace agent stopped"); } catch { /* CONNECTING sockets differ by runtime */ }
    },
  };
}

function waitForReconnect(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(finish, delayMs);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export async function runRemoteWorkspaceAgent(options: {
  state: RemoteWorkspaceDeviceState;
  signal: AbortSignal;
  webSocketFactory?: RemoteWorkspaceWebSocketFactory;
  commandRunner?: RemoteWorkspaceCommandRunner | null;
  onStatus?: (status: RemoteWorkspaceAgentRunStatus) => void;
  minReconnectMs?: number;
  maxReconnectMs?: number;
  random?: () => number;
}): Promise<void> {
  const state = parseRemoteWorkspaceDeviceState(options.state);
  const minimum = options.minReconnectMs ?? 500;
  const maximum = options.maxReconnectMs ?? 15_000;
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum < 10 || maximum < minimum) {
    throw new Error("invalid remote workspace reconnect policy");
  }
  let attempt = 0;
  let delayMs = minimum;
  while (!options.signal.aborted) {
    attempt += 1;
    options.onStatus?.({ state: "connecting", attempt });
    const handle = connectRemoteWorkspaceAgent({
      state,
      ...(options.webSocketFactory ? { webSocketFactory: options.webSocketFactory } : {}),
      ...(options.commandRunner !== undefined ? { commandRunner: options.commandRunner } : {}),
    });
    const stop = () => handle.stop();
    options.signal.addEventListener("abort", stop, { once: true });
    try {
      await handle.connected;
      delayMs = minimum;
      options.onStatus?.({ state: "online", attempt });
      await handle.closed;
    } catch (error) {
      handle.stop();
      if (!options.signal.aborted) {
        options.onStatus?.({
          state: "reconnecting",
          attempt,
          message: error instanceof Error ? error.message : "remote workspace connection failed",
        });
      }
    } finally {
      options.signal.removeEventListener("abort", stop);
    }
    if (options.signal.aborted) break;
    options.onStatus?.({ state: "reconnecting", attempt });
    const random = Math.min(1, Math.max(0, (options.random ?? Math.random)()));
    const jitteredDelay = Math.max(10, Math.round(delayMs * (0.8 + random * 0.4)));
    await waitForReconnect(jitteredDelay, options.signal);
    delayMs = Math.min(maximum, delayMs * 2);
  }
  options.onStatus?.({ state: "stopped", attempt });
}
