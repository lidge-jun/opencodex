/** Connectors that point a Google client at OpenCodex's gateway (Antigravity app, agy CLI). */
export type GatewayClientId = "antigravity" | "agy";

export interface GatewayClientContext {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** OpenCodex config dir; stash files live in `<stateDir>/gateway-clients/`. */
  stateDir: string;
  /** Override for tests; defaults to the platform's admin_settings.json location. */
  adminSettingsPath?: string;
}

export interface GatewayTarget {
  url: string;
  apiKey: string;
  defaultModel?: string;
}

export interface GatewayClientStatus {
  id: GatewayClientId;
  label: string;
  state: "connected" | "disconnected" | "drifted";
  files: { path: string; role: string; exists: boolean }[];
  overrides: { source: "admin_settings" | "env"; detail: string }[];
  notes: string[];
}

export type GatewayRefusalCode = "unsupported-file" | "io-error";

export interface GatewayClientResult {
  ok: boolean;
  code?: GatewayRefusalCode;
  message: string;
  changed: boolean;
  changedFiles: string[];
  restore?: "exact" | "path-wise" | "none";
  notes: string[];
}

export interface GatewayClientConnector {
  id: GatewayClientId;
  label: string;
  status(ctx: GatewayClientContext, target?: GatewayTarget): GatewayClientStatus;
  connect(ctx: GatewayClientContext, target: GatewayTarget): GatewayClientResult;
  disconnect(ctx: GatewayClientContext): GatewayClientResult;
}
