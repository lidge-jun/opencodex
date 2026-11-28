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
import { getAgentsEnabled, getAgentsMaxDepth, getLogicalMaxThreads, getMultiAgentModeHintText, getSubagentDeveloperInstructions, hasAgentsMaxThreads, isMultiAgentV2Enabled, setMultiAgentModeHintText, transitionMultiAgentV2 } from "../codex/features";

import type { ResolveDeps, SpawnInvocation } from "../lib/win-exec";
import { validatedCodexExecInvocation } from "../codex/exec-boundary";
import { deleteConfigTopLevelKey, loadConfig, saveConfig } from "../config";
import {
  MULTI_AGENT_MODE_BY_MODEL_LIMIT, hasMultiAgentModelMode, resolveMultiAgentMode, resolveMultiAgentModeByModel, unmatchedMultiAgentModelModes,
} from "../config/multi-agent-surface";
import type { OcxConfig } from "../types";
import { resolveAndPersistCodexRuntime, type ResolveCodexRuntimeDeps } from "../codex/runtime";
import { withCodexCliSelectionParentWriteAsync } from "../codex/cli-update-selection-gate";

export interface V2CliDeps {
  execFile?: (file: string, args: string[], options?: SpawnInvocation["options"] & { env?: NodeJS.ProcessEnv }) => void;
  isEnabled?: typeof isMultiAgentV2Enabled;
  hasMaxThreads?: typeof hasAgentsMaxThreads;
  sync?: (port?: number) => Promise<unknown>;
  runtimeApi?: RuntimeApiDeps;
  /** Internal seam: bypass executable discovery only when an exec implementation is injected. */
  featuresInvocation?: (action: "enable" | "disable") => SpawnInvocation;
  log?: Pick<Console, "log" | "error">;
}

export type CodexFeaturesInvocationDeps =
  & ResolveDeps
  & Pick<ResolveCodexRuntimeDeps, "existsSync" | "execFileSync" | "configDir" | "readFileSync"
    | "readBundleIdentifier" | "macBundleTrustReason" | "executable" | "realpath">
  & { requireAvailable?: boolean };

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
  const resolved = resolveAndPersistCodexRuntime({
    env: deps.env ?? process.env,
    platform,
    existsSync: deps.existsSync,
    execFileSync: deps.execFileSync,
    configDir: deps.configDir,
    readFileSync: deps.readFileSync,
    readBundleIdentifier: deps.readBundleIdentifier,
    macBundleTrustReason: deps.macBundleTrustReason,
    executable: deps.executable,
    realpath: deps.realpath,
  });
  if (deps.requireAvailable && resolved.runtime.source === "fallback" && resolved.runtime.version === null) {
    throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
  }
  const command = resolved.runtime.command || "codex";
  return validatedCodexExecInvocation(command, ["features", action, feature], {
    env: deps.env,
    platform,
    exists: deps.exists,
    executable: deps.executable,
    realpath: deps.realpath,
    macBundleTrustReason: deps.macBundleTrustReason,
  });
}

export async function codexFeaturesInvocationAsync(action: "enable" | "disable", feature = "multi_agent_v2",
  platform: NodeJS.Platform = process.platform, deps: CodexFeaturesInvocationDeps = {}): Promise<SpawnInvocation> {
  return withCodexCliSelectionParentWriteAsync(() => codexFeaturesInvocation(action, feature, platform, deps), { configDir: deps.configDir });
}

/**
 * Run `codex features <action> <feature>` synchronously - the management API
 * fallback when no deps toggle is injected. Shares the invocation builder and
 * the bounded timeout/stdio options so every production toggle path behaves
 * identically.
 */
export function runCodexFeaturesCommand(
  action: "enable" | "disable",
  feature: string,
  env: NodeJS.ProcessEnv,
  validateBeforeSpawn: () => void,
  preparedInvocation?: SpawnInvocation,
): void {
  const inv = preparedInvocation ?? codexFeaturesInvocation(action, feature, process.platform, { env });
  validateBeforeSpawn();
  execFileSync(inv.file, inv.args,
    {
      stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, windowsHide: true, encoding: "utf8",
      ...inv.options,
      env,
    });
}

