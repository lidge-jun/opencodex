/**
 * Claude Desktop first-party mode.
 *
 * Desktop has two ways to reach opencodex:
 *
 *   - `gateway` (default): the third-party deployment profile (src/claude/desktop-3p.ts). The
 *     whole app is switched to a gateway build; picker entries are opencodex aliases.
 *   - `first-party`: the app keeps its ordinary claude.ai login, Chat tab, connectors and remote
 *     control. Only the Claude Code process it spawns for the Code tab (and that process's
 *     subagents) is redirected, through the `HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS` env in
 *     `~/.claude/settings.json` (src/claude/intercept/settings.ts) and the server's intercept pair
 *     (src/claude/intercept/runtime.ts). It sends Claude subscription traffic through a local
 *     interception proxy, so every first-party surface carries the account-risk notice in
 *     src/claude/desktop-risk.ts.
 *
 * The two are mutually exclusive on disk: applying one removes the other. The mode is persisted
 * in `claudeCode.desktopMode`. Installs that predate the field keep what they run: a selected
 * gateway row or a gateway apply marker keeps `gateway`, and first-party env that opencodex wrote
 * into Claude Code's settings keeps `first-party` (observeClaudeDesktopMode), so moving the default
 * to gateway never flips a working Desktop under the operator.
 */
import { getConfigDir, withConfigDirHardeningSettled } from "../config/paths";
import { WindowsSecretAclSettleTimeoutError } from "../lib/windows-secret-acl";
import { join } from "node:path";
import type { OcxConfig } from "../types";
import { claudeConfigDir } from "./auth-detect";
import { inspectDesktop3pConfigLibrary } from "./desktop-3p";
import { claudeInterceptCaCertPath, ensureLocalInterceptCa } from "./intercept/local-ca";
import { claudeInterceptEnabled, claudeInterceptProxyPort } from "./intercept/port-policy";
import { ensureClaudeInterceptProxyToken, readClaudeInterceptProxyToken } from "./intercept/proxy-auth";
import {
  applyClaudeInterceptSettings,
  buildClaudeInterceptEnv,
  captureClaudeInterceptSettingsRollback,
  inspectClaudeInterceptSettings,
  removeClaudeInterceptSettings,
  type ClaudeInterceptEnv,
  type ClaudeInterceptSettingsState,
  type ClaudeInterceptSettingsWrite,
} from "./intercept/settings";

export const CLAUDE_DESKTOP_MODES = ["first-party", "gateway"] as const;
export type ClaudeDesktopMode = typeof CLAUDE_DESKTOP_MODES[number];
export const DEFAULT_CLAUDE_DESKTOP_MODE: ClaudeDesktopMode = "gateway";

export function isClaudeDesktopMode(value: unknown): value is ClaudeDesktopMode {
  return typeof value === "string" && (CLAUDE_DESKTOP_MODES as readonly string[]).includes(value);
}

type DesktopModeConfig = Pick<OcxConfig, "claudeCode">;

/** What the resolver may learn from disk. Only rows and settings opencodex owns count. */
export interface ClaudeDesktopModeObservation {
  /** Desktop's selected config-library row is our gateway (current or drifted). */
  ownedGatewaySelected?: boolean;
  /** Claude Code's settings carry first-party env that opencodex wrote (applied or stale). */
  ownedFirstPartySettings?: boolean;
}

/**
 * Effective Desktop mode. An explicit `claudeCode.desktopMode` wins. Without one, what is on disk
 * decides for installs that predate the field: a selected owned gateway row or a persisted gateway
 * apply marker keeps `gateway`, owned first-party settings keep `first-party`. Everything else is
 * the gateway default. Pure: callers that decide an apply or a write pass
 * `observeClaudeDesktopMode(config)`.
 */
