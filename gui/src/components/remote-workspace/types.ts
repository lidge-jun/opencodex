import type { TKey } from "../../i18n/shared";

export type RuntimeProfile = "codex" | "claude" | "pi";
type RemoteCapability = "workspace.read" | "workspace.write" | "workspace.exec";
export type RemoteAccessMode = "read-only" | "workspace";
type SessionStatus = "starting" | "ready" | "running" | "waiting_for_executor" | "failed" | "stopped";

interface RemoteRoot { id: string; label: string }
export interface RemoteDevice {
  id: string;
  name: string;
  platform: string;
  capabilities: RemoteCapability[];
  roots: RemoteRoot[];
  online: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}
interface RuntimeAvailability { available: boolean; version?: string; reason?: string }
interface SessionEvent { sequence: number; at: string; type: "status" | "assistant" | "tool" | "error"; text: string }
export interface RemoteSession {
  id: string;
  profile: RuntimeProfile;
  accessMode: RemoteAccessMode;
  deviceId: string;
  deviceName: string;
  rootId: string;
  rootLabel: string;
  capabilities: RemoteCapability[];
  tools: string[];
  threadId: string | null;
  resumable: boolean;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  events: SessionEvent[];
}
export interface RemoteWorkspaceState {
  available: boolean;
  reason?: string;
  devices: RemoteDevice[];
  runtimes: Record<RuntimeProfile, RuntimeAvailability>;
  sessions: RemoteSession[];
}
export interface PairingGrant { code: string; expiresAt: string }

export const PROFILES: RuntimeProfile[] = ["codex", "claude", "pi"];
export const PROFILE_LABEL: Record<RuntimeProfile, string> = { codex: "Codex", claude: "Claude Code", pi: "Pi" };
export const STATUS_TKEY: Record<SessionStatus, TKey> = {
  starting: "remote.status.starting",
  ready: "remote.status.ready",
  running: "remote.status.running",
  waiting_for_executor: "remote.status.waiting",
  failed: "remote.status.failed",
  stopped: "remote.status.stopped",
};
export const EVENT_TKEY: Record<Exclude<SessionEvent["type"], "assistant">, TKey> = {
  status: "remote.event.status",
  tool: "remote.event.tool",
  error: "remote.event.error",
};
