import type { RemoteControlCipher } from "./crypto";
import type {
  RemoteWorkspaceExecutionRequest,
  RemoteWorkspaceExecutor,
} from "./workspace-executor";
import {
  isRemoteWorkspaceToolName,
  remoteWorkspaceCapabilityForTool,
  type RemoteWorkspaceCapability,
  type RemoteWorkspaceToolResult,
} from "./workspace-tools";
import type { RemoteWorkspaceTransport } from "./workspace-coordinator";
import {
  REMOTE_WORKSPACE_RPC_MAX_MESSAGE_BYTES,
  RemoteWorkspaceRpcReassembler,
  frameRemoteWorkspaceRpcMessage,
} from "./workspace-rpc-framing";

// Old endpoints execute request frames immediately and cannot safely participate in prepare/grant.
const REMOTE_WORKSPACE_RPC_VERSION = 2 as const;
const REMOTE_WORKSPACE_RPC_DEFAULT_TIMEOUT_MS = 65_000;
const REMOTE_WORKSPACE_RPC_MAX_TIMEOUT_MS = 120_000;
const REMOTE_WORKSPACE_RPC_MAX_ACTIVE_REQUESTS = 8;
interface RemoteWorkspaceRpcRequest {
  version: typeof REMOTE_WORKSPACE_RPC_VERSION;
  kind: "prepare";
  timeoutMs: number;
  request: RemoteWorkspaceExecutionRequest;
}

interface RemoteWorkspaceRpcCancel {
  version: typeof REMOTE_WORKSPACE_RPC_VERSION;
  kind: "cancel";
  requestId: string;
}

interface RemoteWorkspaceRpcGrant {
  version: typeof REMOTE_WORKSPACE_RPC_VERSION;
  kind: "grant";
  requestId: string;
}

interface RemoteWorkspaceRpcResponse {
  version: typeof REMOTE_WORKSPACE_RPC_VERSION;
  kind: "response";
  requestId: string;
  result: RemoteWorkspaceToolResult;
}

type RemoteWorkspaceRpcMessage = RemoteWorkspaceRpcRequest | RemoteWorkspaceRpcResponse | RemoteWorkspaceRpcCancel | RemoteWorkspaceRpcGrant;

interface PendingRequest {
  resolve(value: RemoteWorkspaceToolResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}

function encodeMessage(value: RemoteWorkspaceRpcMessage): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  if (encoded.byteLength > REMOTE_WORKSPACE_RPC_MAX_MESSAGE_BYTES) {
    throw new Error("remote workspace RPC message exceeds the bounded message limit");
  }
  return encoded;
}

function parseResult(value: unknown): RemoteWorkspaceToolResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid remote workspace RPC result");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => key !== "ok" && key !== "value" && key !== "error")) {
    throw new Error("invalid remote workspace RPC result fields");
  }
  if (raw.ok === true && raw.error === undefined) {
    return raw.value === undefined ? { ok: true } : { ok: true, value: raw.value };
  }
  if (raw.ok === false && raw.value === undefined
    && typeof raw.error === "string" && raw.error.length >= 1 && raw.error.length <= 4096) {
    return { ok: false, error: raw.error };
  }
  throw new Error("invalid remote workspace RPC result status");
}

function parseRequest(value: unknown): RemoteWorkspaceExecutionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid remote workspace RPC request");
  const raw = value as Record<string, unknown>;
  if (
    !boundedIdentifier(raw.requestId)
    || !boundedIdentifier(raw.sessionId)
    || !boundedIdentifier(raw.executorDeviceId)
    || !boundedIdentifier(raw.rootId)
    || !isRemoteWorkspaceToolName(raw.tool)
  ) throw new Error("invalid remote workspace RPC request identity");
  return {
    requestId: raw.requestId,
    sessionId: raw.sessionId,
    executorDeviceId: raw.executorDeviceId,
    rootId: raw.rootId,
    tool: raw.tool,
    arguments: raw.arguments,
  };
}

function parseMessage(value: Uint8Array): RemoteWorkspaceRpcMessage {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > REMOTE_WORKSPACE_RPC_MAX_MESSAGE_BYTES) {
    throw new Error("invalid remote workspace RPC message length");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
  } catch {
    throw new Error("invalid remote workspace RPC JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid remote workspace RPC message");
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== REMOTE_WORKSPACE_RPC_VERSION) throw new Error("unsupported remote workspace RPC version");
  if (raw.kind === "prepare" && Number.isSafeInteger(raw.timeoutMs)
    && (raw.timeoutMs as number) >= 1 && (raw.timeoutMs as number) <= REMOTE_WORKSPACE_RPC_MAX_TIMEOUT_MS) {
    return {
      version: REMOTE_WORKSPACE_RPC_VERSION,
      kind: "prepare",
      timeoutMs: raw.timeoutMs as number,
      request: parseRequest(raw.request),
    };
  }
  if (raw.kind === "response" && boundedIdentifier(raw.requestId)) {
    return {
      version: REMOTE_WORKSPACE_RPC_VERSION,
      kind: "response",
      requestId: raw.requestId,
      result: parseResult(raw.result),
    };
  }
  if ((raw.kind === "cancel" || raw.kind === "grant") && boundedIdentifier(raw.requestId)) {
    return { version: REMOTE_WORKSPACE_RPC_VERSION, kind: raw.kind, requestId: raw.requestId };
  }
  throw new Error("invalid remote workspace RPC message kind");
}

