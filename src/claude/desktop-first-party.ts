/**
 * Claude Desktop first-party mode.
 *
 * Desktop has two ways to reach opencodex:
 *
 *   - `first-party` (default): the app keeps its ordinary claude.ai login, Chat tab, connectors
 *     and remote control. Only the Claude Code process it spawns for the Code tab (and that
 *     process's subagents) is redirected, through the `HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS` env
 *     in `~/.claude/settings.json` (src/claude/intercept/settings.ts) and the server's intercept
 *     pair (src/claude/intercept/runtime.ts). Nothing is written under Desktop's config library.
 *   - `gateway`: the historical third-party deployment profile (src/claude/desktop-3p.ts). The
 *     whole app is switched to a gateway build; picker entries are opencodex aliases.
 *
 * The two are mutually exclusive on disk: applying one removes the other. The mode is persisted
 * in `claudeCode.desktopMode`; installs that predate the field but already carry an applied
 * gateway profile keep `gateway` until they explicitly re-apply, so an update never flips a
 * working Desktop under the operator.
 */
import { getConfigDir } from "../config/paths";
import type { OcxConfig } from "../types";
import { claudeInterceptCaCertPath, ensureLocalInterceptCa } from "./intercept/local-ca";
import { claudeInterceptEnabled, claudeInterceptProxyPort } from "./intercept/runtime";
import {
  applyClaudeInterceptSettings,
  buildClaudeInterceptEnv,
  inspectClaudeInterceptSettings,
  removeClaudeInterceptSettings,
  type ClaudeInterceptEnv,
  type ClaudeInterceptSettingsState,
  type ClaudeInterceptSettingsWrite,
} from "./intercept/settings";

export const CLAUDE_DESKTOP_MODES = ["first-party", "gateway"] as const;
export type ClaudeDesktopMode = typeof CLAUDE_DESKTOP_MODES[number];
export const DEFAULT_CLAUDE_DESKTOP_MODE: ClaudeDesktopMode = "first-party";

export function isClaudeDesktopMode(value: unknown): value is ClaudeDesktopMode {
  return typeof value === "string" && (CLAUDE_DESKTOP_MODES as readonly string[]).includes(value);
}

type DesktopModeConfig = Pick<OcxConfig, "claudeCode">;

/**
 * Effective Desktop mode. An explicit `claudeCode.desktopMode` wins; otherwise a persisted
 * gateway apply marker (`desktopProfile.appliedFingerprint`) means a pre-existing gateway
 * install and keeps `gateway`; everything else is the first-party default.
 */
export function resolveClaudeDesktopMode(config: DesktopModeConfig): ClaudeDesktopMode {
  const explicit = config.claudeCode?.desktopMode;
  if (isClaudeDesktopMode(explicit)) return explicit;
  if (config.claudeCode?.desktopProfile?.appliedFingerprint) return "gateway";
  return DEFAULT_CLAUDE_DESKTOP_MODE;
}

/**
 * Config mutation that records the applied Desktop mode. Switching to first-party also drops
 * the gateway apply marker: the profile assignments stay for a later gateway apply, but a
 * stale `appliedFingerprint` must not make `resolveClaudeDesktopMode` read `gateway` again
 * should the explicit marker ever go missing.
 */
export function recordClaudeDesktopMode(
  config: DesktopModeConfig,
  mode: ClaudeDesktopMode,
): { changed: boolean; value: true } {
  const claudeCode = config.claudeCode ?? {};
  const profile = claudeCode.desktopProfile;
  const dropMarker = mode === "first-party" && profile !== undefined
    && (profile.appliedFingerprint !== undefined || profile.appliedAt !== undefined);
  if (claudeCode.desktopMode === mode && !dropMarker) return { changed: false, value: true };
  if (dropMarker) {
    const { appliedFingerprint: _fingerprint, appliedAt: _at, ...rest } = profile;
    config.claudeCode = { ...claudeCode, desktopMode: mode, desktopProfile: rest };
  } else {
    config.claudeCode = { ...claudeCode, desktopMode: mode };
  }
  return { changed: true, value: true };
}

/**
 * Mode an *apply* without an explicit choice should use. The first-party default only holds
 * where the intercept proxy actually runs; with it disabled (or on a client role) an implied
 * first-party apply would point Claude Code at a proxy that never starts, so fall back to the
 * gateway profile. An explicit `desktopMode: "first-party"` is still honoured (and refused
 * later with `intercept_disabled`, which names the fix).
 */
