import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { resolveAutoContext, type AutoContextMode } from "../claude/context-windows";
import { PROXY_MARKER } from "../claude/auth-detect";
import { isProxyAdmissionSecret } from "./auth-cors";
import type { OcxConfig } from "../types";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { localAdmissionToken, localInferenceDestination } from "../lib/local-destinations";
import { probeHostname } from "./proxy-liveness";
import { providerContextCap } from "../providers/context-cap";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
export { getShellEnvFilePath, installShellHook, uninstallShellHook, claudeCodeCliInstalled, reconcileShellHook } from "./system-env-shell";
export type { SystemEnvDeps } from "./system-env-shell";
import { systemEnvMarkerMode, writeShellEnvFile, removeShellEnvFile } from "./system-env-shell";
import type { SystemEnvDeps } from "./system-env-shell";

const SYSTEM_ENV_NAMES = [
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

const MANAGED_SYSTEM_ENV_NAMES = new Set<string>([
  ...SYSTEM_ENV_NAMES,
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "DISABLE_COMPACT",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
]);

interface SystemEnvTracking {
  pid: number;
  /** The PUBLIC port of the owning proxy: its instance identity and its /healthz port. */
  port: number;
  /**
   * The host `/healthz` answers on — `probeHostname(config.hostname)` at injection time (#4236).
   *
   * Without it the liveness probe went to `127.0.0.1:<public port>`, which does not exist on a
   * tailnet-bound hub: every probe failed, the record was reverted on every start, and the
   * "another instance owns env" guard below could never fire. Absent (⇒ 127.0.0.1) in records
   * written by a build that only ever bound loopback.
   */
  bindHost?: string;
  /**
   * The exact ANTHROPIC_BASE_URL that was injected, when it is not `http://127.0.0.1:<port>`.
   *
   * The injected destination and the proxy's own `/healthz` address separated the day local
   * clients started honoring the unauthenticated loopback listener, and separated again for a
   * non-loopback bind. Ownership on revert is proven against THIS value — it is what was
   * written — while liveness is probed on `bindHost`/`port`, because the loopback listener
   * serves no `/healthz` and probing the injected port would declare a live proxy stale.
   */
  clientBaseUrl?: string;
  injectedAt: string;
  /** Keys that were actually set by injection (revert only unsets these). */
  injectedKeys?: string[];
}

/** Bounded host shape: this value is interpolated into a probe URL, so it is validated on read. */
const BIND_HOST_PATTERN = /^[A-Za-z0-9.\-_]{1,253}$|^\[[0-9A-Fa-f:.]{2,45}\]$/;

type SystemEnvResult = { injected: boolean; reason?: string };
type RevertResult = { reverted: boolean; reason?: string };
type CleanupResult = { cleaned: boolean; reason?: string };

export function getSystemEnvTrackingPath(): string {
  return join(getConfigDir(), "system-env-port");
}

export function launchctlGetenv(name: string): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
  try {
    const value = execFileSync("/bin/launchctl", ["getenv", name], { encoding: "utf8" }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function readTracking(): SystemEnvTracking | undefined {
  try {
    const tracking = JSON.parse(readFileSync(getSystemEnvTrackingPath(), "utf8")) as Partial<SystemEnvTracking>;
    if (!Number.isInteger(tracking.port) || typeof tracking.pid !== "number" || typeof tracking.injectedAt !== "string") {
      return undefined;
    }
    const injectedKeys = Array.isArray(tracking.injectedKeys)
      ? [...new Set(tracking.injectedKeys.filter(
        (name): name is string => typeof name === "string" && MANAGED_SYSTEM_ENV_NAMES.has(name),
      ))]
      : undefined;
    const bindHost = typeof tracking.bindHost === "string" && BIND_HOST_PATTERN.test(tracking.bindHost)
      ? tracking.bindHost
      : undefined;
    const clientBaseUrl = typeof tracking.clientBaseUrl === "string" && /^https?:\/\/[^\s/]+$/.test(tracking.clientBaseUrl)
      ? tracking.clientBaseUrl
      : undefined;
    return { ...tracking, bindHost, clientBaseUrl, injectedKeys } as SystemEnvTracking;
  } catch {
    return undefined;
  }
}

function setLaunchctlEnv(name: string, value: string): void {
  execFileSync("/bin/launchctl", ["setenv", name, value]);
}

function unsetLaunchctlEnv(name: string): void {
  execFileSync("/bin/launchctl", ["unsetenv", name]);
}

function ownedBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** What the tracking record has to remember beyond the public port, or nothing on a pure loopback install. */
interface TrackedDestination {
  /** `probeHostname(config.hostname)` — where `/healthz` answers. */
  bindHost: string;
  /** The injected ANTHROPIC_BASE_URL. */
  clientBaseUrl: string;
}

function writeTracking(port: number, injectedKeys: string[], tracked?: TrackedDestination): void {
  recordOwnedConfigPath(getConfigDir(), getSystemEnvTrackingPath());
  mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  writeFileSync(getSystemEnvTrackingPath(), JSON.stringify({
    pid: process.pid,
    port,
    // Both fields are omitted when they carry no information beyond `port`, so a plain
    // loopback install keeps writing the byte-identical record it always did.
    ...(tracked && tracked.bindHost !== "127.0.0.1" ? { bindHost: tracked.bindHost } : {}),
    ...(tracked && tracked.clientBaseUrl !== ownedBaseUrl(port) ? { clientBaseUrl: tracked.clientBaseUrl } : {}),
    injectedAt: new Date().toISOString(),
    injectedKeys,
  }), { encoding: "utf8", mode: 0o600 });
}

/** The base URL that was injected: the loopback listener or the bind address, not always loopback (#4236). */
function trackedBaseUrl(tracking: Pick<SystemEnvTracking, "port" | "clientBaseUrl">): string {
  return tracking.clientBaseUrl ?? ownedBaseUrl(tracking.port);
}

/** Where the owning proxy's `/healthz` answers — the BIND address, never the injected port (#4236). */
function trackedHealthzOrigin(tracking: Pick<SystemEnvTracking, "port" | "bindHost">): string {
  return `http://${tracking.bindHost ?? "127.0.0.1"}:${tracking.port}`;
}

function rollbackInjectedKeys(port: number, injectedKeys: string[], tracked?: TrackedDestination): void {
  const rollbackFailed: string[] = [];
  for (const name of [...injectedKeys].reverse()) {
    try {
      unsetLaunchctlEnv(name);
    } catch {
      rollbackFailed.unshift(name);
    }
  }

  if (rollbackFailed.length > 0) {
    writeTracking(port, rollbackFailed, tracked);
    return;
  }

  try { unlinkSync(getSystemEnvTrackingPath()); } catch { /* already gone */ }
}

/**
 * In-process effective model-env (default + tier slots, [1m] applied) under the shared
 * 3s bound (audit R4#3). Returns {} on timeout/failure so injection degrades safely.
 */
async function computeEffectiveModelEnv(config: OcxConfig, auto?: AutoContextMode): Promise<{ modelEnv: Record<string, string>; windows: Record<string, number> }> {
  const { boundedContextWindows, buildClaudeContextWindows, effectiveModelEnv } = await import("../claude/context-windows");
  const windows = await boundedContextWindows(async () => {
    const { gatherRoutedModels, nativeContextLimits, visibleNativeSlugs } = await import("../codex/catalog");
    try {
      return buildClaudeContextWindows([...visibleNativeSlugs(config)], await gatherRoutedModels(config), nativeContextLimits(config));
    } catch (error) {
      if (error && typeof error === "object" && (error as { code?: unknown }).code === "catalog_busy") {
        return buildClaudeContextWindows([...visibleNativeSlugs(config)], [], nativeContextLimits(config));
      }
      throw error;
    }
  });
  return { modelEnv: effectiveModelEnv(config.claudeCode, windows ?? {}, auto), windows: windows ?? {} };
}

export async function injectSystemEnv(
  port: number,
  config: OcxConfig,
  deps: SystemEnvDeps = {},
): Promise<SystemEnvResult> {
  if (process.platform !== "darwin") return { injected: false, reason: "not macOS" };
  if (config.claudeCode?.enabled === false) return { injected: false, reason: "claude disabled" };

  // Default OFF — only inject when explicitly enabled by the user.
  if (config.claudeCode?.systemEnv !== true) return { injected: false, reason: "systemEnv disabled" };

  await cleanStaleSystemEnv();

  // A launchd-started `claude` is a LOCAL client: it dials the unauthenticated loopback
  // listener when one is enabled, because on a tailnet-bound hub nothing answers on
  // 127.0.0.1:<public port> (#4236); with no listener the destination is the BIND address,
  // which answers but demands data-plane admission. `port` stays the instance identity.
  const destination = localInferenceDestination(config, port);
  const tracked: TrackedDestination = {
    bindHost: probeHostname(config.hostname),
    clientBaseUrl: destination.origin,
  };
  const markerMode = systemEnvMarkerMode(config, deps);
  // The data-plane credential this host can present to its own public listener: env token,
  // hardened service token file, then a configured key. Never the admin token.
  const hostAdmissionToken = destination.requiresAdmissionToken ? localAdmissionToken(config) : undefined;
  // The launchd domain is machine-wide, so injecting a destination that will 401 every plain
  // `claude` is worse than not injecting at all. Degrade out loud instead: a subscription
  // launch cannot carry a host token (asserting one logs a claude.ai subscriber out, #253),
  // and with no resolvable credential there is nothing to carry either way.
  if (destination.requiresAdmissionToken && (markerMode !== "proxy" || !hostAdmissionToken)) {
    console.error(
      `⚠ Skipping system-environment injection: ${destination.origin} requires an opencodex data-plane `
      + "credential that this launch cannot supply. Enable `unauthenticatedLoopbackListener` or bind the "
      + "proxy to loopback.",
    );
    return { injected: false, reason: "local inference requires a data-plane credential" };
  }

  const currentBaseUrl = launchctlGetenv("ANTHROPIC_BASE_URL");
  // Ours is loopback in every topology but one: with the listener off and a non-loopback bind
  // the value WE wrote names the bind address, and rejecting it as "user has custom" would make
  // every subsequent start refuse to refresh its own injection.
  if (currentBaseUrl
    && !/^http:\/\/127\.0\.0\.1:\d+$/.test(currentBaseUrl)
    && currentBaseUrl !== destination.origin) {
    return { injected: false, reason: "user has custom ANTHROPIC_BASE_URL" };
  }
  // After stale cleanup, if a tracking file still exists with a DIFFERENT port,
  // another live instance owns the env — don't overwrite it.
  const existingTracking = readTracking();
  if (existingTracking && existingTracking.port !== port) {
    return { injected: false, reason: `another instance owns env (port ${existingTracking.port})` };
  }

  const injectedKeys: string[] = existingTracking
    ? [...(existingTracking.injectedKeys ?? SYSTEM_ENV_NAMES)]
    : [];
  const inject = (name: string, value: string) => {
    setLaunchctlEnv(name, value);
    if (!injectedKeys.includes(name)) injectedKeys.push(name);
    writeTracking(port, injectedKeys, tracked);
  };

  try {
    inject("ANTHROPIC_BASE_URL", destination.origin);
    inject("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "1");
    if (markerMode === "proxy") {
      if (hostAdmissionToken) {
        // The guard above proved this exists whenever the destination demands one.
        inject("ANTHROPIC_AUTH_TOKEN", hostAdmissionToken);
      } else if (config.apiKeys?.length) {
        inject("ANTHROPIC_AUTH_TOKEN", config.apiKeys[0].key);
      } else if (launchctlGetenv("ANTHROPIC_AUTH_TOKEN") === undefined) {
        inject("ANTHROPIC_AUTH_TOKEN", PROXY_MARKER);
      }
    } else if (injectedKeys.includes("ANTHROPIC_AUTH_TOKEN")) {
      const currentToken = launchctlGetenv("ANTHROPIC_AUTH_TOKEN");
      if (currentToken
        && (currentToken === PROXY_MARKER || isProxyAdmissionSecret(currentToken, config))) {
        // Subscription switch-back (devlog 260720_claude_authmode_persist): remove
        // opencodex-owned dummy or admission tokens so a launchd-started Claude regains
        // its own claude.ai OAuth. User-set tokens are never touched.
        unsetLaunchctlEnv("ANTHROPIC_AUTH_TOKEN");
        const tokenIdx = injectedKeys.indexOf("ANTHROPIC_AUTH_TOKEN");
        if (tokenIdx >= 0) injectedKeys.splice(tokenIdx, 1);
        writeTracking(port, injectedKeys, tracked);
      }
    }
    // Lever keys (devlog 136 B6): user-wins — skip any key the user already set in the
    // launchd domain, and track ONLY the keys we actually injected so revert cannot
    // delete a pre-existing user value (audit 139 #3).
    const injectLever = (name: string, value: string) => {
      if (launchctlGetenv(name) !== undefined) return;
      inject(name, value);
    };
    // Model slots (default + tier defaults + legacy small-fast) with [1m] auto-marking
    // (devlog 260712 B2, audit R2#3/R4#3): in-process context-window computation under
    // the same 3s bound; on timeout the tier keys are simply not injected this run.
    // Auto-context: a user-owned launchd value drives the marking predicate so the
    // marker and threshold never separate (audit 021 #2); injectLever's user-wins
    // check below keeps that value untouched.
    const userAutoCompact = launchctlGetenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
    const auto = resolveAutoContext(config.claudeCode, userAutoCompact);
    const { modelEnv, windows } = await computeEffectiveModelEnv(config, auto);
    for (const [name, value] of Object.entries(modelEnv)) {
      if (name === "ANTHROPIC_MODEL") continue; // legacy slot handled by shell file only (back-compat)
      injectLever(name, value);
    }
    const maxCtx = config.claudeCode?.maxContextTokens;
    if (typeof maxCtx === "number" && Number.isFinite(maxCtx) && maxCtx > 0) {
      injectLever("CLAUDE_CODE_MAX_CONTEXT_TOKENS", String(Math.floor(maxCtx)));
      injectLever("DISABLE_COMPACT", "1");
    }
    // Auto-context (devlog 260712 020): user-wins lever, inert when maxContextTokens set.
    if (auto.enabled) injectLever("CLAUDE_CODE_AUTO_COMPACT_WINDOW", String(auto.compactWindow));
    if (config.claudeCode?.alwaysEnableEffort === true) {
      injectLever("CLAUDE_CODE_ALWAYS_ENABLE_EFFORT", "1");
    }

    // Shell-hook env file: works for new shells in already-running Terminal.app.
    writeShellEnvFile(port, config, modelEnv, auto, deps);

    // Gateway-model cache pre-write (devlog 030): plain `claude` sessions read the
    // picker list from ~/.claude/cache/gateway-models.json and cannot refresh it
    // without a token — keep it in sync with this proxy's /v1/models. Best-effort.
    try {
      const { refreshGatewayModelCacheFromProxy } = await import("../claude/gateway-cache");
      await refreshGatewayModelCacheFromProxy(port, { admissionConfig: config });
    } catch { /* best-effort */ }

    // Roster agent definitions (devlog 070): same launch-time sync for plain `claude`.
    // Reuses the window map computed above (audit 071 #5 — no second acquisition).
    try {
      const { injectClaudeAgentDefs } = await import("../claude/agents-inject");
      injectClaudeAgentDefs(config, windows);
    } catch { /* best-effort */ }

    writeTracking(port, injectedKeys, tracked);
  } catch (error) {
    rollbackInjectedKeys(port, injectedKeys, tracked);
    removeShellEnvFile();
    console.error("Failed to inject system environment; rolled back launchctl changes:", error);
    throw error;
  }

  return { injected: true };
}

export async function applySystemEnvToggle(config: OcxConfig, port: number): Promise<SystemEnvResult | RevertResult> {
  if (config.claudeCode?.systemEnv === true) return injectSystemEnv(port, config);
  return revertSystemEnv();
}

export function revertSystemEnv(): RevertResult {
  if (process.platform !== "darwin") return { reverted: false, reason: "not macOS" };

  const tracking = readTracking();
  if (!tracking) return { reverted: false, reason: "no tracking file" };

  try {
    const tracksBaseUrl = tracking.injectedKeys?.includes("ANTHROPIC_BASE_URL") ?? true;
    if (tracksBaseUrl && launchctlGetenv("ANTHROPIC_BASE_URL") !== trackedBaseUrl(tracking)) {
      return { reverted: false, reason: "ownership mismatch" };
    }

    // Only unset keys that were actually injected (preserves pre-existing user tokens).
    const keysToUnset = tracking.injectedKeys ?? SYSTEM_ENV_NAMES as unknown as string[];
    for (const name of keysToUnset) {
      try {
        unsetLaunchctlEnv(name);
      } catch {
        // Continue removing the remaining variables during shutdown.
      }
    }
    removeShellEnvFile();
    try {
      unlinkSync(getSystemEnvTrackingPath());
    } catch {
      // The environment was reverted even if the tracking file disappeared concurrently.
    }
    return { reverted: true };
  } catch {
    return { reverted: false, reason: "revert failed" };
  }
}

export async function cleanStaleSystemEnv(): Promise<CleanupResult> {
  const tracking = readTracking();
  if (!tracking) return { cleaned: false, reason: "no tracking file" };

  try {
    // The BIND address and `tracking.port`, never the injected destination: `/healthz` is not
    // on the unauthenticated loopback listener's allowlist, so probing that port would 404 and
    // revert a live proxy's environment (#4236). Nor is it always 127.0.0.1 — a tailnet-bound
    // hub has no loopback socket at all, and probing one there failed every single time, which
    // reverted the record on every start and made the "another instance owns env" guard above
    // unreachable.
    const response = await fetch(`${trackedHealthzOrigin(tracking)}/healthz`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (response.ok) return { cleaned: false, reason: "proxy still alive" };
  } catch {
    // A failed or timed-out health check means the tracked proxy is stale.
  }

  const reverted = revertSystemEnv();
  if (!reverted.reverted) return { cleaned: false, reason: reverted.reason };
  return { cleaned: true };
}