export interface EncryptedRemoteWorkspaceTransportOptions {
  executorDeviceId: string;
  cipher: RemoteControlCipher;
  sendCiphertext(value: Uint8Array): void | Promise<void>;
  timeoutMs?: number;
}

/** Coordinator-side transport. The WebSocket/relay adapter only has to carry ciphertext. */
export class EncryptedRemoteWorkspaceTransport implements RemoteWorkspaceTransport {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly reassembler = new RemoteWorkspaceRpcReassembler();
  private readonly timeoutMs: number;
  private sendTail: Promise<void> = Promise.resolve();
  private online = true;

  constructor(private readonly options: EncryptedRemoteWorkspaceTransportOptions) {
    this.timeoutMs = options.timeoutMs ?? REMOTE_WORKSPACE_RPC_DEFAULT_TIMEOUT_MS;
    if (!boundedIdentifier(options.executorDeviceId) || !Number.isSafeInteger(this.timeoutMs)
      || this.timeoutMs < 1 || this.timeoutMs > REMOTE_WORKSPACE_RPC_MAX_TIMEOUT_MS) {
      throw new Error("invalid encrypted remote workspace transport options");
    }
  }

  isOnline(deviceId: string): boolean {
    return this.online && deviceId === this.options.executorDeviceId;
  }

  async invoke(request: RemoteWorkspaceExecutionRequest): Promise<RemoteWorkspaceToolResult> {
    if (!this.isOnline(request.executorDeviceId)) throw new Error("remote workspace executor is offline");
    if (this.pending.has(request.requestId)) throw new Error("duplicate remote workspace request ID");
    if (this.pending.size >= REMOTE_WORKSPACE_RPC_MAX_ACTIVE_REQUESTS) {
      throw new Error("remote workspace request limit reached");
    }
    const response = new Promise<RemoteWorkspaceToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        void this.sendCancellation(request.requestId);
        reject(new Error("remote workspace request timed out; executor cancellation was requested"));
      }, this.timeoutMs);
      this.pending.set(request.requestId, { resolve, reject, timer });
    });
    const pending = this.pending.get(request.requestId)!;
    // Observe the response immediately: transport backpressure must not defer timeout delivery
    // or leave a rejected response promise unobserved while a write is still waiting to settle.
    void this.prepareAndGrant(request, pending);
    return await response;
  }

  private async prepareAndGrant(request: RemoteWorkspaceExecutionRequest, pending: PendingRequest): Promise<void> {
    try {
      await this.sendMessage(encodeMessage({
        version: REMOTE_WORKSPACE_RPC_VERSION,
        kind: "prepare",
        timeoutMs: this.timeoutMs,
        request,
      }));
      // Check again inside the serialized send queue: another write can delay this grant after
      // prepare has settled. A request that has already timed out must never receive a grant.
      await this.sendMessage(encodeMessage({
        version: REMOTE_WORKSPACE_RPC_VERSION,
        kind: "grant",
        requestId: request.requestId,
      }), () => this.pending.get(request.requestId) === pending);
    } catch {
      // A failed encrypted write consumes a directional counter. Continuing would make every
      // later frame undecryptable, so fail every pending operation instead of waiting for timeout.
      this.close("remote workspace send failed");
    }
  }

  receiveCiphertext(value: Uint8Array): void {
    if (!this.online) throw new Error("remote workspace transport is closed");
    const responsePlaintext = this.reassembler.accept(this.options.cipher.decrypt(value));
    if (!responsePlaintext) return;
    const message = parseMessage(responsePlaintext);
    if (message.kind !== "response") throw new Error("coordinator received a remote workspace request");
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    pending.resolve(message.result);
  }

  close(reason = "remote workspace transport closed"): void {
    if (!this.online) return;
    this.online = false;
    this.reassembler.clear();
    this.options.cipher.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private sendMessage(message: Uint8Array, shouldSend: () => boolean = () => true): Promise<void> {
    const operation = this.sendTail.then(async () => {
      if (!shouldSend()) return;
      if (!this.online) throw new Error("remote workspace transport is closed");
      for (const frame of frameRemoteWorkspaceRpcMessage(message)) {
        await this.options.sendCiphertext(this.options.cipher.encrypt(frame));
      }
    });
    this.sendTail = operation.catch(() => {});
    return operation;
  }

  private async sendCancellation(requestId: string): Promise<void> {
    try {
      await this.sendMessage(encodeMessage({
        version: REMOTE_WORKSPACE_RPC_VERSION,
        kind: "cancel",
        requestId,
      }));
    } catch {
      // A failed encrypted write consumes the send counter; the session cannot safely continue.
      this.close("remote workspace cancellation send failed");
    }
  }
}

