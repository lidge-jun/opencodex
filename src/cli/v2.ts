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
import { dirname } from "node:path";
import { activeCodexConfigPath, getAgentsEnabled, getAgentsMaxDepth, getLogicalMaxThreads, getMultiAgentModeHintText, getSubagentDeveloperInstructions, hasAgentsMaxThreads, isMultiAgentV2Enabled, setMultiAgentModeHintText, transitionMultiAgentV2 } from "../codex/features";

import { commandInvocation, type SpawnInvocation } from "../lib/win-exec";
import { deleteConfigTopLevelKey, loadConfig, saveConfig } from "../config";
import { resolveAndPersistCodexRuntime, type ResolveCodexRuntimeDeps } from "../codex/runtime";

export interface V2CliDeps {
  execFile?: (file: string, args: string[], options?: SpawnInvocation["options"]) => void;
  isEnabled?: typeof isMultiAgentV2Enabled;
  hasMaxThreads?: typeof hasAgentsMaxThreads;
  sync?: (port?: number) => Promise<unknown>;
  log?: Pick<Console, "log" | "error">;
}

export type CodexFeaturesInvocationDeps =
  & Parameters<typeof commandInvocation>[3]
  & Pick<ResolveCodexRuntimeDeps, "existsSync" | "execFileSync" | "configDir" | "readFileSync">;

/**
 * Shared invocation for `codex features enable|disable <feature>` — the single
 * source of truth for the CLI and the management API fallback. Windows npm installs
 * expose `codex` as a `.cmd` shim, which needs the win-exec launcher
 * (devlog 260715_cross_platform_audit/020). Upstream `codex features` validates
 * the key against the installed build's feature registry, so an old Codex will
 * fail loudly instead of silently writing an unknown flag.
 */
export function codexFeaturesInvocation(
  action: "enable" | "disable",
  feature: string = "multi_agent_v2",
  platform: NodeJS.Platform = process.platform,
  deps: CodexFeaturesInvocationDeps = {},
): SpawnInvocation {
  const command = resolveAndPersistCodexRuntime({
    env: deps.env ?? process.env,
    platform,
    existsSync: deps.existsSync,
    execFileSync: deps.execFileSync,
    configDir: deps.configDir,
    readFileSync: deps.readFileSync,
  }).runtime.command || "codex";
  return commandInvocation(command, ["features", action, feature], platform, deps);
}

/**
 * Run `codex features <action> <feature>` synchronously - the management API
 * fallback when no deps toggle is injected. Shares the invocation builder and
 * the bounded timeout/stdio options so every production toggle path behaves
 * identically.
 */
export function runCodexFeaturesCommand(
  action: "enable" | "disable",
  feature: string = "multi_agent_v2",
): void {
  const inv = codexFeaturesInvocation(action, feature);
  execFileSync(inv.file, inv.args,
    {
      stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, windowsHide: true, encoding: "utf8",
      // The reader resolves $CODEX_HOME at call time (including the WSL Windows-home
      // detection); force the same home on the child so it never toggles a different
      // config than the one the postcondition re-reads.
      env: { ...process.env, CODEX_HOME: dirname(activeCodexConfigPath()) },
      ...inv.options,
    });
}

function runCodexFeatures(action: "enable" | "disable", deps: V2CliDeps): void {
  if (deps.execFile) {
    const inv = codexFeaturesInvocation(action);
    deps.execFile(inv.file, inv.args, inv.options);
    return;
  }
  runCodexFeaturesCommand(action);
}

export function v2StatusLine(enabled: boolean): string {
  return enabled
    ? "multi_agent_v2: ON — global V2 override active"
    : "multi_agent_v2: OFF — model catalog pins and defaults decide the surface";
}

export function multiAgentModeLine(mode: string, keepNativeChatGptOnV1 = false): string {
  switch (mode) {
    case "v1": return "multi_agent_mode: v1 — ALL models forced to v1 surface (upstream pins overridden)";
    case "v2": return keepNativeChatGptOnV1
      ? "multi_agent_mode: v2 hybrid — ChatGPT-native models use v1; routed models use v2"
      : "multi_agent_mode: v2 — ALL models forced to v2 surface (upstream pins overridden)";
    default: return "multi_agent_mode: default — upstream model pins respected (sol/terra=v2, luna=v1, rest=codex flag)";
  }
}

function requiresGlobalV2Disabled(multiAgentMode: string | undefined, keepNativeChatGptOnV1: boolean): boolean {
  return multiAgentMode === "v2" && keepNativeChatGptOnV1;
}

