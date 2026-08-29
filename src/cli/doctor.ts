/**
 * `ocx doctor` - read-only environment diagnostics.
 *
 * Explains WHY ChatGPT quota may never populate (and thus why account
 * auto-switch can appear stuck), especially on WSL2 where outbound fetch to
 * chatgpt.com can be blocked by NAT/DNS/VPN/proxy differences. Observe-only:
 * it never sets proxy env, relocates state dirs, mutates quota, or changes
 * networking. See devlog/_plan/260630_wsl-account-autoswitch/30_*.
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getConfigDir, getConfigPath, readConfigDiagnostics } from "../config";
import { readPid } from "../config/process-state";
import { probeUncleanExitState } from "./status";
import { findLiveProxy, type LiveProxy } from "../server/proxy-liveness";
import { BUN_RUNTIME_SOURCES } from "../lib/bun-runtime";
import type { BunRuntimeSource } from "../lib/bun-runtime";
import { maskAccountId } from "../lib/privacy";
import { tokenCollidesWithAdmin } from "../lib/admin-secrets";
import { readInstalledServiceToken } from "../lib/service-secrets";
import { PROXY_ENV_KEYS, proxyEnvPresent } from "../lib/proxy-env";
import { LOCAL_MANAGEMENT_READ_PATHS } from "../lib/local-management-capability";
import { readCodexTokens } from "../codex/auth-collision";
import { withNativeMainSharedClaim } from "../codex/native-main-claim";
import { probeNativeProfileRecoveryState, resolveNativeProfileContext } from "../codex/native-profile-store";
import { NativeProfileError } from "../codex/native-profile-types";
import { collectOrcaCodexHomeDiagnostic, resolveCodexHomeDir as resolveCodexHomeDirImpl, isWslRuntime, listWslWindowsCodexHomes, wslAutomountRoot, type CodexHomeDeps } from "../codex/home";
import { scanCodexAgentRolesWithTomlModelFallback } from "../codex/subagent-model-fallback";
import { diagnoseCodexShim, findCodexOnPath, isWindowsInteropDir, type CodexShimDiagnostic } from "../codex/shim";
import { providerTableString, rootTomlString } from "../codex/injected-marker";
import { countPendingOpencodexHistory } from "../codex/history-provider";
import {
  inspectCodexCoordinator,
  recoverZeroByteCodexCoordinator,
  type CodexCoordinatorDiagnostic,
} from "../codex/coordinator-doctor";
import {
  inspectAbandonedResponseStateTemps,
  reclaimAbandonedResponseStateTemps,
  type ResponseStateTempRecoveryResult,
} from "../responses/state";
import {
  CodexUserIdentityRefusal,
  probeCodexCoordinatorNamespace,
  resolveEffectiveUserIdentity,
} from "../codex/user-identity";
import { collectProjectCodexConfigWarnings, formatProjectCodexConfigWarningsForDoctor } from "../codex/project-config-warnings";
import { collectStartupHealth, formatStartupRoutingDetail, startupHealthSummary } from "../codex/autostart-health";
import {
  displayCodexRuntimePath,
  loadLastEffortClamp,
  persistCodexRuntime,
  resolveAndPersistCodexRuntime,
  resolveCodexRuntime,
} from "../codex/runtime";
import { CODEX_REAUTH_ACTION, collectOAuthHealthEntriesForCli, MASKED_ACCOUNT_FALLBACK, type OAuthHealthEntry } from "../oauth/health";
import { getAuthRefreshIntentLockPath, getAuthStorePath } from "../oauth/store";
import {
  fetchBoundLocalManagementRead,
  type LocalManagementReadDeps,
} from "../server/local-management-read-client";
export { resolveCodexHomeDir } from "../codex/home";

/**
 * `FAIL` exists for a condition that makes the surface unusable rather than degraded.
 * A review of the #2696 work pointed out that reporting a fully fenced management plane
 * — every `/api/*` returning 503 — at the same level as a directory-permission note
 * misleads the reader about severity.
 *
 * Doctor's own exit code still belongs to the uniform contract in wp3b (devlog 025);
 * this type only fixes what the operator is told.
 */
export type OAuthDoctorCheck = { level: "OK" | "WARN" | "FAIL"; message: string };

/**
 * Whether any FAIL-level condition was seen during this `runDoctor` pass.
 *
 * Module-scoped and reset at the top of `runDoctor` rather than threaded through, because
 * `runDoctor` reports by direct `console.log` across a dozen sections and has no checks
 * collection to inspect. Reset matters for the test suite, which calls `runDoctor` several
 * times in one process; a sticky flag would make the second call fail because the first did.
 */
let doctorSawFailure = false;

function recordDoctorFailure(): void {
  doctorSawFailure = true;
}

/** True when the last `runDoctor` pass saw a FAIL-level condition. */
export function doctorFailed(): boolean {
  return doctorSawFailure;
}

