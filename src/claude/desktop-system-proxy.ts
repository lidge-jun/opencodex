import type { OcxConfig } from "../types";
import {
  readWindowsProxyBypassRegistry,
  readWindowsSystemProxy,
  windowsProxyOverrideBypasses,
  type WindowsProxyBypassValues,
  type WindowsSystemProxyResult,
} from "../lib/windows-system-proxy";
import { inspectDesktopFirstParty, observeClaudeDesktopMode } from "./desktop-first-party";
import { desktopFirstPartyDesired } from "./first-party-settings";

/**
 * Whether the Windows system proxy silently bypasses Desktop first-party mode.
 *
 * When Claude Desktop starts the Code tab's Claude Code process, it resolves the operating
 * system proxy for the API host and, when that yields an HTTP proxy, passes it to the process
 * as `HTTPS_PROXY`/`HTTP_PROXY`. That inherited value takes precedence over the `env` block
 * OpenCodex writes into the user's `~/.claude/settings.json` (only Claude Code managed settings
 * override it), so Code-tab traffic goes to the system proxy and never reaches the intercept.
 * Routed subagent models then fail, and nothing else reports why. A system proxy such as Clash or
 * v2rayN, with no bypass for the API host, is the common case.
 *
 * Observe-only: this reads the registry and never changes it. A PAC script and WPAD automatic
 * detection decide per request, so they are reported as undecidable rather than guessed, and a
 * failed read is reported as unreadable rather than as an absent value. Like the other doctor
 * proxy surfaces it never prints the proxy value, which can carry credentials.
 */

export const FIRST_PARTY_API_HOST = "api.anthropic.com";

export type DesktopSystemProxyVerdict = "no-proxy" | "bypassed" | "conflict" | "pac" | "auto-detect" | "unreadable";

export type DesktopSystemProxyAssessment =
  | { kind: "not-applicable" }
  | {
    kind: DesktopSystemProxyVerdict;
    /** settings.json carries an owned first-party env that no longer matches the port or token. */
    settingsStale: boolean;
    /** WPAD detection is on (or unknown) next to a static proxy; a WPAD script would win. */
    autoDetectAlsoOn: boolean;
  };

export type DesktopFirstPartySettingsState = "applied" | "stale" | "off";

export interface DesktopSystemProxyInput {
  platform: NodeJS.Platform;
  firstParty: DesktopFirstPartySettingsState;
  systemProxy: WindowsSystemProxyResult;
  /** `null` when the Internet Settings key could not be read. */
  bypass: WindowsProxyBypassValues | null;
}

function classify(systemProxy: WindowsSystemProxyResult, bypass: WindowsProxyBypassValues | null): DesktopSystemProxyVerdict {
  if (bypass === null || systemProxy.kind === "unreadable") return "unreadable";
  if (bypass.autoConfigUrl) return "pac";
  // Desktop skips SOCKS entries, and an http=-only value does not cover an https:// API host.
  const covering = systemProxy.kind === "proxy" && Boolean(systemProxy.httpsUrl);
  if (!covering) return bypass.autoDetect === false ? "no-proxy" : "auto-detect";
  // A failed WPAD lookup falls back to the static proxy, so a static conflict stands either way.
  return windowsProxyOverrideBypasses(bypass.proxyOverride, FIRST_PARTY_API_HOST) ? "bypassed" : "conflict";
}

export function assessDesktopSystemProxy(input: DesktopSystemProxyInput): DesktopSystemProxyAssessment {
  if (input.platform !== "win32" || input.firstParty === "off") return { kind: "not-applicable" };
  const kind = classify(input.systemProxy, input.bypass);
  return {
    kind,
    settingsStale: input.firstParty === "stale",
    autoDetectAlsoOn: kind === "bypassed" && input.bypass?.autoDetect !== false,
  };
}

const STALE_LINES = [
  "      The OpenCodex first-party env in ~/.claude/settings.json is stale (proxy port or token changed);",
  "      run `ocx ensure`, then re-run `ocx doctor`.",
];

