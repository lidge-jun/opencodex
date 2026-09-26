import { durableBunRuntime } from "../lib/bun-runtime";
import { existsSync, readFileSync } from "node:fs";
import { codexAutoStartEnabled, getConfigPath, readConfigDiagnostics } from "../config";
import { getPidPath, readPid, readRuntimePort, type RuntimePortState } from "../config/process-state";
import { diagnoseCodexBundledPlugins, type CodexPluginsDiagnostic } from "../codex/plugins-doctor";
import { findLiveProxy, probeHostname } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";
import { diagnoseService, serviceLogPath } from "../service";
import { collectStartupHealth, type StartupHealth } from "../codex/autostart-health";
import { getCodexRoutingKind } from "../codex/inject";
import { missingOwnedCatalogPath } from "../codex/inject/config-toml";
import { CODEX_CONFIG_PATH } from "../codex/paths";
import { diagnoseCodexShim } from "../codex/shim";
import { displayCodexRuntimePath, effortClampAppliesToRuntime, liveRemovedEfforts, loadLastEffortClamp, resolveCodexRuntime } from "../codex/runtime";
import { packageVersion } from "./help";
import { computeVersionSkew, type VersionSkew } from "./version-skew";
import { redactSecretString, redactUserPath } from "../lib/redact";
import { collectOrcaCodexHomeDiagnostic, type OrcaCodexHomeDiagnostic } from "../codex/home";
import { grokFenceEndpointDrift, readGrokStatus } from "../grok/status";
import { effectiveLoopbackListenerPort } from "../codex/loopback-target";
import { claudeDesktopIntegrationEnabled } from "../codex/desired-state";
import { claudeDesktopPolicyHealth, probeClaudeDesktopPolicy, type ClaudeDesktopPolicyHealth } from "../claude/desktop-policy";
import { collectClientConnectionStatus, type ClientConnectionStatus } from "./connect";
import { readClientConnectionState, sameClientConnectionOwner } from "../client/state";
import type { HubStateOAuthEntry, HubStateProvider } from "../remote/hub-state";
import type { HubStateSource } from "../client/hub-state";
import { readServiceApiTokenState, serviceApiTokenFilePath } from "../lib/service-secrets";
import { tokenCollidesWithAdmin } from "../lib/admin-secrets";
export { proxyHealthFailureReason, isConnectionRefused, isUncleanExitEvidence, probeUncleanExitState } from "./status-probes";
export type { ListenTarget } from "./status-probes";
import { checkProxyHealth, probeUncleanExitState, type ListenTarget } from "./status-probes";
import { LOCAL_MANAGEMENT_READ_PATHS } from "../lib/local-management-capability";
import { fetchBoundLocalManagementRead } from "../server/local-management-read-client";

/**
 * The state of the data-plane admission secret the SERVICE will use. State only -- never the value.
 *
 * Always about the file, because the file is what the service reads: the launchd plist and the
 * systemd unit `cat` it into `OPENCODEX_API_AUTH_TOKEN` before exec, so a token in the CLI's own
 * shell says nothing about the running hub. `present (env)` used to be reported here and was
 * simply wrong about whose environment it meant (see `dataTokenEnvInShell`).
 *
 * `admin-collision (file)` is the #4236 incident shape: the file holds the MANAGEMENT token, so
 * the server fences the whole management plane closed at boot and the hub crash-loops. It used
 * to report `present (file)`, which is how the cause stayed invisible.
 */
export type HubDataTokenState =
  | "present (file)"
  | "unsafe (file)"
  | "admin-collision (file)"
  | "missing";

export type HubStatus = {
  /** Advertised data origin: hub.dataPublicOrigin, else derived from the bind address. */
  dataOrigin: string;
  /** True when dataOrigin came from config rather than being derived from the bind. */
  dataOriginConfigured: boolean;
  /**
   * The unauthenticated loopback listener, in PR2's two forms: `companion` shares the public
   * port (the one-port hub), `ported` binds its own. `off` means the hub does not serve its
   * own local clients at all.
   */
  loopbackListener: { state: "off" | "companion" | "ported"; port: number | null };
  managementIngress: { enabled: boolean; port: number | null };
  managementPublicOrigin: string | null;
  dataToken: HubDataTokenState;
  dataTokenPath: string;
  /**
   * `OPENCODEX_API_AUTH_TOKEN` is set in the shell that ran `ocx status` — which is NOT the
   * environment the installed service runs in. Reported separately, and honestly, because it
   * does decide what a FOREGROUND `ocx start` in this same shell would admit.
   */
  dataTokenEnvInShell: boolean;
};

/**
 * What a connected client learned from its hub, and how reliable that answer is (#4236).
 *
 * `stateSource` is the load-bearing field. "hub" is a live read; "cache" is the last good read
 * from THIS connection, still the hub's state rather than this machine's; "unavailable" means
 * nothing true is known, and the consumer must say so rather than substitute local facts. A
 * client's own `providers`/`oauth` sections are empty by design, so presenting them as the
 * answer is not a degraded report — it is a wrong one.
 */