function runCodexFeatures(action: "enable" | "disable", deps: V2CliDeps, env: NodeJS.ProcessEnv, validateBeforeSpawn: () => void): void {
  if (deps.execFile) {
    const inv = deps.featuresInvocation ? deps.featuresInvocation(action)
      : codexFeaturesInvocation(action, "multi_agent_v2", process.platform, { env });
    validateBeforeSpawn();
    deps.execFile(inv.file, inv.args, { ...inv.options, env });
    return;
  }
  runCodexFeaturesCommand(action, "multi_agent_v2", env, validateBeforeSpawn);
}

export function v2StatusLine(enabled: boolean): string {
  return enabled
    ? "multi_agent_v2: ON — global V2 override active"
    : "multi_agent_v2: OFF — model catalog pins and defaults decide the surface";
}

export function multiAgentModeLine(mode: string, keepNativeChatGptOnV1 = false): string {
  switch (mode) {
    case "v1": return "multi_agent_mode: v1 — ALL models forced to v1 surface (upstream pins overridden)";
    case "v2-plaintext": return "multi_agent_mode: v2-plaintext — new sessions select V2; subsequent eligible canonical ChatGPT requests, including existing V2 sessions, use experimental plaintext over HTTPS; global override stays OFF";
    case "v2": return keepNativeChatGptOnV1
      ? "multi_agent_mode: v2 hybrid — ChatGPT-native models use v1; routed models use v2"
      : "multi_agent_mode: v2 — ALL models forced to v2 surface (upstream pins overridden)";
    default: return "multi_agent_mode: default — upstream model pins respected (sol/terra=v2, luna=v1, rest=codex flag)";
  }
}

function requiresGlobalV2Disabled(multiAgentMode: string | undefined, keepNativeChatGptOnV1: boolean): boolean {
  return multiAgentMode === "v2-plaintext" || (multiAgentMode === "v2" && keepNativeChatGptOnV1);
}

/** A per-model v1 entry is a catalog pin too, so the global override defeats it the same way. */
function hasV1ModelPin(config: OcxConfig): boolean {
  return hasMultiAgentModelMode(config, "v1");
}

const V2_ON_V1_MODEL_PIN = "v2 on: incompatible with a v1 model-mode entry. Codex's global multi_agent_v2 overrides that model's v1 catalog pin. Run 'ocx v2 model-mode <model> default' for each v1 entry first.";

