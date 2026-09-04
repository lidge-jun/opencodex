import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  atomicWriteFile,
  getConfigDir,
  hardenConfigDir,
  hardenExistingSecret,
} from "../config";
import { RemoteWorkspaceCoordinator, type RemoteWorkspaceTransport } from "./workspace-coordinator";
import type { RemoteWorkspaceHub } from "./workspace-hub";
import { isRemoteWorkspaceAgentProfile, type RemoteWorkspaceAgentProfile } from "./workspace-agent-protocol";
import type { RemoteWorkspaceExecutionRequest } from "./workspace-executor";
import { runRemoteWorkspaceCleanupSteps } from "./workspace-process";
import { truncateRemoteWorkspaceUtf8 } from "./workspace-utf8";
import { REMOTE_CONTROL_MAX_SESSIONS_PER_DEVICE } from "./protocol";
import {
  parseRemoteWorkspaceCapabilities,
  remoteWorkspaceToolsForCapabilities,
  type RemoteWorkspaceCapability,
  type RemoteWorkspaceToolName,
  type RemoteWorkspaceToolResult,
} from "./workspace-tools";

export const REMOTE_WORKSPACE_SESSION_STATE_VERSION = 1 as const;

export type RemoteWorkspaceSessionStatus =
  | "starting"
  | "ready"
  | "running"
  | "waiting_for_executor"
  | "failed"
  | "stopped";

export type RemoteWorkspaceAccessMode = "read-only" | "workspace";

export interface RemoteWorkspaceSessionEvent {
  sequence: number;
  at: string;
  type: "status" | "assistant" | "tool" | "error";
  text: string;
}

export interface RemoteWorkspaceSessionSummary {
  id: string;
  profile: RemoteWorkspaceAgentProfile;
  accessMode: RemoteWorkspaceAccessMode;
  deviceId: string;
  deviceName: string;
  rootId: string;
  rootLabel: string;
  capabilities: RemoteWorkspaceCapability[];
  tools: RemoteWorkspaceToolName[];
  threadId: string | null;
  /** True only after the runtime has created durable history that can be resumed. */
  resumable: boolean;
  status: RemoteWorkspaceSessionStatus;
  createdAt: string;
  updatedAt: string;
  events: RemoteWorkspaceSessionEvent[];
}

export interface RemoteWorkspaceRuntimeHandle {
  threadId: string;
  canResume?(): boolean;
  prompt(text: string): Promise<void>;
  stop(): Promise<void>;
}

export interface RemoteWorkspaceRuntimeFactory {
  profile: RemoteWorkspaceAgentProfile;
  available(): Promise<{ available: boolean; version?: string; reason?: string }>;
  start(options: {
    sessionId: string;
    deviceId: string;
    deviceName: string;
    rootId: string;
    rootLabel: string;
    capabilities: RemoteWorkspaceCapability[];
    tools: RemoteWorkspaceToolName[];
    resumeThreadId?: string;
    coordinator: RemoteWorkspaceCoordinator;
    emit(type: RemoteWorkspaceSessionEvent["type"], text: string): void;
  }): Promise<RemoteWorkspaceRuntimeHandle>;
}

export interface RemoteWorkspaceSessionState {
  version: typeof REMOTE_WORKSPACE_SESSION_STATE_VERSION;
  sessions: RemoteWorkspaceSessionSummary[];
}

export interface RemoteWorkspaceSessionStateStore {
  load(): RemoteWorkspaceSessionState | null;
  save(state: RemoteWorkspaceSessionState): void;
}

interface LiveSession extends RemoteWorkspaceSessionSummary {
  handle: RemoteWorkspaceRuntimeHandle | null;
  unregister: (() => void) | null;
  closeTransport: (() => Promise<void>) | null;
  operation: Promise<void>;
  stopOperation: Promise<boolean> | null;
  remoteTransport: SwitchableRemoteWorkspaceTransport | null;
  turnActive: boolean;
}