export function resolveClaudeDesktopApplyMode(
  config: Pick<OcxConfig, "claudeCode" | "runtimeRole">,
): ClaudeDesktopMode {
  const resolved = resolveClaudeDesktopMode(config);
  if (resolved === "gateway" || isClaudeDesktopMode(config.claudeCode?.desktopMode)) return resolved;
  return claudeInterceptEnabled(config) ? "first-party" : "gateway";
}

export interface DesktopFirstPartyTarget {
  proxyPort: number;
  caCertPath: string;
  env: ClaudeInterceptEnv;
}

/** The settings env a first-party apply on this machine writes (CA is created on demand). */
export function desktopFirstPartyTarget(
  config: Pick<OcxConfig, "claudeCode" | "port">,
  opencodexConfigDir = getConfigDir(),
): DesktopFirstPartyTarget {
  const proxyPort = claudeInterceptProxyPort(config, config.port ?? 10100);
  const caCertPath = claudeInterceptCaCertPath(opencodexConfigDir);
  return { proxyPort, caCertPath, env: buildClaudeInterceptEnv(proxyPort, caCertPath) };
}

export interface DesktopFirstPartyInspection {
  /** False when the server will not run the intercept pair (client role, intercept disabled). */
  interceptEnabled: boolean;
  proxyPort: number;
  caCertPath: string;
  settings: ClaudeInterceptSettingsState;
  /** settings.json carries exactly the env the current config would write. */
  applied: boolean;
  /** Ours, but for an older port/config directory. Re-apply refreshes it. */
  stale: boolean;
}

export interface DesktopFirstPartyOptions {
  opencodexConfigDir?: string;
  claudeConfigDir?: string;
}

export function inspectDesktopFirstParty(
  config: Pick<OcxConfig, "claudeCode" | "port" | "runtimeRole">,
  options: DesktopFirstPartyOptions = {},
): DesktopFirstPartyInspection {
  const target = desktopFirstPartyTarget(config, options.opencodexConfigDir);
  const settings = inspectClaudeInterceptSettings(target.env, options.claudeConfigDir);
  return {
    interceptEnabled: claudeInterceptEnabled(config),
    proxyPort: target.proxyPort,
    caCertPath: target.caCertPath,
    settings,
    applied: settings.kind === "applied",
    stale: settings.kind === "stale",
  };
}

export type DesktopFirstPartyApplyResult =
  | { ok: true; changed: boolean; path: string; env: ClaudeInterceptEnv; proxyPort: number }
  | { ok: false; reason: "intercept_disabled" | "ca_unavailable" | "unreadable" | "foreign_env"; path: string };

/**
 * Write the first-party env into Claude Code's settings. Creates the local CA first so the
 * path we point `NODE_EXTRA_CA_CERTS` at exists before Claude Code ever reads it.
 */
export function applyDesktopFirstParty(
  config: Pick<OcxConfig, "claudeCode" | "port" | "runtimeRole">,
  options: DesktopFirstPartyOptions = {},
): DesktopFirstPartyApplyResult {
  const opencodexConfigDir = options.opencodexConfigDir ?? getConfigDir();
  const target = desktopFirstPartyTarget(config, opencodexConfigDir);
  if (!claudeInterceptEnabled(config)) return { ok: false, reason: "intercept_disabled", path: "" };
  try {
    ensureLocalInterceptCa(opencodexConfigDir);
  } catch {
    return { ok: false, reason: "ca_unavailable", path: target.caCertPath };
  }
  const written = applyClaudeInterceptSettings(target.env, options.claudeConfigDir);
  if (!written.ok) return { ok: false, reason: written.reason, path: written.path };
  return { ok: true, changed: written.changed, path: written.path, env: target.env, proxyPort: target.proxyPort };
}

/** Remove the first-party env. Only values anchored on our CA path are touched. */
export function removeDesktopFirstParty(options: DesktopFirstPartyOptions = {}): ClaudeInterceptSettingsWrite {
  const caCertPath = claudeInterceptCaCertPath(options.opencodexConfigDir ?? getConfigDir());
  return removeClaudeInterceptSettings(caCertPath, options.claudeConfigDir);
}
