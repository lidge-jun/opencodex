import { readConfigDiagnostics, withConfigMutationLockSync } from "../config";
import type { OcxConfig } from "../types";

/** Reflect controller-owned fields from current durable state, preserving concurrent settings. */
export function mirrorRouteNativeSettings(live: OcxConfig, current: OcxConfig): void {
  for (const client of ["codex", "grok", "claude-desktop"] as const) {
    const value = current.clientIntegrations?.[client];
    if (value !== undefined) (live.clientIntegrations ??= {})[client] = value;
    else if (live.clientIntegrations) delete live.clientIntegrations[client];
  }
  for (const key of ["enabled", "authModeMigratedAt"] as const) {
    const value = current.claudeCode?.[key];
    if (value !== undefined) live.claudeCode = { ...live.claudeCode, [key]: value };
    else if (live.claudeCode) delete live.claudeCode[key];
  }
  const messages = current.apiSurfaces?.messages?.enabled;
  if (messages !== undefined) live.apiSurfaces = { ...live.apiSurfaces, messages: { ...live.apiSurfaces?.messages, enabled: messages } };
  else if (live.apiSurfaces?.messages) delete live.apiSurfaces.messages.enabled;
}

export function refreshRouteNativeSettings(live: OcxConfig): void {
  withConfigMutationLockSync(() => {
    const latest = readConfigDiagnostics();
    if (latest.source !== "file" || latest.error) throw new Error("config_unavailable");
    mirrorRouteNativeSettings(live, latest.config);
  });
}

/** A copy carrying the durable native switches; another process may have changed them. */
export function withDurableRouteNativeSettings(config: OcxConfig): OcxConfig {
  const copy = structuredClone(config);
  const latest = readConfigDiagnostics();
  if (latest.source === "file" && !latest.error) mirrorRouteNativeSettings(copy, latest.config);
  return copy;
}
