import { durableBunRuntime } from "./bun-runtime";
import { codexAutoStartEnabled, getConfigPath, getPidPath, readConfigDiagnostics, readPid, readRuntimePort, type RuntimePortState } from "./config";
import { diagnoseCodexBundledPlugins, type CodexPluginsDiagnostic } from "./codex-plugins-doctor";
import type { OcxConfig } from "./types";
import { serviceStatusSummary } from "./service";

type HealthCheck = {
  ok: boolean;
  url: string;
  message: string;
  label: string;
};

export type CliStatusJson = {
  schemaVersion: 1;
  proxy: {
    running: boolean;
    pid: number | null;
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
  defaultProvider: string | null;
  config: {
    source: "default" | "file" | "fallback";
    error: string | null;
  };
  service: { summary: string };
  codexShim: { summary: string };
  codexPlugins: CodexPluginsDiagnostic;
};

export type CliStatusView = {
  json: CliStatusJson;
  proxyLabel: string;
  healthLabel: string;
};

function healthHost(hostname?: string): string {
  return !hostname || hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;
}

export type ListenTarget = {
  port: number;
  hostname?: string;
  source: "runtime" | "config";
  healthUrl: string;
  dashboardUrl: string;
};

export function selectListenTarget(
  config: Pick<OcxConfig, "port" | "hostname">,
  pid: number | null,
  runtimePort: RuntimePortState | null,
): ListenTarget {
  const currentRuntimePort = pid && runtimePort?.pid === pid ? runtimePort : null;
  const port = currentRuntimePort ? currentRuntimePort.port : config.port ?? 10100;
  const hostname = currentRuntimePort ? currentRuntimePort.hostname : config.hostname;
  return {
    port,
    hostname,
    source: currentRuntimePort ? "runtime" : "config",
    healthUrl: `http://${healthHost(hostname)}:${port}/healthz`,
    dashboardUrl: `http://localhost:${port}/`,
  };
}

async function checkProxyHealth(target: ListenTarget): Promise<HealthCheck> {
  const url = target.healthUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const message = `returned HTTP ${response.status}`;
      return { ok: false, url, message, label: `${url} ${message}` };
    }
    const body = await response.json().catch(() => null) as { version?: unknown; uptime?: unknown } | null;
    const version = typeof body?.version === "string" ? ` v${body.version}` : "";
    const uptime = typeof body?.uptime === "number" ? `, uptime ${Math.round(body.uptime)}s` : "";
    const message = `ok${version}${uptime}`;
    return { ok: true, url, message, label: `${url} ${message}` };
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? "timed out" : "unreachable";
    return { ok: false, url, message: reason, label: `${url} ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function collectStatus(): Promise<CliStatusView> {
  const configDiagnostics = readConfigDiagnostics();
  const config = configDiagnostics.config;
  const pid = readPid();
  const listen = selectListenTarget(config, pid, pid ? readRuntimePort(pid) : null);
  const health = await checkProxyHealth(listen);
  const bunRuntime = durableBunRuntime();
  const serviceSummary = serviceStatusSummary();
  const { codexShimStatus } = await import("./codex-shim");
  const codexShimSummary = codexShimStatus();
  const codexPlugins = diagnoseCodexBundledPlugins();
  const proxyLabel = pid && health.ok
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
        running: Boolean(pid && health.ok),
        pid,
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
      defaultProvider: typeof config.defaultProvider === "string" ? config.defaultProvider : null,
      config: {
        source: configDiagnostics.source,
        error: configDiagnostics.error,
      },
      service: { summary: serviceSummary },
      codexShim: { summary: codexShimSummary },
      codexPlugins,
    },
  };
}