export function multiAgentModeByModelLines(config: OcxConfig, globalV2Enabled: boolean): string[] {
  const entries = [...resolveMultiAgentModeByModel(config)];
  if (entries.length === 0) return ["multi_agent_mode_by_model: (none: every model follows multi_agent_mode)"];
  return ["multi_agent_mode_by_model:", ...entries.map(([model, mode]) => `  ${model}: ${mode}`),
    ...(globalV2Enabled && hasV1ModelPin(config)
      ? ["multi_agent_mode_by_model: CONFLICT (global multi_agent_v2 overrides the v1 entries); run 'ocx v2 off' to reconcile"] : [])];
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
    log.log(mode === "v2-plaintext"
      ? "keep_native_chatgpt_on_v1: inactive in v2-plaintext mode; stored preference is preserved"
      : cfg.keepNativeChatGptOnV1 === true
      ? requiresGlobalV2Disabled(mode, keepNativeV1) && isEnabled()
        ? "keep_native_chatgpt_on_v1: CONFLICT — global multi_agent_v2 overrides the native v1 catalog pin; run 'ocx v2 keep-native-v1 on' to reconcile"
        : "keep_native_chatgpt_on_v1: ON — global V2 override is off; ChatGPT-native rows use v1 and routed rows use v2 when mode is v2"
      : "keep_native_chatgpt_on_v1: OFF");
    for (const line of multiAgentModeByModelLines(cfg, isEnabled())) log.log(line);
    const threads = getLogicalMaxThreads();
    log.log(`max_threads: ${threads ?? "(unset — codex default)"}`);
    const v2Active = isEnabled() || mode === "v2-plaintext";
    const agentsEnabled = getAgentsEnabled();
    log.log(`agents.enabled: ${agentsEnabled === null ? "(unset — upstream default true)" : agentsEnabled}`);
    const maxDepth = getAgentsMaxDepth();
    // max_depth is V1-only upstream; say so whenever V2 is active so the number
    // cannot be misread as an effective V2 limit.
    log.log(`agents.max_depth: ${maxDepth ?? "(unset — upstream default 1)"}${v2Active ? " (V1-only — ignored by V2 sessions)" : ""}`);
    const instructions = getSubagentDeveloperInstructions();
    log.log(`subagent_developer_instructions: ${instructions === null ? "(unset — children inherit)" : instructions === "" ? '"" (clears inherited instructions)' : JSON.stringify(instructions)}`);
    const modeHint = getMultiAgentModeHintText();
    log.log(`multi_agent_mode_hint_text: ${modeHint === null ? "(unset — effort-derived policy: ultra=proactive, else explicit)" : JSON.stringify(modeHint)}`);
    if (isEnabled() && hasMaxThreads()) {
      log.log("WARNING: [agents] max_concurrent_threads_per_session / max_threads is set — codex refuses to start while multi_agent_v2 is enabled. Remove the agents limit from config.toml (concurrency lives in features.multi_agent_v2.max_concurrent_threads_per_session).");
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
      const result = parsed.value === null ? setMultiAgentModeHintText(null)
        : await withCodexCliSelectionParentWriteAsync(() => setMultiAgentModeHintText(parsed.value));
      if (!result.ok) return emit(false, ["Unable to write the native mode hint. Check Codex support and ownership, then read ocx v2 status."]);
      changed = result.changed;
      return emit(true, [result.changed ? "multi_agent_mode_hint_text saved — applies to new sessions." : "multi_agent_mode_hint_text already set — nothing to do."]);
    }
    if (parsed.verb === "threads") {
      // Admission can wait on recovery ACL checks; the feature state is read once admitted, in
      // the same synchronous turn as the transition, so a change made meanwhile is not undone.
      let enabled = false;
      const result = await withCodexCliSelectionParentWriteAsync(() => {
        enabled = (deps.isEnabled ?? isMultiAgentV2Enabled)();
        return transitionMultiAgentV2(enabled, (next, env, validate) => runCodexFeatures(next ? "enable" : "disable", deps, env, validate), { threadLimit: parsed.value });
      });
      if (!result.ok) return emit(false, ["Unable to update the native thread limit. Read ocx v2 status before retrying."]);
      changed = result.changed;
      return emit(true, [changed ? `max_threads = ${parsed.value} (${enabled ? "v2" : "v1"}) — applies to new sessions.` : `max_threads already ${parsed.value} — nothing to do.`]);
    }
    // Every awaited admission below re-reads, decides and saves the config inside its
    // synchronous callback, so a setting changed while admission waited is neither
    // overruled by a stale decision nor overwritten by a stale save.
    let config = loadConfig();
    let successLines: string[];
    let unchangedKeep: boolean | undefined;
    if (parsed.verb === "mode") {
      const needsPlaintextAcknowledgment = () => parsed.value === "v2-plaintext"
        && config.multiAgentMode !== "v2-plaintext" && !parsed.plaintextAcknowledged;
      const refuseUnacknowledgedPlaintext = () => emit(false, ["Entering v2-plaintext requires --acknowledge-plaintext-agent-messages. Enabled compilation also affects subsequent eligible canonical ChatGPT requests from existing V2 sessions. Task text can remain in Codex history, provider requests and local response/debug state; TLS and authentication stay enabled. Existing ciphertext is not decrypted, and disabling does not delete retained copies."]);
      if (needsPlaintextAcknowledgment()) return refuseUnacknowledgedPlaintext();
      const persistMode = (): boolean => {
        const before = config.multiAgentMode ?? "default";
        if (parsed.value === "default") deleteConfigTopLevelKey(config, "multiAgentMode");
        else config.multiAgentMode = parsed.value;
        saveConfig(config);
        return before !== parsed.value;
      };
      if (parsed.value !== "default") {
        let modeChanged = false;
        let acknowledgmentRequired = false;
        const transition = await withCodexCliSelectionParentWriteAsync(() => {
          config = loadConfig();
          if (needsPlaintextAcknowledgment()) {
            acknowledgmentRequired = true;
            return { ok: true as const, changed: false };
          }
          const target = parsed.value === "v2" && config.keepNativeChatGptOnV1 !== true && !hasV1ModelPin(config);
          const result = transitionMultiAgentV2(target, (next, env, validate) => runCodexFeatures(next ? "enable" : "disable", deps, env, validate));
          if (result.ok) modeChanged = persistMode();
          return result;
        });
        if (acknowledgmentRequired) return refuseUnacknowledgedPlaintext();
        if (!transition.ok) { changed = false; return emit(false, ["Native mode transition failed. Read ocx v2 status before retrying."]); }
        changed = modeChanged || transition.changed;
      } else {
        changed = persistMode();
      }
      successLines = [multiAgentModeLine(parsed.value, config.keepNativeChatGptOnV1 === true),
        "Catalog pins apply to NEW sessions; running sessions keep their pinned multi-agent version. Plaintext compilation follows the current setting for subsequent eligible canonical ChatGPT requests, including existing V2 sessions. Existing ciphertext is not decrypted, stored history is not rewritten, and disabling does not delete retained copies."];
    } else if (parsed.verb === "model-mode") {
      const stored = () => resolveMultiAgentModeByModel(config).get(parsed.model);
      const needsPlaintextAcknowledgment = () => parsed.value === "v2-plaintext"
        && stored() !== "v2-plaintext" && !parsed.plaintextAcknowledged;
      const refuseUnacknowledgedPlaintext = () => emit(false, ["A v2-plaintext model-mode entry requires --acknowledge-plaintext-agent-messages. That model's eligible canonical ChatGPT requests are compiled to plaintext, including existing V2 sessions. Task text can remain in Codex history, provider requests and local response/debug state; existing ciphertext is not decrypted."]);
      if (needsPlaintextAcknowledgment()) return refuseUnacknowledgedPlaintext();
      const current = resolveMultiAgentModeByModel(config);
      if (parsed.value !== null && !current.has(parsed.model) && current.size >= MULTI_AGENT_MODE_BY_MODEL_LIMIT) {
        return emit(false, [`multi_agent_mode_by_model already holds ${MULTI_AGENT_MODE_BY_MODEL_LIMIT} entries. Remove one with 'ocx v2 model-mode <model> default' before adding ${parsed.model}.`]);
      }
      let unchangedModel = false;
      const persistModelMode = (): void => {
        unchangedModel = stored() === (parsed.value ?? undefined);
        const next = new Map(resolveMultiAgentModeByModel(config));
        if (parsed.value === null) next.delete(parsed.model);
        else next.set(parsed.model, parsed.value);
        if (next.size > 0) config.multiAgentModeByModel = Object.fromEntries(next);
        else deleteConfigTopLevelKey(config, "multiAgentModeByModel");
        saveConfig(config);
      };
      if (parsed.value === "v1") {
        // A v1 pin needs the global override off. Every explicit mode turns it off here, as
        // keep-native-v1 does; base mode leaves the override to the operator and refuses instead.
        let baseModeConflict = false;
        const transition = await withCodexCliSelectionParentWriteAsync(() => {
          config = loadConfig();
          const baseMode = resolveMultiAgentMode(config) === "default";
          if (baseMode && (deps.isEnabled ?? isMultiAgentV2Enabled)()) { baseModeConflict = true; return { ok: true as const, changed: false }; }
          const result = baseMode ? { ok: true as const, changed: false }
            : transitionMultiAgentV2(false, (next, env, validate) => runCodexFeatures(next ? "enable" : "disable", deps, env, validate));
          if (result.ok) persistModelMode();
          return result;
        });
        if (baseModeConflict) return emit(false, ["model-mode v1: needs Codex's global multi_agent_v2 override off, and base mode leaves that override to you. Run 'ocx v2 off', or select a mode with 'ocx v2 mode <v1|v2|v2-plaintext>' first."]);
        if (!transition.ok) { changed = false; return emit(false, ["Native model-mode transition failed. Read ocx v2 status before retrying."]); }
        changed = !unchangedModel || transition.changed;
      } else {
        persistModelMode();
        changed = !unchangedModel;
      }
      successLines = [parsed.value === null
        ? `multi_agent_mode_by_model: ${parsed.model} removed. It follows multi_agent_mode again (new sessions).`
        : `multi_agent_mode_by_model: ${parsed.model} = ${parsed.value} (new sessions).`,
        ...(parsed.value === "v2-plaintext" ? ["Plaintext compilation follows this entry for that model's subsequent eligible canonical ChatGPT requests, including existing V2 sessions."] : [])];
    } else if (parsed.verb === "keep-native-v1") {
      const persistKeep = (): void => {
        unchangedKeep = (config.keepNativeChatGptOnV1 === true) === parsed.value;
        if (parsed.value) config.keepNativeChatGptOnV1 = true;
        else deleteConfigTopLevelKey(config, "keepNativeChatGptOnV1");
        saveConfig(config);
      };
      if (parsed.value && requiresGlobalV2Disabled(config.multiAgentMode, true)) {
        const transition = await withCodexCliSelectionParentWriteAsync(() => {
          config = loadConfig();
          // Revalidated once admitted: mode may have left v2 while admission waited.
          const result = requiresGlobalV2Disabled(config.multiAgentMode, true)
            ? transitionMultiAgentV2(false, (next, env, validate) => runCodexFeatures(next ? "enable" : "disable", deps, env, validate))
            : { ok: true as const, changed: false };
          if (result.ok) persistKeep();
          return result;
        });
        if (!transition.ok) { changed = false; return emit(false, ["Native hybrid-mode transition failed. Read ocx v2 status before retrying."]); }
        changed = !unchangedKeep || transition.changed;
      } else {
        persistKeep();
        changed = !unchangedKeep;
      }
      successLines = [parsed.value
        ? "keep_native_chatgpt_on_v1: ON — ChatGPT-native rows stay v1 when mode is v2 (new sessions)."
        : "keep_native_chatgpt_on_v1: OFF — ChatGPT-native rows follow v1/base/v2 (new sessions)."];
    } else {
      const want = parsed.verb === "on";
      if (want && requiresGlobalV2Disabled(config.multiAgentMode, config.keepNativeChatGptOnV1 === true)) {
        if (config.multiAgentMode === "v2-plaintext") return emit(false, ["v2 on: incompatible with v2-plaintext. Its catalog selects V2 for new sessions while the global override stays OFF. Select another mode explicitly first."]);
        return emit(false, ["v2 on: incompatible with keep-native-v1 while mode is v2 — Codex's global multi_agent_v2 overrides the native v1 catalog pin. Run 'ocx v2 keep-native-v1 off' first."]);
      }
      if (want && hasV1ModelPin(config)) return emit(false, [V2_ON_V1_MODEL_PIN]);
      let incompatible = false;
      let v1ModelPin = false;
      const transition = await withCodexCliSelectionParentWriteAsync(() => {
        // Revalidated once admitted: keep-native-v1 or mode v2 may have been set meanwhile.
        config = loadConfig();
        if (want && requiresGlobalV2Disabled(config.multiAgentMode, config.keepNativeChatGptOnV1 === true)) {
          incompatible = true;
          return { ok: true as const, changed: false };
        }
        if (want && hasV1ModelPin(config)) {
          v1ModelPin = true;
          return { ok: true as const, changed: false };
        }
        return transitionMultiAgentV2(want, (next, env, validate) => runCodexFeatures(next ? "enable" : "disable", deps, env, validate));
      });
      if (incompatible) {
        if (config.multiAgentMode === "v2-plaintext") return emit(false, ["v2 on: incompatible with v2-plaintext. Its catalog selects V2 for new sessions while the global override stays OFF. Select another mode explicitly first."]);
        return emit(false, ["v2 on: incompatible with keep-native-v1 while mode is v2 — Codex's global multi_agent_v2 overrides the native v1 catalog pin. Run 'ocx v2 keep-native-v1 off' first."]);
      }
      if (v1ModelPin) return emit(false, [V2_ON_V1_MODEL_PIN]);
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
    if (sync.ok && parsed.verb === "model-mode" && !changed) {
      successLines = [`multi_agent_mode_by_model: ${parsed.model} already ${parsed.value ?? "following multi_agent_mode"}, nothing to do.`];
    }
    if (sync.ok && parsed.verb === "model-mode" && parsed.value !== null) {
      // After the sync, so the catalog read is the one this entry was just applied to.
      const { readCatalog, readCodexCatalogPath } = await import("../codex/catalog");
      const rows = readCatalog(readCodexCatalogPath())?.models;
      if (rows && unmatchedMultiAgentModelModes([parsed.model], rows.flatMap(row => typeof row.slug === "string" ? [row.slug] : [])).length > 0) {
        successLines.push(`No catalog model matches '${parsed.model}'. The entry is stored and applies if that model appears; check the id with 'ocx models list'.`);
      }
    }
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
