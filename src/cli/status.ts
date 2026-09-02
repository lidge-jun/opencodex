import { durableBunRuntime } from "../lib/bun-runtime";
import { codexAutoStartEnabled, getConfigPath, readConfigDiagnostics } from "../config";
import { getPidPath, readPid, readPidFileValue, readRuntimePort, type RuntimePortState } from "../config/process-state";
import { diagnoseCodexBundledPlugins, type CodexPluginsDiagnostic } from "../codex/plugins-doctor";
import { findLiveProxy, isOpencodexHealthz, probeHostname } from "../server/proxy-liveness";
import { directLocalHttpFetch } from "../server/direct-local-http";
import type { OcxConfig } from "../types";
import { diagnoseService, serviceLogPath } from "../service";
import { collectStartupHealth, type StartupHealth } from "../codex/autostart-health";
import { isProcessAlive } from "../lib/process-control";
import { getCodexRoutingKind } from "../codex/inject";
import { diagnoseCodexShim } from "../codex/shim";
import { displayCodexRuntimePath, effortClampAppliesToRuntime, loadLastEffortClamp, resolveCodexRuntime } from "../codex/runtime";
import { packageVersion } from "./help";
import { computeVersionSkew, type VersionSkew } from "./version-skew";
import { redactSecretString, redactUserPath } from "../lib/redact";
import { collectOrcaCodexHomeDiagnostic, type OrcaCodexHomeDiagnostic } from "../codex/home";
import { grokFenceEndpointDrift, readGrokStatus } from "../grok/status";
import { claudeDesktopIntegrationEnabled } from "../codex/desired-state";
import { claudeDesktopPolicyHealth, probeClaudeDesktopPolicy, type ClaudeDesktopPolicyHealth } from "../claude/desktop-policy";
import { collectClientConnectionStatus } from "./connect";

type HealthCheck = {
  ok: boolean;
  url: string;
  message: string;
  label: string;
  /** True only for a connect-phase refusal: proof that nothing holds the port. */
  refused?: boolean;
};

