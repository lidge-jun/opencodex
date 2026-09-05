import { loadConfig, saveConfig } from "../config";
import {
  CODEX_REASONING_LEVELS,
  configuredReasoningEfforts,
  isDeclaredReasoningEffort,
  mapReasoningEffort,
  reasoningEffortMapFor,
} from "../reasoning-effort";
import { findLiveProxy } from "../server/proxy-liveness";
import { modelInList, type OcxConfig } from "../types";
import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

export const EFFORT_USAGE = `Usage:
  ocx effort [status] [--json]
  ocx effort <low|medium|high|xhigh|max|ultra|none|minimal|-> [--json]
  ocx effort set [--main <level|->] [--subagent <level|->] [--injection <level|->] [--json]
  ocx effort clear [--json]
  ocx effort model <provider/model|model> [--json]

Note: 'ocx effort clear' resets main and subagent caps but keeps delegation
injection effort. Use 'ocx effort set --injection -' to clear injection effort.`;

function clearable(value: string | undefined): string | null | undefined {
  return value === "-" ? null : value;
}

function validateEffortLevel(level: string | null | undefined, label: string): string | null | undefined {
  if (level === undefined || level === null) return level;
  const trimmed = level.trim();
  if (trimmed === "-" || trimmed === "") return null;
  if (!isDeclaredReasoningEffort(trimmed)) {
    throw new CliUsageError(
      `unknown reasoning effort "${trimmed}" for ${label} (allowed: ${CODEX_REASONING_LEVELS.map(l => l.effort).join(", ")}, none, minimal, -)`,
      EFFORT_USAGE,
    );
  }
  return trimmed;
}

interface EffortCapsResponse {
  effortCap: string | null;
  subagentEffortCap: string | null;
  efforts: string[];
}

interface InjectionResponse {
  effort?: string | null;
}

async function getLiveStatus(deps: RuntimeApiDeps): Promise<{
  effortCap: string | null;
  subagentEffortCap: string | null;
  injectionEffort: string | null;
  efforts: string[];
  source: "runtime";
}> {
  // Propagate API failures once live mode is selected — do not swallow 401/500 into null (#3528 review).
  const [caps, injection] = await Promise.all([
    runtimeRequest<EffortCapsResponse>("/api/effort-caps", {}, deps),
    runtimeRequest<InjectionResponse>("/api/injection-model", {}, deps),
  ]);
  return {
    effortCap: caps.effortCap ?? null,
    subagentEffortCap: caps.subagentEffortCap ?? null,
    injectionEffort: injection?.effort ?? null,
    efforts: caps.efforts ?? CODEX_REASONING_LEVELS.map(l => l.effort),
    source: "runtime",
  };
}

function getOfflineStatus(): {
  effortCap: string | null;
  subagentEffortCap: string | null;
  injectionEffort: string | null;
  efforts: string[];
  source: "config";
} {
  const config = loadConfig();
  return {
    effortCap: config.effortCap ?? null,
    subagentEffortCap: config.subagentEffortCap ?? null,
    injectionEffort: config.injectionEffort ?? null,
    efforts: CODEX_REASONING_LEVELS.map(l => l.effort),
    source: "config",
  };
}

async function status(wantsJson: boolean, deps: RuntimeApiDeps): Promise<void> {
  let data: {
    effortCap: string | null;
    subagentEffortCap: string | null;
    injectionEffort: string | null;
    efforts: string[];
    source: "runtime" | "config";
  };

  const liveFinder = deps.findLiveProxy ?? findLiveProxy;
  const live = await liveFinder().catch(() => null);
  const isLive = Boolean(live || deps.baseUrl);

  if (isLive) {
    // Once live proxy / baseUrl is selected, propagate API failures; do not silently substitute local config (#3528 review).
    data = await getLiveStatus(deps);
  } else {
    data = getOfflineStatus();
  }

  const lines = [
    `Reasoning effort status (${data.source === "runtime" ? "live proxy" : "offline config"}):`,
    `  Main agent effort cap:     ${data.effortCap ?? "(unset — no cap)"}`,
    `  Subagent effort cap:       ${data.subagentEffortCap ?? "(unset — no cap)"}`,
    `  Subagent injection effort: ${data.injectionEffort ?? "(unset — inherits parent session)"}`,
    "",
    "Supported Codex reasoning effort ladder:",
    ...CODEX_REASONING_LEVELS.map(l => `  - ${l.effort.padEnd(8)} ${l.description}`),
  ];

  printData(data, wantsJson, lines);
}

