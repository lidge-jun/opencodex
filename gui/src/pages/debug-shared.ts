export interface DebugSettings {
  enabled: boolean;
  usage: boolean;
  injection: boolean;
  claude: boolean;
  runtimeOverride: Partial<Record<"debug" | "usage" | "injection" | "claude", boolean>>;
  env: Record<"debug" | "usage" | "injection" | "claude", boolean>;
}

export interface DebugLogEntry {
  seq: number;
  at: number;
  line: string;
}

export interface ClaudeInboundEntry {
  id: number;
  at: number;
  endpoint: string;
  model: string;
  resolvedModel?: string;
  stream?: boolean;
  maxTokens?: number;
  thinkingType?: string;
  thinkingBudgetTokens?: number;
  outputConfigEffort?: string;
  metadataKeys?: string[];
  hasMetadataUserId: boolean;
  hasSystem: boolean;
  anthropicBeta?: string;
  userIdTag?: string;
  systemTag?: string;
}

export type LogStream = "provider" | "usage" | "injection";

export const DEBUG_STREAMS = ["provider", "usage", "injection"] as const;

export function formatLogTime(at: number): string {
  return at > 0 ? `[${new Date(at).toLocaleTimeString()}] ` : "";
}

export function formatClaudeInboundTime(at: number): string {
  return new Date(at).toLocaleTimeString();
}

export function isStreamEnabled(debug: DebugSettings | null, stream: LogStream): boolean {
  return stream === "provider" ? !!debug?.enabled : stream === "usage" ? !!debug?.usage : !!debug?.injection;
}

export function isDebugFlagEnabled(debug: DebugSettings, flag: keyof DebugSettings["env"]): boolean {
  return flag === "debug" ? debug.enabled : flag === "usage" ? debug.usage : flag === "injection" ? debug.injection : debug.claude;
}
