import { isValidVisionTimeoutMs } from "../vision/plan";
import { isDeclaredReasoningEffort } from "../reasoning-effort";
import { runCatalogAction } from "./catalog-command-result";
import { serializeManagementJson } from "./json-input";
import { projectSettingsApply } from "./settings-result";
import { CliUsageError, desktopSwitchApplyReason, printData, runtimeBaseUrl, runtimeRequest,
  takeFlag, takeOptionWithSyntax, type RuntimeApiDeps } from "./runtime-api";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function boolean(args: string[], flag: string): boolean | undefined {
  const value = takeOptionWithSyntax(args, flag)?.value;
  if (value === undefined) return undefined;
  if (["on", "true", "yes", "1", "enabled"].includes(value.toLowerCase())) return true;
  if (["off", "false", "no", "0", "disabled"].includes(value.toLowerCase())) return false;
  throw new CliUsageError(`${flag} must be on or off`);
}
function invalid(): never { throw new Error("Invalid agent settings receipt"); }

/** Additive default-sync option; normalized server state, not a native-write claim. */
export async function handleInjectionDefaults(argsInput: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCatalogAction(async () => {
    const args = [...argsInput];
    if (args.shift() !== "set") throw new CliUsageError("--sync-codex-defaults requires agent injection set");
    const wantsJson = takeFlag(args, "--json");
    const sync = boolean(args, "--sync-codex-defaults");
    const guidance = boolean(args, "--guidance");
    const body: Record<string, unknown> = {};
    for (const [flag, key] of [["--model", "model"], ["--effort", "effort"], ["--prompt", "prompt"]] as const) {
      const value = takeOptionWithSyntax(args, flag)?.value;
      if (value !== undefined) body[key] = value === "-" ? null : value;
    }
    if (sync === undefined || args.length) throw new CliUsageError("Provide --sync-codex-defaults on or off and supported injection options");
    body.syncCodexSubagentDefaults = sync;
    if (guidance !== undefined) body.multiAgentGuidanceEnabled = guidance;
    const pinned = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
    const value = await runtimeRequest("/api/injection-model", { method: "PUT", redirect: "error", body: serializeManagementJson(body) }, pinned);
    if (!record(value) || value.ok !== true || typeof value.multiAgentGuidanceEnabled !== "boolean"
      || typeof value.syncCodexSubagentDefaults !== "boolean"
      || ["model", "effort", "prompt"].some(key => value[key] !== null && typeof value[key] !== "string")) invalid();
    const data = { ok: true, multiAgentGuidanceEnabled: value.multiAgentGuidanceEnabled,
      syncCodexSubagentDefaults: value.syncCodexSubagentDefaults, model: value.model, effort: value.effort, prompt: value.prompt };
    printData(data, wantsJson, ["Injection settings saved.", `Guidance: ${data.multiAgentGuidanceEnabled}`,
      `Effective default-sync setting: ${data.syncCodexSubagentDefaults}`]);
    return 0;
  });
}

