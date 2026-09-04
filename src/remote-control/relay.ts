import {
  REMOTE_CONTROL_MAX_BUFFERED_BYTES,
  REMOTE_CONTROL_MAX_SESSIONS_PER_DEVICE,
  decodeRemoteControlRelayFrame,
  encodeRemoteControlRelayFrame,
  isRemoteControlUuid,
  type RemoteControlRelayFrameKind,
} from "./protocol";

export interface RemoteControlRelayPeer {
  bufferedAmount(): number;
  send(value: Uint8Array): void;
  close(code: number, reason: string): void;
}

interface RelaySession {
  deviceId: string;
  client: RemoteControlRelayPeer;
}

export interface OpaqueRemoteControlRelayOptions {
  maxBufferedBytes?: number;
  maxSessionsPerDevice?: number;
}

/**
 * Routes bounded envelopes without decoding the handshake or application payload.
 * Account/session authorization belongs at the HTTP/WebSocket upgrade boundary;
 * this class begins only after that control-plane decision has succeeded.
 */
export class OpaqueRemoteControlRelay {
  private readonly hosts = new Map<string, RemoteControlRelayPeer>();
  private readonly sessions = new Map<string, RelaySession>();
  private readonly maxBufferedBytes: number;
  private readonly maxSessionsPerDevice: number;

  constructor(options: OpaqueRemoteControlRelayOptions = {}) {
    this.maxBufferedBytes = options.maxBufferedBytes ?? REMOTE_CONTROL_MAX_BUFFERED_BYTES;
    this.maxSessionsPerDevice = options.maxSessionsPerDevice ?? REMOTE_CONTROL_MAX_SESSIONS_PER_DEVICE;
    if (!Number.isSafeInteger(this.maxBufferedBytes) || this.maxBufferedBytes < 1) {
      throw new Error("invalid remote control relay buffer limit");
    }
    if (!Number.isSafeInteger(this.maxSessionsPerDevice) || this.maxSessionsPerDevice < 1) {
      throw new Error("invalid remote control relay session limit");
    }
  }

  registerHost(deviceId: string, host: RemoteControlRelayPeer): () => void {
    if (!isRemoteControlUuid(deviceId)) throw new Error("invalid remote control device ID");
    const previous = this.hosts.get(deviceId);
    if (previous && previous !== host) {
      previous.close(1012, "remote control host reconnected");
      this.closeDeviceSessions(deviceId, 1012, "remote control host reconnected");
    }
    this.hosts.set(deviceId, host);
    return () => {
      if (this.hosts.get(deviceId) !== host) return;
      this.hosts.delete(deviceId);
      this.closeDeviceSessions(deviceId, 1013, "remote control host disconnected");
    };
  }

  attachClient(options: {
    sessionId: string;
    deviceId: string;
    client: RemoteControlRelayPeer;
    openPayload: Uint8Array;
  }): () => void {
    if (this.sessions.has(options.sessionId)) throw new Error("remote control session is already attached");
    const host = this.hosts.get(options.deviceId);
    if (!host) throw new Error("remote control host is offline");
    const active = [...this.sessions.values()].filter(session => session.deviceId === options.deviceId).length;
    if (active >= this.maxSessionsPerDevice) throw new Error("remote control device session limit reached");
    const session: RelaySession = { deviceId: options.deviceId, client: options.client };
    this.sessions.set(options.sessionId, session);
    try {
      this.forward(host, "open", options.sessionId, options.openPayload);
    } catch (error) {
      this.sessions.delete(options.sessionId);
      throw error;
    }
    return () => this.detachClient(options.sessionId, options.client);
  }

  receiveFromClient(sessionId: string, client: RemoteControlRelayPeer, payload: Uint8Array): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.client !== client) throw new Error("unknown remote control client session");
    const host = this.hosts.get(session.deviceId);
    if (!host) {
      this.sessions.delete(sessionId);
      client.close(1013, "remote control host is offline");
      return;
    }
    try {
      this.forward(host, "data", sessionId, payload);
    } catch (error) {
      this.sessions.delete(sessionId);
      client.close(1013, "remote control host is backpressured");
      throw error;
    }
  }

  receiveFromHost(deviceId: string, host: RemoteControlRelayPeer, encoded: Uint8Array): void {
    if (this.hosts.get(deviceId) !== host) throw new Error("unknown remote control host");
    const frame = decodeRemoteControlRelayFrame(encoded);
    if (frame.kind === "open") throw new Error("remote control host cannot open browser sessions");
    const session = this.sessions.get(frame.sessionId);
    if (!session) return;
    if (session.deviceId !== deviceId) {
      host.close(1008, "remote control session ownership mismatch");
      return;
    }
    if (frame.kind === "close") {
      this.sessions.delete(frame.sessionId);
      session.client.close(1000, "remote control host closed the session");
      return;
    }
    if (session.client.bufferedAmount() > this.maxBufferedBytes) {
      this.sessions.delete(frame.sessionId);
      session.client.close(1013, "remote control relay backpressure");
      this.forward(host, "close", frame.sessionId, new Uint8Array());
      return;
    }
    // Intentionally forward the payload byte-for-byte. Only the endpoints parse it.
    session.client.send(frame.payload);
  }

  private detachClient(sessionId: string, client: RemoteControlRelayPeer): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.client !== client) return;
    this.sessions.delete(sessionId);
    const host = this.hosts.get(session.deviceId);
    if (host) {
      try {
        this.forward(host, "close", sessionId, new Uint8Array());
      } catch {
        // The client is already detached; the host transport owns its own close path.
      }
    }
  }

  private closeDeviceSessions(deviceId: string, code: number, reason: string): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.deviceId !== deviceId) continue;
      this.sessions.delete(sessionId);
      session.client.close(code, reason);
    }
  }

  private forward(
    target: RemoteControlRelayPeer,
    kind: RemoteControlRelayFrameKind,
    sessionId: string,
    payload: Uint8Array,
  ): void {
    if (target.bufferedAmount() > this.maxBufferedBytes) {
      target.close(1013, "remote control relay backpressure");
      throw new Error("remote control relay target is backpressured");
    }
    target.send(encodeRemoteControlRelayFrame({ kind, sessionId, payload }));
  }
}