const MAX_EVENTS_PER_SESSION = 100;
const MAX_EVENT_TEXT_BYTES = 8 * 1024;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_LIVE_SESSIONS = 8;
const MAX_RETAINED_SESSIONS = 64;
const MAX_LIST_EVENTS_PER_SESSION = 20;
const MAX_PERSISTED_EVENTS_PER_SESSION = 40;
const MAX_PERSISTED_EVENT_TEXT_BYTES = 4 * 1024;
const MAX_SESSION_STATE_BYTES = 16 * 1024 * 1024;
const AVAILABILITY_CACHE_MS = 30_000;
type RuntimeAvailability = Record<RemoteWorkspaceAgentProfile, { available: boolean; version?: string; reason?: string }>;

class SwitchableRemoteWorkspaceTransport implements RemoteWorkspaceTransport {
  constructor(private current: RemoteWorkspaceTransport) {}

  replace(next: RemoteWorkspaceTransport): void {
    this.current = next;
  }

  isOnline(deviceId: string): boolean {
    return this.current.isOnline(deviceId);
  }

  invoke(request: RemoteWorkspaceExecutionRequest): Promise<RemoteWorkspaceToolResult> {
    return this.current.invoke(request);
  }
}

function boundedPrompt(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1 || Buffer.byteLength(value, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error("remote workspace prompt must contain 1 to 262144 UTF-8 bytes");
  }
  return value;
}

function boundedEventText(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_EVENT_TEXT_BYTES) return value;
  const marker = "\n[truncated]";
  return `${truncateRemoteWorkspaceUtf8(value, MAX_EVENT_TEXT_BYTES - Buffer.byteLength(marker, "utf8"))}${marker}`;
}

function boundedPersistedEventText(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_PERSISTED_EVENT_TEXT_BYTES) return value;
  const marker = "\n[truncated for restart snapshot]";
  const maximum = MAX_PERSISTED_EVENT_TEXT_BYTES - Buffer.byteLength(marker, "utf8");
  return `${truncateRemoteWorkspaceUtf8(value, maximum)}${marker}`;
}

function boundedString(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error(`invalid remote workspace ${label}`);
  }
  return value;
}

function timestamp(value: unknown): string {
  const result = boundedString(value, "timestamp", 64);
  if (!Number.isFinite(Date.parse(result))) throw new Error("invalid remote workspace timestamp");
  return result;
}

function parseStatus(value: unknown): RemoteWorkspaceSessionStatus {
  if (value === "starting" || value === "ready" || value === "running"
    || value === "waiting_for_executor" || value === "failed" || value === "stopped") return value;
  throw new Error("invalid remote workspace session status");
}

function parseAccessMode(value: unknown): RemoteWorkspaceAccessMode {
  if (value === undefined || value === "workspace") return "workspace";
  if (value === "read-only") return value;
  throw new Error("invalid remote workspace access mode");
}

function parseEvent(value: unknown): RemoteWorkspaceSessionEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid remote workspace session event");
  const raw = value as Record<string, unknown>;
  if (typeof raw.sequence !== "number" || !Number.isSafeInteger(raw.sequence) || raw.sequence < 1) {
    throw new Error("invalid remote workspace event sequence");
  }
  if (raw.type !== "status" && raw.type !== "assistant" && raw.type !== "tool" && raw.type !== "error") {
    throw new Error("invalid remote workspace event type");
  }
  return {
    sequence: raw.sequence,
    at: timestamp(raw.at),
    type: raw.type,
    text: boundedString(raw.text, "event text", MAX_EVENT_TEXT_BYTES),
  };
}

