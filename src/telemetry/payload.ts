import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { packageVersion } from "../lib/package-version";
import { detectInstallOwnership } from "../update";
import type { DailyTelemetryAggregate } from "./aggregate";
import {
  ARCH_VALUES,
  OS_VALUES,
  TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_VERSION_RE,
  validateTelemetryPayloadV1,
  type TelemetryArch,
  type TelemetryInstallChannel,
  type TelemetryOs,
  type TelemetryPayloadV1,
  type TelemetryReleaseChannel,
} from "./contract";

export interface ResolveInstallChannelOptions {
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  detectOwnership?: () => { installer?: string };
}

export function resolveInstallChannel(options: ResolveInstallChannelOptions = {}): TelemetryInstallChannel {
  const env = options.env ?? process.env;
  if (env.OCX_DESKTOP_SUPERVISED === "1") return "desktop";
  const exists = options.exists ?? existsSync;
  try {
    if (exists("/.dockerenv") || exists("/run/.containerenv")) return "docker";
  } catch { /* ignore fs errors */ }
  try {
    const installer = (options.detectOwnership ?? detectInstallOwnership)()?.installer;
    switch (installer) {
      case "npm":
        return "npm-global";
      case "pnpm":
        return "pnpm-global";
      case "bun":
        return "bun-global";
      case "mise":
        return "mise";
      case "standalone":
        return "standalone";
      case "source":
        return "source";
      default:
        return "unknown";
    }
  } catch {
    return "unknown";
  }
}

export function normalizeTelemetryVersion(raw = packageVersion("0.0.0")): {
  version: string;
  releaseChannel: TelemetryReleaseChannel;
} {
  const stripped = raw.trim().replace(/^v/, "").split("+")[0] ?? "0.0.0";
  const version = TELEMETRY_VERSION_RE.test(stripped) ? stripped : "0.0.0";
  const releaseChannel: TelemetryReleaseChannel = version.includes("-preview.") ? "preview" : "latest";
  return { version, releaseChannel };
}

export function resolveTelemetryOs(platform: string = process.platform): TelemetryOs {
  return (OS_VALUES as readonly string[]).includes(platform) && platform !== "other"
    ? (platform as TelemetryOs)
    : "other";
}

export function resolveTelemetryArch(arch: string = process.arch): TelemetryArch {
  return (ARCH_VALUES as readonly string[]).includes(arch) && arch !== "other"
    ? (arch as TelemetryArch)
    : "other";
}

export interface BuildTelemetryPayloadOptions {
  aggregate: DailyTelemetryAggregate;
  installDayHash: string;
  newInstall: boolean;
  batchId?: string;
  version?: string;
  releaseChannel?: TelemetryReleaseChannel;
  os?: TelemetryOs;
  arch?: TelemetryArch;
  installChannel?: TelemetryInstallChannel;
  now?: number;
}

export function buildTelemetryPayloadV1(options: BuildTelemetryPayloadOptions): TelemetryPayloadV1 {
  const versionInfo = normalizeTelemetryVersion(options.version);
  const candidate: TelemetryPayloadV1 = {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    batchId: options.batchId ?? randomUUID(),
    day: options.aggregate.day,
    installDayHash: options.installDayHash,
    newInstall: options.newInstall,
    env: {
      version: options.version ?? versionInfo.version,
      releaseChannel: options.releaseChannel ?? versionInfo.releaseChannel,
      os: options.os ?? resolveTelemetryOs(),
      arch: options.arch ?? resolveTelemetryArch(),
      installChannel: options.installChannel ?? resolveInstallChannel(),
    },
    activeMinutes: options.aggregate.activeMinutes,
    requests: {
      completed: options.aggregate.requests.completed,
      failed: options.aggregate.requests.failed,
      incomplete: options.aggregate.requests.incomplete,
      aborted: options.aggregate.requests.aborted,
    },
    models: options.aggregate.models.map(row => ({
      providerKind: row.providerKind,
      modelFamily: row.modelFamily,
      requests: row.requests,
      inputTokens: row.inputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      outputTokens: row.outputTokens,
      reasoningTokens: row.reasoningTokens,
    })),
    errors: { ...options.aggregate.errors },
  };
  const validated = validateTelemetryPayloadV1(candidate, options.now);
  if (!validated.ok) {
    throw new Error(`Invalid telemetry payload: ${validated.error}`);
  }
  return validated.payload;
}
