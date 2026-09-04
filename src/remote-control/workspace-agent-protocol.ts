import {
  parseRemoteControlClientHello,
  parseRemoteControlHostHello,
  serializeRemoteControlHello,
} from "./crypto";
import {
  isRemoteControlCommandProfile,
  isRemoteControlUuid,
  type RemoteControlClientHello,
  type RemoteControlCommandProfile,
  type RemoteControlHostHello,
} from "./protocol";
import {
  parseRemoteWorkspaceCapabilities,
  type RemoteWorkspaceCapability,
} from "./workspace-tools";

export const REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION = 1 as const;
export const REMOTE_WORKSPACE_AGENT_MAX_CONTROL_BYTES = 96 * 1024;

export type RemoteWorkspaceAgentProfile = Extract<RemoteControlCommandProfile, "codex" | "claude" | "pi">;

export type RemoteWorkspaceHubMessage =
  | {
      version: typeof REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION;
      type: "presence_ack";
      capabilities: RemoteWorkspaceCapability[];
    }
  | {
      version: typeof REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION;
      type: "session_open";
      rootId: string;
      clientHello: RemoteControlClientHello;
    }
  | {
      version: typeof REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION;
      type: "ciphertext";
      sessionId: string;
      payload: Uint8Array;
    }
  | {
      version: typeof REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION;
      type: "session_close";
      sessionId: string;
      reason: string;
    };

export type RemoteWorkspaceAgentMessage =
  | {
      version: typeof REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION;
      type: "presence";
      capabilities: RemoteWorkspaceCapability[];
    }
  | {
      version: typeof REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION;
      type: "session_accept";
      sessionId: string;
      hostHello: RemoteControlHostHello;
    }
  | {
      version: typeof REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION;
      type: "session_reject";
      sessionId: string;
      reason: string;
    }
  | {
      version: typeof REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION;
      type: "ciphertext";
      sessionId: string;
      payload: Uint8Array;
    }
  | {
      version: typeof REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION;
      type: "heartbeat";
      nonce: string;
    };

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`invalid remote workspace ${label}`);
  }
  return value;
}

function reason(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error("invalid remote workspace close reason");
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error("invalid remote workspace control message fields");
  }
}

function encodedHello(value: RemoteControlClientHello | RemoteControlHostHello): string {
  return Buffer.from(serializeRemoteControlHello(value)).toString("base64url");
}

function decodedHello(value: unknown, kind: "client"): RemoteControlClientHello;
function decodedHello(value: unknown, kind: "host"): RemoteControlHostHello;
function decodedHello(value: unknown, kind: "client" | "host"): RemoteControlClientHello | RemoteControlHostHello {
  if (typeof value !== "string" || value.length < 1 || value.length > 24 * 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid remote workspace handshake encoding");
  }
  const bytes = Buffer.from(value, "base64url");
  return kind === "client" ? parseRemoteControlClientHello(bytes) : parseRemoteControlHostHello(bytes);
}

function payload(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length < 1 || value.length > 88 * 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid remote workspace ciphertext encoding");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength < 24 || decoded.byteLength > 64 * 1024) {
    throw new Error("invalid remote workspace ciphertext length");
  }
  return decoded;
}

function parseObject(raw: string | Uint8Array): Record<string, unknown> {
  const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
  if (bytes.byteLength < 1 || bytes.byteLength > REMOTE_WORKSPACE_AGENT_MAX_CONTROL_BYTES) {
    throw new Error("invalid remote workspace control message length");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("invalid remote workspace control message JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid remote workspace control message");
  }
  const value = parsed as Record<string, unknown>;
  if (value.version !== REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION) {
    throw new Error("unsupported remote workspace agent protocol");
  }
  return value;
}

export function isRemoteWorkspaceAgentProfile(value: unknown): value is RemoteWorkspaceAgentProfile {
  return isRemoteControlCommandProfile(value) && value !== "shell";
}

export function serializeRemoteWorkspaceHubMessage(message: RemoteWorkspaceHubMessage): string {
  const value: Record<string, unknown> = { ...message };
  if (message.type === "session_open") value.clientHello = encodedHello(message.clientHello);
  if (message.type === "ciphertext") value.payload = Buffer.from(message.payload).toString("base64url");
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > REMOTE_WORKSPACE_AGENT_MAX_CONTROL_BYTES) {
    throw new Error("remote workspace hub message is too large");
  }
  return encoded;
}

