export const REMOTE_CONTROL_PROTOCOL_VERSION = 1 as const;
export const REMOTE_CONTROL_RELAY_HEADER_BYTES = 18;
export const REMOTE_CONTROL_MAX_RELAY_PAYLOAD_BYTES = 64 * 1024;
export const REMOTE_CONTROL_MAX_SESSIONS_PER_DEVICE = 4;
export const REMOTE_CONTROL_MAX_BUFFERED_BYTES = 1024 * 1024;

export const REMOTE_CONTROL_COMMAND_PROFILES = ["shell", "codex", "claude", "pi"] as const;
export type RemoteControlCommandProfile = typeof REMOTE_CONTROL_COMMAND_PROFILES[number];

export const REMOTE_CONTROL_CAPABILITIES = [
  "terminal.input",
  "terminal.output",
  "terminal.resize",
  "workspace.read",
  "workspace.write",
  "workspace.exec",
] as const;
export type RemoteControlCapability = typeof REMOTE_CONTROL_CAPABILITIES[number];

export interface RemoteControlClientHello {
  version: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  sessionId: string;
  deviceId: string;
  commandProfile: RemoteControlCommandProfile;
  capabilities: RemoteControlCapability[];
  ephemeralPublicKey: string;
  nonce: string;
  signature: string;
}

export interface RemoteControlHostHello {
  version: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  sessionId: string;
  deviceId: string;
  capabilities: RemoteControlCapability[];
  ephemeralPublicKey: string;
  nonce: string;
  signature: string;
}

export type RemoteControlRelayFrameKind = "open" | "data" | "close";

export interface RemoteControlRelayFrame {
  kind: RemoteControlRelayFrameKind;
  sessionId: string;
  payload: Uint8Array;
}

export type RemoteControlApplicationFrame =
  | { kind: "input"; data: Uint8Array }
  | { kind: "resize"; columns: number; rows: number }
  | { kind: "output"; data: Uint8Array }
  | { kind: "exit"; code: number };

const RELAY_KIND_TO_BYTE: Record<RemoteControlRelayFrameKind, number> = {
  open: 1,
  data: 2,
  close: 3,
};
const RELAY_BYTE_TO_KIND = new Map<number, RemoteControlRelayFrameKind>([
  [1, "open"],
  [2, "data"],
  [3, "close"],
]);

const APPLICATION_KIND_TO_BYTE = {
  input: 1,
  resize: 2,
  output: 3,
  exit: 4,
} as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRemoteControlUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function remoteControlUuidBytes(value: string): Uint8Array {
  if (!isRemoteControlUuid(value)) throw new Error("invalid remote control UUID");
  return Uint8Array.from(value.replaceAll("-", "").match(/.{2}/g)!, byte => Number.parseInt(byte, 16));
}