/** New sidecar fields share the existing candidate normalization and partial PUT contract. */
export async function handleSidecarRuntimeSettings(argsInput: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCatalogAction(async () => {
    const args = [...argsInput], section = args.shift();
    if (section !== "web" && section !== "vision") throw new CliUsageError("Sidecar settings require web or vision");
    const wantsJson = takeFlag(args, "--json");
    const model = takeOptionWithSyntax(args, "--model")?.value;
    const backend = takeOptionWithSyntax(args, "--backend")?.value;
    const reasoning = takeOptionWithSyntax(args, "--reasoning")?.value;
    const max = takeOptionWithSyntax(args, "--max-descriptions")?.value;
    const timeout = takeOptionWithSyntax(args, "--timeout-ms")?.value;
    const enabled = boolean(args, "--enabled");
    const stream = boolean(args, "--stream-routed-output");
    if (args.length || (section === "web" && (max !== undefined || timeout !== undefined))
      || (section === "vision" && stream !== undefined)) throw new CliUsageError("Unsupported option for this sidecar section");
    const settings: Record<string, unknown> = {};
    if (model !== undefined) settings.model = model === "-" ? "" : model;
    if (backend !== undefined) settings.backend = backend === "-" ? null : backend;
    if (reasoning !== undefined) settings.reasoning = reasoning;
    if (enabled !== undefined) settings.enabled = enabled;
    if (stream !== undefined) settings.streamRoutedModelOutput = stream;
    if (max !== undefined) {
      const value = Number(max);
      if (!max.trim() || !Number.isSafeInteger(value) || value < 1) throw new CliUsageError("--max-descriptions requires a positive integer");
      settings.maxDescriptionsPerTurn = value;
    }
    if (timeout !== undefined) {
      const value = Number(timeout);
      if (!timeout.trim() || !isValidVisionTimeoutMs(value)) throw new CliUsageError("--timeout-ms requires an integer from 1 to 2147483647");
      settings.timeoutMs = value;
    }
    if (!Object.keys(settings).length) throw new CliUsageError("Provide at least one sidecar setting");
    const pinned = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
    if (section === "web" && model !== undefined && model !== "-") {
      const offered = await runtimeRequest("/api/sidecar-settings", { redirect: "error" }, pinned);
      if (!record(offered) || !Array.isArray(offered.webSearchModels)) invalid();
      const requestedBackend = backend === "-" ? "openai" : backend;
      const option = offered.webSearchModels.find(row => record(row)
        && (row.value === model || row.model === model)
        && (requestedBackend === undefined || row.backend === requestedBackend));
      if (option !== undefined) {
        if (!record(option) || typeof option.model !== "string" || typeof option.backend !== "string"
          || !["openai", "anthropic", "xai", "gemini", "exa"].includes(option.backend)) invalid();
        settings.model = option.model;
        if (backend !== "-") settings.backend = option.backend;
      }
    }
    const value = await runtimeRequest("/api/sidecar-settings", { method: "PUT", redirect: "error",
      body: serializeManagementJson(section === "web" ? { webSearch: settings } : { vision: settings }) }, pinned);
    if (!record(value) || value.ok !== true) invalid();
    const raw = section === "web" ? value.webSearch : value.vision;
    const backends = section === "web" ? ["openai", "anthropic", "xai", "gemini", "exa"] : ["openai", "anthropic", "routed"];
    if (!record(raw) || typeof raw.enabled !== "boolean" || typeof raw.model !== "string" || !raw.model.trim()
      || (raw.backend !== undefined && (typeof raw.backend !== "string" || !backends.includes(raw.backend)))) invalid();
    const selected: Record<string, unknown> = { enabled: raw.enabled, model: raw.model,
      ...(raw.backend !== undefined ? { backend: raw.backend } : {}) };
    let verified = true;
    if (section === "web") {
      if (typeof raw.streamRoutedModelOutput !== "boolean") invalid();
      selected.streamRoutedModelOutput = raw.streamRoutedModelOutput;
      if (stream !== undefined && raw.streamRoutedModelOutput !== stream) verified = false;
    } else {
      if (!isValidVisionTimeoutMs(raw.timeoutMs) || typeof raw.maxDescriptionsPerTurn !== "number"
        || !Number.isSafeInteger(raw.maxDescriptionsPerTurn) || raw.maxDescriptionsPerTurn < 1
        || (raw.reasoning !== undefined && (typeof raw.reasoning !== "string" || !isDeclaredReasoningEffort(raw.reasoning)))) invalid();
      selected.timeoutMs = raw.timeoutMs;
      selected.maxDescriptionsPerTurn = raw.maxDescriptionsPerTurn;
      if (raw.reasoning !== undefined) selected.reasoning = raw.reasoning;
      if (timeout !== undefined && raw.timeoutMs !== Number(timeout)) verified = false;
    }
    const apply = projectSettingsApply(value.codexWebSearch);
    if (!apply) invalid();
    const data = { ok: true, [section === "web" ? "webSearch" : "vision"]: selected, codexWebSearch: apply,
      ...(!verified ? { verification: "unverified" } : {}) };
    const lines = [`${section} sidecar settings saved.`];
    if (!apply.applied) lines.push(`Native apply: ${desktopSwitchApplyReason(apply.reason)}.`);
    if (!verified) lines.push("The target did not confirm the requested new setting. Read back before retrying.");
    printData(data, wantsJson, lines);
    return !verified || (!apply.applied && apply.reason !== "not_requested") ? 1 : 0;
  });
}