export async function cmdV2(args: string[], deps: V2CliDeps = {}, findPort?: () => Promise<number | undefined>): Promise<number> {
  const log = deps.log ?? console;
  const isEnabled = deps.isEnabled ?? isMultiAgentV2Enabled;
  const hasMaxThreads = deps.hasMaxThreads ?? hasAgentsMaxThreads;
  const verb = (args[0] ?? "status").trim().toLowerCase();

  if (verb === "status") {
    log.log(v2StatusLine(isEnabled()));
    const cfg = loadConfig();
    const mode = cfg.multiAgentMode ?? "default";
    const keepNativeV1 = cfg.keepNativeChatGptOnV1 === true;
    log.log(multiAgentModeLine(mode, keepNativeV1));
    log.log(cfg.keepNativeChatGptOnV1 === true
      ? requiresGlobalV2Disabled(mode, keepNativeV1) && isEnabled()
        ? "keep_native_chatgpt_on_v1: CONFLICT — global multi_agent_v2 overrides the native v1 catalog pin; run 'ocx v2 keep-native-v1 on' to reconcile"
        : "keep_native_chatgpt_on_v1: ON — global V2 override is off; ChatGPT-native rows use v1 and routed rows use v2 when mode is v2"
      : "keep_native_chatgpt_on_v1: OFF");
    const threads = getLogicalMaxThreads();
    log.log(`max_threads: ${threads ?? "(unset — codex default)"}`);
    const v2Active = isEnabled();
    const agentsEnabled = getAgentsEnabled();
    log.log(`agents.enabled: ${agentsEnabled === null ? "(unset — upstream default true)" : agentsEnabled}`);
    const maxDepth = getAgentsMaxDepth();
    // max_depth is V1-only upstream; say so whenever V2 is active so the number
    // cannot be misread as an effective V2 limit.
    log.log(`agents.max_depth: ${maxDepth ?? "(unset — upstream default 1)"}${v2Active ? " (V1-only — ignored while multi_agent_v2 is enabled)" : ""}`);
    const instructions = getSubagentDeveloperInstructions();
    log.log(`subagent_developer_instructions: ${instructions === null ? "(unset — children inherit)" : instructions === "" ? '"" (clears inherited instructions)' : JSON.stringify(instructions)}`);
    const modeHint = getMultiAgentModeHintText();
    log.log(`multi_agent_mode_hint_text: ${modeHint === null ? "(unset — effort-derived policy: ultra=proactive, else explicit)" : JSON.stringify(modeHint)}`);
    if (isEnabled() && hasMaxThreads()) {
      log.log("WARNING: [agents] max_threads is set — codex refuses to start while multi_agent_v2 is enabled. Remove it from config.toml (concurrency lives in features.multi_agent_v2.max_concurrent_threads_per_session).");
    }
    return 0;
  }
  if (verb === "mode-hint") {
    const value = args[1];
    if (value === undefined) {
      log.error("v2 mode-hint: pass the hint text, or --clear to unset it.");
      return 1;
    }
    if (value === "--clear") {
      const result = setMultiAgentModeHintText(null);
      if (!result.ok) {
        log.error(`v2 mode-hint: ${result.error}`);
        return 1;
      }
      log.log(result.changed
        ? "multi_agent_mode_hint_text cleared — effort-derived policy resumes (new sessions)."
        : "multi_agent_mode_hint_text already unset — nothing to do.");
      return 0;
    }
    // `--clear` is the only reserved token; hints are otherwise arbitrary
    // nonblank text and may legitimately begin with a hyphen.
    if (value.trim().length === 0) {
      log.error("v2 mode-hint: pass the hint text, or --clear to unset it.");
      return 1;
    }
    const result = setMultiAgentModeHintText(value);
    if (!result.ok) {
      log.error(`v2 mode-hint: ${result.error}`);
      return 1;
    }
    log.log(result.changed
      ? `multi_agent_mode_hint_text set (new sessions).`
      : "multi_agent_mode_hint_text already set — nothing to do.");
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
      const target = modeArg === "v2" && cfg.keepNativeChatGptOnV1 !== true;
      const transition = transitionMultiAgentV2(target, enabled => runCodexFeatures(enabled ? "enable" : "disable", deps));
      if (!transition.ok) {
        log.error(`multi-agent mode transition failed: ${transition.error}`);
        return 1;
      }
    }
    if (modeArg === "default") deleteConfigTopLevelKey(cfg, "multiAgentMode");
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
  if (verb === "keep-native-v1") {
    const flag = (args[1] ?? "").trim().toLowerCase();
    if (flag !== "on" && flag !== "off") {
      log.error("v2 keep-native-v1: expected on|off");
      return 1;
    }
    const cfg = loadConfig();
    const next = flag === "on";
    const already = cfg.keepNativeChatGptOnV1 === true === next;
    if (next && requiresGlobalV2Disabled(cfg.multiAgentMode, true)) {
      const transition = transitionMultiAgentV2(false, enabled => runCodexFeatures(enabled ? "enable" : "disable", deps));
      if (!transition.ok) {
        log.error(`keep-native-v1 transition failed: ${transition.error}`);
        return 1;
      }
    }
    if (next) cfg.keepNativeChatGptOnV1 = true;
    else deleteConfigTopLevelKey(cfg, "keepNativeChatGptOnV1");
    saveConfig(cfg);
    try {
      const sync = deps.sync ?? (await import("../codex/sync")).syncModelsToCodex;
      await sync(findPort ? await findPort() : undefined);
    } catch (err) {
      log.error(`catalog resync failed: ${err instanceof Error ? err.message : String(err)} — run 'ocx sync' manually.`);
      return 1;
    }
    if (already) {
      log.log(next
        ? "keep_native_chatgpt_on_v1 already ON — catalog re-synced."
        : "keep_native_chatgpt_on_v1 already OFF — catalog re-synced.");
      return 0;
    }
    log.log(next
      ? "keep_native_chatgpt_on_v1: ON — ChatGPT-native rows stay v1 when mode is v2 (new sessions)."
      : "keep_native_chatgpt_on_v1: OFF — ChatGPT-native rows follow v1/base/v2 (new sessions).");
    return 0;
  }
  if (verb !== "on" && verb !== "off") {
    log.error(`v2: unknown verb '${verb}' (expected status|on|off|mode <v1|default|v2>|keep-native-v1 <on|off>|threads <n>|mode-hint <text|--clear>)`);
    return 1;
  }

  const want = verb === "on";
  if (want) {
    const cfg = loadConfig();
    if (requiresGlobalV2Disabled(cfg.multiAgentMode, cfg.keepNativeChatGptOnV1 === true)) {
      log.error("v2 on: incompatible with keep-native-v1 while mode is v2 — Codex's global multi_agent_v2 overrides the native v1 catalog pin. Run 'ocx v2 keep-native-v1 off' first.");
      return 1;
    }
  }
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