export type CliStatusJson = {
  schemaVersion: 1;
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


export type ListenTarget = {
  port: number;
  hostname?: string;
  source: "runtime" | "config";
  healthUrl: string;
  dashboardUrl: string;
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

export function proxyHealthFailureReason(error: unknown, signal: AbortSignal): "timed out" | "unreachable" {
  return signal.aborted || (error instanceof Error && error.name === "AbortError")
    ? "timed out"
    : "unreachable";
}

/**
 * "Nothing is listening" is narrower than "the probe failed". `unreachable` covers every
 * non-abort failure, including a socket that was ACCEPTED and then reset — which is what
 * an in-flight start looks like mid-bind. Only a connect-phase refusal proves the port is
 * free, so this reads the underlying errno instead of the display string.
 */
export function isConnectionRefused(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (code === "ECONNREFUSED" || code === "ConnectionRefused") return true;
    // Bun surfaces the refusal as a plain message on some platforms; the errno name is
    // still the discriminator, not a substring of arbitrary prose.
    if (typeof code === "string" && code.endsWith("ECONNREFUSED")) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A proxy killed by a native trap or SIGKILL never runs the exit cleanup that removes
 * `ocx.pid` and `runtime-port.json` (only SIGINT/SIGTERM/SIGHUP and normal exit are
 * wired to it), so both records outlive it. That makes "crashed" and "never started"
 * distinguishable — and #1419 is what it costs when we discard the distinction: the
 * reporter's unsupervised `ocx gui` proxy died and every later command said only
 * "not running", never that a previous process had exited or that a service would
 * have restarted it.
 *
 * Two races have to stay closed, because a false "it crashed" is worse than a missing
 * hint. `handleStart` binds the port BEFORE it publishes either record, so:
 *
 * - a start that publishes between two reads is caught by comparing the raw records
 *   observed before and after the probes (the same snapshot discipline
 *   `removePidIfValueIs` uses for deletion);
 * - a start that has bound but not yet published leaves both snapshots identical, so
 *   records alone cannot see it. That one is excluded on the port instead: the probe
 *   must have been REFUSED at connect, which is the only outcome proving nothing holds
 *   the port. A socket that is accepted and then reset — an in-flight bind — is not a
 *   refusal, so review caught `unreachable` being too broad for this job.
 *
 * What this can and cannot prove: the records outliving their process establish that the
 * previous run did not complete its cleanup. It does not establish a cause, and it cannot
 * fully exclude a clean exit whose `unlinkSync` failed, because cleanup ignores that
 * error (`src/cli/index.ts:324-325`) and the records carry no session provenance. The
 * wording therefore says the records remain and the run MAY have exited unexpectedly.
 */
export function isUncleanExitEvidence(input: {
  live: boolean;
  healthOk: boolean;
  healthRefused: boolean;
  ownerPidAlive: boolean;
  pidRecordBefore: number | null;
  pidRecordAfter: number | null;
  runtimePidBefore: number | null;
  runtimePidAfter: number | null;
}): boolean {
  if (input.live || input.healthOk) return false;
  if (!input.healthRefused) return false;
  if (input.ownerPidAlive) return false;
  if (input.pidRecordBefore !== input.pidRecordAfter) return false;
  if (input.runtimePidBefore !== input.runtimePidAfter) return false;
  return input.pidRecordAfter !== null || input.runtimePidAfter !== null;
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

async function checkProxyHealth(target: ListenTarget): Promise<HealthCheck> {
  const url = target.healthUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const response = await directLocalHttpFetch(url, { signal: controller.signal });
    if (!response.ok) {
      const message = `returned HTTP ${response.status}`;
      return { ok: false, url, message, label: `${url} ${message}` };
    }
    const body = await response.json().catch(() => null) as { service?: unknown; status?: unknown; version?: unknown; uptime?: unknown } | null;
    if (!isOpencodexHealthz(body)) {
      const message = "responded, but not an opencodex proxy";
      return { ok: false, url, message, label: `${url} ${message}` };
    }
    const version = typeof body?.version === "string" ? ` v${body.version}` : "";
    const uptime = typeof body?.uptime === "number" ? `, uptime ${Math.round(body.uptime)}s` : "";
    const message = `ok${version}${uptime}`;
    return { ok: true, url, message, label: `${url} ${message}` };
  } catch (error) {
    const reason = proxyHealthFailureReason(error, controller.signal);
    return { ok: false, url, message: reason, label: `${url} ${reason}`, refused: isConnectionRefused(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The ONE evidence gatherer for stale-process state, shared by `ocx status` and
 * `ocx doctor`.
 *
 * It deliberately probes the port named by the STALE RECORD, not the configured display
 * port. Review found the two commands disagreeing precisely here: a proxy that hopped to
 * a fallback port, or a config whose port changed after the crash, left status probing
 * the configured port while doctor probed the recorded one, so one reported a crash and
 * the other did not. The question being asked is "is the process that wrote this record
 * gone?", and only that record's own port can answer it.
 *
 * `live` short-circuits before the probe so a healthy install pays nothing.
 */
export async function probeUncleanExitState(input: {
  live: boolean;
  port?: number;
  hostname?: string | null;
}): Promise<boolean> {
  if (input.live) return false;
  const pidRecordBefore = readPidFileValue();
  const runtimeBefore = readRuntimePort();
  const runtimePidBefore = runtimeBefore?.pid ?? null;
  if (pidRecordBefore === null && runtimePidBefore === null) return false;
  const ownerPid = pidRecordBefore ?? runtimePidBefore;
  if (ownerPid !== null && isProcessAlive(ownerPid)) return false;
  // The recorded port is the evidence target. Fall back to the configured port only when
  // no runtime record exists, which is the pid-file-only case.
  const port = runtimeBefore?.port ?? input.port ?? 10100;
  const hostname = runtimeBefore?.hostname ?? input.hostname ?? undefined;
  const health = await checkProxyHealth({
    port,
    hostname,
    source: runtimeBefore ? "runtime" : "config",
    healthUrl: `http://${probeHostname(hostname)}:${port}/healthz`,
    dashboardUrl: `http://localhost:${port}/`,
  });
  const pidRecordAfter = readPidFileValue();
  const runtimePidAfter = readRuntimePort()?.pid ?? null;
  const ownerPidAfter = pidRecordAfter ?? runtimePidAfter;
  return isUncleanExitEvidence({
    live: false,
    healthOk: health.ok,
    healthRefused: health.refused === true,
    ownerPidAlive: ownerPidAfter !== null && isProcessAlive(ownerPidAfter),
    pidRecordBefore,
    pidRecordAfter,
    runtimePidBefore,
    runtimePidAfter,
  });
}

export async function collectStatus(): Promise<CliStatusView> {
  const configDiagnostics = readConfigDiagnostics();
  const config = configDiagnostics.config;
  const claudeDesktop = {
    desiredEnabled: claudeDesktopIntegrationEnabled(config),
    policy: claudeDesktopPolicyHealth(probeClaudeDesktopPolicy()),
  };
  const clientConnection = collectClientConnectionStatus();
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
  const service = diagnoseService();
  // A service can be registered and still not serve: the manager reports the job
  // either way. `live` was already identity-probed a few lines above, so cross-check
  // rather than print registration as if it were service.
  const serviceSummary = service.installed && !live
    ? `${service.summary} — registered but NOT serving; see ${serviceLogPath()} and re-run 'ocx service repair'`
    : service.summary;
  const codexShim = diagnoseCodexShim();
  const codexShimSummary = codexShim.summary;
  const startup = collectStartupHealth(config, {
    service,
    shim: codexShim,
    routingKind: getCodexRoutingKind(),
  });
  const codexPlugins = diagnoseCodexBundledPlugins();
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
      `Catalog clamp removed: ${lastClamp!.removedEfforts.join(", ")}. Run ocx doctor for diagnosis and recovery.`,
    );
  }
  // A Grok fence naming a port we are not listening on is invisible everywhere else:
  // grok retries the refused connection on its own side, so no request — and therefore
  // no log line — ever reaches us. Surface it here, where the live port is already known.
  const grokDrift = (() => {
    try {
      return grokFenceEndpointDrift(readGrokStatus(), health.ok ? listen.port : undefined);
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
      removedEfforts: clampActive ? (lastClamp?.removedEfforts ?? []) : [],
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