export function serializeRemoteWorkspaceAgentMessage(message: RemoteWorkspaceAgentMessage): string {
  const value: Record<string, unknown> = { ...message };
  if (message.type === "session_accept") value.hostHello = encodedHello(message.hostHello);
  if (message.type === "ciphertext") value.payload = Buffer.from(message.payload).toString("base64url");
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > REMOTE_WORKSPACE_AGENT_MAX_CONTROL_BYTES) {
    throw new Error("remote workspace agent message is too large");
  }
  return encoded;
}

export function parseRemoteWorkspaceHubMessage(raw: string | Uint8Array): RemoteWorkspaceHubMessage {
  const value = parseObject(raw);
  if (value.type === "presence_ack") {
    exactKeys(value, ["version", "type", "capabilities"]);
    return {
      version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
      type: "presence_ack",
      capabilities: parseRemoteWorkspaceCapabilities(value.capabilities),
    };
  }
  if (value.type === "session_open") {
    exactKeys(value, ["version", "type", "rootId", "clientHello"]);
    const clientHello = decodedHello(value.clientHello, "client");
    if (!isRemoteWorkspaceAgentProfile(clientHello.commandProfile)) {
      throw new Error("invalid remote workspace session profile");
    }
    return {
      version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
      type: "session_open",
      rootId: identifier(value.rootId, "root ID"),
      clientHello,
    };
  }
  if (value.type === "ciphertext") {
    exactKeys(value, ["version", "type", "sessionId", "payload"]);
    const sessionId = identifier(value.sessionId, "session ID");
    if (!isRemoteControlUuid(sessionId)) throw new Error("invalid remote workspace session ID");
    return { version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION, type: "ciphertext", sessionId, payload: payload(value.payload) };
  }
  if (value.type === "session_close") {
    exactKeys(value, ["version", "type", "sessionId", "reason"]);
    const sessionId = identifier(value.sessionId, "session ID");
    if (!isRemoteControlUuid(sessionId)) throw new Error("invalid remote workspace session ID");
    return { version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION, type: "session_close", sessionId, reason: reason(value.reason) };
  }
  throw new Error("unsupported remote workspace hub message");
}

export function parseRemoteWorkspaceAgentMessage(raw: string | Uint8Array): RemoteWorkspaceAgentMessage {
  const value = parseObject(raw);
  if (value.type === "presence") {
    exactKeys(value, ["version", "type", "capabilities"]);
    return {
      version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
      type: "presence",
      capabilities: parseRemoteWorkspaceCapabilities(value.capabilities),
    };
  }
  if (value.type === "session_accept") {
    exactKeys(value, ["version", "type", "sessionId", "hostHello"]);
    const sessionId = identifier(value.sessionId, "session ID");
    if (!isRemoteControlUuid(sessionId)) throw new Error("invalid remote workspace session ID");
    return {
      version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
      type: "session_accept",
      sessionId,
      hostHello: decodedHello(value.hostHello, "host"),
    };
  }
  if (value.type === "session_reject") {
    exactKeys(value, ["version", "type", "sessionId", "reason"]);
    const sessionId = identifier(value.sessionId, "session ID");
    if (!isRemoteControlUuid(sessionId)) throw new Error("invalid remote workspace session ID");
    return { version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION, type: "session_reject", sessionId, reason: reason(value.reason) };
  }
  if (value.type === "ciphertext") {
    exactKeys(value, ["version", "type", "sessionId", "payload"]);
    const sessionId = identifier(value.sessionId, "session ID");
    if (!isRemoteControlUuid(sessionId)) throw new Error("invalid remote workspace session ID");
    return { version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION, type: "ciphertext", sessionId, payload: payload(value.payload) };
  }
  if (value.type === "heartbeat") {
    exactKeys(value, ["version", "type", "nonce"]);
    return { version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION, type: "heartbeat", nonce: identifier(value.nonce, "heartbeat nonce") };
  }
  throw new Error("unsupported remote workspace agent message");
}
