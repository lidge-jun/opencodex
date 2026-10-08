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
import { CliUsageError, terminalSafeText, type RuntimeApiDeps } from "./runtime-api";
import { parseV2Command, V2_USAGE, type V2ParsedCommand } from "./v2-input";
import { handleV2RuntimeCommand } from "./v2-runtime";
import { localV2State, v2LocalSyncResult, type V2LocalSync } from "./v2-local-output";
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
  runtimeApi?: RuntimeApiDeps;
  /** Internal seam: bypass executable discovery only when an exec implementation is injected. */
  featuresInvocation?: (action: "enable" | "disable") => SpawnInvocation;
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
    const inv = (deps.featuresInvocation ?? codexFeaturesInvocation)(action);
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

function printLocalStatus(deps: V2CliDeps): number {
  const log = deps.log ?? console;
  const isEnabled = deps.isEnabled ?? isMultiAgentV2Enabled;
  const hasMaxThreads = deps.hasMaxThreads ?? hasAgentsMaxThreads;
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

/** Parse before selecting either the native writer or the runtime management target. */
export async function cmdV2(args: string[], deps: V2CliDeps = {}, findPort?: () => Promise<number | undefined>): Promise<number> {
  const log = deps.log ?? console;
  let parsed: V2ParsedCommand;
  try { parsed = parseV2Command(args); }
  catch (error) {
    log.error(error instanceof CliUsageError ? error.message : "v2: invalid command");
    for (const line of V2_USAGE.split("\n")) log.error(line);
    const boundary = args.indexOf("--");
    return (boundary < 0 ? args : args.slice(0, boundary)).includes("--live") ? 2 : 1;
  }
  if (parsed.live) return handleV2RuntimeCommand(parsed, deps.runtimeApi);
  let changed: boolean | null = false;
  let sync: V2LocalSync = { status: "not-attempted", ok: false };
  const emit = (ok: boolean, lines: string[]): number => {
    // A read-back failure cannot claim rollback or overwrite already observed mutation evidence.
    let state: ReturnType<typeof localV2State> | null = null;
    try { state = localV2State(deps.isEnabled, deps.hasMaxThreads); }
    catch { ok = false; lines = ["Local V2 outcome is unverified. Read ocx v2 status before retrying; no rollback is implied."]; }
    if (parsed.json) log.log(JSON.stringify({ ok, target: "local", action: parsed.verb, changed, state, sync }));
    else for (const line of lines) (ok ? log.log : log.error).call(log, terminalSafeText(line));
    return ok ? 0 : 1;
  };
  try {
    if (parsed.verb === "status") {
      if (!parsed.json) return printLocalStatus(deps);
      return emit(true, []);
    }
    if (parsed.verb === "mode-hint") {
      const result = setMultiAgentModeHintText(parsed.value);
      if (!result.ok) return emit(false, ["Unable to write the native mode hint. Check Codex support and ownership, then read ocx v2 status."]);
      changed = result.changed;
      return emit(true, [result.changed ? "multi_agent_mode_hint_text saved — applies to new sessions." : "multi_agent_mode_hint_text already set — nothing to do."]);
    }
    if (parsed.verb === "threads") {
      const enabled = (deps.isEnabled ?? isMultiAgentV2Enabled)();
      const result = transitionMultiAgentV2(enabled, next => runCodexFeatures(next ? "enable" : "disable", deps), { threadLimit: parsed.value });
      if (!result.ok) return emit(false, ["Unable to update the native thread limit. Read ocx v2 status before retrying."]);
      changed = result.changed;
      return emit(true, [changed ? `max_threads = ${parsed.value} (${enabled ? "v2" : "v1"}) — applies to new sessions.` : `max_threads already ${parsed.value} — nothing to do.`]);
    }
    const config = loadConfig();
    let successLines: string[];
    let unchangedKeep: boolean | undefined;
    if (parsed.verb === "mode") {
      changed = (config.multiAgentMode ?? "default") !== parsed.value;
      if (parsed.value !== "default") {
        const target = parsed.value === "v2" && config.keepNativeChatGptOnV1 !== true;
        const transition = transitionMultiAgentV2(target, next => runCodexFeatures(next ? "enable" : "disable", deps));
        if (!transition.ok) { changed = false; return emit(false, ["Native mode transition failed. Read ocx v2 status before retrying."]); }
        changed ||= transition.changed;
      }
      if (parsed.value === "default") deleteConfigTopLevelKey(config, "multiAgentMode");
      else config.multiAgentMode = parsed.value;
      saveConfig(config);
      successLines = [multiAgentModeLine(parsed.value, config.keepNativeChatGptOnV1 === true),
        "Applies to NEW sessions; running sessions keep their pinned multi-agent version."];
    } else if (parsed.verb === "keep-native-v1") {
      unchangedKeep = (config.keepNativeChatGptOnV1 === true) === parsed.value;
      changed = !unchangedKeep;
      if (parsed.value && requiresGlobalV2Disabled(config.multiAgentMode, true)) {
        const transition = transitionMultiAgentV2(false, next => runCodexFeatures(next ? "enable" : "disable", deps));
        if (!transition.ok) { changed = false; return emit(false, ["Native hybrid-mode transition failed. Read ocx v2 status before retrying."]); }
        changed ||= transition.changed;
      }
      if (parsed.value) config.keepNativeChatGptOnV1 = true;
      else deleteConfigTopLevelKey(config, "keepNativeChatGptOnV1");
      saveConfig(config);
      successLines = [parsed.value
        ? "keep_native_chatgpt_on_v1: ON — ChatGPT-native rows stay v1 when mode is v2 (new sessions)."
        : "keep_native_chatgpt_on_v1: OFF — ChatGPT-native rows follow v1/base/v2 (new sessions)."];
    } else {
      const want = parsed.verb === "on";
      if (want && requiresGlobalV2Disabled(config.multiAgentMode, config.keepNativeChatGptOnV1 === true)) {
        return emit(false, ["v2 on: incompatible with keep-native-v1 while mode is v2 — Codex's global multi_agent_v2 overrides the native v1 catalog pin. Run 'ocx v2 keep-native-v1 off' first."]);
      }
      const transition = transitionMultiAgentV2(want, next => runCodexFeatures(next ? "enable" : "disable", deps));
      if (!transition.ok) return emit(false, ["Native feature transition failed. Read ocx v2 status before retrying."]);
      changed = transition.changed;
      if (!changed) return emit(true, [`multi_agent_v2 already ${want ? "ON" : "OFF"} — nothing to do.`]);
      successLines = [v2StatusLine(want),
        "Applies to NEW sessions; running sessions keep their pinned multi-agent version. Restart the Codex app (or wait out its picker cache) to see the ladder change."];
    }
    // Preserve the legacy graph: mode/keep and changed toggles sync even with no port.
    try {
      const port = findPort ? await findPort() : undefined;
      const result = deps.sync ? await deps.sync(port)
        : await (await import("../codex/sync")).syncModelsToCodex(port, undefined, parsed.json ? null : log);
      sync = v2LocalSyncResult(result);
    } catch { sync = { status: "failed", ok: false }; }
    if (sync.ok && parsed.verb === "keep-native-v1" && unchangedKeep) {
      const outcome = sync.status !== "skipped" && "catalog" in sync && sync.catalog?.converged
        ? "catalog re-synced." : "catalog sync skipped by policy.";
      successLines = [`keep_native_chatgpt_on_v1 already ${parsed.value ? "ON" : "OFF"} — ${outcome}`];
    }
    return emit(sync.ok, sync.ok ? successLines
      : ["catalog resync failed or is unverified; local V2 settings landed. Read ocx v2 status, then run ocx sync."]);
  } catch {
    changed = null;
    return emit(false, ["Local V2 operation failed; native or saved settings may have changed. Read ocx v2 status before retrying; no rollback is implied."]);
  }
}