export function resolveClaudeDesktopMode(
  config: DesktopModeConfig,
  observed: ClaudeDesktopModeObservation = {},
): ClaudeDesktopMode {
  const explicit = config.claudeCode?.desktopMode;
  if (isClaudeDesktopMode(explicit)) return explicit;
  if (observed.ownedGatewaySelected) return "gateway";
  if (config.claudeCode?.desktopProfile?.appliedFingerprint) return "gateway";
  if (observed.ownedFirstPartySettings) return "first-party";
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
 * Mode an *apply* without an explicit choice should use. With gateway as the default, first-party
 * only comes from an explicit choice or an observed first-party install; both are honoured even
 * when the intercept is disabled, and the apply is then refused with `intercept_disabled`, which
 * names the fix, instead of silently replacing the operator's mode.
 */
export function resolveClaudeDesktopApplyMode(
  config: Pick<OcxConfig, "claudeCode" | "runtimeRole">,
  observed: ClaudeDesktopModeObservation = {},
): ClaudeDesktopMode {
  return resolveClaudeDesktopMode(config, observed);
}

export interface DesktopFirstPartyTarget {
  proxyPort: number;
  caCertPath: string;
  env: ClaudeInterceptEnv;
}

function firstPartyTarget(
  config: Pick<OcxConfig, "claudeCode" | "port">,
  opencodexConfigDir: string,
  authToken: string,
): DesktopFirstPartyTarget {
  const proxyPort = claudeInterceptProxyPort(config, config.port ?? 10100);
  const caCertPath = claudeInterceptCaCertPath(opencodexConfigDir);
  return { proxyPort, caCertPath, env: buildClaudeInterceptEnv(proxyPort, caCertPath, authToken) };
}

/** The settings env a first-party apply on this machine writes (CA and token are created on demand). */
export function desktopFirstPartyTarget(
  config: Pick<OcxConfig, "claudeCode" | "port">,
  opencodexConfigDir = getConfigDir(),
): DesktopFirstPartyTarget {
  return firstPartyTarget(config, opencodexConfigDir, ensureClaudeInterceptProxyToken(opencodexConfigDir));
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

/** Prepare rollback before replacing a gateway, without changing settings. */
export function captureDesktopFirstPartyRollback(
  config: Pick<OcxConfig, "claudeCode" | "port">,
  options: DesktopFirstPartyOptions = {},
): () => boolean {
  // The expected env resolves at rollback time: the apply mints the proxy token, so capturing it
  // here would both mint on a path that may never apply and throw when the intercept directory is
  // unavailable — a failure the apply already reports as ca_unavailable.
  return captureClaudeInterceptSettingsRollback(
    () => desktopFirstPartyTarget(config, options.opencodexConfigDir).env, options.claudeConfigDir,
  );
}

export function inspectDesktopFirstParty(
  config: Pick<OcxConfig, "claudeCode" | "port" | "runtimeRole">,
  options: DesktopFirstPartyOptions = {},
): DesktopFirstPartyInspection {
  const opencodexConfigDir = options.opencodexConfigDir ?? getConfigDir();
  // Inspection is read-only: a missing token means no apply or runtime start produced one,
  // so an owned env can never match the empty credential — it classifies stale, and a real
  // apply is what refreshes it.
  const target = firstPartyTarget(config, opencodexConfigDir, readClaudeInterceptProxyToken(opencodexConfigDir) ?? "");
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

/**
 * Observe what Desktop runs today for the resolver. Never throws: an unreadable library or
 * settings file is no evidence, and a foreign proxy env is never mistaken for ours.
 */
export function observeClaudeDesktopMode(
  config: Pick<OcxConfig, "claudeCode" | "port" | "runtimeRole">,
  options: DesktopFirstPartyOptions = {},
): ClaudeDesktopModeObservation {
  const observed: ClaudeDesktopModeObservation = {};
  try {
    const library = inspectDesktop3pConfigLibrary({ appliedFingerprint: config.claudeCode?.desktopProfile?.appliedFingerprint ?? null });
    observed.ownedGatewaySelected = library.kind === "gateway_ours" || library.kind === "gateway_drifted";
  } catch { // no-excuse-ok: catch -- an unreadable library is no gateway evidence.
    observed.ownedGatewaySelected = false;
  }
  try {
    const kind = inspectDesktopFirstParty(config, options).settings.kind;
    observed.ownedFirstPartySettings = config.claudeCode?.cliFirstParty === true
      ? false : kind === "applied" || kind === "stale";
  } catch { // no-excuse-ok: catch -- unreadable settings are no first-party evidence.
    observed.ownedFirstPartySettings = false;
  }
  return observed;
}

const SECRET_FAILURE_CAUSES = ["EACCES", "EPERM", "ENOENT", "EEXIST", "EIO", "EBUSY", "ETIMEDOUT",
  "EICACLS", "EACLIDENTITY", "local_ca_path_unsafe", "client_lifecycle_busy", "client_lifecycle_lock_failed",
  "claude_intercept_proxy_token_invalid", "Error", "TypeError", "RangeError", "unknown"] as const;
export interface InterceptSecretDiagnostic {
  stage: "ca" | "token";
  cause: typeof SECRET_FAILURE_CAUSES[number];
}
function secretFailureCause(error: unknown): InterceptSecretDiagnostic["cause"] {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  // Allowlist labels, never arbitrary messages, paths, ACL stdout, or error-supplied names.
  for (const allowed of SECRET_FAILURE_CAUSES) if (code === allowed) return allowed;
  for (const allowed of ["TypeError", "RangeError", "Error"] as const)
    if (error instanceof Error && error.name === allowed) return allowed;
  return "unknown";
}
export type DesktopFirstPartyApplyResult =
  | { ok: true; changed: boolean; path: string; env: ClaudeInterceptEnv; proxyPort: number }
  | { ok: false; reason: "intercept_disabled" | "ca_unavailable" | "unreadable" | "foreign_env"; path: string; diagnostic?: InterceptSecretDiagnostic };

/** Async apply/reconcile boundaries translate admission timeout into the existing refusal. */
export async function withFirstPartySecretsSettled<T>(configDir: string, prepare: () => T):
  Promise<T | Extract<DesktopFirstPartyApplyResult, { ok: false }>> {
  try { return await withConfigDirHardeningSettled(configDir, prepare); }
  catch (error) {
    if (!(error instanceof WindowsSecretAclSettleTimeoutError)) throw error;
    return { ok: false, reason: "ca_unavailable", path: claudeInterceptCaCertPath(configDir),
      diagnostic: { stage: "ca", cause: "ETIMEDOUT" } };
  }
}

/**
 * Run a captured first-party rollback once overlapping ACL work settles. A settle timeout
 * leaves the rollback unrun and reports it as incomplete, so callers keep their existing
 * "rollback did not complete" response instead of escaping into a generic error path.
 */
export async function rollbackDesktopFirstPartySettled(configDir: string, rollback: () => boolean): Promise<boolean> {
  try { return await withConfigDirHardeningSettled(configDir, rollback); }
  catch (error) {
    if (!(error instanceof WindowsSecretAclSettleTimeoutError)) throw error;
    return false;
  }
}

/**
 * Write the first-party env into Claude Code's settings. Creates the local CA first so the
 * path we point `NODE_EXTRA_CA_CERTS` at exists before Claude Code ever reads it.
 */
export function applyDesktopFirstParty(
  config: Pick<OcxConfig, "claudeCode" | "port" | "runtimeRole">,
  options: DesktopFirstPartyOptions = {},
): DesktopFirstPartyApplyResult {
  const opencodexConfigDir = options.opencodexConfigDir ?? getConfigDir();
  if (!claudeInterceptEnabled(config)) return { ok: false, reason: "intercept_disabled", path: "" };
  let target: DesktopFirstPartyTarget;
  let stage: InterceptSecretDiagnostic["stage"] = "ca";
  try {
    ensureLocalInterceptCa(opencodexConfigDir);
    stage = "token";
    target = desktopFirstPartyTarget(config, opencodexConfigDir);
  } catch (error) {
    const diagnostic = { stage, cause: secretFailureCause(error) };
    console.warn(`[claude-intercept] secret preparation failed: stage=${diagnostic.stage} cause=${diagnostic.cause}`);
    return { ok: false, reason: "ca_unavailable", path: claudeInterceptCaCertPath(opencodexConfigDir), diagnostic };
  }
  const written = applyClaudeInterceptSettings(target.env, options.claudeConfigDir);
  if (!written.ok) return { ok: false, reason: written.reason, path: written.path };
  return { ok: true, changed: written.changed, path: written.path, env: target.env, proxyPort: target.proxyPort };
}

/** Remove Desktop's share of the env, retaining the shared pair for a desired CLI. */
export function removeDesktopFirstParty(
  config: Pick<OcxConfig, "claudeCode" | "runtimeRole">,
  options: DesktopFirstPartyOptions = {},
): ClaudeInterceptSettingsWrite & { retainedFor?: "cli" } {
  if (config.claudeCode?.cliFirstParty === true) {
    return { ok: true, changed: false, path: join(options.claudeConfigDir ?? claudeConfigDir(), "settings.json"), retainedFor: "cli" };
  }
  const caCertPath = claudeInterceptCaCertPath(options.opencodexConfigDir ?? getConfigDir());
  return removeClaudeInterceptSettings(caCertPath, options.claudeConfigDir);
}

/**
 * Remove Desktop's first-party env once ACL work overlapping the Claude settings home settles.
 * A `CLAUDE_CONFIG_DIR` nested in the opencodex home shares the config-root hardening flight, so
 * the credential-bearing settings rewrite gets the same admission as other intercept secrets.
 * The config is read inside the same synchronous turn. Admission, authority-read and removal
 * exceptions return the existing unreadable refusal so a committed gateway remains explicit.
 */
export async function removeDesktopFirstPartySettled(
  readConfig: () => Pick<OcxConfig, "claudeCode" | "runtimeRole">,
  options: DesktopFirstPartyOptions = {},
  remove: typeof removeDesktopFirstParty = removeDesktopFirstParty,
): Promise<ReturnType<typeof removeDesktopFirstParty>> {
  const dir = options.claudeConfigDir ?? claudeConfigDir();
  try { return await withConfigDirHardeningSettled(dir, () => remove(readConfig(), options)); }
  catch { return { ok: false, reason: "unreadable", path: join(dir, "settings.json") }; }
}
