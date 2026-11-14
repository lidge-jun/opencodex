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

/**
 * Every note a connector can attach, keyed by a stable code. The CLI prints `text`; the dashboard
 * translates `code`, so the English here is the source for both and no caller parses it.
 */
export const GATEWAY_NOTE_TEXT = {
  "restart-app": "Restart Antigravity to apply a change.",
  "no-google-sign-in": "In gateway mode the app does not use the Google sign-in.",
  "agy-follows-app": "agy follows this file unless it is connected on its own.",
  "settings-not-json": "settings.json is not strict JSON (comments, trailing commas or a syntax error). OpenCodex will not rewrite a file it cannot round-trip; fix or simplify it, then connect again.",
  "settings-not-object": "settings.json does not hold a JSON object, so OpenCodex left it untouched.",
  "no-restore-record": "No restore record exists (connected outside OpenCodex), so disconnect cannot restore your previous settings.",
  "new-terminal": "Open a new terminal to pick up the agy function.",
  "agy-version": "Gateway support needs agy 1.2.15 or newer.",
  "windows-unverified": "Google documents the agy gateway for macOS and Linux. The Windows build also reads the AGY_LLM_GATEWAY_* settings, but this path has not been verified end to end on Windows.",
  "agy-env-exported": "AGY_LLM_GATEWAY_URL is exported globally in the environment OpenCodex sees; the agy function overrides it for agy only.",
} as const;
export type GatewayNoteCode = keyof typeof GATEWAY_NOTE_TEXT;
export interface GatewayNote { code: GatewayNoteCode; text: string }
export const gatewayNote = (code: GatewayNoteCode): GatewayNote => ({ code, text: GATEWAY_NOTE_TEXT[code] });

/** `code` names the override for the dashboard; `detail` is the CLI's English line and never echoes a secret. */
export interface GatewayOverride {
  source: "admin_settings" | "env";
  code: "admin-gateway" | "admin-unreadable" | "env-gateway";
  detail: string;
}

export interface GatewayClientStatus {
  id: GatewayClientId;
  label: string;
  state: "connected" | "disconnected" | "drifted";
  files: { path: string; role: string; exists: boolean }[];
  overrides: GatewayOverride[];
  notes: GatewayNote[];
  /** Antigravity only: `models.defaultModelId` as the settings file holds it now. */
  defaultModel?: string;
}

export type GatewayRefusalCode = "unsupported-file" | "io-error";

export interface GatewayClientResult {
  ok: boolean;
  code?: GatewayRefusalCode;
  message: string;
  changed: boolean;
  changedFiles: string[];
  restore?: "exact" | "path-wise" | "none";
  notes: GatewayNote[];
}

export interface GatewayClientConnector {
  id: GatewayClientId;
  label: string;
  status(ctx: GatewayClientContext, target?: GatewayTarget): GatewayClientStatus;
  connect(ctx: GatewayClientContext, target: GatewayTarget): GatewayClientResult;
  disconnect(ctx: GatewayClientContext): GatewayClientResult;
}