function remoteControlUuidString(value: Uint8Array): string {
  if (value.byteLength !== 16) throw new Error("invalid remote control UUID bytes");
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isRemoteControlCommandProfile(value: unknown): value is RemoteControlCommandProfile {
  return typeof value === "string" && (REMOTE_CONTROL_COMMAND_PROFILES as readonly string[]).includes(value);
}

export function normalizeRemoteControlCapabilities(value: unknown): RemoteControlCapability[] {
  if (!Array.isArray(value) || value.length > REMOTE_CONTROL_CAPABILITIES.length) {
    throw new Error("invalid remote control capabilities");
  }
  const allowed = new Set<string>(REMOTE_CONTROL_CAPABILITIES);
  const result = value.map(capability => {
    if (typeof capability !== "string" || !allowed.has(capability)) {
      throw new Error("invalid remote control capability");
    }
    return capability as RemoteControlCapability;
  });
  if (new Set(result).size !== result.length) throw new Error("duplicate remote control capability");
  return result.sort();
}

export function encodeRemoteControlRelayFrame(frame: RemoteControlRelayFrame): Uint8Array {
  if (!isRemoteControlUuid(frame.sessionId)) throw new Error("invalid relay session ID");
  if (!(frame.payload instanceof Uint8Array) || frame.payload.byteLength > REMOTE_CONTROL_MAX_RELAY_PAYLOAD_BYTES) {
    throw new Error("remote control relay payload is too large");
  }
  const kind = RELAY_KIND_TO_BYTE[frame.kind];
  if (!kind) throw new Error("invalid remote control relay frame kind");
  const result = new Uint8Array(REMOTE_CONTROL_RELAY_HEADER_BYTES + frame.payload.byteLength);
  result[0] = REMOTE_CONTROL_PROTOCOL_VERSION;
  result[1] = kind;
  result.set(remoteControlUuidBytes(frame.sessionId), 2);
  result.set(frame.payload, REMOTE_CONTROL_RELAY_HEADER_BYTES);
  return result;
}

export function decodeRemoteControlRelayFrame(value: Uint8Array): RemoteControlRelayFrame {
  if (
    !(value instanceof Uint8Array)
    || value.byteLength < REMOTE_CONTROL_RELAY_HEADER_BYTES
    || value.byteLength > REMOTE_CONTROL_RELAY_HEADER_BYTES + REMOTE_CONTROL_MAX_RELAY_PAYLOAD_BYTES
  ) throw new Error("invalid remote control relay frame length");
  if (value[0] !== REMOTE_CONTROL_PROTOCOL_VERSION) throw new Error("unsupported remote control relay protocol");
  const kind = RELAY_BYTE_TO_KIND.get(value[1]!);
  if (!kind) throw new Error("invalid remote control relay frame kind");
  return {
    kind,
    sessionId: remoteControlUuidString(value.subarray(2, REMOTE_CONTROL_RELAY_HEADER_BYTES)),
    payload: value.slice(REMOTE_CONTROL_RELAY_HEADER_BYTES),
  };
}

function validTerminalDimension(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 4096;
}

export function encodeRemoteControlApplicationFrame(frame: RemoteControlApplicationFrame): Uint8Array {
  if (frame.kind === "input" || frame.kind === "output") {
    if (!(frame.data instanceof Uint8Array) || frame.data.byteLength > REMOTE_CONTROL_MAX_RELAY_PAYLOAD_BYTES - 25) {
      throw new Error("remote control terminal payload is too large");
    }
    const result = new Uint8Array(1 + frame.data.byteLength);
    result[0] = APPLICATION_KIND_TO_BYTE[frame.kind];
    result.set(frame.data, 1);
    return result;
  }
  if (frame.kind === "resize") {
    if (!validTerminalDimension(frame.columns) || !validTerminalDimension(frame.rows)) {
      throw new Error("invalid remote control terminal size");
    }
    const result = new Uint8Array(5);
    result[0] = APPLICATION_KIND_TO_BYTE.resize;
    const view = new DataView(result.buffer);
    view.setUint16(1, frame.columns, false);
    view.setUint16(3, frame.rows, false);
    return result;
  }
  if (!Number.isInteger(frame.code) || frame.code < -0x80000000 || frame.code > 0x7fffffff) {
    throw new Error("invalid remote control terminal exit code");
  }
  const result = new Uint8Array(5);
  result[0] = APPLICATION_KIND_TO_BYTE.exit;
  new DataView(result.buffer).setInt32(1, frame.code, false);
  return result;
}

export function decodeRemoteControlApplicationFrame(value: Uint8Array): RemoteControlApplicationFrame {
  if (!(value instanceof Uint8Array) || value.byteLength < 1) throw new Error("empty remote control application frame");
  if (value[0] === APPLICATION_KIND_TO_BYTE.input || value[0] === APPLICATION_KIND_TO_BYTE.output) {
    if (value.byteLength > REMOTE_CONTROL_MAX_RELAY_PAYLOAD_BYTES - 24) {
      throw new Error("remote control terminal payload is too large");
    }
    return {
      kind: value[0] === APPLICATION_KIND_TO_BYTE.input ? "input" : "output",
      data: value.slice(1),
    };
  }
  if (value[0] === APPLICATION_KIND_TO_BYTE.resize) {
    if (value.byteLength !== 5) throw new Error("invalid remote control resize frame");
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    const columns = view.getUint16(1, false);
    const rows = view.getUint16(3, false);
    if (!validTerminalDimension(columns) || !validTerminalDimension(rows)) {
      throw new Error("invalid remote control terminal size");
    }
    return { kind: "resize", columns, rows };
  }
  if (value[0] === APPLICATION_KIND_TO_BYTE.exit) {
    if (value.byteLength !== 5) throw new Error("invalid remote control exit frame");
    return { kind: "exit", code: new DataView(value.buffer, value.byteOffset, value.byteLength).getInt32(1, false) };
  }
  throw new Error("unknown remote control application frame");
}