async function setEffort(
  options: {
    main?: string | null;
    subagent?: string | null;
    injection?: string | null;
  },
  wantsJson: boolean,
  deps: RuntimeApiDeps,
): Promise<void> {
  const validatedMain = validateEffortLevel(options.main, "--main");
  const validatedSubagent = validateEffortLevel(options.subagent, "--subagent");
  const validatedInjection = validateEffortLevel(options.injection, "--injection");

  if (validatedMain === undefined && validatedSubagent === undefined && validatedInjection === undefined) {
    throw new CliUsageError("at least one effort option (--main, --subagent, or --injection) is required", EFFORT_USAGE);
  }

  // Probe live proxy BEFORE any mutation attempt
  const liveFinder = deps.findLiveProxy ?? findLiveProxy;
  const live = await liveFinder().catch(() => null);
  const isLive = Boolean(live || deps.baseUrl);

  if (isLive) {
    // Live update path: once live proxy / baseUrl is selected, HTTP 4xx/5xx or transport
    // errors must never fall through to silent offline config writes (#3528 review).
    const capsBody: Record<string, unknown> = {};
    if (validatedMain !== undefined) capsBody.effortCap = validatedMain;
    if (validatedSubagent !== undefined) capsBody.subagentEffortCap = validatedSubagent;

    let capsCommitted = false;
    let injectionCommitted = false;

    if (Object.keys(capsBody).length > 0) {
      await runtimeRequest<EffortCapsResponse>("/api/effort-caps", {
        method: "PUT",
        body: JSON.stringify(capsBody),
      }, deps);
      capsCommitted = true;
    }

    if (validatedInjection !== undefined) {
      try {
        await runtimeRequest<InjectionResponse>("/api/injection-model", {
          method: "PUT",
          body: JSON.stringify({ effort: validatedInjection }),
        }, deps);
        injectionCommitted = true;
      } catch (err) {
        if (capsCommitted) {
          const errMsg = err instanceof Error ? err.message : String(err);
          throw new Error(`effort caps were updated on live proxy, but injection effort failed: ${errMsg}`);
        }
        throw err;
      }
    }

    // Accurately reflect live state: query fresh live status so unchanged caps are never serialized as null.
    // If the read fails after a successful PUT, wrap with explicit partial-application error (#3528 review).
    let finalStatus: { effortCap: string | null; subagentEffortCap: string | null; injectionEffort: string | null; efforts: string[] };
    try {
      finalStatus = await getLiveStatus(deps);
    } catch (err) {
      if (capsCommitted || injectionCommitted) {
        const errMsg = err instanceof Error ? err.message : String(err);
        throw new Error(`live state was updated, but verifying live status failed: ${errMsg}`);
      }
      throw err;
    }

    const result = {
      ok: true,
      effortCap: finalStatus.effortCap,
      subagentEffortCap: finalStatus.subagentEffortCap,
      injectionEffort: finalStatus.injectionEffort,
      source: "runtime" as const,
    };

    printData(result, wantsJson, [
      "Effort caps updated on live proxy:",
      ...(validatedMain !== undefined ? [`  Main agent effort cap:     ${validatedMain ?? "(cleared)"}`] : []),
      ...(validatedSubagent !== undefined ? [`  Subagent effort cap:       ${validatedSubagent ?? "(cleared)"}`] : []),
      ...(validatedInjection !== undefined ? [`  Subagent injection effort: ${validatedInjection ?? "(cleared)"}`] : []),
    ]);
    return;
  }

  // Offline persistence path: only reached when no live proxy was found before mutation
  const config = loadConfig();
  if (validatedMain !== undefined) {
    if (validatedMain === null) delete config.effortCap;
    else config.effortCap = validatedMain;
  }
  if (validatedSubagent !== undefined) {
    if (validatedSubagent === null) delete config.subagentEffortCap;
    else config.subagentEffortCap = validatedSubagent;
  }
  if (validatedInjection !== undefined) {
    if (validatedInjection === null) delete config.injectionEffort;
    else config.injectionEffort = validatedInjection;
  }
  saveConfig(config);

  const result = {
    ok: true,
    effortCap: config.effortCap ?? null,
    subagentEffortCap: config.subagentEffortCap ?? null,
    injectionEffort: config.injectionEffort ?? null,
    source: "config" as const,
  };

  printData(result, wantsJson, [
    "[offline] Effort caps updated in config.json (proxy is not running; changes will take effect on next start):",
    ...(validatedMain !== undefined ? [`  Main agent effort cap:     ${validatedMain ?? "(cleared)"}`] : []),
    ...(validatedSubagent !== undefined ? [`  Subagent effort cap:       ${validatedSubagent ?? "(cleared)"}`] : []),
    ...(validatedInjection !== undefined ? [`  Subagent injection effort: ${validatedInjection ?? "(cleared)"}`] : []),
  ]);
}