export interface EncryptedRemoteWorkspaceExecutorEndpointOptions {
  executorDeviceId: string;
  sessionId: string;
  rootId: string;
  capabilities: readonly RemoteWorkspaceCapability[];
  cipher: RemoteControlCipher;
  executor: Pick<RemoteWorkspaceExecutor, "invoke">;
  sendCiphertext(value: Uint8Array): void | Promise<void>;
}

/** Executor-side endpoint. It accepts only authenticated, ordered E2EE session frames. */
export class EncryptedRemoteWorkspaceExecutorEndpoint {
  private closed = false;
  private readonly active = new Map<string, {
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
    request: RemoteWorkspaceExecutionRequest;
    started: boolean;
  }>();
  private readonly reassembler = new RemoteWorkspaceRpcReassembler();
  private sendTail: Promise<void> = Promise.resolve();

  private readonly grantedCapabilities: ReadonlySet<RemoteWorkspaceCapability>;
  private readonly sessionId: string;
  private readonly rootId: string;

  constructor(private readonly options: EncryptedRemoteWorkspaceExecutorEndpointOptions) {
    if (!boundedIdentifier(options.executorDeviceId) || !boundedIdentifier(options.sessionId)
      || !boundedIdentifier(options.rootId)) throw new Error("invalid remote workspace executor endpoint");
    this.options = { ...options };
    this.sessionId = options.sessionId;
    this.rootId = options.rootId;
    this.grantedCapabilities = new Set(options.capabilities);
  }

  async receiveCiphertext(value: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("remote workspace executor endpoint is closed");
    const requestPlaintext = this.reassembler.accept(this.options.cipher.decrypt(value));
    if (!requestPlaintext) return;
    const message = parseMessage(requestPlaintext);
    if (message.kind === "cancel") {
      const active = this.active.get(message.requestId);
      if (active) {
        active.controller.abort();
        if (!active.started) {
          clearTimeout(active.timer);
          this.active.delete(message.requestId);
        }
      }
      return;
    }
    if (message.kind === "grant") {
      const active = this.active.get(message.requestId);
      if (!active || active.controller.signal.aborted) return;
      if (active.started) throw new Error("duplicate remote workspace execution grant");
      active.started = true;
      await this.executeGranted(active.request, active.controller, active.timer);
      return;
    }
    if (message.kind !== "prepare") throw new Error("executor received a remote workspace response");
    if (message.request.executorDeviceId !== this.options.executorDeviceId) {
      throw new Error("remote workspace encrypted request targeted another executor");
    }
    if (message.request.sessionId !== this.sessionId || message.request.rootId !== this.rootId) {
      throw new Error("remote workspace encrypted request does not match its session binding");
    }
    if (!this.grantedCapabilities.has(remoteWorkspaceCapabilityForTool(message.request.tool))) {
      throw new Error("remote workspace tool capability was not granted to this session");
    }
    if (this.active.has(message.request.requestId)) throw new Error("duplicate remote workspace executor request ID");
    if (this.active.size >= REMOTE_WORKSPACE_RPC_MAX_ACTIVE_REQUESTS) {
      throw new Error("remote workspace executor request limit reached");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      const active = this.active.get(message.request.requestId);
      if (active && !active.started) this.active.delete(message.request.requestId);
    }, message.timeoutMs);
    this.active.set(message.request.requestId, { controller, timer, request: message.request, started: false });
  }

  private async executeGranted(
    request: RemoteWorkspaceExecutionRequest,
    controller: AbortController,
    timer: ReturnType<typeof setTimeout>,
  ): Promise<void> {
    let result: RemoteWorkspaceToolResult;
    try {
      result = await this.options.executor.invoke(request, controller.signal);
    } finally {
      clearTimeout(timer);
      this.active.delete(request.requestId);
    }
    if (this.closed) return;
    let responsePlaintext: Uint8Array;
    try {
      responsePlaintext = encodeMessage({
        version: REMOTE_WORKSPACE_RPC_VERSION,
        kind: "response",
        requestId: request.requestId,
        result,
      });
    } catch {
      responsePlaintext = encodeMessage({
        version: REMOTE_WORKSPACE_RPC_VERSION,
        kind: "response",
        requestId: request.requestId,
        result: { ok: false, error: "remote workspace result exceeded the encrypted frame limit" },
      });
    }
    await this.sendMessage(responsePlaintext);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reassembler.clear();
    for (const active of this.active.values()) {
      clearTimeout(active.timer);
      active.controller.abort();
    }
    this.active.clear();
    this.options.cipher.destroy();
  }

  private sendMessage(message: Uint8Array): Promise<void> {
    const operation = this.sendTail.then(async () => {
      if (this.closed) throw new Error("remote workspace executor endpoint is closed");
      for (const frame of frameRemoteWorkspaceRpcMessage(message)) {
        await this.options.sendCiphertext(this.options.cipher.encrypt(frame));
      }
    });
    this.sendTail = operation.catch(() => {});
    return operation;
  }
}
