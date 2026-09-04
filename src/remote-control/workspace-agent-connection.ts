import type { RemoteControlIdentityKeyPair } from "./crypto";
import {
  RemoteControlClientHandshake,
  acceptRemoteControlClientHello,
} from "./crypto";
import type { RemoteWorkspaceExecutor } from "./workspace-executor";
import { REMOTE_CONTROL_MAX_SESSIONS_PER_DEVICE } from "./protocol";
import {
  EncryptedRemoteWorkspaceExecutorEndpoint,
  EncryptedRemoteWorkspaceTransport,
} from "./workspace-rpc";
import {
  REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
  parseRemoteWorkspaceAgentMessage,
  parseRemoteWorkspaceHubMessage,
  serializeRemoteWorkspaceAgentMessage,
  serializeRemoteWorkspaceHubMessage,
  type RemoteWorkspaceAgentProfile,
} from "./workspace-agent-protocol";
import {
  parseRemoteWorkspaceCapabilities,
  type RemoteWorkspaceCapability,
} from "./workspace-tools";
import { truncateRemoteWorkspaceUtf8 } from "./workspace-utf8";

const SESSION_OPEN_TIMEOUT_MS = 10_000;

export interface RemoteWorkspaceControlSocket {
  send(value: string): void | Promise<void>;
  close(code: number, reason: string): void;
}

interface PendingHubSession {
  handshake: RemoteControlClientHandshake;
  resolve(transport: EncryptedRemoteWorkspaceTransport): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function safeReason(value: string): string {
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  const selected = cleaned || "remote workspace session closed";
  return truncateRemoteWorkspaceUtf8(selected, 120);
}

/** Hub-side representation of one authenticated, online OCX-only executor. */
export class RemoteWorkspaceHubAgentConnection {
  private readonly pending = new Map<string, PendingHubSession>();
  private readonly active = new Map<string, EncryptedRemoteWorkspaceTransport>();
  private readonly cancelledSessionIds = new Set<string>();
  private closed = false;
  private presenceAccepted = false;
  private presencePending = false;
  private currentCapabilities: RemoteWorkspaceCapability[];

  constructor(private readonly options: {
    deviceId: string;
    devicePublicKey: string;
    hubIdentity: RemoteControlIdentityKeyPair;
    socket: RemoteWorkspaceControlSocket;
    capabilities?: readonly RemoteWorkspaceCapability[];
    onCapabilities?: (capabilities: readonly RemoteWorkspaceCapability[]) => void;
    sessionOpenTimeoutMs?: number;
  }) {
    this.currentCapabilities = parseRemoteWorkspaceCapabilities(options.capabilities);
  }

  isOnline(): boolean {
    return !this.closed && this.presenceAccepted;
  }

  capabilities(): RemoteWorkspaceCapability[] {
    return [...this.currentCapabilities];
  }