export type CliRemoteHubStatus = {
  connected: boolean;
  /** The hub's advertised data origin when it publishes one, else the URL this client dials. */
  origin: string | null;
  stateSource: HubStateSource;
  /** Present whenever `stateSource` is not "hub". Operator-facing, never a bare error code. */
  reason?: string;
  fetchedAt?: string;
  ageSeconds?: number;
  hubVersion: string | null;
  providers: HubStateProvider[];
  oauth: HubStateOAuthEntry[];
  subagentModels: string[];
  /** The hub hit one of its own caps, so the lists above are a prefix and the report says so. */
  truncated: boolean;
  /** The hub's own Claude Code toggle; a client cannot infer it from local config. */
  claudeCodeEnabled: boolean | null;
};

export type CliStatusJson = {
  schemaVersion: 1;
  /**
   * This machine's topology role, named rather than inferred (#4236).
   *
   * Every other field in this report was already ambiguous without it: an agent reading
   * `providers: {}` on a client could not tell "nothing is configured" from "the provider
   * configuration lives on the hub". Additive, so `schemaVersion` stays 1.
   */
  runtimeRole: "standalone" | "hub" | "client";
  proxy: {
    running: boolean;
    pid: number | null;
    /** Persisted owner records outlived their process: the last proxy did not exit cleanly. */
    staleProcessState: boolean;
    health: {
      ok: boolean;
      url: string;
      message: string;
    };
  };
  dashboard: { url: string };
  listen: {
    port: number;
    hostname: string | null;
    source: "runtime" | "config";
  };
  paths: {
    config: string;
    pid: string;
    runtime: string;
  };
  runtime: {
    source: string;
    overrideEnv?: string;
  };
  codexAutostart: boolean;
  startup: StartupHealth;
  defaultProvider: string | null;
  config: {
    source: "default" | "file" | "fallback";
    error: string | null;
  };
  connection: {
    state: "disconnected" | "connected" | "invalid" | "mismatched";
    reason?: string;
    serverUrl?: string;
    managementUrl?: string;
    protocolVersion?: number;
    apiKeyId?: string;
    selectedClients?: string[];
    catalog?: "present" | "missing" | "unsafe";
    catalogAgeSeconds?: number;
    credentialFile: "owned" | "missing" | "changed" | "unsafe";
    /**
     * #4207: whether the selected local Codex CLI can consume the catalog this client
     * installed. Absent unless a client connection exists. `connected` alone proved only the
     * hub and the credential, and a reader who stopped there saw a healthy connection while
     * `codex exec` was exiting before its first request.
     */
    readiness?: "ready" | "unverified" | "incompatible";
    readinessReason?: string;
  };
  service: { summary: string };
  codexShim: { summary: string };
  codexPlugins: CodexPluginsDiagnostic;
  codexRuntime: {
    path: string;
    version: string | null;
    source: string;
    newerAvailable: { path: string; version: string | null } | null;
    warning: string | null;
    catalogClamp: {
      active: boolean;
      removedEfforts: string[];
      runtimeVersion: string | null;
    };
  };
  codexHome: OrcaCodexHomeDiagnostic;
  claudeDesktop: {
    desiredEnabled: boolean;
    policy: ClaudeDesktopPolicyHealth;
  };
  /**
   * The hub-only facts an operator needs in one place, or null on a standalone/client machine.
   *
   * Scattered across the report they were unusable: the public data origin came from `listen`,
   * the management origin was folded into `dashboard.url`, the loopback companion appeared
   * nowhere, and the data-plane token appeared nowhere at all -- so the one question a hub
   * operator actually asks ("is this reachable, and can another machine join?") took four other
   * commands to answer. Additive and nullable, so `schemaVersion` stays 1.
   *
   * Never carries a token value; only which source holds one.
   */
  hub: HubStatus | null;
  /**
   * The hub's answer on a connected client, or a not-connected placeholder (#4236).
   *
   * Separate from `connection`, which describes the LINK (is the key owned, is the catalog
   * present). This describes what is on the other end of it. Additive and always present, so
   * `schemaVersion` stays 1 and a consumer never has to branch on the key existing.
   */
  remoteHub: CliRemoteHubStatus;
  /**
   * This CLI's version against the running proxy's (#2701).
   *
   * Additive and optional-by-value, so `schemaVersion` stays 1: an existing consumer that
   * ignores the key is unaffected, and `proxyVersion` is null when nothing is live.
   */
  versionSkew: VersionSkew;
};

export type CliStatusView = {
  json: CliStatusJson;
  proxyLabel: string;
  healthLabel: string;
};


type StatusListenConfig = Pick<OcxConfig, "port" | "hostname" | "runtimeRole" | "hub">;

function statusDashboardUrl(config: StatusListenConfig, hostname: string | undefined, port: number): string {
  const managementOrigin = config.runtimeRole === "hub" ? config.hub?.managementPublicOrigin : undefined;
  if (managementOrigin) return managementOrigin.endsWith("/") ? managementOrigin : `${managementOrigin}/`;

  const reachableHostname = probeHostname(hostname);
  const dashboardHostname = reachableHostname === "127.0.0.1"
    || reachableHostname === "[::1]"
    || reachableHostname.toLowerCase() === "localhost"
    ? "localhost"
    : reachableHostname;
  return `http://${dashboardHostname}:${port}/`;
}