function pathIsWritable(path: string): boolean {
  try {
    // Directories need execute/search as well as write for create+rename.
    accessSync(path, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Observe-only: can we atomically replace auth.json (sibling tmp + rename)? */
function isOAuthCredentialStorageWritable(): boolean {
  const storePath = getAuthStorePath();
  const dir = existsSync(storePath) ? dirname(storePath) : getConfigDir();
  if (existsSync(dir)) return pathIsWritable(dir);
  // Config dir missing: check nearest existing ancestor (no mkdir — observe-only).
  let parent = dirname(dir);
  for (let i = 0; i < 8; i++) {
    if (existsSync(parent)) return pathIsWritable(parent);
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return false;
}

/** Observe-only: refresh lock paths resolve and their parent dir is writable. */
function isOAuthRefreshSingleFlightReady(): boolean {
  try {
    const sample = getAuthRefreshIntentLockPath("doctor-probe", "probe-account");
    if (!sample.includes("auth.refresh.")) return false;
    const dir = getConfigDir();
    if (existsSync(dir)) return pathIsWritable(dir);
    return isOAuthCredentialStorageWritable();
  } catch {
    return false;
  }
}

function actionForDoctorEntry(entry: OAuthHealthEntry): string {
  if (entry.action) return entry.action;
  if (entry.provider === "codex") {
    return CODEX_REAUTH_ACTION;
  }
  if (entry.health.status === "warning" && entry.health.reason === "stale_credentials") {
    return `run \`ocx login ${entry.provider}\``;
  }
  if (entry.health.status === "warning" && entry.health.reason === "metadata_mismatch") {
    return `run \`ocx login ${entry.provider}\` to refresh credentials`;
  }
  return `run \`ocx doctor\` again after fixing OAuth state for ${entry.provider}`;
}

function describeDoctorHealth(entry: OAuthHealthEntry): string {
  const masked = maskAccountId(entry.accountId) ?? MASKED_ACCOUNT_FALLBACK;
  const health = entry.health;
  switch (health.status) {
    case "reauth_required":
      return `Account ${masked} requires reauthentication`;
    case "cooldown":
      return health.reason === "rate_limit"
        ? `Account ${masked} is rate limited until ${health.until}`
        : `Account ${masked} is quota limited until ${health.until}`;
    case "warning":
      switch (health.reason) {
        case "refresh_conflict":
          return `Account ${masked} has a refresh conflict`;
        case "metadata_mismatch":
          return `Account ${masked} has a metadata mismatch`;
        case "stale_credentials":
          return `Account ${masked} has incomplete credentials`;
      }
    case "healthy":
      return `Account ${masked} is healthy`;
  }
}

/**
 * Detect the management/data-plane credential collision behind #2696.
 *
 * The service exports the service token file as `OPENCODEX_API_AUTH_TOKEN` before
 * starting the proxy. When that value is the admin token, the server treats the
 * management credential as a data-plane admission secret and fences the ENTIRE
 * management plane closed at boot: every `/api/*` returns 503, including on a loopback
 * install that never needed a data-plane secret.
 *
 * `assertNotAdminToken` in src/service.ts now refuses to create this state, but an
 * install made before that guard existed is already broken on disk, and the symptom
 * (every management command failing) points nowhere. This is the check that names it.
 *
 * Observe-only, like the rest of doctor: it compares shapes and never prints, logs, or
 * returns a credential value.
 */
export function dataPlaneCredentialCollisionCheck(
  env: NodeJS.ProcessEnv = process.env,
  installedServiceToken: string | null = readInstalledServiceToken(),
): OAuthDoctorCheck {
  const dataPlane = env.OPENCODEX_API_AUTH_TOKEN?.trim() || installedServiceToken?.trim() || "";
  if (!dataPlane) {
    return { level: "OK", message: "No data-plane token is set, so it cannot collide with the management token." };
  }
  // Same comparison as assertNotAdminToken: minted prefix or configuredAdminToken
  // (env or admin-api-token file). The file token is the one the service wrapper
  // actually exports; inspecting only the doctor process env reported OK on every
  // already-broken install (#2696).
  if (!tokenCollidesWithAdmin(dataPlane, env)) {
    return { level: "OK", message: "Data-plane and management credentials are distinct." };
  }
  return {
    // Not a degradation: while this holds, every /api/* returns 503 and no ocx
    // management command can work at all.
    level: "FAIL",
    message:
      "The data-plane secret (OPENCODEX_API_AUTH_TOKEN or the service token file) holds the "
      + "management (admin) token, so the proxy fences the whole management API closed and "
      + "every ocx management command fails with 503. "
      + "Action: unset OPENCODEX_API_AUTH_TOKEN, replace the service token file with a distinct "
      + "data-plane key, then re-run `ocx service install` and restart the proxy",
  };
}

/**
 * OAuth reliability checks for `ocx doctor`. Observe-only: never mutates
 * credentials, locks, or networking. Every WARN includes a recovery Action.
 */
export async function collectOAuthDoctorChecks(
  now = Date.now(),
  deps: Parameters<typeof collectOAuthHealthEntriesForCli>[1] = {},
): Promise<OAuthDoctorCheck[]> {
  const checks: OAuthDoctorCheck[] = [];

  checks.push(dataPlaneCredentialCollisionCheck());

  if (isOAuthCredentialStorageWritable()) {
    checks.push({ level: "OK", message: "OAuth credential storage directory is writable for atomic auth.json updates." });
  } else {
    checks.push({
      level: "WARN",
      message:
        "OAuth credential storage directory is not writable. Action: fix permissions on OPENCODEX_HOME so ocx can create temp files and rename auth.json",
    });
  }

  if (isOAuthRefreshSingleFlightReady()) {
    checks.push({ level: "OK", message: "Token refresh single-flight is active." });
  } else {
    checks.push({
      level: "WARN",
      message:
        "Token refresh single-flight is unavailable. Action: fix permissions on OPENCODEX_HOME so ocx can create refresh lock files",
    });
  }

  const report = await collectOAuthHealthEntriesForCli(now, deps);
  if (report.codexHealthSource === "unavailable") {
    checks.push({
      level: "WARN",
      message:
        "Codex account health unavailable (proxy not running). Action: start the proxy and re-run `ocx doctor` to inspect live cooldown/reauth",
    });
  } else if (report.codexHealthSource === "management-auth-failed") {
    checks.push({
      level: "WARN",
      message:
        "Codex account health unavailable (proxy running; management authentication failed). Action: verify the admin token configuration, restart the proxy, and re-run `ocx doctor`",
    });
  } else if (report.codexHealthSource === "management-api-unavailable") {
    checks.push({
      level: "WARN",
      message:
        "Codex account health unavailable (proxy running; management API response failed). Action: inspect the proxy service log, restart the proxy if needed, and re-run `ocx doctor`",
    });
  }
  for (const entry of report.entries) {
    if (entry.health.status === "healthy") continue;
    const action = actionForDoctorEntry(entry);
    checks.push({
      level: "WARN",
      message: `${describeDoctorHealth(entry)}. Action: ${action}`,
    });
  }

  // Build-time / architecture note — not a runtime fabrication scanner.
  checks.push({
    level: "OK",
    message: "Codex forward path uses pass-through client metadata (build-time invariant; not a runtime scan).",
  });

  return checks;
}

const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const PROBE_TIMEOUT_MS = 8000;

export type PathRow = { label: string; path: string; exists: boolean };

export function collectPaths(): PathRow[] {
  const codexHome = resolveCodexHomeDirImpl();
  const opencodexHome = getConfigDir();
  return [
    { label: "CODEX_HOME", path: codexHome, exists: existsSync(codexHome) },
    { label: "CODEX_HOME/auth.json", path: join(codexHome, "auth.json"), exists: existsSync(join(codexHome, "auth.json")) },
    { label: "OPENCODEX_HOME", path: opencodexHome, exists: existsSync(opencodexHome) },
    { label: "OPENCODEX_HOME/config.json", path: getConfigPath(), exists: existsSync(getConfigPath()) },
  ];
}

export type FsTypeInfo = { fstype: string; mount: string; isDrvfs: boolean; isMntDrive: boolean };

/**
 * Parse `/proc/mounts`-shaped content and return the longest mount-point prefix
 * covering `path`. `mountsContent` is injectable for testing; in production the
 * caller passes the real file (or null off-Linux -> "n/a").
 */
export function detectFsType(path: string, mountsContent: string | null): FsTypeInfo {
  const isMntDrive = /^\/mnt\/[a-z]\//i.test(path) || /^\/mnt\/[a-z]$/i.test(path);
  if (!mountsContent) {
    return { fstype: "n/a", mount: "", isDrvfs: false, isMntDrive };
  }
  let best: { mount: string; fstype: string } | null = null;
  for (const line of mountsContent.split("\n")) {
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const mount = parts[1]!;
    const fstype = parts[2]!;
    if (path === mount || path.startsWith(mount.endsWith("/") ? mount : `${mount}/`) || mount === "/") {
      if (!best || mount.length > best.mount.length) best = { mount, fstype };
    }
  }
  const fstype = best?.fstype ?? "unknown";
  return {
    fstype,
    mount: best?.mount ?? "",
    isDrvfs: fstype === "drvfs" || fstype === "9p",
    isMntDrive,
  };
}

function readMounts(): string | null {
  try {
    return process.platform === "linux" ? readFileSync("/proc/mounts", "utf-8") : null;
  } catch {
    return null;
  }
}

export type WslDualInstallDiagnostic = {
  wsl: boolean;
  automountRoot: string;
  effectiveCodexHome: string;
  effectiveIsWindowsMount: boolean;
  linuxCodexConfigured: boolean;
  windowsCodexHomes: string[];
  dualInstall: boolean;
  interopCodexOnPath: string | null;
};

type WslDualInstallDeps = CodexHomeDeps & {
  pathValue?: string;
  effectiveCodexHome?: string;
};

/**
 * WSL + Windows dual-install visibility: which `.codex` home each side owns,
 * whether the effective home sits on a Windows mount, and whether the `codex`
 * on PATH is actually the Windows launcher reached through drive interop.
 * Read-only; hints are printed by runDoctor, never applied.
 */
export function collectWslDualInstall(deps: WslDualInstallDeps = {}): WslDualInstallDiagnostic {
  const wsl = isWslRuntime(deps);
  const effectiveCodexHome = deps.effectiveCodexHome ?? resolveCodexHomeDirImpl(deps);
  if (!wsl) {
    return {
      wsl: false,
      automountRoot: "/mnt",
      effectiveCodexHome,
      effectiveIsWindowsMount: false,
      linuxCodexConfigured: false,
      windowsCodexHomes: [],
      dualInstall: false,
      interopCodexOnPath: null,
    };
  }
  const automountRoot = wslAutomountRoot(deps);
  const exists = deps.existsSync ?? existsSync;
  const home = (deps.homedir ?? homedir)();
  const linuxCodexConfigured = !!home && exists(join(home, ".codex", "config.toml"));
  const windowsCodexHomes = listWslWindowsCodexHomes(deps);
  const onPath = findCodexOnPath({
    pathValue: deps.pathValue ?? process.env.PATH,
    wsl: false, // scan everything; classify interop ourselves
    posixPaths: true, // WSL PATH entries are POSIX regardless of the host running doctor
    automountRoot,
    // When a fake fs is injected (tests), the real lstat/readFile would miss its
    // synthetic paths; treat every injected hit as a plain non-shim file.
    ...(deps.existsSync ? { exists: deps.existsSync, isShimFile: () => false, isDirectory: () => false } : {}),
  });
  const interopCodexOnPath = onPath && isWindowsInteropDir(onPath, automountRoot) ? onPath : null;
  return {
    wsl,
    automountRoot,
    effectiveCodexHome,
    effectiveIsWindowsMount: isWindowsInteropDir(effectiveCodexHome, automountRoot),
    linuxCodexConfigured,
    windowsCodexHomes,
    dualInstall: linuxCodexConfigured && windowsCodexHomes.length > 0,
    interopCodexOnPath,
  };
}

export type ProxyEnvRow = { key: string; present: boolean };
export type EnvMap = Record<string, string | undefined>;

function ownEnvValue(env: EnvMap, name: string): string | undefined {
  return Object.hasOwn(env, name) ? env[name] : undefined;
}

/** Report only presence/absence of proxy env vars - never the value (it may
 * embed credentials). Checks both upper- and lower-case forms. */
export function collectProxyEnv(env: EnvMap = process.env): ProxyEnvRow[] {
  return PROXY_ENV_KEYS.map(key => ({
    key,
    present: proxyEnvPresent(key, env),
  }));
}

export type ConfiguredProxyDiagnostic = {
  key: "config.proxy";
  present: boolean;
  configured: boolean;
  source: "default" | "file" | "fallback";
  detail: string;
};

export function envReferenceName(value: string): string | null {
  const braced = value.match(/^\$\{(\w+)\}$/);
  if (braced) return braced[1]!;
  const bare = value.match(/^\$(\w+)$/);
  return bare ? bare[1]! : null;
}

export type ProviderApiKeyDiagnostic = {
  provider: string;
  envName: string;
  detail: string;
};

/** Warn when a key-auth provider's apiKey env reference resolves empty in this process. */
export function collectProviderApiKeyDiagnostics(
  providers: Record<string, { authMode?: string; apiKey?: string }> = readConfigDiagnostics().config.providers ?? {},
  env: EnvMap = process.env,
): ProviderApiKeyDiagnostic[] {
  const rows: ProviderApiKeyDiagnostic[] = [];
  for (const [provider, config] of Object.entries(providers)) {
    if (config.authMode !== "key") continue;
    const raw = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
    if (!raw) continue;
    const envName = envReferenceName(raw);
    if (!envName) continue;
    const resolved = ownEnvValue(env, envName);
    if (resolved?.trim()) continue;
    rows.push({
      provider,
      envName,
      detail: `provider ${provider}: env reference ${envName} is unset or empty in this process`,
    });
  }
  return rows;
}

export type CodexEnvKeyReadinessDiagnostic = {
  envName: string;
  shimState: "missing" | "unhealthy";
  detail: string;
  action: string;
};

/** Warn when routed Codex cannot obtain its configured admission token at launch. */
export function collectCodexEnvKeyReadiness(
  configText: string | null,
  env: EnvMap,
  shim: CodexShimDiagnostic,
  serviceTokenPresent: boolean,
): CodexEnvKeyReadinessDiagnostic | null {
  if (!configText || rootTomlString(configText, "model_provider") !== "opencodex") return null;
  const envName = providerTableString(configText, "opencodex", "env_key")?.trim();
  const envValue = envName ? ownEnvValue(env, envName) : undefined;
  if (!envName || envValue?.trim() || shim.healthy || !serviceTokenPresent) return null;
  const shimState = shim.installed ? "unhealthy" : "missing";
  return {
    envName,
    shimState,
    detail: `Codex uses env_key ${envName}, but that variable is unset and the OpenCodex shim is ${shimState}; the service token file exists but plain Codex does not load it`,
    action: `Run 'ocx codex-shim install' to repair launch-time token injection, or export ${envName} in the process that starts Codex`,
  };
}

export function collectConfiguredProxy(): ConfiguredProxyDiagnostic {
  const diagnostics = readConfigDiagnostics();
  const rawProxy = typeof diagnostics.config.proxy === "string" ? diagnostics.config.proxy.trim() : "";
  if (diagnostics.error) {
    return {
      key: "config.proxy",
      present: false,
      configured: false,
      source: diagnostics.source,
      detail: `config unreadable (${diagnostics.error})`,
    };
  }
  if (!rawProxy) {
    return {
      key: "config.proxy",
      present: false,
      configured: false,
      source: diagnostics.source,
      detail: "not configured",
    };
  }

  const envName = envReferenceName(rawProxy);
  const resolved = rawProxy.startsWith("$")
    ? ownEnvValue(process.env, envName ?? rawProxy.slice(1))
    : rawProxy;
  if (resolved?.trim()) {
    return {
      key: "config.proxy",
      present: true,
      configured: true,
      source: diagnostics.source,
      detail: envName ? `env reference ${envName} resolved` : "value hidden",
    };
  }

  return {
    key: "config.proxy",
    present: false,
    configured: true,
    source: diagnostics.source,
    detail: envName ? `env reference ${envName} is unset` : "empty after resolution",
  };
}

export function parseProcessEnvBlock(content: string): EnvMap {
  const env: EnvMap = Object.create(null);
  for (const entry of content.split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return env;
}

export type RunningProxyEnvDiagnostic =
  | { status: "not_running"; rows: ProxyEnvRow[] }
  | { status: "ok"; pid: number; rows: ProxyEnvRow[] }
  | { status: "unavailable"; pid: number; reason: string; rows: ProxyEnvRow[] };

type RunningProxyEnvDeps = {
  readPidFn?: () => number | null;
  readEnvironFn?: (pid: number) => string | null;
  platform?: NodeJS.Platform | string;
};

function readProcessEnviron(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf-8");
  } catch {
    return null;
  }
}

/*
 * [Decision Log]
 * - Purpose: Make `ocx doctor` distinguish the current shell env from the already-running proxy process env.
 * - Alternatives: Rename the old section only; parse service-manager env for each OS; read the recorded proxy PID's env presence.
 * - Rationale: PID env presence is the narrowest useful diagnostic on Linux/WSL, avoids secret value output, and keeps unsupported platforms explicit.
 */
export function collectRunningProxyEnv(deps: RunningProxyEnvDeps = {}): RunningProxyEnvDiagnostic {
  const rowsWhenEmpty = () => collectProxyEnv({});
  const pid = (deps.readPidFn ?? readPid)();
  if (!pid) return { status: "not_running", rows: rowsWhenEmpty() };

  const platform = deps.platform ?? process.platform;
  if (platform !== "linux" && !deps.readEnvironFn) {
    return {
      status: "unavailable",
      pid,
      reason: "process env inspection is only supported on Linux",
      rows: rowsWhenEmpty(),
    };
  }

  const content = (deps.readEnvironFn ?? readProcessEnviron)(pid);
  if (content === null) {
    return {
      status: "unavailable",
      pid,
      reason: "could not read process environment",
      rows: rowsWhenEmpty(),
    };
  }

  return {
    status: "ok",
    pid,
    rows: collectProxyEnv(parseProcessEnvBlock(content)),
  };
}

export type WhamProbeResult = {
  ok: boolean;
  status: number | null;
  durationMs: number;
  classification: "ok" | "timeout" | "connect_error" | string;
  authenticated: boolean;
};

type NativeMainDoctorClaim = <T>(operation: () => Promise<T>) => Promise<T>;

export interface WhamProbeDeps {
  withNativeMainClaim?: NativeMainDoctorClaim;
  probeNativeMainRecoveryState?: typeof probeNativeProfileRecoveryState;
}

/**
 * Replicate the runtime WHAM fetch shape (same URL, 8s timeout, main-token
 * headers when present) so the probe fails exactly where the real path fails.
 * `fetchImpl` is injectable for testing.
 */
export async function probeWham(
  fetchImpl: typeof fetch = fetch,
  deps: WhamProbeDeps = {},
): Promise<WhamProbeResult> {
  const start = performance.now();
  let authenticated = false;
  try {
    const context = resolveNativeProfileContext();
    const withClaim = deps.withNativeMainClaim
      ?? (<T>(operation: () => Promise<T>) => withNativeMainSharedClaim(context, operation));
    return await withClaim(async () => {
      const recoveryState = (deps.probeNativeMainRecoveryState ?? probeNativeProfileRecoveryState)(context);
      if (recoveryState !== "none") {
        return {
          ok: false,
          status: null,
          durationMs: Math.round(performance.now() - start),
          classification: `native_main_recovery_${recoveryState}`,
          authenticated: false,
        };
      }
      const tokens = readCodexTokens();
      const headers: Record<string, string> = {};
      if (tokens) {
        headers.Authorization = `Bearer ${tokens.access_token}`;
        headers["ChatGPT-Account-Id"] = tokens.account_id;
      }
      authenticated = !!tokens;
      const resp = await fetchImpl(WHAM_USAGE_URL, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const durationMs = Math.round(performance.now() - start);
      return {
        ok: resp.ok,
        status: resp.status,
        durationMs,
        classification: resp.ok ? "ok" : `http_${resp.status}`,
        authenticated,
      };
    });
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    if (
      err instanceof NativeProfileError
      && (err.code === "NATIVE_MAIN_CLAIM_BUSY" || err.code === "NATIVE_MAIN_CLAIM_UNAVAILABLE")
    ) {
      return {
        ok: false,
        status: null,
        durationMs,
        classification: err.code.toLowerCase(),
        authenticated: false,
      };
    }
    const name = err instanceof Error ? err.name : String(err);
    const classification = name === "TimeoutError" || name === "AbortError"
      ? "timeout"
      : "connect_error";
    return { ok: false, status: null, durationMs, classification, authenticated };
  }
}

/**
 * Service-process memory/runtime introspection (#314 WP4).
 *
 * Doctor runs in its OWN Bun process; the only honest source for the SERVICE
 * process identity (Bun version, RSS, stream-mode gate decision) is the
 * authed management endpoint added in WP3. Observe-only: failures render as
 * honest status lines, never as fake data, and never fail the command.
 */
export type ServiceMemoryData = {
  pid: number;
  bunVersion: string;
  /** Launch-time provenance; absent for services installed before the marker existed. */
  bunRuntimeSource?: BunRuntimeSource;
  platform: string;
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  observedBytes?: number;
  observedMetric?: MemoryMetric;
  jscHeap: { heapSize: number } | null;
  streamMode: string;
  eagerRelay: { useEagerRelay: boolean; reason: string } | null;
  watchdog: { warnThresholdBytes: number; lastWarnAt: number | null; observedBytes?: number; observedMetric?: MemoryMetric } | null;
};

export type ServiceMemoryReport =
  | { status: "ok"; data: ServiceMemoryData }
  | { status: "unauthorized" }
  | { status: "unreachable"; error: string };

const SERVICE_MEMORY_TIMEOUT_MS = 2000;
const DEFAULT_MEMORY_THRESHOLD_BYTES = 4 * 1024 ** 3;
type MemoryMetric = "rss" | "external" | "arrayBuffers";

function observedMemory(data: { rss: number; external?: number; arrayBuffers?: number }): {
  bytes: number;
  metric: MemoryMetric;
} {
  const values: Array<{ metric: MemoryMetric; bytes: number }> = [
    { metric: "rss", bytes: data.rss },
    { metric: "external", bytes: data.external ?? 0 },
    { metric: "arrayBuffers", bytes: data.arrayBuffers ?? 0 },
  ];
  return values.reduce((best, next) => next.bytes > best.bytes ? next : best, values[0]);
}

export async function fetchServiceMemory(
  target: LiveProxy,
  deps: LocalManagementReadDeps = {},
): Promise<ServiceMemoryReport> {
  try {
    const read = await fetchBoundLocalManagementRead(target, LOCAL_MANAGEMENT_READ_PATHS.systemMemory, {
      ...deps,
      timeoutMs: SERVICE_MEMORY_TIMEOUT_MS,
    });
    if (read.kind === "unavailable") {
      return read.reason === "transport"
        ? { status: "unreachable", error: "fetch failed" }
        : { status: "unauthorized" };
    }
    const { response: res, targetPid } = read;
    if (res.status === 401 || res.status === 403) return { status: "unauthorized" };
    if (!res.ok) return { status: "unreachable", error: `http ${res.status}` };
    const body = await res.json() as Partial<ServiceMemoryData>;
    if (
      body.pid !== targetPid
      || typeof body.bunVersion !== "string"
      || typeof body.rss !== "number"
    ) {
      return { status: "unreachable", error: "malformed response" };
    }
    return {
      status: "ok",
      data: {
        pid: body.pid,
        bunVersion: body.bunVersion,
        // Allowlisted independently of the server: an unrecognized wire value is
        // treated as absent rather than echoed into user-facing guidance.
        bunRuntimeSource: BUN_RUNTIME_SOURCES.find(source => source === body.bunRuntimeSource),
        platform: typeof body.platform === "string" ? body.platform : "unknown",
        rss: body.rss,
        heapUsed: typeof body.heapUsed === "number" ? body.heapUsed : 0,
        external: typeof body.external === "number" ? body.external : 0,
        arrayBuffers: typeof body.arrayBuffers === "number" ? body.arrayBuffers : 0,
        observedBytes: typeof body.observedBytes === "number" ? body.observedBytes : undefined,
        observedMetric: body.observedMetric === "rss" || body.observedMetric === "external" || body.observedMetric === "arrayBuffers"
          ? body.observedMetric
          : undefined,
        jscHeap: body.jscHeap && typeof body.jscHeap.heapSize === "number" ? { heapSize: body.jscHeap.heapSize } : null,
        streamMode: typeof body.streamMode === "string" ? body.streamMode : "auto",
        eagerRelay: body.eagerRelay && typeof body.eagerRelay.reason === "string"
          ? { useEagerRelay: body.eagerRelay.useEagerRelay === true, reason: body.eagerRelay.reason }
          : null,
        watchdog: body.watchdog && typeof body.watchdog.warnThresholdBytes === "number"
          ? {
            warnThresholdBytes: body.watchdog.warnThresholdBytes,
            lastWarnAt: body.watchdog.lastWarnAt ?? null,
            observedBytes: typeof body.watchdog.observedBytes === "number" ? body.watchdog.observedBytes : undefined,
            observedMetric: body.watchdog.observedMetric === "rss" || body.watchdog.observedMetric === "external" || body.watchdog.observedMetric === "arrayBuffers"
              ? body.watchdog.observedMetric
              : undefined,
          }
          : null,
      },
    };
  } catch (err) {
    return { status: "unreachable", error: err instanceof Error ? err.name : "fetch failed" };
  }
}

const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))}MB`;

export const RECLAIM_RESPONSE_TEMPS_FLAG = "--reclaim-response-temps";
export const RECOVER_ZERO_BYTE_COORDINATOR_FLAG = "--recover-zero-byte-coordinator";
/** Matches the dry run's entry bound so report and reclaim agree on a large backlog. */
const RESPONSE_TEMP_RECLAIM_MAX_CLEANUPS = 4_096;
/** Names the subsystem: other components mint temps with the same shape and are not covered. */
const CLEAN_RESPONSE_TEMP_LINE = "  ok  No abandoned response-state temp files.";

/**
 * Render the abandoned-temp section (testable without console capture).
 *
 * Report is the DEFAULT and reclaim is opt-in: `doctor` is a diagnostic an operator runs
 * to understand a machine, so deleting files as a side effect of asking a question is the
 * wrong default even for cache files.
 *
 * Counts come from `eligible`/`eligibleBytes`, never `matched`: `matched` is incremented
 * before the file-type, age, boot-floor, and liveness gates, so reporting it would tell an
 * operator that live-pid temps and young temps are "abandoned".
 */
export function formatResponseTempLines(
  result: ResponseStateTempRecoveryResult,
  reclaimed: boolean,
): string[] {
  if (reclaimed) {
    if (result.removed === 0 && result.failed === 0) return [CLEAN_RESPONSE_TEMP_LINE];
    const lines = [`  ok  Reclaimed ${result.removed} abandoned response-state temp file(s), ${mb(result.bytesRemoved)} freed.`];
    if (result.failed > 0) {
      // Never "retried automatically": this command exists for the operator whose proxy will
      // NOT start, and in that state nothing retries anything.
      lines.push(`  !!  ${result.failed} file(s) could not be removed (in use or locked). Retried on the next reclaim — automatically while the proxy runs, otherwise re-run this command.`);
    }
    // `truncated`, not `eligible > removed + failed`: outside a dry run every eligible entry
    // is unlinked or failed on the same iteration it is counted, so those two are always
    // equal and the comparison never fired. An operator with a backlog past the budget was
    // told the reclaim had finished.
    if (result.truncated) {
      lines.push("  !!  Cleanup budget reached; files remain. Run the command again to continue.");
    }
    return lines;
  }
  if (result.eligible === 0) return [CLEAN_RESPONSE_TEMP_LINE];
  const lines = [
    `  !!  ${result.eligible} abandoned response-state temp file(s), ${mb(result.eligibleBytes)} reclaimable.`,
    "      These are interrupted snapshot writes (continuation cache only) and are safe to remove.",
    "      Reclaim them with: ocx doctor --reclaim-response-temps",
  ];
  // The dry run skips the cleanup budget but is still bounded by the entry cap, so a large
  // enough backlog makes this a floor rather than a total. Say so instead of letting an
  // operator size the problem from a truncated count.
  if (result.truncated) lines.push("      Scan stopped at its entry budget; the real total is higher.");
  return lines;
}

export function formatCoordinatorDoctorLines(diagnostic: CodexCoordinatorDiagnostic): string[] {
  const pathLine = diagnostic.path ? [`       path: ${diagnostic.path}`] : [];
  const evidenceLines = "evidence" in diagnostic && diagnostic.evidence
    ? [
      `       size: ${diagnostic.evidence.sizeBytes} bytes; user_version: ${diagnostic.evidence.schemaVersion}`,
      `       tables: ${diagnostic.evidence.tables.length === 0 ? "none" : diagnostic.evidence.tables.join(", ")}`,
      `       transition rows: ${diagnostic.evidence.transitionRows ?? "not inspected"}; singleton=1 rows: ${diagnostic.evidence.singletonRows ?? "not inspected"}`,
    ]
    : [];
  switch (diagnostic.kind) {
    case "absent":
      return ["  ok     native-write coordinator not created yet", ...pathLine];
    case "ready":
      return ["  ok     native-write coordinator has an authoritative transition row", ...pathLine, ...evidenceLines];
    case "zero-byte":
      return [
        "  !!     native-write coordinator is a zero-byte remnant and has no authority",
        ...pathLine,
        ...evidenceLines,
        `       Action: stop the OpenCodex proxy/service, then run ocx doctor ${RECOVER_ZERO_BYTE_COORDINATOR_FLAG} --yes`,
      ];
    case "unversioned-empty":
      return [
        "  !!     native-write coordinator is a non-empty unversioned database; automatic recovery is refused",
        ...pathLine,
        ...evidenceLines,
      ];
    case "rowless":
      return [
        "  !!     native-write coordinator has schema version 1 but no authoritative row; automatic recovery is refused",
        ...pathLine,
        ...evidenceLines,
      ];
    case "unversioned-nonempty":
      return [
        "  !!     native-write coordinator is unversioned and contains unknown tables; automatic recovery is refused",
        ...pathLine,
        ...evidenceLines,
      ];
    case "unsupported":
      return [
        `  !!     native-write coordinator schema version ${diagnostic.version} is unsupported; automatic recovery is refused`,
        ...pathLine,
        ...evidenceLines,
      ];
    case "changed":
      return ["  --     native-write coordinator changed during diagnosis; re-run ocx doctor", ...pathLine];
    case "unsafe":
      return [`  !!     native-write coordinator path is unsafe: ${diagnostic.reason}`, ...pathLine];
    case "unreadable":
      return [`  !!     native-write coordinator is unreadable: ${diagnostic.reason}`, ...pathLine, ...evidenceLines];
  }
}

/** Render the doctor "Memory / runtime" section lines (testable without console capture). */
export function formatServiceMemoryLines(report: ServiceMemoryReport): string[] {
  const lines: string[] = [];
  lines.push(`  --     doctor process Bun ${Bun.version} (this is NOT the service process)`);
  if (report.status === "unauthorized") {
    lines.push("  --     local diagnostic capability unavailable — restart the running proxy with this OpenCodex version");
    return lines;
  }
  if (report.status === "unreachable") {
    lines.push(`  --     proxy not reachable (not running?) [${report.error}]`);
    return lines;
  }
  const d = report.data;
  lines.push(`  ok     service pid ${d.pid}: Bun ${d.bunVersion} on ${d.platform}`);
  const observed = observedMemory(d);
  const observedBytes = d.observedBytes ?? d.watchdog?.observedBytes ?? observed.bytes;
  const observedMetric = d.observedMetric ?? d.watchdog?.observedMetric ?? observed.metric;
  lines.push(`         rss=${mb(d.rss)}, external=${mb(d.external)}, arrayBuffers=${mb(d.arrayBuffers)}, heapUsed=${mb(d.heapUsed)}${d.jscHeap ? `, jscHeap=${mb(d.jscHeap.heapSize)}` : ""}`);
  lines.push(`         observed=${mb(observedBytes)} (${observedMetric})`);
  lines.push(`         streamMode=${d.streamMode}${d.eagerRelay ? ` (eager relay: ${d.eagerRelay.useEagerRelay ? "on" : "off"}, ${d.eagerRelay.reason})` : ""}`);
  if (d.watchdog) {
    lines.push(`         watchdog threshold=${mb(d.watchdog.warnThresholdBytes)}${d.watchdog.lastWarnAt ? `, last warn ${new Date(d.watchdog.lastWarnAt).toISOString()}` : ", no warnings"}`);
  }
  // Interpretation rule: reuse the watchdog threshold and the same max-of
  // observed memory counters, so doctor and watchdog never disagree about
  // "high". RSS/working-set can under-report committed retention on Windows, and
  // Bun 1.3.14 heap counters are not standalone leak proof.
  const threshold = d.watchdog?.warnThresholdBytes ?? DEFAULT_MEMORY_THRESHOLD_BYTES;
  const jsShare = d.rss > 0 ? Math.max(d.heapUsed, d.jscHeap?.heapSize ?? 0) / d.rss : 0;
  if (observedBytes < threshold) {
    lines.push("         memory usage looks normal");
  } else if (observedMetric !== "rss") {
    lines.push(`  !!     high observed memory via ${observedMetric}; Windows RSS/working-set counters may be blind. See docs: troubleshooting/windows-memory`);
  } else if (jsShare < 0.25) {
    lines.push("  !!     high RSS with a small JS heap — native-side growth (Bun runtime buffers/handles). See docs: troubleshooting/windows-memory");
  } else if (jsShare >= 0.5) {
    lines.push("  !!     high RSS with large JS/JSC counters — possible JS-side retention; compare responseState/external samples before filing an app leak");
  } else {
    lines.push("  !!     high RSS, indeterminate split — capture two doctor runs over time to see the trend");
  }
  if (d.platform === "win32" && d.eagerRelay?.reason === "auto-known-bad") {
    lines.push(`         service is running Bun ${d.bunVersion} on Windows — a version affected by the upstream Bun memory issue.`);
    // The remediation depends on how the SERVICE was launched, which only the
    // launch-time marker can answer. Telling someone to set OPENCODEX_BUN_PATH
    // when it is already set is the bug this branch exists to avoid (#848).
    if (d.bunRuntimeSource === "override") {
      lines.push(`         OPENCODEX_BUN_PATH is already active for this service — the override runtime is itself an affected version (unvalidated — own risk).`);
      lines.push("         Options: point the override at a different runtime, or opt into streamMode \"eager-relay\" via PUT /api/settings (crash risk on this runtime; see docs).");
    } else if (d.bunRuntimeSource === undefined) {
      lines.push("         this service records no runtime origin (installed before provenance tracking), so OpenCodex cannot tell whether an override is already active.");
      lines.push("         Reinstall the service to record it, or opt into streamMode \"eager-relay\" via PUT /api/settings (crash risk on this runtime; see docs).");
    } else {
      const origin = d.bunRuntimeSource === "process" ? "the runtime that launched it" : "the bundled runtime";
      lines.push(`         the service is using ${origin}. Options: wait for a bundled runtime update, or set OPENCODEX_BUN_PATH to a runtime you trust (unvalidated — own risk),`);
      lines.push("         or opt into streamMode \"eager-relay\" via PUT /api/settings (crash risk on this runtime; see docs).");
    }
  }
  return lines;
}

/**
 * Actionable hint for the most common confusion: Codex/Claude clients fail with raw
 * connection errors (e.g. "error sending request for url (http://127.0.0.1:10100/...)")
 * when the proxy is simply not running. Returns null when a live proxy was found.
 */
export function proxyDownRestartHint(input: {
  proxyRunning: boolean;
  port: number;
  serviceViable: boolean;
  /** Absent means "unknown"; the hint then keeps its pre-repair wording. */
  serviceInstalled?: boolean;
  serviceConflict?: boolean;
  /**
   * Persisted owner records outlived their process (#1419). Cause-neutral: what is on
   * disk proves an unclean exit, not which signal caused it.
   */
  staleProcessState?: boolean;
}): string | null {
  if (input.proxyRunning) return null;
  // `serviceViable` alone conflates "no service at all" with "registered but stale or
  // stopped". Only the first wants `install`: re-registering an existing service costs a
  // UAC prompt on Windows and can switch a WinSW backend to Task Scheduler. A conflict
  // still needs uninstall-then-install, which repairService() refuses outright.
  const installedButBroken = input.serviceInstalled === true && input.serviceConflict !== true;
  const restart = input.serviceViable
    ? "Restart it with 'ocx service start' (service installed) or 'ocx start'."
    : installedButBroken
      ? "Restart it with 'ocx start', or refresh the installed service: 'ocx service repair'."
      : "Restart it with 'ocx start', or install the persistent service: 'ocx service install'.";
  const uncleanExit = input.staleProcessState === true
    ? "Stale process records remain, so the previous run may have exited unexpectedly. "
    : "";
  return `The ocx proxy is not running. ${uncleanExit}Codex/Claude clients pinned to 127.0.0.1:${input.port} fail with errors like "error sending request for url (http://127.0.0.1:${input.port}/v1/responses)". ${restart}`;
}

export async function runDoctor(args: string[] = []): Promise<void> {
  if (args.includes("--fix-codex-runtime")) {
    const resolved = resolveCodexRuntime();
    if (!resolved.newerAvailable) {
      console.log("No newer Codex runtime found; keeping current selection.");
      const current = resolveAndPersistCodexRuntime();
      console.log(`Selected: ${displayCodexRuntimePath(current.runtime.command)} (${current.runtime.version ?? "unknown"})`);
      return;
    }
    if (resolved.runtime.source === "environment") {
      console.log("CODEX_CLI_PATH currently overrides configured runtimes.");
      console.log(`Unset or update CODEX_CLI_PATH to use ${displayCodexRuntimePath(resolved.newerAvailable.command)} (${resolved.newerAvailable.version ?? "unknown"}).`);
      console.log("Then run ocx sync.");
      return;
    }
    persistCodexRuntime({
      command: resolved.newerAvailable.command,
      version: resolved.newerAvailable.version,
      source: "configured",
    });
    console.log(`Updated Codex runtime to ${displayCodexRuntimePath(resolved.newerAvailable.command)} (${resolved.newerAvailable.version ?? "unknown"}).`);
    console.log("Run ocx sync to refresh the catalog against this runtime.");
    return;
  }

  if (args.includes(RECOVER_ZERO_BYTE_COORDINATOR_FLAG)) {
    if (!args.includes("--yes")) {
      console.log(`Recovery is explicit and creates a same-directory backup. Re-run: ocx doctor ${RECOVER_ZERO_BYTE_COORDINATOR_FLAG} --yes`);
      process.exitCode = 1;
      return;
    }
    const diagnostics = readConfigDiagnostics().config;
    const live = await findLiveProxy({
      configFn: () => ({ port: diagnostics.port, hostname: diagnostics.hostname }),
    });
    if (live) {
      console.log(`Recovery refused: OpenCodex proxy pid ${live.pid} is still running. Stop the proxy/service and retry.`);
      process.exitCode = 1;
      return;
    }
    const recovered = recoverZeroByteCodexCoordinator();
    if (!recovered.ok) {
      console.log(`Recovery refused: ${recovered.reason}.`);
      process.exitCode = 1;
      return;
    }
    console.log(`Moved the non-authoritative coordinator to ${recovered.backupPath}`);
    console.log("Run `ocx sync` to retry Codex config injection. The backup was preserved and no Codex config/catalog file was changed by recovery.");
    process.exitCode = 0;
    return;
  }

  console.log("opencodex doctor\n");
  // Reset per pass: the suite drives runDoctor several times in one process, and a sticky
  // flag would fail the second call because the first saw a problem.
  doctorSawFailure = false;

  // Ordering note: the memory/runtime section renders after "Running proxy
  // process proxy env" below; helpers live above runDoctor for testability.

  const paths = collectPaths();
  const mounts = readMounts();
  console.log("Paths");
  for (const row of paths) {
    const fs = detectFsType(row.path, mounts);
    const flags = [fs.fstype !== "n/a" ? `fs=${fs.fstype}` : null, fs.isDrvfs || fs.isMntDrive ? "WSL /mnt drive" : null]
      .filter(Boolean).join(", ");
    console.log(`  ${row.exists ? "ok " : "-- "} ${row.label}: ${row.path}${flags ? `  (${flags})` : ""}`);
  }

  // Runs without the proxy on purpose: the worst accumulation happens when the proxy will
  // not start, which is exactly when the in-process periodic reclaim never ticks.
  const reclaimTemps = args.includes(RECLAIM_RESPONSE_TEMPS_FLAG);
  console.log("\nResponse-state temp files");
  // A typo must not silently degrade into "nothing to reclaim" — the operator would read the
  // report as an answer to a question they never actually asked.
  for (const arg of args) {
    if (arg !== RECLAIM_RESPONSE_TEMPS_FLAG && /^--reclaim/.test(arg)) {
      console.log(`  !!  Unrecognized flag ${arg}; did you mean ${RECLAIM_RESPONSE_TEMPS_FLAG}? Reporting only.`);
    }
  }
  for (const line of formatResponseTempLines(
    // The reclaim budget matches the report budget: a report bounded by entries and a removal
    // bounded by a smaller cleanup cap would tell an operator 816 and then silently free 512.
    reclaimTemps
      ? reclaimAbandonedResponseStateTemps({ maxCleanups: RESPONSE_TEMP_RECLAIM_MAX_CLEANUPS })
      : inspectAbandonedResponseStateTemps(),
    reclaimTemps,
  )) console.log(line);

  const orcaHome = collectOrcaCodexHomeDiagnostic();
  console.log("\nCodex app home targeting");
  console.log(`  ${orcaHome.mismatch ? "!! " : "ok "} Effective Codex home: ${orcaHome.effectiveCodexHome}`);
  if (orcaHome.mismatch) {
    console.log(`  !!  ${orcaHome.warning}`);
    console.log(`      Action: ${orcaHome.action}`);
  } else {
    console.log("      No Orca-owned CODEX_HOME mismatch detected.");
  }

  const doctorConfig = readConfigDiagnostics().config;
  const codexConfigPath = join(resolveCodexHomeDirImpl(), "config.toml");
  const codexConfigText = (() => {
    try { return readFileSync(codexConfigPath, "utf8"); } catch { return null; }
  })();
  const serviceTokenPresent = Boolean(readInstalledServiceToken()?.trim());
  const codexEnvKeyReadiness = collectCodexEnvKeyReadiness(
    codexConfigText,
    process.env,
    diagnoseCodexShim(),
    serviceTokenPresent,
  );
  const startup = collectStartupHealth(doctorConfig);
  console.log("\nCodex restart safety");
  console.log(`  ${startup.rebootSafe ? "ok " : "!! "} ${startupHealthSummary(startup)}`);
  console.log(`       ${formatStartupRoutingDetail(startup)}`);

  console.log("\nCodex runtime selection");
  {
    const resolved = resolveCodexRuntime();
    const selected = resolved.runtime;
    console.log(`  ok  Selected runtime: ${displayCodexRuntimePath(selected.command)} (${selected.version ?? "unknown"}, source=${selected.source})`);
    const envFailures = resolved.failures.filter(item => item.source === "environment");
    for (const failure of envFailures) {
      console.log(`  !!  Invalid CODEX_CLI_PATH: ${failure.reason}`);
    }
    const shimFailures = resolved.failures.filter(item => item.source === "shim");
    if (shimFailures.length > 0) {
      console.log(`  !!  Stale shim target rejected (${shimFailures.length})`);
    }
    if (resolved.replacedConfigured) {
      console.log(`  !!  Preferred runtime unavailable; fell back to ${displayCodexRuntimePath(selected.command)}`);
    }
    if (resolved.newerAvailable) {
      console.log(`  !!  Multiple Codex installations found.`);
      console.log(`  ok  Newer usable runtime found: ${displayCodexRuntimePath(resolved.newerAvailable.command)} (${resolved.newerAvailable.version ?? "unknown"})`);
      console.log("       Suggested: set CODEX_CLI_PATH to the desired binary and run ocx sync.");
      console.log("       Optional: ocx doctor --fix-codex-runtime");
    }
    const lastClamp = loadLastEffortClamp();
    if (lastClamp && lastClamp.removedEfforts.length > 0) {
      console.log(`  !!  ${lastClamp.removedEfforts.join(" and ")} were removed during catalog sync.`);
      console.log("       Suggested: set CODEX_CLI_PATH to a newer Codex binary and run ocx sync.");
    }
  }

  // #618: identity-verified liveness first so pid-file absence does not hide a live service.
  // Reuse the diagnostics config already loaded above so doctor stays read-only on malformed JSON.
  const live = await findLiveProxy({
    configFn: () => ({ port: doctorConfig.port, hostname: doctorConfig.hostname }),
  });

  // Mirrors `ocx status` through the same comparison rather than a second implementation:
  // two diagnostics disagreeing about whether an install is stale is worse than one (#2701).
  // No extra probe -- findLiveProxy already carried the version back.
  {
    const { packageVersion } = await import("./help");
    const { computeVersionSkew } = await import("./version-skew");
    const skew = computeVersionSkew(packageVersion(), live?.version);
    if (skew.skewed && skew.warning) {
      console.log(`!! ${skew.warning}`);
    } else if (skew.proxyVersion !== null) {
      console.log(`ok ocx ${skew.cliVersion} matches the running proxy`);
    }
  }

  const currentProxyEnv = collectProxyEnv();
  const configuredProxy = collectConfiguredProxy();
  const runningProxyEnv = collectRunningProxyEnv({
    readPidFn: () => (live ? live.pid : readPid()),
  });

  console.log("\nCurrent doctor process proxy env (presence only)");
  for (const row of currentProxyEnv) {
    console.log(`  ${row.present ? "set    " : "unset  "} ${row.key}`);
  }

  console.log("\nConfigured proxy (value hidden)");
  console.log(`  ${configuredProxy.present ? "set    " : "unset  "} ${configuredProxy.key} (${configuredProxy.source}; ${configuredProxy.detail})`);

  const providerApiKeys = collectProviderApiKeyDiagnostics(doctorConfig.providers);
  console.log("\nProvider API keys (value hidden)");
  if (providerApiKeys.length === 0) {
    console.log("  ok     no empty env-referenced provider keys detected in this process");
  } else {
    for (const row of providerApiKeys) {
      console.log(`  !!     ${row.detail}`);
    }
  }

  console.log("\nCodex env_key launch readiness");
  if (codexEnvKeyReadiness) {
    console.log(`  !!     ${codexEnvKeyReadiness.detail}`);
    console.log(`         Action: ${codexEnvKeyReadiness.action}`);
  } else {
    console.log("  ok     no broken OpenCodex env_key launch path detected");
  }

  console.log("\nRunning proxy process proxy env (presence only)");
  if (runningProxyEnv.status === "not_running") {
    console.log("  --     no running ocx proxy process found");
  } else if (runningProxyEnv.status === "unavailable") {
    console.log(`  --     pid ${runningProxyEnv.pid}: ${runningProxyEnv.reason}`);
  } else {
    console.log(`  ok     pid ${runningProxyEnv.pid}`);
    for (const row of runningProxyEnv.rows) {
      console.log(`  ${row.present ? "set    " : "unset  "} ${row.key}`);
    }
  }

  console.log("\nMemory / runtime");
  {
    if (!live) {
      console.log(`  --     doctor process Bun ${Bun.version} (this is NOT the service process)`);
      console.log("  --     no running ocx proxy found (no live pid/runtime record)");
    } else {
      const report = await fetchServiceMemory(live);
      for (const line of formatServiceMemoryLines(report)) console.log(line);
    }
  }

  console.log("\nWHAM reachability");
  const probe = await probeWham();
  const detail = probe.status !== null ? `status=${probe.status}` : `error=${probe.classification}`;
  console.log(`  ${probe.ok ? "ok " : "-- "} ${WHAM_USAGE_URL}`);
  console.log(`       ${detail}, ${probe.durationMs}ms, ${probe.authenticated ? "authenticated" : "unauthenticated"}`);

  // Design B upgrade visibility: only the backup manifest authorizes restoring provider
  // metadata. Bare routed rows have unknown provenance and remain unchanged. This read-only
  // probe reports manifest work and database readability; it never mutates.
  console.log("\nCodex history metadata restore");
  // The history failure messages point here; make the visit worthwhile by
  // probing the coordinator namespace the locks live in. The probe exercises
  // identity, runtime-root, and permission checks without taking any lock or
  // creating anything (a doctor run must observe, not initialize).
  try {
    const identity = resolveEffectiveUserIdentity();
    const probe = probeCodexCoordinatorNamespace(identity);
    if (probe.status === "missing") {
      console.log("  ok     history coordinator namespace not created yet (no history operation has run)");
    } else {
      console.log("  ok     history coordinator namespace resolves");
    }
  } catch (cause) {
    const reason = cause instanceof CodexUserIdentityRefusal ? cause.message : String(cause);
    console.log(`  --     history coordinator namespace refused: ${reason}`);
  }
  console.log("\nCodex native-write coordinator");
  for (const line of formatCoordinatorDoctorLines(inspectCodexCoordinator())) console.log(line);
  const pending = countPendingOpencodexHistory();
  if (pending.failed) {
    if (pending.failureReason === "busy") {
      console.log("  --     history database, backup manifest, or rollout file is busy — exact metadata restore is pending");
    } else if (pending.failureReason === "permission") {
      console.log("  --     state DB or backup manifest access was denied — restore state unknown");
    } else {
      console.log("  --     backup manifest or restore target failed integrity checks — manual review required");
    }
  } else if (pending.pendingRows === 0 && pending.backupEntries === 0) {
    console.log("  ok     no manifest-backed provider metadata pending; untracked routed history is unchanged");
  } else {
    console.log(`  --     ${pending.backupEntries} backup manifest entr${pending.backupEntries === 1 ? "y" : "ies"} pending exact metadata restore`);
  }

  console.log("\nProject Codex configs");
  const projectWarnings = collectProjectCodexConfigWarnings();
  if (projectWarnings.length === 0) {
    console.log("  ok     no project-local provider bypass detected");
  } else {
    for (const line of formatProjectCodexConfigWarningsForDoctor(projectWarnings)) {
      console.log(line);
    }
  }

  console.log("\nCodex agent role files");
  const tomlFallbackRoles = scanCodexAgentRolesWithTomlModelFallback(resolveCodexHomeDirImpl());
  if (tomlFallbackRoles.length === 0) {
    console.log("  ok     no per-role model_fallback fields in $CODEX_HOME/agents/*.toml");
  } else {
    console.log(`  [WARN] ${tomlFallbackRoles.length} agent role file${tomlFallbackRoles.length === 1 ? "" : "s"} contain${tomlFallbackRoles.length === 1 ? "s" : ""} \`model_fallback\`: ${tomlFallbackRoles.join(", ")}`);
    console.log("        Codex >= 0.146 rejects that field as unknown and skips the whole role. Move the chains to opencodex config `subagentModelFallbackByModel` (keyed by primary model) and remove the field from the TOML files.");
  }

  const dual = collectWslDualInstall();
  if (dual.wsl) {
    console.log("\nWSL Codex installs");
    console.log(`  ${dual.linuxCodexConfigured ? "ok " : "-- "} Linux ~/.codex/config.toml`);
    if (dual.windowsCodexHomes.length > 0) {
      for (const winHome of dual.windowsCodexHomes) console.log(`  ok  Windows ${winHome}`);
    } else {
      console.log("  --  no Windows-profile .codex detected under /mnt/c/Users");
    }
    console.log(`      effective CODEX_HOME: ${dual.effectiveCodexHome}${dual.effectiveIsWindowsMount ? " (Windows mount)" : ""}`);
    if (dual.interopCodexOnPath) {
      console.log(`  --  codex on PATH is the Windows launcher via interop: ${dual.interopCodexOnPath}`);
    }
  }

  // OAuth reliability: observe-only (no mutations / auto-repair).
  console.log("\nOAuth reliability");
  for (const check of await collectOAuthDoctorChecks()) {
    console.log(`  [${check.level}] ${check.message}`);
    // A diagnostic that always exits 0 cannot gate anything, which defeats the point of
    // running it from a script (#2697's sibling defect). FAIL is the level reserved for a
    // surface that is unusable rather than degraded, so it -- and only it -- fails the
    // command. WARN stays exit 0 on purpose: warning on a degraded-but-working install
    // must not break a pipeline that is legitimately green.
    if (check.level === "FAIL") recordDoctorFailure();
  }

  // #857: a running Codex app-server can keep an older in-memory catalog than
  // the one on disk — surface it outside sync time.
  const { collectCodexAppServerCatalogState } = await import("../codex/app-server-processes");
  const catalogState = collectCodexAppServerCatalogState();
  if (catalogState.state === "stale") {
    console.log(`  [WARN] Codex app-server (PID(s): ${catalogState.processes.map(p => p.pid).join(", ")}) started before the on-disk catalog changed; its in-memory model list disagrees with ocx. Action: restart Codex (or run \`ocx sync --restart-codex\`; on Windows the desktop app may need \`ocx sync --restart-desktop-app\`)`);
  } else if (catalogState.state === "unknown") {
    console.log("  [WARN] Could not verify whether the running Codex app-server's model catalog is current (start time or catalog unreadable). Action: if the model list looks stale, restart Codex");
  } else if (catalogState.state === "fresh") {
    console.log("  [OK] Codex app-server model catalog is current with the on-disk catalog.");
  }

  // Hints, not fixes.
  const hints: string[] = [];
  const proxyDown = proxyDownRestartHint({
    proxyRunning: Boolean(live),
    port: live?.port ?? doctorConfig.port ?? 10100,
    serviceViable: startup.serviceViable,
    serviceInstalled: startup.serviceInstalled,
    serviceConflict: startup.serviceConflict,
    // Threaded through the same decision helper `ocx status` uses, so the two
    // diagnostics cannot drift. A helper-only change would satisfy a unit test while
    // real `ocx doctor` output never mentioned the crash (#1419).
    staleProcessState: await probeUncleanExitState({
      live: Boolean(live),
      port: doctorConfig.port,
      hostname: doctorConfig.hostname,
    }),
  });
  if (proxyDown) hints.push(proxyDown);
  for (const row of providerApiKeys) {
    hints.push(`${row.detail}. Set ${row.envName} in the shell that starts the proxy, or store a literal key in config (value hidden here).`);
  }
  if (codexEnvKeyReadiness) hints.push(`${codexEnvKeyReadiness.detail}. ${codexEnvKeyReadiness.action}.`);
  const anyDrvfs = paths.some(p => detectFsType(p.path, mounts).isDrvfs || detectFsType(p.path, mounts).isMntDrive);
  const noProxy = currentProxyEnv.every(p => !p.present) && !configuredProxy.present;
  if (!startup.rebootSafe) {
    const command = startup.recommendedCommand ?? startup.commands.restoreNative;
    hints.push(`Codex is pinned to the local proxy without persistent startup protection. After restart, requests can reconnect indefinitely. Run '${command}'.`);
  }
  if (anyDrvfs) {
    hints.push("State dir is on a Windows-mounted (/mnt) drive. Prefer the Linux home (~) under WSL for token/lock reliability.");
  }
  if (!probe.ok) {
    if (probe.classification === "timeout" || probe.classification === "connect_error") {
      hints.push("WHAM probe could not reach chatgpt.com. On WSL2 this is often NAT/DNS/VPN. Quota cannot prime, so auto-switch stays on unknown scores.");
      if (noProxy) {
        hints.push("No proxy is visible to this doctor process and config.proxy is unset or unresolved. If Windows uses a proxy/VPN, set config.proxy or start ocx from a shell with HTTP(S)_PROXY.");
      }
    }
  }
  if (pending.failed && pending.failureReason === "busy") {
    hints.push("Backed-up history metadata is pending or its state is unreadable. The running proxy retries exact restoration automatically; to force it now, close the Codex app and run 'ocx sync'. Untracked routed history is not relabeled.");
  } else if (pending.failed && pending.failureReason === "permission") {
    hints.push("Backed-up history metadata could not be inspected because access was denied. Fix access to the reported Codex history paths, then run 'ocx sync'; repeated retries do not repair permissions.");
  } else if (pending.failed) {
    hints.push("The history manifest or its target is invalid or changed. Preserve both, inspect the manifest/database/rollout identity, and do not repeatedly run 'ocx sync' until the mismatch is understood. Untracked routed history is not relabeled.");
  } else if (pending.backupEntries > 0) {
    hints.push("Backed-up history metadata is pending. The running proxy retries exact restoration automatically; to force it now, close the Codex app and run 'ocx sync'. Untracked routed history is not relabeled.");
  }
  if (dual.dualInstall && !dual.effectiveIsWindowsMount) {
    hints.push(`Codex is installed on BOTH WSL and Windows. Each side keeps its own ~/.codex (logins, config, catalog are separate); ocx here manages the Linux one. To share a single home, set CODEX_HOME=${dual.windowsCodexHomes[0] ?? `${dual.automountRoot}/c/Users/<you>/.codex`} in WSL (drvfs file locking is less reliable).`);
    hints.push("localhost is one-way in WSL2 NAT mode: Windows-side codex reaches this WSL proxy via localhost (localhostForwarding, on by default), but a Windows-side proxy is NOT reachable from WSL via localhost — use networkingMode=mirrored in .wslconfig for both directions.");
  }
  if (dual.interopCodexOnPath) {
    hints.push("The `codex` found on PATH is the Windows launcher reached through WSL interop; ocx will not shim it (a WSL shim breaks Windows invocations). Install codex inside WSL (npm i -g @openai/codex) or run 'ocx ensure' from Windows.");
  }
  if (hints.length > 0) {
    console.log("\nHints");
    for (const h of hints) console.log(`  - ${h}`);
  }
}