function parseSession(value: unknown): RemoteWorkspaceSessionSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid remote workspace session");
  const raw = value as Record<string, unknown>;
  if (!isRemoteWorkspaceAgentProfile(raw.profile)) throw new Error("invalid remote workspace session profile");
  const accessMode = parseAccessMode(raw.accessMode);
  const capabilities = parseRemoteWorkspaceCapabilities(raw.capabilities);
  if (accessMode === "read-only"
    && (capabilities.length !== 1 || capabilities[0] !== "workspace.read")) {
    throw new Error("read-only remote workspace state contains write capabilities");
  }
  const tools = remoteWorkspaceToolsForCapabilities(capabilities);
  if (!Array.isArray(raw.events) || raw.events.length > MAX_EVENTS_PER_SESSION) {
    throw new Error("invalid remote workspace session events");
  }
  if (raw.threadId !== null && typeof raw.threadId !== "string") throw new Error("invalid remote workspace thread ID");
  const resumable = raw.resumable === undefined
    ? raw.threadId !== null
    : raw.resumable === true;
  if (raw.resumable !== undefined && typeof raw.resumable !== "boolean") {
    throw new Error("invalid remote workspace resumable state");
  }
  if (resumable && raw.threadId === null) throw new Error("resumable remote workspace session has no thread ID");
  return {
    id: boundedString(raw.id, "session ID"),
    profile: raw.profile,
    accessMode,
    deviceId: boundedString(raw.deviceId, "device ID"),
    deviceName: boundedString(raw.deviceName, "device name", 80),
    rootId: boundedString(raw.rootId, "root ID"),
    rootLabel: boundedString(raw.rootLabel, "root label", 80),
    capabilities,
    tools,
    threadId: raw.threadId === null ? null : boundedString(raw.threadId, "thread ID"),
    resumable,
    status: parseStatus(raw.status),
    createdAt: timestamp(raw.createdAt),
    updatedAt: timestamp(raw.updatedAt),
    events: raw.events.map(parseEvent),
  };
}

export function parseRemoteWorkspaceSessionState(value: unknown): RemoteWorkspaceSessionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid remote workspace session state");
  const raw = value as Record<string, unknown>;
  if (raw.version !== REMOTE_WORKSPACE_SESSION_STATE_VERSION || !Array.isArray(raw.sessions)) {
    throw new Error("unsupported remote workspace session state");
  }
  if (raw.sessions.length > MAX_RETAINED_SESSIONS) throw new Error("remote workspace retained session limit exceeded");
  const ids = new Set<string>();
  const sessions = raw.sessions.map(item => {
    const session = parseSession(item);
    if (ids.has(session.id)) throw new Error("duplicate remote workspace session ID");
    ids.add(session.id);
    return session;
  });
  return { version: REMOTE_WORKSPACE_SESSION_STATE_VERSION, sessions };
}

export class RemoteWorkspaceSessionFileStore implements RemoteWorkspaceSessionStateStore {
  constructor(private readonly path = join(getConfigDir(), "remote-workspace-sessions.json")) {}

  load(): RemoteWorkspaceSessionState | null {
    hardenConfigDir();
    if (!existsSync(this.path)) return null;
    hardenExistingSecret(this.path);
    const metadata = statSync(this.path);
    if (!metadata.isFile() || metadata.size > MAX_SESSION_STATE_BYTES) {
      throw new Error("remote workspace session state is too large");
    }
    return parseRemoteWorkspaceSessionState(JSON.parse(readFileSync(this.path, "utf8")));
  }

  save(state: RemoteWorkspaceSessionState): void {
    const parsed = parseRemoteWorkspaceSessionState(state);
    const body = `${JSON.stringify(parsed, null, 2)}\n`;
    if (Buffer.byteLength(body, "utf8") > MAX_SESSION_STATE_BYTES) {
      throw new Error("remote workspace session state is too large");
    }
    const directory = getConfigDir();
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    hardenConfigDir();
    atomicWriteFile(this.path, body);
  }
}

export class RemoteWorkspaceSessionService {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly runtimes = new Map<RemoteWorkspaceAgentProfile, RemoteWorkspaceRuntimeFactory>();
  private sequence = 0;
  private availabilityCache: { at: number; value: RuntimeAvailability } | null = null;
  private availabilityFlight: Promise<RuntimeAvailability> | null = null;