const STARTUP_HEALTH_BOOLEAN_FIELDS = [
  "routingInjected", "localRoutingDependency", "autostartEnabled", "rebootSafe",
  "serviceInstalled", "serviceViable", "serviceEnabled", "serviceRunning",
  "serviceStale", "serviceConflict", "shimInstalled", "shimHealthy",
  "serviceSupported", "diagnosticStale",
] as const;

export async function fetchLiveStartupHealth(
  live: NonNullable<Awaited<ReturnType<typeof findLiveProxy>>>,
  deps: Parameters<typeof fetchBoundLocalManagementRead>[2] = {},
): Promise<StartupHealth | null> {
  const result = await fetchBoundLocalManagementRead(
    live, LOCAL_MANAGEMENT_READ_PATHS.startupHealth, { timeoutMs: 1_500, ...deps },
  );
  if (result.kind !== "response" || !result.response.ok) return null;
  let payload: unknown;
  try { payload = await result.response.json(); } catch { return null; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  if (row.status !== "native" && row.status !== "protected" && row.status !== "at-risk") return null;
  if (row.protection !== "service" && row.protection !== "shim" && row.protection !== "none") return null;
  if (row.routingKind !== "native" && row.routingKind !== "opencodex-local"
    && row.routingKind !== "custom-local" && row.routingKind !== "custom-remote" && row.routingKind !== "unknown") return null;
  if (row.shimCoverage !== "full" && row.shimCoverage !== "cli-only" && row.shimCoverage !== "none") return null;
  if (typeof row.platform !== "string") return null;
  if (row.recommendedCommand !== null && typeof row.recommendedCommand !== "string") return null;
  if (!row.commands || typeof row.commands !== "object" || Array.isArray(row.commands)) return null;
  for (const key of ["installService", "repairService", "installShim", "restoreNative"] as const) {
    if (typeof (row.commands as Record<string, unknown>)[key] !== "string") return null;
  }
  if (row.routingAdoption !== undefined) {
    if (!row.routingAdoption || typeof row.routingAdoption !== "object" || Array.isArray(row.routingAdoption)) return null;
    const adoption = row.routingAdoption as Record<string, unknown>;
    if (adoption.adoption !== "not-applicable" && adoption.adoption !== "adopted"
      && adoption.adoption !== "pending-client-restart" && adoption.adoption !== "unknown") return null;
    if (adoption.injectedAtMs !== null && typeof adoption.injectedAtMs !== "number") return null;
    if (typeof adoption.observedClients !== "number" || !Array.isArray(adoption.staleClients)) return null;
    for (const client of adoption.staleClients) {
      if (!client || typeof client !== "object" || Array.isArray(client)) return null;
      const row = client as Record<string, unknown>;
      if (typeof row.pid !== "number" || typeof row.startedAtMs !== "number") return null;
    }
  }
  for (const key of STARTUP_HEALTH_BOOLEAN_FIELDS) if (typeof row[key] !== "boolean") return null;
  return payload as StartupHealth;
}

/** Prefer an attested live verdict and evaluate the local fallback only when live state is absent. */
export function selectStatusStartupHealth(
  liveStartup: StartupHealth | null,
  fallback: () => StartupHealth,
): StartupHealth {
  return liveStartup ?? fallback();
}

/** Build the service summary from the same startup source that `ocx status` selected. */
export function statusServiceSummary(
  liveStartup: StartupHealth | null,
  service: Pick<ReturnType<typeof diagnoseService>, "installed" | "summary">,
  live: boolean,
): string {
  if (liveStartup) {
    if (liveStartup.protection === "service" && liveStartup.serviceViable) {
      return `running under the live managed service (logs: ${serviceLogPath()})`;
    }
    const state = [
      liveStartup.serviceInstalled ? "installed" : "absent",
      liveStartup.serviceRunning ? "running" : "not running",
      liveStartup.serviceViable ? "viable" : "not viable",
    ].join(", ");
    const action = liveStartup.recommendedCommand ? `; run '${liveStartup.recommendedCommand}'` : "";
    return `live startup reports service ${state}${action} (logs: ${serviceLogPath()})`;
  }
  return service.installed && !live
    ? `${service.summary} — registered but NOT serving; see ${serviceLogPath()} and re-run 'ocx service repair'`
    : service.summary;
}

/**
 * The hub block, or null when this machine is not a hub.
 *
 * The token line is about the FILE, not this shell. `ocx status` used to print `present (env)`
 * whenever the calling shell happened to export `OPENCODEX_API_AUTH_TOKEN`, but the service
 * wrapper overwrites that variable from the token file before exec — so the label described the
 * operator's terminal and not the hub. The shell's variable is reported as its own flag instead.
 *
 * The token VALUE is never read into the report. `readServiceApiTokenState` returns it; the only
 * things derived from it are `kind` and the admin-token comparison, neither of which can carry
 * bytes of the secret.
 */
export function collectHubStatus(
  config: Pick<OcxConfig, "runtimeRole" | "hostname" | "port" | "hub" | "unauthenticatedLoopbackListener">,
  listen: { port: number; hostname?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): HubStatus | null {
  if (config.runtimeRole !== "hub") return null;
  const listener = config.unauthenticatedLoopbackListener;
  const loopbackPort = effectiveLoopbackListenerPort(config, listen.port);
  const ingress = config.hub?.managementIngress;
  const configuredDataOrigin = config.hub?.dataPublicOrigin;
  const host = probeHostname(listen.hostname ?? config.hostname);
  const tokenState = ((): HubDataTokenState => {
    const state = readServiceApiTokenState();
    if (state.kind === "unsafe") return "unsafe (file)";
    if (state.kind !== "present") return "missing";
    return tokenCollidesWithAdmin(state.token, env) ? "admin-collision (file)" : "present (file)";
  })();
  return {
    dataOrigin: configuredDataOrigin
      ?? `http://${host === "127.0.0.1" ? "localhost" : host}:${listen.port}`,
    dataOriginConfigured: Boolean(configuredDataOrigin),
    loopbackListener: loopbackPort === null
      ? { state: "off", port: null }
      : { state: listener?.enabled && listener.port === undefined ? "companion" : "ported", port: loopbackPort },
    managementIngress: {
      enabled: ingress?.enabled === true,
      port: ingress?.enabled === true ? ingress.port : null,
    },
    managementPublicOrigin: config.hub?.managementPublicOrigin ?? null,
    dataToken: tokenState,
    dataTokenPath: serviceApiTokenFilePath(),
    dataTokenEnvInShell: Boolean(env.OPENCODEX_API_AUTH_TOKEN?.trim()),
  };
}

/**
 * The human rendering of the hub block, owned here rather than in the `ocx status` printer so
 * the sentences are testable without spawning the CLI. Indentation is the caller's.
 */
export function hubStatusLines(hub: HubStatus): string[] {
  const listener = hub.loopbackListener.state === "off"
    ? "off — this hub does not route its own local Codex/Claude clients"
    : hub.loopbackListener.state === "companion"
      ? `companion on http://127.0.0.1:${hub.loopbackListener.port} — same port as the public listener, no credential needed locally`
      : `ported on http://127.0.0.1:${hub.loopbackListener.port} — a second port local clients must be pointed at`;
  const tokenLines = [`  Data token: ${hub.dataToken}${hub.dataToken === "missing" ? "" : ` at ${hub.dataTokenPath}`}`];
  if (hub.dataToken === "admin-collision (file)") {
    // Naming the consequence matters more than naming the state: this is what a crash-looping
    // hub looks like from `ocx status`, and nothing else in the report says so (#4236).
    tokenLines.push(
      "    that file holds the MANAGEMENT token, so the hub fences its management API closed at boot —",
      "    delete it and run 'ocx service repair' to generate a data-plane token",
    );
  }
  if (hub.dataTokenEnvInShell) {
    tokenLines.push("    OPENCODEX_API_AUTH_TOKEN is also set in this shell; the installed service reads the file, not this");
  }
  return [
    "Hub:",
    `  Data origin: ${hub.dataOrigin}${hub.dataOriginConfigured ? " (hub.dataPublicOrigin)" : " (derived from the bind address)"}`,
    `  Loopback listener: ${listener}`,
    `  Management ingress: ${hub.managementIngress.enabled ? `http://127.0.0.1:${hub.managementIngress.port}` : "disabled"}`,
    `  Management origin: ${hub.managementPublicOrigin ?? "unset — remote pairing and the remote dashboard need hub.managementPublicOrigin"}`,
    ...tokenLines,
    "  Invite a machine: ocx hub invite",
  ];
}

/** The not-connected placeholder. Arrays are empty because nothing was asked, not because nothing exists. */
export function disconnectedRemoteHubStatus(): CliRemoteHubStatus {
  return {
    connected: false,
    origin: null,
    stateSource: "unavailable",
    hubVersion: null,
    providers: [],
    oauth: [],
    subagentModels: [],
    truncated: false,
    claudeCodeEnabled: null,
  };
}

/**
 * The data key this status snapshot may spend, and the cause when it may not.
 *
 * A reconnect or a rotation can replace both files between the snapshot and this read, so a
 * matching cache owner alone does not authorize sending the current token. Withholding is only
 * half the job: reporting every withheld case as "no usable data-plane token" is false for a
 * client that reconnected and holds a perfectly good token for a different hub, and a cause the
 * operator acts on has to be the real one (#4169 is the same defect in the stop path).
 */
function boundHubStateToken(
  current: ReturnType<typeof readClientConnectionState>,
  token: ReturnType<typeof readServiceApiTokenState>,
  owner: { serverUrl: string; apiKeyId: string; connectedAt: string },
): { token: string | null; withheldReason?: string } {
  if (current.kind !== "connected") {
    return { token: null, withheldReason: "this client is no longer connected" };
  }
  if (!sameClientConnectionOwner(current.value, owner)) {
    return { token: null, withheldReason: "the saved connection no longer matches the one this status reports" };
  }
  if (token.kind !== "present") {
    return { token: null, withheldReason: "this client has no usable data-plane token" };
  }
  if (token.fingerprint !== current.value.tokenFingerprint) {
    return { token: null, withheldReason: "the data-plane token no longer belongs to the saved connection" };
  }
  return { token: token.token };
}

/**
 * Ask the hub what it can serve, with a bounded read and a cache fallback.
 *
 * `ocx status` must answer while the hub is offline, so the fetch is bounded and a failure is
 * reported rather than thrown. It must also never answer from local provider/login state — see
 * `src/client/hub-state.ts` for why that substitution is the defect rather than a graceful
 * degradation.
 */
export async function collectRemoteHubStatus(
  connection: Pick<ClientConnectionStatus, "state" | "serverUrl" | "apiKeyId" | "connectedAt">,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: number } = {},
): Promise<CliRemoteHubStatus> {
  if (connection.state !== "connected" || !connection.serverUrl || !connection.apiKeyId || !connection.connectedAt) {
    return disconnectedRemoteHubStatus();
  }
  const { resolveHubState } = await import("../client/hub-state");
  const owner = {
    serverUrl: connection.serverUrl,
    apiKeyId: connection.apiKeyId,
    connectedAt: connection.connectedAt,
  };
  const bound = boundHubStateToken(readClientConnectionState(), readServiceApiTokenState(), owner);
  const resolved = await resolveHubState({
    owner,
    token: bound.token,
    ...(bound.withheldReason ? { withheldTokenReason: bound.withheldReason } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    connected: true,
    // The hub's own advertised origin when it publishes one; otherwise the URL this client
    // dials, which is the origin the operator would recognize.
    origin: resolved.state?.origin ?? connection.serverUrl,
    stateSource: resolved.stateSource,
    ...(resolved.reason ? { reason: resolved.reason } : {}),
    ...(resolved.fetchedAt ? { fetchedAt: resolved.fetchedAt } : {}),
    ...(resolved.ageSeconds === undefined ? {} : { ageSeconds: resolved.ageSeconds }),
    hubVersion: resolved.state?.hubVersion ?? null,
    providers: resolved.state?.providers ?? [],
    oauth: resolved.state?.oauth ?? [],
    subagentModels: resolved.state?.subagentModels ?? [],
    truncated: resolved.state?.truncated === true,
    claudeCodeEnabled: resolved.state ? resolved.state.claudeCode.enabled : null,
  };
}

/**
 * The one line that has to be read before anything else in the report.
 *
 * It goes FIRST, above the proxy line, because the failure mode is an agent or operator reading
 * the provider and login lines in isolation and concluding the hub cannot do something it can.
 * A buried `Remote hub: connected (<url>)` line — which is all this report had — does not stop
 * that, as #4236 demonstrated.
 */
export function remoteHubBannerLine(remoteHub: CliRemoteHubStatus): string | null {
  if (!remoteHub.connected) return null;
  const origin = remoteHub.origin ?? "the hub";
  if (remoteHub.stateSource === "unavailable") {
    return `⚠️  Hub ${origin}: state unavailable (${remoteHub.reason ?? "unknown reason"}) — provider and login lines below are LOCAL and do not describe the hub.`;
  }
  const staleness = remoteHub.stateSource === "cache"
    ? ` — cached ${remoteHub.ageSeconds ?? "?"}s ago (${remoteHub.reason ?? "live read failed"})`
    : "";
  return `🔗 State from hub ${origin}${staleness}: provider credentials, logins and delegable models below are the HUB's, not this machine's.`;
}

/**
 * The hub-sourced provider/login/model block, owned here so the sentences are testable without
 * spawning the CLI. Indentation is the caller's. Empty when nothing true is known.
 */
export function remoteHubStatusLines(remoteHub: CliRemoteHubStatus): string[] {
  if (!remoteHub.connected || remoteHub.stateSource === "unavailable") return [];
  const origin = remoteHub.origin ?? "hub";
  const lines = [
    `OAuth logins (hub ${origin}):`,
    ...(remoteHub.oauth.length === 0
      ? ["  (the hub reported no OAuth providers)"]
      : remoteHub.oauth.map(entry => `  ${entry.provider.padEnd(10)} ${entry.loggedIn ? "✓ logged in" : "✗ not logged in"}`)),
    `Providers (hub ${origin}):`,
    ...(remoteHub.providers.length === 0
      ? ["  (the hub reported no providers)"]
      : remoteHub.providers.map(provider => {
        // `authMode` is what keeps "no API key" from reading as "not configured": an `oauth`
        // provider legitimately has no key and is still fully usable.
        const credential = provider.hasCredential ? "credential stored" : `no API key (authMode ${provider.authMode ?? "key"})`;
        return `  ${provider.name.padEnd(10)} ${provider.adapter} — ${credential}${provider.disabled ? ", disabled" : ""}`;
      })),
    `Delegable models (hub ${origin}): ${remoteHub.subagentModels.length === 0 ? "none" : remoteHub.subagentModels.join(", ")}`,
  ];
  if (remoteHub.hubVersion) lines.push(`Hub version: ${remoteHub.hubVersion}`);
  // The hub told us its own lists are a prefix. Saying nothing here would make this report claim
  // completeness it does not have — the same shape of confident-and-wrong answer as #4236.
  if (remoteHub.truncated) {
    lines.push("  (the hub truncated this state to fit its response caps; some rows are not listed)");
  }
  return lines;
}

export function selectListenTarget(
  config: StatusListenConfig,
  pid: number | null,
  runtimePort: RuntimePortState | null,
): ListenTarget {
  const currentRuntimePort = pid && runtimePort?.pid === pid ? runtimePort : null;
  const port = currentRuntimePort ? currentRuntimePort.port : config.port ?? 10100;
  const hostname = currentRuntimePort?.hostname ?? config.hostname;
  return {
    port,
    hostname,
    source: currentRuntimePort ? "runtime" : "config",
    healthUrl: `http://${probeHostname(hostname)}:${port}/healthz`,
    dashboardUrl: statusDashboardUrl(config, hostname, port),
  };
}

/** Prefer live result (including authoritative null pid) over the on-disk pid file. */
export function resolveStatusPid(
  live: { pid: number | null } | null,
  pidFile: number | null,
): number | null {
  return live ? live.pid : pidFile;
}

/**
 * `ocx status` greens on process liveness alone, so a proxy that answers
 * /healthz reads healthy even when Codex is not pointed at it and every routed
 * request goes to OpenAI instead (#2411). The proxy line is not wrong — the
 * listener really is up — so it keeps its check, and this supplies the signal
 * that was missing rather than corrupting the one that was already honest.
 *
 * Only `native` warns. `custom-local` and `unknown` are also "this proxy is
 * unused", but startupHealthSummary already renders both as AT RISK with a
 * remedy command, and `custom-remote` is a deliberate operator choice. Warning
 * on all four would teach operators to skip the line that matters.
 */
export function unusedProxyWarningLines(input: {
  proxyUp: boolean;
  routingKind: StartupHealth["routingKind"];
}): string[] {
  if (!input.proxyUp || input.routingKind !== "native") return [];
  return [
    "⚠️  Codex routing is native — the running proxy is unused.",
    "   Codex requests go to OpenAI, not this proxy. Re-point with: ocx start",
  ];
}

/**
 * The mirror case: routing is ours and nothing is answering it.
 *
 * #5261: this state does not merely fail model calls. The root `openai_base_url` we inject
 * is the base URL of Codex's own built-in openai provider, so with the proxy down a user can
 * be stopped at Codex sign-in with no mention of opencodex anywhere on the screen. The
 * injection is on disk and survives reboot, so it does not clear itself.
 *
 * The rest of the not-running report offers only ways to bring the proxy BACK, which is the
 * wrong half of the choice for someone who wants their editor working again now. `ocx restore`
 * needs no proxy, no management API and no network, so name it here — this report is the
 * surface such a user is most likely to reach before the config file itself.
 *
 * Restricted to routing opencodex owns. `custom-local` is somebody else's gateway, and
 * `ocx restore` would not remove it.
 */
export function deadProxyRoutingAdviceLines(input: {
  proxyUp: boolean;
  routingKind: StartupHealth["routingKind"];
}): string[] {
  if (input.proxyUp || input.routingKind !== "opencodex-local") return [];
  return [
    "Codex is still pointed at this proxy, so sign-in and model requests both fail while it is down.",
    "To hand Codex back to its own account and endpoints without starting anything: ocx restore",
  ];
}

/**
 * Read the live Codex config and report an opencodex catalog pointer whose file is gone.
 *
 * Unreadable or absent config is reported as no finding rather than as a problem: this is a
 * diagnostic line, and inventing one from missing evidence is worse than staying quiet.
 */
export function detectMissingCodexCatalogPath(): string | null {
  try {
    if (!existsSync(CODEX_CONFIG_PATH)) return null;
    return missingOwnedCatalogPath(readFileSync(CODEX_CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The one state in this report where Codex is broken independently of the proxy (#5261).
 *
 * A `model_catalog_json` naming a file that is gone stops Codex loading its configuration at
 * all, so it presents as the same blank wall as dead routing while having a different cause and
 * a different fix. Both are named, because restarting the proxy rewrites the catalog and
 * restoring removes the pointer, and which one the user wants is their choice, not ours.
 */
export function missingCodexCatalogLines(missingCatalogPath: string | null): string[] {
  if (!missingCatalogPath) return [];
  return [
    "⚠️  Codex is pointed at a model catalog that is no longer on disk, so Codex cannot load its config:",
    `   ${missingCatalogPath}`,
    "   Regenerate it with 'ocx start', or remove opencodex from Codex with 'ocx restore'.",
  ];
}

export async function collectStatus(): Promise<CliStatusView> {
  const configDiagnostics = readConfigDiagnostics();
  const config = configDiagnostics.config;
  const claudeDesktop = {
    desiredEnabled: claudeDesktopIntegrationEnabled(config),
    policy: claudeDesktopPolicyHealth(probeClaudeDesktopPolicy()),
  };
  const resolvedRuntime = (() => {
    try {
      return resolveCodexRuntime();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const redacted = redactUserPath(redactSecretString(message)).slice(0, 160);
      return {
        runtime: { command: "codex", version: null, source: "fallback" as const },
        failures: [{
          command: "codex",
          source: "fallback" as const,
          reason: `resolve threw: ${redacted}`,
        }],
        replacedConfigured: undefined,
        newerAvailable: undefined,
      };
    }
  })();
  const clientConnection = collectClientConnectionStatus(Date.now(), undefined, {
    selectedCodexCommand: resolvedRuntime.runtime.command,
  });
  // Asked before the local probes below so a connected client's report is hub-sourced from its
  // first line. Bounded and failure-tolerant: an offline hub degrades the remoteHub block, it
  // does not fail `ocx status`.
  const remoteHub = await collectRemoteHubStatus(clientConnection);
  // Prefer identity-verified liveness (runtime-port + /healthz) over ocx.pid alone (#618).
  // Pass the already-resolved diagnostics config so findLiveProxy does not re-load and
  // warn on malformed config.json (status --json must stay stderr-clean).
  const live = await findLiveProxy({
    configFn: () => ({ port: config.port, hostname: config.hostname }),
  });
  const pidFile = readPid();
  // Preserve an authoritative null from orphan/legacy liveness — do not restore pidFile.
  const pid = resolveStatusPid(live, pidFile);
  // No extra request: findLiveProxy's identity probe already parsed and validated the
  // healthz body, so the version came back with the liveness result.
  const versionSkew = computeVersionSkew(packageVersion(), live?.version);
  const listen = live
    ? {
      port: live.port,
      hostname: live.hostname,
      source: live.source,
      healthUrl: `http://${probeHostname(live.hostname)}:${live.port}/healthz`,
      dashboardUrl: statusDashboardUrl(config, live.hostname, live.port),
    }
    : selectListenTarget(config, pidFile, pidFile ? readRuntimePort(pidFile) : null);
  // findLiveProxy already identity-probed /healthz; avoid a second fetch that can race.
  const health = live
    ? {
      ok: true,
      url: listen.healthUrl,
      message: `ok (pid ${live.pid ?? "unknown"})`,
      label: `${listen.healthUrl} ok (live)`,
    }
    : await checkProxyHealth(listen);
  // Same gatherer `ocx doctor` uses, so the two commands cannot reach different verdicts
  // about the same on-disk state (review found them diverging on fallback ports).
  const staleProcessState = await probeUncleanExitState({
    live: Boolean(live),
    port: config.port,
    hostname: config.hostname,
  });
  const bunRuntime = durableBunRuntime();
  const liveStartup = live ? await fetchLiveStartupHealth(live) : null;
  const service = diagnoseService();
  // A service can be registered and still not serve: the manager reports the job
  // either way. When the identity-probed live proxy provides an attested startup verdict,
  // prefer it over a shell-local service-manager probe that lacks the service environment.
  const serviceSummary = statusServiceSummary(liveStartup, service, Boolean(live));
  const codexShim = diagnoseCodexShim();
  const codexShimSummary = codexShim.summary;
  const startup = selectStatusStartupHealth(liveStartup, () => collectStartupHealth(config, {
    service,
    shim: codexShim,
    routingKind: getCodexRoutingKind(),
  }));
  const codexPlugins = diagnoseCodexBundledPlugins();
  const lastClamp = loadLastEffortClamp();
  const clampActive = effortClampAppliesToRuntime(lastClamp, resolvedRuntime.runtime);
  const codexHome = collectOrcaCodexHomeDiagnostic();
  const warningParts: string[] = [];
  if (
    resolvedRuntime.replacedConfigured
    && resolvedRuntime.replacedConfigured.from.command !== resolvedRuntime.runtime.command
  ) {
    warningParts.push(
      `Preferred Codex runtime is unavailable; using ${displayCodexRuntimePath(resolvedRuntime.runtime.command)} instead. Run ocx doctor for diagnosis and recovery.`,
    );
  } else if (
    resolvedRuntime.runtime.source === "fallback"
    && resolvedRuntime.failures.length > 0
    && !resolvedRuntime.runtime.version
  ) {
    const detail = resolvedRuntime.failures[0]?.reason;
    warningParts.push(
      detail
        ? `No validated Codex runtime found (${detail}); falling back to \`codex\`. Run ocx doctor for diagnosis and recovery.`
        : "No validated Codex runtime found; falling back to `codex`. Run ocx doctor for diagnosis and recovery.",
    );
  }
  if (resolvedRuntime.newerAvailable) {
    warningParts.push("OpenCodex is using an older Codex binary. Run ocx doctor for diagnosis and recovery.");
  }
  if (clampActive) {
    warningParts.push(
      `Catalog clamp removed: ${liveRemovedEfforts(lastClamp).join(", ")}. Run ocx doctor for diagnosis and recovery.`,
    );
  }
  // A Grok fence naming a port we are not listening on is invisible everywhere else:
  // grok retries the refused connection on its own side, so no request — and therefore
  // no log line — ever reaches us. Surface it here, where the live port is already known.
  const grokDrift = (() => {
    try {
      // Locally reachable is a set: the public port plus the unauthenticated loopback
      // listener's port. A fence naming either is correct; only a third port is drift (#4236).
      return grokFenceEndpointDrift(
        readGrokStatus(),
        health.ok ? listen.port : undefined,
        health.ok ? effectiveLoopbackListenerPort(config, listen.port) : null,
      );
    } catch {
      return null; // reading grok's config must never break `ocx status`
    }
  })();
  if (grokDrift) {
    warningParts.push(
      `Grok Build config points at port ${grokDrift.fencePort}, but the proxy is on `
      + `${grokDrift.livePort}; grok turns will retry against a closed port. Run 'ocx ensure' to repoint it.`,
    );
  }
  const codexRuntime = {
    path: displayCodexRuntimePath(resolvedRuntime.runtime.command),
    version: resolvedRuntime.runtime.version,
    source: resolvedRuntime.runtime.source,
    newerAvailable: resolvedRuntime.newerAvailable
      ? {
        path: displayCodexRuntimePath(resolvedRuntime.newerAvailable.command),
        version: resolvedRuntime.newerAvailable.version,
      }
      : null,
    warning: warningParts.length > 0 ? warningParts.join(" ") : null,
    catalogClamp: {
      active: clampActive,
      // Report what is still clamped, not what the file happens to name: a leftover written
      // before the max/ultra exemption lists rungs nothing removes any more.
      removedEfforts: clampActive ? [...liveRemovedEfforts(lastClamp)] : [],
      runtimeVersion: clampActive ? (lastClamp?.runtimeVersion ?? null) : null,
    },
  };
  const proxyLabel = live
    ? `running (PID ${live.pid ?? pid ?? "unknown"})`
    : pid && health.ok
      ? `running (PID ${pid})`
      : pid
        ? `PID file points to PID ${pid}, but health check failed`
        : health.ok
          ? "reachable, but PID file is missing or stale"
          : "not running";

  return {
    proxyLabel,
    healthLabel: health.label,
    json: {
      schemaVersion: 1,
      runtimeRole: config.runtimeRole ?? "standalone",
      proxy: {
        running: Boolean(live) || Boolean(pid && health.ok),
        pid: live?.pid ?? pid,
        staleProcessState,
        health: {
          ok: health.ok,
          url: health.url,
          message: health.message,
        },
      },
      dashboard: { url: listen.dashboardUrl },
      listen: {
        port: listen.port,
        hostname: listen.hostname ?? null,
        source: listen.source,
      },
      paths: {
        config: getConfigPath(),
        pid: getPidPath(),
        runtime: bunRuntime.path,
      },
      runtime: {
        source: bunRuntime.source,
        ...(bunRuntime.source === "override" ? { overrideEnv: bunRuntime.overrideEnv } : {}),
      },
      hub: collectHubStatus(config, listen),
      remoteHub,
      codexAutostart: codexAutoStartEnabled(config),
      startup,
      defaultProvider: typeof config.defaultProvider === "string" ? config.defaultProvider : null,
      config: {
        source: configDiagnostics.source,
        error: configDiagnostics.error,
      },
      connection: {
        state: clientConnection.state,
        ...(clientConnection.reason ? { reason: clientConnection.reason } : {}),
        ...(clientConnection.serverUrl ? { serverUrl: clientConnection.serverUrl } : {}),
        ...(clientConnection.managementUrl ? { managementUrl: clientConnection.managementUrl } : {}),
        ...(clientConnection.protocolVersion ? { protocolVersion: clientConnection.protocolVersion } : {}),
        ...(clientConnection.apiKeyId ? { apiKeyId: clientConnection.apiKeyId } : {}),
        ...(clientConnection.selectedClients ? { selectedClients: [...clientConnection.selectedClients] } : {}),
        catalog: clientConnection.catalog,
        ...(clientConnection.catalogAgeSeconds !== undefined ? { catalogAgeSeconds: clientConnection.catalogAgeSeconds } : {}),
        credentialFile: clientConnection.token,
        ...(clientConnection.readiness ? { readiness: clientConnection.readiness } : {}),
        ...(clientConnection.readinessReason ? { readinessReason: clientConnection.readinessReason } : {}),
      },
      service: { summary: serviceSummary },
      codexShim: { summary: codexShimSummary },
      codexPlugins,
      codexRuntime,
      codexHome,
      claudeDesktop,
      // Own field rather than a line in `codexRuntime.warning`: a stale ocx on PATH is a
      // fact about this install, not about the Codex runtime, and filing it there would
      // print it under the wrong heading (#2701).
      versionSkew,
    },
  };
}
