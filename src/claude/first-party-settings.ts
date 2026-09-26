import { getConfigDir } from "../config/paths";
import { claudeDesktopIntegrationEnabled } from "../codex/desired-state";
import { join } from "node:path";
import type { OcxConfig } from "../types";
import { claudeConfigDir } from "./auth-detect";
import {
  applyDesktopFirstParty,
  inspectDesktopFirstParty,
  resolveClaudeDesktopMode,
  type ClaudeDesktopModeObservation,
  type DesktopFirstPartyOptions,
} from "./desktop-first-party";
import { claudeInterceptCaCertPath } from "./intercept/local-ca";
import { claudeInterceptEnabled } from "./intercept/runtime";
import { isClaudeInterceptProxyUrl, removeClaudeInterceptSettings, type ClaudeInterceptSettingsState } from "./intercept/settings";

export type ClaudeFirstPartyClient = "desktop" | "cli";
export interface ClaudeFirstPartyDesired { desktop: boolean; cli: boolean }

export function cliFirstPartyDesired(config: Pick<OcxConfig, "claudeCode">): boolean {
  return config.claudeCode?.cliFirstParty === true;
}

export function desktopFirstPartyDesired(
  config: Pick<OcxConfig, "claudeCode" | "clientIntegrations">,
  observed?: ClaudeDesktopModeObservation,
): boolean {
  return claudeDesktopIntegrationEnabled(config)
    && resolveClaudeDesktopMode(config, observed) === "first-party";
}

export function firstPartyDesired(
  config: Pick<OcxConfig, "claudeCode" | "clientIntegrations">,
  observed?: ClaudeDesktopModeObservation,
): ClaudeFirstPartyDesired {
  return { desktop: desktopFirstPartyDesired(config, observed), cli: cliFirstPartyDesired(config) };
}

export type ClaudeFirstPartyReconcileResult =
  | { ok: true; action: "applied" | "removed" | "unchanged"; changed: boolean; path: string }
  | { ok: false; reason: "intercept_disabled" | "ca_unavailable" | "unreadable" | "foreign_env"; path: string };

export function reconcileClaudeFirstPartySettings(
  config: Pick<OcxConfig, "claudeCode" | "port" | "runtimeRole" | "clientIntegrations">,
  desired: ClaudeFirstPartyDesired,
  options: DesktopFirstPartyOptions = {},
): ClaudeFirstPartyReconcileResult {
  if (!desired.desktop && !desired.cli) {
    const ownedCa = claudeInterceptCaCertPath(options.opencodexConfigDir ?? getConfigDir());
    const removed = removeClaudeInterceptSettings(ownedCa, options.claudeConfigDir);
    if (!removed.ok) return removed;
    return { ok: true, action: removed.changed ? "removed" : "unchanged", changed: removed.changed, path: removed.path };
  }
  if (!claudeInterceptEnabled(config)) {
    return { ok: true, action: "unchanged", changed: false,
      path: join(options.claudeConfigDir ?? claudeConfigDir(), "settings.json") };
  }
  const written = applyDesktopFirstParty(config, options);
  if (!written.ok) return written;
  return { ok: true, action: written.changed ? "applied" : "unchanged", changed: written.changed, path: written.path };
}

export type FirstPartyProxyStatus = "none" | "live" | "stopped" | "disabled" | "broken" | "foreign" | "local" | "unknown";
export interface FirstPartyProxyStatusInput {
  settings: ClaudeInterceptSettingsState;
  boundProxyPort: number | null;
  eligible: boolean;
}

/** Classify the settings URL against the listener actually bound in this process. */
export function firstPartyProxyStatus({ settings, boundProxyPort, eligible }: FirstPartyProxyStatusInput): FirstPartyProxyStatus {
  if (settings.kind === "unreadable") return "unknown";
  if (settings.kind === "absent") return "none";
  const proxy = settings.env.HTTPS_PROXY;
  if (!isClaudeInterceptProxyUrl(proxy)) return "none";
  // A foreign CA cannot establish ownership; preserve tokenless loopback as an uncertain local proxy.
  if (settings.kind === "foreign") {
    return /^http:\/\/opencodex:[^@/]+@/.test(proxy) ? "foreign" : "local";
  }
  if (boundProxyPort === null) return "stopped";
  // The URL shape is owned; a malformed/out-of-range port cannot match the bound listener.
  let port: number;
  try { port = Number(new URL(proxy).port || 80); } catch { return "broken"; }
  const usable = settings.kind === "applied" && port === boundProxyPort;
  if (!eligible) return usable ? "disabled" : "broken";
  return usable ? "live" : "broken";
}

/** Read-only: inspectDesktopFirstParty reads an existing token; it never creates one. */
export function readFirstPartyProxyStatus(
  config: Pick<OcxConfig, "claudeCode" | "port" | "runtimeRole">,
  boundProxyPort: number | null,
  options: DesktopFirstPartyOptions = {},
): FirstPartyProxyStatus {
  const settings = inspectDesktopFirstParty(config, options).settings;
  return firstPartyProxyStatus({ settings, boundProxyPort, eligible: claudeInterceptEnabled(config) });
}