  constructor(
    private readonly hub: RemoteWorkspaceHub,
    factories: readonly RemoteWorkspaceRuntimeFactory[],
    private readonly now: () => number = Date.now,
    private readonly store?: RemoteWorkspaceSessionStateStore,
  ) {
    for (const factory of factories) {
      if (this.runtimes.has(factory.profile)) throw new Error("duplicate remote workspace runtime profile");
      this.runtimes.set(factory.profile, factory);
    }
    for (const summary of this.store?.load()?.sessions ?? []) {
      const restoredStatus = summary.status === "stopped"
        ? "stopped"
        : summary.threadId && summary.resumable
          ? "waiting_for_executor"
          : "failed";
      this.sessions.set(summary.id, {
        ...summary,
        status: restoredStatus,
        handle: null,
        unregister: null,
        closeTransport: null,
        operation: Promise.resolve(),
        stopOperation: null,
        remoteTransport: null,
        turnActive: false,
      });
      for (const event of summary.events) this.sequence = Math.max(this.sequence, event.sequence);
    }
  }

  async availability(): Promise<RuntimeAvailability> {
    if (this.availabilityCache && this.now() - this.availabilityCache.at < AVAILABILITY_CACHE_MS) {
      return structuredClone(this.availabilityCache.value);
    }
    if (this.availabilityFlight) return structuredClone(await this.availabilityFlight);
    this.availabilityFlight = (async () => {
      const probe = async (profile: RemoteWorkspaceAgentProfile) => {
        const factory = this.runtimes.get(profile);
        if (!factory) return { available: false, reason: "runtime adapter is not installed" };
        try { return await factory.available(); }
        catch { return { available: false, reason: "runtime availability probe failed" }; }
      };
      const [codex, claude, pi] = await Promise.all([
        probe("codex"),
        probe("claude"),
        probe("pi"),
      ]);
      const value: RuntimeAvailability = { codex, claude, pi };
      this.availabilityCache = { at: this.now(), value };
      return value;
    })();
    try { return structuredClone(await this.availabilityFlight); }
    finally { this.availabilityFlight = null; }
  }

  list(): RemoteWorkspaceSessionSummary[] {
    this.refreshOfflineStates();
    return [...this.sessions.values()].map(session => this.publicSession(session, MAX_LIST_EVENTS_PER_SESSION));
  }

  get(sessionId: string): RemoteWorkspaceSessionSummary | null {
    this.refreshOfflineStates();
    const session = this.sessions.get(sessionId);
    return session ? this.publicSession(session) : null;
  }

