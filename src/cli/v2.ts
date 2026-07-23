/**
 * `ocx v2 status|on|off` — toggle/report the codex `multi_agent_v2` feature that
 * controls the multi-agent surface (v1 vs v2 collab mode).
 *
 * Contract:
 *  - config.toml writes go through the official `codex features enable|disable`
 *    CLI only (format-preserving TOML edit stays upstream-owned).
 *  - after a successful flip the catalog is RESYNCED so model metadata stays fresh.
 *  - flips preserve the active thread limit while moving it between the v1/v2
 *    config keys, with byte-for-byte rollback when the feature command fails.
 *  - nothing in the catalog build path calls this module; no auto-flip exists.
 */
import { execFileSync } from "node:child_process";
import { getLogicalMaxThreads, hasAgentsMaxThreads, isMultiAgentV2Enabled, transitionMultiAgentV2 } from "../codex/features";

import { commandInvocation, type SpawnInvocation } from "../lib/win-exec";
import { loadConfig, saveConfig } from "../config";
import { resolveAndPersistCodexRuntime } from "../codex/runtime";

export interface V2CliDeps {
  execFile?: (file: string, args: string[], options?: SpawnInvocation["options"]) => void;
  isEnabled?: typeof isMultiAgentV2Enabled;
  hasMaxThreads?: typeof hasAgentsMaxThreads;
  sync?: (port?: number) => Promise<unknown>;
  log?: Pick<Console, "log" | "error">;
}

/**
 * Shared invocation for `codex features enable|disable multi_agent_v2` — the single
 * source of truth for the CLI and the management API fallback. Windows npm installs
 * expose `codex` as a `.cmd` shim, which needs the win-exec launcher
 * (devlog 260715_cross_platform_audit/020).
 */
export function codexFeaturesInvocation(
  action: "enable" | "disable",
  platform: NodeJS.Platform = process.platform,
  deps: Parameters<typeof commandInvocation>[3] = {},
): SpawnInvocation {
  const envPath = (deps.env ?? process.env).CODEX_CLI_PATH?.trim();
  const command = envPath
    || resolveAndPersistCodexRuntime({
      env: deps.env ?? process.env,
      platform,
    }).runtime.command
    || "codex";
  return commandInvocation(command, ["features", action, "multi_agent_v2"], platform, deps);
}

function runCodexFeatures(action: "enable" | "disable", deps: V2CliDeps): void {
  const exec = deps.execFile ?? ((file: string, args: string[], options?: SpawnInvocation["options"]) => {
    execFileSync(file, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, windowsHide: true, ...options });
  });
  const inv = codexFeaturesInvocation(action);
  exec(inv.file, inv.args, inv.options);
}

export function v2StatusLine(enabled: boolean): string {
  return enabled
    ? "multi_agent_v2: ON — v2 multi-agent surface active"
    : "multi_agent_v2: OFF — v1 multi-agent surface (default install)";
}

export function multiAgentModeLine(mode: string): string {
  switch (mode) {
    case "v1": return "multi_agent_mode: v1 — ALL models forced to v1 surface (upstream pins overridden)";
    case "v2": return "multi_agent_mode: v2 — ALL models forced to v2 surface (upstream pins overridden)";
    default: return "multi_agent_mode: default — upstream model pins respected (sol/terra=v2, luna=v1, rest=codex flag)";
  }
}