function inspectModelEffort(modelTarget: string, wantsJson: boolean): void {
  // Reject leading or trailing slash selectors before lookup (#3528 review)
  if (modelTarget.startsWith("/") || modelTarget.endsWith("/")) {
    throw new CliUsageError(
      `invalid model selector "${modelTarget}" (must be <provider/model> or <model> without leading or trailing slashes)`,
      EFFORT_USAGE,
    );
  }

  const config = loadConfig();
  let providerName = "";
  let modelId = modelTarget;

  const slashIndex = modelTarget.indexOf("/");
  if (slashIndex > 0) {
    providerName = modelTarget.slice(0, slashIndex);
    modelId = modelTarget.slice(slashIndex + 1);
  } else {
    providerName = config.defaultProvider || "openai";
  }

  const provider = config.providers[providerName];
  if (!provider) {
    throw new CliUsageError(
      `Provider "${providerName}" is not configured. Configured providers: ${Object.keys(config.providers).join(", ")}`,
      EFFORT_USAGE,
    );
  }

  const isReasoningDisabled = modelInList(provider.noReasoningModels, modelId);
  const efforts = configuredReasoningEfforts(provider, modelId);
  const wireMap = reasoningEffortMapFor(provider, modelId);

  // Derive sample ladder directly from canonical CODEX_REASONING_LEVELS (#3528 review)
  const mappedExamples: Record<string, string | undefined> = {};
  for (const { effort } of CODEX_REASONING_LEVELS) {
    mappedExamples[effort] = mapReasoningEffort(provider, modelId, effort);
  }

  const result = {
    provider: providerName,
    model: modelId,
    reasoningDisabled: isReasoningDisabled,
    supportedEfforts: efforts ?? null,
    wireMap: wireMap ?? null,
    mappedTiers: mappedExamples,
  };

  const lines = [
    `Reasoning effort configuration for ${providerName}/${modelId}:`,
    `  Reasoning disabled: ${isReasoningDisabled ? "yes (noReasoningModels)" : "no"}`,
    `  Supported ladder:   ${efforts ? efforts.join(", ") : "(default / unconstrained)"}`,
    `  Wire mapping overrides: ${wireMap ? JSON.stringify(wireMap) : "(standard provider mapping)"}`,
    "  Sample wire translations:",
    ...Object.entries(mappedExamples).map(([req, wire]) => `    ${req.padEnd(8)} -> ${wire ?? "(omitted/unsupported)"}`),
  ];

  printData(result, wantsJson, lines);
}

export async function handleEffortCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const args = [...argv];
    const wantsJson = takeFlag(args, "--json");

    if (args.length === 0) {
      await status(wantsJson, deps);
      return;
    }

    const rawFirst = args[0]!;
    const first = rawFirst.toLowerCase();

    if (first === "status") {
      args.shift();
      rejectArgs(args, EFFORT_USAGE);
      await status(wantsJson, deps);
      return;
    }

    if (first === "clear" || first === "unset") {
      args.shift();
      rejectArgs(args, EFFORT_USAGE);
      await setEffort({ main: null, subagent: null }, wantsJson, deps);
      return;
    }

    if (first === "set") {
      args.shift();
      const main = clearable(takeOption(args, "--main"));
      const subagent = clearable(takeOption(args, "--subagent"));
      const injection = clearable(takeOption(args, "--injection"));
      rejectArgs(args, EFFORT_USAGE);
      await setEffort({ main, subagent, injection }, wantsJson, deps);
      return;
    }

    if (first === "model") {
      args.shift();
      const target = args.shift();
      if (!target) throw new CliUsageError("model identifier (<provider/model> or <model>) is required", EFFORT_USAGE);
      rejectArgs(args, EFFORT_USAGE);
      inspectModelEffort(target, wantsJson);
      return;
    }

    // Shorthand: check if first argument is an effort level or "-"
    if (first === "-" || isDeclaredReasoningEffort(first)) {
      args.shift();
      rejectArgs(args, EFFORT_USAGE);
      await setEffort({ main: first === "-" ? null : first }, wantsJson, deps);
      return;
    }

    // Shorthand model inspection: preserve raw casing and check slash boundaries (#3528 review)
    if (rawFirst.includes("/")) {
      args.shift();
      rejectArgs(args, EFFORT_USAGE);
      inspectModelEffort(rawFirst, wantsJson);
      return;
    }

    throw new CliUsageError(`unknown effort command or level "${rawFirst}"`, EFFORT_USAGE);
  });
}