  async create(input: {
    profile: RemoteWorkspaceAgentProfile;
    deviceId: string;
    rootId: string;
    accessMode?: RemoteWorkspaceAccessMode;
  }): Promise<RemoteWorkspaceSessionSummary> {
    this.pruneRetainedSessions();
    const liveCount = [...this.sessions.values()].filter(session => session.handle !== null).length;
    if (liveCount >= MAX_LIVE_SESSIONS) throw new Error("remote workspace active session limit reached");
    const deviceLiveCount = [...this.sessions.values()].filter(session => (
      session.deviceId === input.deviceId && session.handle !== null
    )).length;
    if (deviceLiveCount >= REMOTE_CONTROL_MAX_SESSIONS_PER_DEVICE) {
      throw new Error("remote workspace executor session limit reached");
    }
    const factory = this.runtimes.get(input.profile);
    if (!factory) throw new Error(`remote workspace ${input.profile} runtime is not installed on the hub`);
    const available = await factory.available();
    if (!available.available) throw new Error(available.reason ?? `remote workspace ${input.profile} runtime is unavailable`);
    const device = this.hub.listDevices().find(candidate => candidate.id === input.deviceId);
    if (!device) throw new Error("remote workspace device not found");
    const root = device.roots.find(candidate => candidate.id === input.rootId);
    if (!root) throw new Error("remote workspace root not found on the selected device");
    const connection = this.hub.connection(device.id);
    if (!connection) throw new Error("remote workspace executor is offline");
    const id = randomUUID();
    const accessMode = parseAccessMode(input.accessMode ?? "read-only");
    const deviceCapabilities = parseRemoteWorkspaceCapabilities(device.capabilities);
    const capabilities = accessMode === "read-only"
      ? parseRemoteWorkspaceCapabilities(["workspace.read"])
      : deviceCapabilities;
    const tools = remoteWorkspaceToolsForCapabilities(capabilities);
    const connectionCapabilities = connection.capabilities();
    if (capabilities.some(capability => !connectionCapabilities.includes(capability))) {
      throw new Error("remote workspace executor capability advertisement is stale; refresh and try again");
    }
    const timestamp = new Date(this.now()).toISOString();
    const session: LiveSession = {
      id,
      profile: input.profile,
      accessMode,
      deviceId: device.id,
      deviceName: device.name,
      rootId: root.id,
      rootLabel: root.label,
      capabilities,
      tools,
      threadId: null,
      resumable: false,
      status: "starting",
      createdAt: timestamp,
      updatedAt: timestamp,
      events: [],
      handle: null,
      unregister: null,
      closeTransport: null,
      operation: Promise.resolve(),
      stopOperation: null,
      remoteTransport: null,
      turnActive: false,
    };
    this.sessions.set(id, session);
    this.emit(session, "status", `Starting ${input.profile} on ${device.name}/${root.label}`);
    try {
      this.persist();
    } catch (error) {
      this.sessions.delete(id);
      throw error;
    }
    try {
      session.closeTransport = () => connection.closeSession(id);
      const transport = await connection.openSession({ sessionId: id, rootId: root.id, profile: input.profile });
      if (session.stopOperation) {
        await session.closeTransport().catch(() => {});
        session.closeTransport = null;
        throw new Error("remote workspace session was stopped while starting");
      }
      const remoteTransport = new SwitchableRemoteWorkspaceTransport(transport);
      session.remoteTransport = remoteTransport;
      const coordinator = new RemoteWorkspaceCoordinator(remoteTransport);
      const handle = await factory.start({
        sessionId: id,
        deviceId: device.id,
        deviceName: device.name,
        rootId: root.id,
        rootLabel: root.label,
        capabilities,
        tools,
        coordinator,
        emit: (type, text) => this.emit(session, type, text),
      });
      if (session.stopOperation) {
        await handle.stop().catch(() => {});
        throw new Error("remote workspace session was stopped while starting");
      }
      session.threadId = handle.threadId;
      session.resumable = handle.canResume?.() ?? true;
      session.handle = handle;
      session.unregister = coordinator.register({
        sessionId: id,
        threadId: handle.threadId,
        executorDeviceId: device.id,
        executorName: device.name,
        rootId: root.id,
        capabilities,
        tools,
      });
      this.status(session, "ready", `${input.profile} is ready on ${device.name}/${root.label}`);
      return this.publicSession(session);
    } catch (error) {
      let reported = error;
      if (session.status !== "stopped") {
        try {
          this.status(session, "failed", error instanceof Error ? error.message : "remote workspace session failed to start");
        } catch (persistenceError) {
          reported = persistenceError;
        }
      }
      session.unregister?.();
      session.unregister = null;
      await session.handle?.stop().catch(() => {});
      session.handle = null;
      await session.closeTransport?.().catch(() => {});
      session.closeTransport = null;
      session.remoteTransport = null;
      throw reported;
    }
  }

