import {
  acceptRemoteControlClientHello,
  parseRemoteControlClientHello,
  serializeRemoteControlHello,
  type RemoteControlCipher,
} from "./crypto";
import {
  REMOTE_CONTROL_CAPABILITIES,
  REMOTE_CONTROL_MAX_RELAY_PAYLOAD_BYTES,
  REMOTE_CONTROL_MAX_SESSIONS_PER_DEVICE,
  decodeRemoteControlApplicationFrame,
  encodeRemoteControlApplicationFrame,
  type RemoteControlApplicationFrame,
  type RemoteControlCapability,
  type RemoteControlCommandProfile,
} from "./protocol";

export interface RemoteControlTerminal {
  write(value: Uint8Array): void | Promise<void>;
  resize(columns: number, rows: number): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface RemoteControlTerminalFactory {
  create(options: {
    commandProfile: RemoteControlCommandProfile;
    onOutput(value: Uint8Array): void;
    onExit(code: number): void;
  }): RemoteControlTerminal | Promise<RemoteControlTerminal>;
}

interface HostSession {
  commandProfile: RemoteControlCommandProfile;
  capabilities: Set<RemoteControlCapability>;
  cipher: RemoteControlCipher;
  onCiphertext(value: Uint8Array): void;
  terminal?: RemoteControlTerminal;
  queue: Promise<void>;
  closed: boolean;
}

export interface RemoteControlHostOptions {
  deviceId: string;
  devicePrivateKey: string;
  accountPublicKey: string;
  terminalFactory: RemoteControlTerminalFactory;
  allowedCapabilities?: readonly RemoteControlCapability[];
  maxSessions?: number;
}

/**
 * Local execution boundary for the Paseo-style topology. The relay never owns
 * this registry or a terminal. A successfully signed hello reserves only a
 * session; the first authenticated input/resize frame starts the local process.
 */
export class RemoteControlHost {
  private readonly sessions = new Map<string, HostSession>();
  private readonly allowedCapabilities: readonly RemoteControlCapability[];
  private readonly maxSessions: number;

  constructor(private readonly options: RemoteControlHostOptions) {
    this.allowedCapabilities = options.allowedCapabilities ?? REMOTE_CONTROL_CAPABILITIES;
    this.maxSessions = options.maxSessions ?? REMOTE_CONTROL_MAX_SESSIONS_PER_DEVICE;
    if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1) {
      throw new Error("invalid remote control host session limit");
    }
  }

  open(sessionId: string, clientHelloPayload: Uint8Array, onCiphertext: (value: Uint8Array) => void): Uint8Array {
    if (this.sessions.has(sessionId)) throw new Error("remote control host session already exists");
    if (this.sessions.size >= this.maxSessions) throw new Error("remote control host session limit reached");
    const clientHello = parseRemoteControlClientHello(clientHelloPayload);
    const accepted = acceptRemoteControlClientHello(clientHello, {
      expectedSessionId: sessionId,
      expectedDeviceId: this.options.deviceId,
      accountPublicKey: this.options.accountPublicKey,
      devicePrivateKey: this.options.devicePrivateKey,
      allowedCapabilities: this.allowedCapabilities,
    });
    this.sessions.set(sessionId, {
      commandProfile: clientHello.commandProfile,
      capabilities: new Set(accepted.hello.capabilities),
      cipher: accepted.cipher,
      onCiphertext,
      queue: Promise.resolve(),
      closed: false,
    });
    return serializeRemoteControlHello(accepted.hello);
  }

  receive(sessionId: string, encryptedPayload: Uint8Array): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return Promise.reject(new Error("unknown remote control host session"));
    const run = session.queue
      .then(() => this.handleAuthenticatedFrame(sessionId, session, encryptedPayload))
      .catch(async error => {
        await this.close(sessionId);
        throw error;
      });
    session.queue = run.catch(() => undefined);
    return run;
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.closed = true;
    session.cipher.destroy();
    if (session.terminal) await session.terminal.close();
  }

  private async handleAuthenticatedFrame(
    sessionId: string,
    session: HostSession,
    encryptedPayload: Uint8Array,
  ): Promise<void> {
    let frame: RemoteControlApplicationFrame;
    try {
      frame = decodeRemoteControlApplicationFrame(session.cipher.decrypt(encryptedPayload));
    } catch (error) {
      await this.close(sessionId);
      throw error;
    }
    if (frame.kind !== "input" && frame.kind !== "resize") {
      await this.close(sessionId);
      throw new Error("remote control client sent a host-only terminal frame");
    }
    const required: RemoteControlCapability = frame.kind === "input" ? "terminal.input" : "terminal.resize";
    if (!session.capabilities.has(required)) {
      await this.close(sessionId);
      throw new Error(`remote control capability ${required} was not granted`);
    }
    if (!session.terminal) {
      const terminal = await this.startTerminal(sessionId, session);
      if (session.closed) {
        await terminal.close();
        throw new Error("remote control host session closed while starting the terminal");
      }
      session.terminal = terminal;
    }
    if (frame.kind === "input") await session.terminal.write(frame.data);
    else await session.terminal.resize(frame.columns, frame.rows);
  }

  private async startTerminal(sessionId: string, session: HostSession): Promise<RemoteControlTerminal> {
    return await this.options.terminalFactory.create({
      commandProfile: session.commandProfile,
      onOutput: value => {
        if (session.closed || !session.capabilities.has("terminal.output")) return;
        const maxChunk = REMOTE_CONTROL_MAX_RELAY_PAYLOAD_BYTES - 25;
        for (let offset = 0; offset < value.byteLength; offset += maxChunk) {
          this.emitApplicationFrame(sessionId, session, { kind: "output", data: value.subarray(offset, offset + maxChunk) });
        }
      },
      onExit: code => {
        if (session.closed) return;
        this.emitApplicationFrame(sessionId, session, { kind: "exit", code });
        void this.close(sessionId);
      },
    });
  }

  private emitApplicationFrame(
    sessionId: string,
    session: HostSession,
    frame: RemoteControlApplicationFrame,
  ): void {
    try {
      session.onCiphertext(session.cipher.encrypt(encodeRemoteControlApplicationFrame(frame)));
    } catch {
      void this.close(sessionId);
    }
  }
}