export async function cmdV2(args: string[], deps: V2CliDeps = {}, findPort?: () => Promise<number | undefined>): Promise<number> {
  const log = deps.log ?? console;
  const isEnabled = deps.isEnabled ?? isMultiAgentV2Enabled;
  const hasMaxThreads = deps.hasMaxThreads ?? hasAgentsMaxThreads;
  const verb = (args[0] ?? "status").trim().toLowerCase();

  if (verb === "status") {
    log.log(v2StatusLine(isEnabled()));
    const cfg = loadConfig();
    log.log(multiAgentModeLine(cfg.multiAgentMode ?? "default"));
    const threads = getLogicalMaxThreads();
    log.log(`max_threads: ${threads ?? "(unset — codex default)"}`);
    if (isEnabled() && hasMaxThreads()) {
      log.log("WARNING: [agents] max_threads is set — codex refuses to start while multi_agent_v2 is enabled. Remove it from config.toml (concurrency lives in features.multi_agent_v2.max_concurrent_threads_per_session).");
    }
    return 0;
  }
  if (verb === "threads") {
    const value = Number((args[1] ?? "").trim());
    if (!Number.isInteger(value) || value < 1) {
      log.error("v2 threads: pass an integer >= 1 (features.multi_agent_v2.max_concurrent_threads_per_session)");
      return 1;
    }
    const enabled = isEnabled();
    const result = transitionMultiAgentV2(enabled, next => runCodexFeatures(next ? "enable" : "disable", deps), { threadLimit: value });
    if (!result.ok) { log.error(`v2 threads: ${result.error}`); return 1; }
    log.log(result.changed
      ? `max_threads = ${value} (${enabled ? "v2" : "v1"}) — applies to new sessions.`
      : `max_threads already ${value} — nothing to do.`);
    return 0;
  }
  if (verb === "mode") {
    const modeArg = (args[1] ?? "").trim().toLowerCase();
    if (modeArg !== "v1" && modeArg !== "default" && modeArg !== "v2") {
      log.error("v2 mode: expected v1|default|v2");
      return 1;
    }
    const cfg = loadConfig();
    if (modeArg !== "default") {
      const target = modeArg === "v2";
      const transition = transitionMultiAgentV2(target, enabled => runCodexFeatures(enabled ? "enable" : "disable", deps));
      if (!transition.ok) {
        log.error(`multi-agent mode transition failed: ${transition.error}`);
        return 1;
      }
    }
    if (modeArg === "default") delete cfg.multiAgentMode;
    else cfg.multiAgentMode = modeArg as "v1" | "v2";
    saveConfig(cfg);
    try {
      const sync = deps.sync ?? (await import("../codex/sync")).syncModelsToCodex;
      await sync(findPort ? await findPort() : undefined);
    } catch (err) {
      log.error(`catalog resync failed: ${err instanceof Error ? err.message : String(err)} — run 'ocx sync' manually.`);
      return 1;
    }
    log.log(multiAgentModeLine(modeArg));
    log.log("Applies to NEW sessions; running sessions keep their pinned multi-agent version.");
    return 0;
  }
  if (verb !== "on" && verb !== "off") {
    log.error(`v2: unknown verb '${verb}' (expected status|on|off|mode <v1|default|v2>|threads <n>)`);
    return 1;
  }

  const want = verb === "on";
  const transition = transitionMultiAgentV2(want, enabled => runCodexFeatures(enabled ? "enable" : "disable", deps));
  if (!transition.ok) {
    log.error(`codex features ${want ? "enable" : "disable"} multi_agent_v2 failed: ${transition.error}`);
    return 1;
  }
  if (!transition.changed) {
    log.log(`multi_agent_v2 already ${want ? "ON" : "OFF"} — nothing to do.`);
    return 0;
  }

  // Resync catalog so multi-agent surface metadata stays fresh in both the
  // on-disk catalog and models_cache.json after the toggle flip.
  try {
    const sync = deps.sync ?? (await import("../codex/sync")).syncModelsToCodex;
    await sync(findPort ? await findPort() : undefined);
  } catch (err) {
    log.error(`catalog resync failed (flag IS flipped): ${err instanceof Error ? err.message : String(err)} — run 'ocx sync' manually.`);
    return 1;
  }
  log.log(v2StatusLine(want));
  log.log("Applies to NEW sessions; running sessions keep their pinned multi-agent version. Restart the Codex app (or wait out its picker cache) to see the ladder change.");
  return 0;
}