  async prompt(sessionId: string, value: unknown): Promise<RemoteWorkspaceSessionSummary> {
    const prompt = boundedPrompt(value);
    const session = this.sessions.get(sessionId);
    if (!session || session.status === "stopped") throw new Error("remote workspace session is not ready");
    if (!session.handle && (!session.threadId || !session.resumable)) {
      throw new Error("remote workspace session cannot be resumed");
    }
    if (session.turnActive) throw new Error("remote workspace session already has an active turn");
    if (session.stopOperation) throw new Error("remote workspace session is stopping");
    session.turnActive = true;
    const run = async () => {
      try {
        await this.ensureRemoteTransport(session);
        await this.ensureRuntime(session);
        if (session.stopOperation) throw new Error("remote workspace session is stopping");
        this.status(session, "running", "Turn started");
        await session.handle!.prompt(prompt);
        session.resumable = session.handle!.canResume?.() ?? true;
        if (!this.hub.connection(session.deviceId)
          || !session.remoteTransport?.isOnline(session.deviceId)) {
          this.status(session, "waiting_for_executor", "Turn completed; reconnect the remote executor before continuing.");
        } else {
          this.status(session, "ready", "Turn completed");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "remote workspace turn failed";
        this.status(session, this.hub.connection(session.deviceId) ? "failed" : "waiting_for_executor", message);
        throw error;
      } finally {
        session.turnActive = false;
      }
    };
    session.operation = run();
    await session.operation;
    return this.publicSession(session);
  }

  async stop(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.stopOperation) return session.stopOperation;
    session.stopOperation = (async () => {
      const handle = session.handle;
      const activeOperation = session.operation;
      // Cancellation has to run before waiting for the active turn. Waiting first makes
      // Stop unable to interrupt a model request or remote command that never completes.
      try {
        await runRemoteWorkspaceCleanupSteps([
          async () => { if (handle) await handle.stop(); },
          () => activeOperation.catch(() => {}),
          () => { session.unregister?.(); session.unregister = null; },
          async () => { if (session.closeTransport) await session.closeTransport(); },
          () => {
            session.closeTransport = null;
            session.handle = null;
            session.remoteTransport = null;
          },
        ]);
      } catch (error) {
        this.status(session, "failed", "Session cleanup failed; one or more owned resources did not close.");
        throw error;
      }
      this.status(session, "stopped", "Session stopped");
      return true;
    })();
    return session.stopOperation;
  }

  async stopAll(): Promise<void> {
    const active = [...this.sessions.values()].filter(session => session.status !== "stopped");
    await Promise.all(active.map(session => this.stop(session.id).then(() => undefined)));
    this.persist();
  }

  async shutdown(): Promise<void> {
    const active = [...this.sessions.values()].filter(session => session.status !== "stopped");
    await Promise.all(active.map(async session => {
      if (session.stopOperation) {
        await session.stopOperation;
        return;
      }
      session.stopOperation = (async () => {
        const handle = session.handle;
        const activeOperation = session.operation;
        try {
          await runRemoteWorkspaceCleanupSteps([
            async () => { if (handle) await handle.stop(); },
            () => activeOperation.catch(() => {}),
            () => { session.unregister?.(); session.unregister = null; },
            async () => { if (session.closeTransport) await session.closeTransport(); },
            () => {
              session.closeTransport = null;
              session.handle = null;
              session.remoteTransport = null;
            },
          ]);
        } catch (error) {
          this.status(session, "failed", "Hub shutdown could not close every Remote Workspace resource.");
          throw error;
        }
        this.status(
          session,
          session.threadId && session.resumable ? "waiting_for_executor" : "failed",
          session.threadId && session.resumable
            ? "Hub stopped; reconnect the executor to resume this session."
            : "Hub stopped before the model session was created.",
        );
        return true;
      })();
      await session.stopOperation;
    }));
    this.persist();
  }

  private status(session: LiveSession, status: RemoteWorkspaceSessionStatus, text: string): void {
    session.status = status;
    this.emit(session, status === "failed" ? "error" : "status", text);
    this.persist();
  }

  private emit(session: LiveSession, type: RemoteWorkspaceSessionEvent["type"], text: string): void {
    const at = new Date(this.now()).toISOString();
    session.updatedAt = at;
    session.events.push({ sequence: ++this.sequence, at, type, text: boundedEventText(text) });
    if (session.events.length > MAX_EVENTS_PER_SESSION) {
      session.events.splice(0, session.events.length - MAX_EVENTS_PER_SESSION);
    }
  }

  private publicSession(session: LiveSession, eventLimit = MAX_EVENTS_PER_SESSION): RemoteWorkspaceSessionSummary {
    const {
      handle: _handle,
      unregister: _unregister,
      closeTransport: _close,
      operation: _operation,
      stopOperation: _stopOperation,
      remoteTransport: _remoteTransport,
      turnActive: _turnActive,
      ...publicState
    } = session;
    return structuredClone({ ...publicState, events: publicState.events.slice(-eventLimit) });
  }