  async openSession(options: {
    sessionId: string;
    rootId: string;
    profile: RemoteWorkspaceAgentProfile;
  }): Promise<EncryptedRemoteWorkspaceTransport> {
    if (!this.isOnline()) throw new Error("remote workspace executor is offline");
    if (this.pending.has(options.sessionId) || this.active.has(options.sessionId)) {
      throw new Error("remote workspace session already exists");
    }
    if (this.pending.size + this.active.size >= REMOTE_CONTROL_MAX_SESSIONS_PER_DEVICE) {
      throw new Error("remote workspace executor session limit reached");
    }
    const handshake = RemoteControlClientHandshake.create({
      sessionId: options.sessionId,
      deviceId: this.options.deviceId,
      commandProfile: options.profile,
      capabilities: this.capabilities(),
      accountPrivateKey: this.options.hubIdentity.privateKey,
    });
    const timeoutMs = this.options.sessionOpenTimeoutMs ?? SESSION_OPEN_TIMEOUT_MS;
    const opened = new Promise<EncryptedRemoteWorkspaceTransport>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(options.sessionId);
        this.rememberCancelledSession(options.sessionId);
        reject(new Error("remote workspace session handshake timed out"));
      }, timeoutMs);
      this.pending.set(options.sessionId, { handshake, resolve, reject, timer });
    });
    try {
      await this.options.socket.send(serializeRemoteWorkspaceHubMessage({
        version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
        type: "session_open",
        rootId: options.rootId,
        clientHello: handshake.hello,
      }));
    } catch (error) {
      const pending = this.pending.get(options.sessionId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(options.sessionId);
        pending.reject(error instanceof Error ? error : new Error("remote workspace session send failed"));
      }
    }
    return await opened;
  }

  receive(raw: string | Uint8Array): void {
    if (this.closed) throw new Error("remote workspace executor is offline");
    const message = parseRemoteWorkspaceAgentMessage(raw);
    if (message.type === "presence") {
      if (this.presenceAccepted || this.presencePending) {
        throw new Error("remote workspace executor sent duplicate presence");
      }
      const capabilities = parseRemoteWorkspaceCapabilities(message.capabilities);
      this.presencePending = true;
      const accept = () => {
        if (this.closed) return;
        this.options.onCapabilities?.(capabilities);
        this.currentCapabilities = capabilities;
        this.presenceAccepted = true;
        this.presencePending = false;
      };
      let sent: void | Promise<void>;
      try {
        sent = this.options.socket.send(serializeRemoteWorkspaceHubMessage({
          version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
          type: "presence_ack",
          capabilities,
        }));
      } catch (error) {
        this.presencePending = false;
        throw error;
      }
      if (sent && typeof sent.then === "function") {
        void sent.then(accept).catch(() => this.close("remote workspace presence acknowledgement failed"));
      } else {
        accept();
      }
      return;
    }
    if (!this.presenceAccepted) {
      throw new Error("remote workspace executor presence is required before session traffic");
    }
    if (message.type === "heartbeat") return;
    if (message.type === "session_accept") {
      const pending = this.pending.get(message.sessionId);
      if (!pending) {
        if (!this.cancelledSessionIds.delete(message.sessionId)) {
          throw new Error("remote workspace accepted an unknown session");
        }
        void Promise.resolve(this.options.socket.send(serializeRemoteWorkspaceHubMessage({
          version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
          type: "session_close",
          sessionId: message.sessionId,
          reason: "remote workspace session was already cancelled",
        }))).catch(() => this.close("remote workspace cancelled-session cleanup failed"));
        return;
      }
      const cipher = pending.handshake.complete(message.hostHello, this.options.devicePublicKey);
      const transport = new EncryptedRemoteWorkspaceTransport({
        executorDeviceId: this.options.deviceId,
        cipher,
        sendCiphertext: value => this.options.socket.send(serializeRemoteWorkspaceHubMessage({
          version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
          type: "ciphertext",
          sessionId: message.sessionId,
          payload: value,
        })),
      });
      clearTimeout(pending.timer);
      this.pending.delete(message.sessionId);
      this.active.set(message.sessionId, transport);
      pending.resolve(transport);
      return;
    }
    if (message.type === "session_reject") {
      const pending = this.pending.get(message.sessionId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.sessionId);
      pending.reject(new Error(safeReason(message.reason)));
      return;
    }
    const transport = this.active.get(message.sessionId);
    if (!transport) throw new Error("remote workspace ciphertext targeted an unknown session");
    transport.receiveCiphertext(message.payload);
  }

  async closeSession(sessionId: string, reason = "remote workspace session closed"): Promise<void> {
    const pending = this.pending.get(sessionId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(sessionId);
      this.rememberCancelledSession(sessionId);
      pending.reject(new Error(safeReason(reason)));
    }
    const transport = this.active.get(sessionId);
    if (transport) {
      this.active.delete(sessionId);
      transport.close(safeReason(reason));
    }
    if (this.closed) return;
    await this.options.socket.send(serializeRemoteWorkspaceHubMessage({
      version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
      type: "session_close",
      sessionId,
      reason: safeReason(reason),
    }));
  }

  close(reason = "remote workspace executor disconnected"): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(safeReason(reason)));
    }
    this.pending.clear();
    for (const transport of this.active.values()) transport.close(safeReason(reason));
    this.active.clear();
    this.cancelledSessionIds.clear();
    try { this.options.socket.close(1008, safeReason(reason)); } catch { /* socket is already gone */ }
  }

  private rememberCancelledSession(sessionId: string): void {
    this.cancelledSessionIds.add(sessionId);
    while (this.cancelledSessionIds.size > 16) {
      const oldest = this.cancelledSessionIds.values().next();
      if (oldest.done) break;
      this.cancelledSessionIds.delete(oldest.value);
    }
  }
}