function verdictLines(kind: DesktopSystemProxyVerdict): string[] {
  switch (kind) {
    case "no-proxy":
      return ["  ok  No Windows system proxy covers the Claude API; the Code tab uses the OpenCodex proxy from settings.json."];
    case "bypassed":
      return [`  ok  ${FIRST_PARTY_API_HOST} is on the Windows proxy bypass list; the Code tab uses the OpenCodex proxy from settings.json.`];
    case "pac":
      return [
        "  --  Windows uses a proxy auto-config (PAC) script, so OpenCodex cannot tell whether Claude Desktop",
        `      sends ${FIRST_PARTY_API_HOST} through a proxy. If routed models fail in the Code tab, make the script return DIRECT for it.`,
      ];
    case "auto-detect":
      return [
        "  --  Windows automatic proxy detection (WPAD) is on or could not be read, so OpenCodex cannot tell whether",
        `      Claude Desktop sends ${FIRST_PARTY_API_HOST} through a proxy. If routed models fail in the Code tab, turn off`,
        "      \"Automatically detect settings\" or make the network's WPAD script return DIRECT for it.",
      ];
    case "unreadable":
      return ["  --  Could not read the Windows proxy settings."];
    case "conflict":
      return [
        `  !!  The Windows system proxy applies to ${FIRST_PARTY_API_HOST}. Claude Desktop passes it to the Code tab`,
        "      as HTTPS_PROXY, which takes precedence over the OpenCodex proxy in ~/.claude/settings.json,",
        "      so first-party routing is bypassed and routed models fail there.",
        `      Fix: add ${FIRST_PARTY_API_HOST} to your proxy client's system-proxy bypass list (Clash Verge: system_proxy_bypass),`,
        "      then fully quit and reopen Claude Desktop.",
      ];
  }
}

export function formatDesktopSystemProxyLines(assessment: DesktopSystemProxyAssessment): string[] {
  if (assessment.kind === "not-applicable") return [];
  const clear = assessment.kind === "no-proxy" || assessment.kind === "bypassed";
  // A stale env never earns an `ok`: the Code tab would reach a proxy URL that no longer matches.
  if (clear && assessment.settingsStale) return [`  --  ${STALE_LINES[0]!.trimStart()}`, STALE_LINES[1]!];
  const lines = verdictLines(assessment.kind);
  if (assessment.autoDetectAlsoOn) {
    lines.push("      Automatic proxy detection (WPAD) is also on; a WPAD script on this network would decide instead.");
  }
  if (assessment.settingsStale) lines.push(...STALE_LINES);
  return lines;
}

export interface DesktopSystemProxyDeps {
  platform?: NodeJS.Platform;
  firstPartyState?: () => DesktopFirstPartySettingsState;
  readSystemProxy?: () => WindowsSystemProxyResult;
  readBypass?: () => WindowsProxyBypassValues | null;
}

function liveFirstPartyState(
  config: Pick<OcxConfig, "claudeCode" | "clientIntegrations" | "port" | "runtimeRole">,
): DesktopFirstPartySettingsState {
  try {
    const settings = inspectDesktopFirstParty(config).settings.kind;
    if (settings !== "applied" && settings !== "stale") return "off";
    return desktopFirstPartyDesired(config, observeClaudeDesktopMode(config)) ? settings : "off";
  } catch { // no-excuse-ok: catch -- unreadable Claude settings are no first-party evidence.
    return "off";
  }
}

/** Reads the live state. Registry reads run only on Windows with a Desktop first-party env. */
export function collectDesktopSystemProxy(
  config: Pick<OcxConfig, "claudeCode" | "clientIntegrations" | "port" | "runtimeRole">,
  deps: DesktopSystemProxyDeps = {},
): DesktopSystemProxyAssessment {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return { kind: "not-applicable" };
  const firstParty = (deps.firstPartyState ?? (() => liveFirstPartyState(config)))();
  if (firstParty === "off") return { kind: "not-applicable" };
  return assessDesktopSystemProxy({
    platform,
    firstParty,
    systemProxy: (deps.readSystemProxy ?? readWindowsSystemProxy)(),
    bypass: (deps.readBypass ?? readWindowsProxyBypassRegistry)(),
  });
}