  private async ensureRemoteTransport(session: LiveSession): Promise<void> {
    if (session.remoteTransport?.isOnline(session.deviceId)) return;
    const connection = this.hub.connection(session.deviceId);
    if (!connection) {
      this.status(session, "waiting_for_executor", "Remote executor is offline; local fallback is disabled.");
      throw new Error("remote workspace executor is offline");
    }
    const connectionCapabilities = connection.capabilities();
    if (session.capabilities.some(capability => !connectionCapabilities.includes(capability))) {
      throw new Error("remote workspace executor capabilities changed; start a new session for this computer");
    }
    this.status(session, "starting", `Reconnecting ${session.deviceName}/${session.rootLabel}`);
    const transport = await connection.openSession({
      sessionId: session.id,
      rootId: session.rootId,
      profile: session.profile,
    });
    if (session.stopOperation) {
      await connection.closeSession(session.id).catch(() => {});
      throw new Error("remote workspace session is stopping");
    }
    await session.closeTransport?.().catch(() => {});
    if (session.remoteTransport) session.remoteTransport.replace(transport);
    else session.remoteTransport = new SwitchableRemoteWorkspaceTransport(transport);
    session.closeTransport = () => connection.closeSession(session.id);
    this.status(session, "ready", `${session.profile} reconnected to ${session.deviceName}/${session.rootLabel}`);
  }

  private async ensureRuntime(session: LiveSession): Promise<void> {
    if (session.handle) return;
    if (!session.threadId || !session.resumable || !session.remoteTransport) {
      throw new Error("remote workspace session cannot be resumed");
    }
    const factory = this.runtimes.get(session.profile);
    if (!factory) throw new Error(`remote workspace ${session.profile} runtime is not installed on the hub`);
    const available = await factory.available();
    if (!available.available) throw new Error(available.reason ?? `remote workspace ${session.profile} runtime is unavailable`);
    const coordinator = new RemoteWorkspaceCoordinator(session.remoteTransport);
    const handle = await factory.start({
      sessionId: session.id,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      rootId: session.rootId,
      rootLabel: session.rootLabel,
      capabilities: [...session.capabilities],
      tools: [...session.tools],
      resumeThreadId: session.threadId,
      coordinator,
      emit: (type, text) => this.emit(session, type, text),
    });
    try {
      session.unregister = coordinator.register({
        sessionId: session.id,
        threadId: handle.threadId,
        executorDeviceId: session.deviceId,
        executorName: session.deviceName,
        rootId: session.rootId,
        capabilities: [...session.capabilities],
        tools: [...session.tools],
      });
    } catch (error) {
      await handle.stop().catch(() => {});
      throw error;
    }
    session.threadId = handle.threadId;
    session.handle = handle;
    this.status(session, "ready", `${session.profile} resumed on ${session.deviceName}/${session.rootLabel}`);
  }

  private refreshOfflineStates(): void {
    for (const session of this.sessions.values()) {
      if (session.status !== "ready" || this.hub.connection(session.deviceId)) continue;
      this.status(session, "waiting_for_executor", "Remote executor is offline; local fallback is disabled.");
    }
  }

  private pruneRetainedSessions(): void {
    if (this.sessions.size < MAX_RETAINED_SESSIONS) return;
    for (const [id, session] of this.sessions) {
      if (session.status !== "stopped" && !(session.status === "failed" && session.handle === null)) continue;
      this.sessions.delete(id);
      if (this.sessions.size < MAX_RETAINED_SESSIONS) return;
    }
    if (this.sessions.size >= MAX_RETAINED_SESSIONS) {
      throw new Error("remote workspace retained session limit reached; stop an active session first");
    }
  }

  private persist(): void {
    if (!this.store) return;
    const sessions = [...this.sessions.values()].map(session => {
      const summary = this.publicSession(session);
      return {
        ...summary,
        events: summary.events.slice(-MAX_PERSISTED_EVENTS_PER_SESSION).map(event => ({
          ...event,
          text: boundedPersistedEventText(event.text),
        })),
      };
    });
    this.store.save({ version: REMOTE_WORKSPACE_SESSION_STATE_VERSION, sessions });
  }
}
