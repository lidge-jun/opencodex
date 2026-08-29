import { execFile } from "node:child_process";
import { join } from "node:path";
import { codexAutoStartEnabled } from "../config";
import { deriveStartupHealth, type StartupHealth } from "../codex/autostart-health";
import { getCodexRoutingKind } from "../codex/inject";
import { diagnoseCodexShim } from "../codex/shim";
import { durableBunPath } from "../lib/bun-runtime";
import type { OcxConfig } from "../types";
import { truncateRetainedUtf8 } from "../lib/admission";

const CACHE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
const INITIAL_PROBE_WAIT_MS = 5_500;
const MAX_DIAGNOSTIC_VALUE_BYTES = 8 * 1024;
let cached: { timestamp: number; value: StartupHealth } | null = null;
let inflight: Promise<StartupHealth> | null = null;
let generation = 0;

export function markStartupHealthDiagnosticStale(value: StartupHealth): StartupHealth {
  if (!value.localRoutingDependency) return { ...value, diagnosticStale: true };
  return {
    ...value,
    status: "at-risk",
    rebootSafe: false,
    protection: "none",
    diagnosticStale: true,
    // Mirror deriveStartupHealth's choice: an already-registered service is refreshed in
    // place. Hardcoding installService here silently undid that for every stale-cache
    // read, which is the path the dashboard hits while a probe is revalidating.
    recommendedCommand: value.routingKind === "custom-local" || value.routingKind === "unknown"
      ? value.commands.restoreNative
      : value.serviceInstalled && !value.serviceConflict
        ? value.commands.repairService
        : value.commands.installService,
  };
}

function conservativeFallback(config: Pick<OcxConfig, "codexAutoStart">): StartupHealth {
  const shim = diagnoseCodexShim();
  return deriveStartupHealth({
    routingKind: getCodexRoutingKind(),
    autostartEnabled: codexAutoStartEnabled(config),
    serviceInstalled: false,
    serviceViable: false,
    serviceEnabled: false,
    serviceRunning: false,
    serviceStale: false,
    serviceConflict: false,
    serviceSupported: process.platform === "win32" || process.platform === "darwin" || process.platform === "linux",
    shimInstalled: shim.installed,
    shimHealthy: shim.healthy,
    platform: process.platform,
    diagnosticStale: true,
  });
}

function runProbe(config: Pick<OcxConfig, "codexAutoStart">): Promise<StartupHealth> {
  const bun = durableBunPath();
  const cli = join(import.meta.dir, "..", "cli", "index.ts");
  return new Promise(resolve => {
    execFile(bun, [cli, "__startup-health"], {
      encoding: "utf8",
      env: process.env,
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    }, (error, stdout) => {
      if (!error) {
        const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          try {
            const parsed = JSON.parse(lines[index]) as StartupHealth;
            if (["native", "protected", "at-risk"].includes(parsed.status) && typeof parsed.rebootSafe === "boolean") {
              resolve({
                ...parsed,
                recommendedCommand: parsed.recommendedCommand === null
                  ? null
                  : truncateRetainedUtf8(parsed.recommendedCommand, MAX_DIAGNOSTIC_VALUE_BYTES),
                commands: {
                  installService: truncateRetainedUtf8(parsed.commands.installService, MAX_DIAGNOSTIC_VALUE_BYTES),
                  repairService: truncateRetainedUtf8(parsed.commands.repairService, MAX_DIAGNOSTIC_VALUE_BYTES),
                  installShim: truncateRetainedUtf8(parsed.commands.installShim, MAX_DIAGNOSTIC_VALUE_BYTES),
                  restoreNative: truncateRetainedUtf8(parsed.commands.restoreNative, MAX_DIAGNOSTIC_VALUE_BYTES),
                },
                diagnosticStale: false,
              });
              return;
            }
          } catch { /* scan earlier output; config repair messages may precede JSON */ }
        }
      }
      resolve(cached ? markStartupHealthDiagnosticStale(cached.value) : conservativeFallback(config));
    });
  });
}

function refreshInBackground(config: Pick<OcxConfig, "codexAutoStart">): void {
  if (inflight) return;
  const startedGeneration = generation;
  const probe = runProbe(config).then(value => {
    if (startedGeneration === generation) cached = { timestamp: Date.now(), value };
    return value;
  });
  inflight = probe.finally(() => {
    if (inflight === probe || startedGeneration === generation) inflight = null;
  });
}

/** Stale-while-revalidate: service-manager probes never hold open a model/UI request. */
export async function getCachedStartupHealth(config: Pick<OcxConfig, "codexAutoStart">): Promise<StartupHealth> {
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.value;
  refreshInBackground(config);
  // An expired or empty read is an explicit protection check. Wait for the
  // isolated probe instead of presenting a synthetic failure while that probe
  // is still running. The probe remains child-process isolated and hard-capped
  // at 5s; stale state is returned only if that bounded probe cannot settle.
  if (inflight) {
    const settled = await Promise.race([
      inflight,
      new Promise<null>(resolve => setTimeout(() => resolve(null), INITIAL_PROBE_WAIT_MS)),
    ]);
    if (settled) return settled;
  }
  return cached ? markStartupHealthDiagnosticStale(cached.value) : conservativeFallback(config);
}

export function invalidateStartupHealthCache(): void {
  generation += 1;
  cached = null;
  inflight = null;
}