/** Executor-side connection. It owns no Codex, Claude Code, Pi, provider key, or model session. */
export class RemoteWorkspaceExecutorAgentConnection {
  private readonly sessions = new Map<string, EncryptedRemoteWorkspaceExecutorEndpoint>();
  private closed = false;

  constructor(private readonly options: {
    deviceId: string;
    deviceIdentity: RemoteControlIdentityKeyPair;
    hubPublicKey: string;
    executor: RemoteWorkspaceExecutor;
    capabilities?: readonly RemoteWorkspaceCapability[];
    onPresenceAccepted?: () => void;
    socket: RemoteWorkspaceControlSocket;
  }) {
    this.currentCapabilities = parseRemoteWorkspaceCapabilities(options.capabilities);
  }

  private readonly currentCapabilities: RemoteWorkspaceCapability[];

  async receive(raw: string | Uint8Array): Promise<void> {
    if (this.closed) throw new Error("remote workspace agent connection is closed");
    const message = parseRemoteWorkspaceHubMessage(raw);
    if (message.type === "presence_ack") {
      if (message.capabilities.length !== this.currentCapabilities.length
        || message.capabilities.some((capability, index) => capability !== this.currentCapabilities[index])) {
        throw new Error("remote workspace Hub acknowledged different executor capabilities");
      }
      this.options.onPresenceAccepted?.();
      return;
    }
    if (message.type === "session_open") {
      let endpoint: EncryptedRemoteWorkspaceExecutorEndpoint | null = null;
      try {
        if (this.sessions.has(message.clientHello.sessionId)) {
          throw new Error("remote workspace executor session already exists");
        }
        if (this.sessions.size >= REMOTE_CONTROL_MAX_SESSIONS_PER_DEVICE) {
          throw new Error("remote workspace executor session limit reached");
        }
        if (message.clientHello.deviceId !== this.options.deviceId) {
          throw new Error("remote workspace session targeted another executor");
        }
        const accepted = acceptRemoteControlClientHello(message.clientHello, {
          expectedSessionId: message.clientHello.sessionId,
          expectedDeviceId: this.options.deviceId,
          accountPublicKey: this.options.hubPublicKey,
          devicePrivateKey: this.options.deviceIdentity.privateKey,
          allowedCapabilities: this.currentCapabilities,
        });
        endpoint = new EncryptedRemoteWorkspaceExecutorEndpoint({
          executorDeviceId: this.options.deviceId,
          cipher: accepted.cipher,
          executor: this.options.executor,
          sendCiphertext: value => this.options.socket.send(serializeRemoteWorkspaceAgentMessage({
            version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
            type: "ciphertext",
            sessionId: message.clientHello.sessionId,
            payload: value,
          })),
        });
        this.sessions.set(message.clientHello.sessionId, endpoint);
        await this.options.socket.send(serializeRemoteWorkspaceAgentMessage({
          version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
          type: "session_accept",
          sessionId: message.clientHello.sessionId,
          hostHello: accepted.hello,
        }));
      } catch (error) {
        if (endpoint) {
          this.sessions.delete(message.clientHello.sessionId);
          endpoint.close();
        }
        await this.options.socket.send(serializeRemoteWorkspaceAgentMessage({
          version: REMOTE_WORKSPACE_AGENT_PROTOCOL_VERSION,
          type: "session_reject",
          sessionId: message.clientHello.sessionId,
          reason: safeReason(error instanceof Error ? error.message : "remote workspace session refused"),
        }));
      }
      return;
    }
    if (message.type === "session_close") {
      this.sessions.get(message.sessionId)?.close();
      this.sessions.delete(message.sessionId);
      return;
    }
    const endpoint = this.sessions.get(message.sessionId);
    if (!endpoint) throw new Error("remote workspace ciphertext targeted an unknown executor session");
    // Decryption and counter validation happen synchronously before this returns. The execution
    // promise is intentionally detached so an unencrypted session_close control frame can abort a
    // long-running command instead of waiting behind that command on the socket's ordered queue.
    void endpoint.receiveCiphertext(message.payload).catch(() => {
      this.close();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const endpoint of this.sessions.values()) endpoint.close();
    this.sessions.clear();
  }
}
