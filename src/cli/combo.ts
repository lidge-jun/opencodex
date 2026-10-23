import { normalizeJevQuotaTiers } from "../combos/jev-quota-config";
import { parseJevSessionPinDuration } from "../combos/jev-session-pin-config";
import { JEV_DECISION_TIMEOUT_MAX_MS, JEV_DECISION_TIMEOUT_MIN_MS } from "../combos/types";
import {
  CliUsageError,
  printData,
  rejectArgs,
  RuntimeApiError,
  runCliAction,
  runtimeRequest,
  runtimeBaseUrl,
  takeFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

import { prepareComboInput } from "./combo-input";
import { printComboWriteResult } from "./combo-result";
import { runCatalogAction } from "./catalog-command-result";
import { serializeManagementJson } from "./json-input";

const USAGE = `Usage:
  ocx combo [list] [--json]
  ocx combo show <id> [--json]
  ocx combo set <id> [--targets <provider/model[:weight],...> | --targets-file <FILE|->]
      [--strategy <failover|round-robin|random|least-used|reset-window|jev>] [--sticky <1-100|->]
      [--effort <low|medium|high|xhigh|max|ultra|->] [--effort-mode <fallback|force|->]
      (force overrides valid client effort and can increase cost/latency) [--alias <name|->]
      [--native-alias [on|off]] [--allow-metered-targets <on|off>] [--display-name <label|->]
      [--description <text|->]
      [--image-input <auto|disabled>] [--reasoning-effort-mode <strict|adaptive>]
      [--decision-provider <provider|-> | --decision-model <route|->] [--decision-timeout <ms|->]
      [--decision-quota-signals <on|off|->] [--decision-quota-tiers <JSON|->]
      [--session-pin <duration|->] (e.g. 20m; keeps a session on JEV's target while active)
      (jev only; the provider must be a configured jev-decision row)
      [--rename-from <id>] [--json]
  ocx combo stats <id> [--range <7d|30d|all>] [--json]
  ocx combo remove <id> --yes [--json]
  ocx combo test [--combo <id>] [--decision-provider <provider|jev> | --decision-model <route>]
      [--decision-timeout <ms>] [--json]
      (one synthetic decision probe through the decision method; may spend a decision call)
  ocx combo discover [--query <text>] [--json]`;

type ComboRow = Record<string, unknown> & { id?: string; model?: string; strategy?: string };
const STRATEGIES = ["failover", "round-robin", "random", "least-used", "reset-window", "jev"] as const;
const isComboStrategy = (value: string): value is typeof STRATEGIES[number] => (STRATEGIES as readonly string[]).includes(value);
// Combo writes print fixed messages instead of server text. When --targets kept a stored JEV
// strategy the user did not name, a refusal of the targets or a JEV setting says so (#7579).
const KEPT_JEV_REJECTED = "combo_targets_rejected_by_kept_jev";
const KEPT_JEV_FIELDS = new Set(["targets", "decisionProvider", "decisionModel", "decisionTimeoutMs", "decisionQuotaSignals", "decisionQuotaTiers", "sessionPin"]);
const SET_ERRORS = {
  [KEPT_JEV_REJECTED]: "The selected target rejected the new targets or the kept jev settings. Without --strategy, --targets keeps the stored jev strategy with its decision method, quota policy and session pin, and the save checks the new targets together with them. Inspect the combo with ocx combo show <id> --json, then fix the targets or those settings, or pass --strategy to change the strategy.",
};

function parseTargets(value: string): Array<{ provider: string; model: string; weight?: number }> {
  const targets = value.split(",").map(part => part.trim()).filter(Boolean).map(part => {
    const colon = part.lastIndexOf(":");
    let selector = part;
    let weight: number | undefined;
    if (colon > part.indexOf("/")) {
      const maybeWeight = Number(part.slice(colon + 1));
      if (Number.isInteger(maybeWeight)) {
        selector = part.slice(0, colon);
        weight = maybeWeight;
      }
    }
    const slash = selector.indexOf("/");
    if (slash <= 0 || slash === selector.length - 1) throw new CliUsageError(`invalid target "${part}"; use provider/model[:weight]`, USAGE);
    const target = { provider: selector.slice(0, slash), model: selector.slice(slash + 1), ...(weight !== undefined ? { weight } : {}) };
    if (weight !== undefined && (weight < 1 || weight > 10_000)) throw new CliUsageError(`target weight must be 1-10000: ${part}`, USAGE);
    return target;
  });
  if (targets.length === 0) throw new CliUsageError("--targets requires at least one provider/model", USAGE);
  return targets;
}

async function list(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<{ combos?: ComboRow[] }>("/api/combos", {}, deps);
  const rows = result.combos ?? [];
  printData(result, wantsJson, rows.length ? rows.map(row => `${String(row.id)}  ${String(row.model ?? `combo/${row.id}`)}`) : ["No combos configured."]);
}

async function show(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const id = args.shift();
  const wantsJson = takeFlag(args, "--json");
  if (!id) throw new CliUsageError("combo id is required", USAGE);
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<{ combos?: ComboRow[] }>("/api/combos", {}, deps);
  const combo = (result.combos ?? []).find(row => row.id === id);
  if (!combo) throw new CliUsageError(`unknown combo ${id}`);
  printData(combo, wantsJson);
}

/** Handle `ocx combo set`: parse the combo id and flags (including `--decision-quota-signals` and `--decision-quota-tiers`), then create or update the combo through the management API. */
async function set(argv: string[], deps: RuntimeApiDeps): Promise<number> {
  const args = [...argv];
  const id = args.shift()?.trim();
  const wantsJson = takeFlag(args, "--json");
  if (!id) throw new CliUsageError("combo id is required", USAGE);
  const additional = await prepareComboInput(args, deps);
  const targetsRaw = takeOption(args, "--targets");
  const parsedTargets = targetsRaw === undefined ? undefined : parseTargets(targetsRaw);
  const renameFrom = takeOption(args, "--rename-from");
  const replacingTargets = parsedTargets !== undefined || additional.targets !== undefined;
  const strategyRaw = takeOption(args, "--strategy");
  if (strategyRaw !== undefined && !isComboStrategy(strategyRaw)) throw new CliUsageError("--strategy must be failover, round-robin, random, least-used, reset-window, or jev", USAGE);
  const stickyRaw = takeOption(args, "--sticky");
  const stickyLimit = stickyRaw === undefined ? undefined : stickyRaw === "-" ? 1 : Number(stickyRaw);
  if (stickyLimit !== undefined && (!Number.isInteger(stickyLimit) || stickyLimit < 1)) {
    throw new CliUsageError("--sticky must be an integer from 1 to 100, or -", USAGE);
  }
  if (stickyLimit !== undefined && stickyLimit > 100) throw new CliUsageError("--sticky must be <= 100", USAGE);
  const effort = takeOption(args, "--effort");
  const effortMode = takeOption(args, "--effort-mode");
  if (effortMode !== undefined && effortMode !== "fallback" && effortMode !== "force" && effortMode !== "-") {
    throw new CliUsageError("--effort-mode must be fallback, force, or -", USAGE);
  }
  const alias = takeOption(args, "--alias");

  const displayName = takeOption(args, "--display-name");
  const description = takeOption(args, "--description");
  const decisionProvider = takeOption(args, "--decision-provider");
  const decisionModel = takeOption(args, "--decision-model");
  if (decisionModel !== undefined && decisionModel !== "-" && decisionProvider !== undefined && decisionProvider !== "-") {
    throw new CliUsageError("--decision-model cannot be combined with --decision-provider", USAGE);
  }
  const quotaSignals = takeOption(args, "--decision-quota-signals");
  const quotaTiers = takeOption(args, "--decision-quota-tiers");
  if (quotaSignals !== undefined && !["on", "off", "-"].includes(quotaSignals)) throw new CliUsageError("--decision-quota-signals must be on, off or -", USAGE);
  let parsedQuotaTiers: ReturnType<typeof normalizeJevQuotaTiers> | null;
  try { parsedQuotaTiers = quotaTiers === undefined || quotaTiers === "-" ? null : normalizeJevQuotaTiers(JSON.parse(quotaTiers)); } catch { throw new CliUsageError("invalid --decision-quota-tiers JSON", USAGE); }
  if (quotaTiers !== undefined && quotaTiers !== "-" && !parsedQuotaTiers) throw new CliUsageError("quota tiers must be finite 0..100 and strictly ascending", USAGE);
  const sessionPinRaw = takeOption(args, "--session-pin");
  const sessionPinMs = sessionPinRaw === undefined || sessionPinRaw === "-" ? undefined : parseJevSessionPinDuration(sessionPinRaw);
  if (sessionPinRaw !== undefined && sessionPinRaw !== "-" && sessionPinMs === undefined) {
    throw new CliUsageError("--session-pin must be a duration from 1m to 24h (for example 90s, 20m, 1h, or milliseconds), or -", USAGE);
  }
  const decisionTimeout = takeOption(args, "--decision-timeout");
  let decisionTimeoutMs: number | null | undefined;
  if (decisionTimeout !== undefined) {
    decisionTimeoutMs = decisionTimeout === "-" ? null : Number(decisionTimeout);
    if (decisionTimeoutMs !== null
      && (!Number.isInteger(decisionTimeoutMs)
        || decisionTimeoutMs < JEV_DECISION_TIMEOUT_MIN_MS
        || decisionTimeoutMs > JEV_DECISION_TIMEOUT_MAX_MS)) {
      throw new CliUsageError(
        `--decision-timeout must be an integer from ${JEV_DECISION_TIMEOUT_MIN_MS} to ${JEV_DECISION_TIMEOUT_MAX_MS}, or -`,
        USAGE,
      );
    }
  }
  rejectArgs(args, USAGE);
  // Flags that belong to one strategy. An explicit --strategy is checked before any request; an
  // omitted one is the stored strategy, so it is checked once the row has been read.
  const requireStrategyFlags = (strategy: string): void => {
    if (stickyLimit !== undefined && strategy !== "round-robin") throw new CliUsageError("--sticky applies only to round-robin", USAGE);
    if (strategy === "jev") return;
    if (decisionModel !== undefined && decisionModel !== "-") throw new CliUsageError("--decision-model applies only to the jev strategy", USAGE);
    if (decisionProvider !== undefined && decisionProvider !== "-") throw new CliUsageError("--decision-provider applies only to the jev strategy", USAGE);
    if (quotaSignals !== undefined && quotaSignals !== "-" || quotaTiers !== undefined && quotaTiers !== "-") throw new CliUsageError("quota settings apply only to jev", USAGE);
    if (sessionPinMs !== undefined) throw new CliUsageError("--session-pin applies only to the jev strategy", USAGE);
    if (decisionTimeoutMs != null) throw new CliUsageError("--decision-timeout applies only to the jev strategy", USAGE);
  };
  if (strategyRaw !== undefined) requireStrategyFlags(strategyRaw);
  deps = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
  // Replacing targets keeps every other stored setting, including the strategy and its policy (#7579).
  const current = await runtimeRequest<{ combos?: ComboRow[] }>("/api/combos", { redirect: "error" }, deps);
  const existing = current.combos?.find(row => row.id === (renameFrom ?? id));
  if (!replacingTargets && !existing) {
    throw new CliUsageError("--targets is required when creating a combo", USAGE);
  }
  const strategy = strategyRaw ?? existing?.strategy ?? "failover";
  if (!isComboStrategy(strategy)) throw new CliUsageError(`combo ${renameFrom ?? id} has an unsupported stored strategy; pass --strategy`, USAGE);
  if (strategyRaw === undefined) requireStrategyFlags(strategy);
  // Listing-only nulls must not be resent as explicit clears (alias rejects null).
  const combo: Record<string, unknown> = existing
    ? Object.fromEntries(Object.entries(existing).filter(([, value]) => value !== null))
    : { strategy, stickyLimit: stickyLimit ?? 1 };
  delete combo.id;
  delete combo.model;
  if (replacingTargets) combo.targets = additional.targets ?? parsedTargets;
  combo.strategy = strategy;
  if (stickyLimit !== undefined) combo.stickyLimit = stickyLimit;
  if (effort !== undefined) combo.defaultEffort = effort === "-" ? null : effort;
  if (effortMode !== undefined) combo.defaultEffortMode = effortMode === "-" ? "fallback" : effortMode;
  if (alias !== undefined) combo.alias = alias === "-" ? "" : alias;
  if (additional.nativeAlias !== undefined) combo.nativeAlias = additional.nativeAlias;
  if (additional.allowMeteredTargets !== undefined) combo.allowMeteredTargets = additional.allowMeteredTargets;
  if (additional.imageInput !== undefined) combo.imageInput = additional.imageInput;
  if (additional.reasoningEffortMode !== undefined) combo.reasoningEffortMode = additional.reasoningEffortMode;
  if (displayName !== undefined) combo.displayName = displayName === "-" ? "" : displayName;
  if (description !== undefined) combo.description = description === "-" ? "" : description;
  if (decisionProvider !== undefined) combo.decisionProvider = decisionProvider === "-" ? null : decisionProvider;
  if (decisionModel !== undefined) combo.decisionModel = decisionModel === "-" ? null : decisionModel;
  if (decisionProvider !== undefined && decisionProvider !== "-") combo.decisionModel = null;
  if (decisionModel !== undefined && decisionModel !== "-") combo.decisionProvider = null;
  if (decisionTimeoutMs !== undefined) combo.decisionTimeoutMs = decisionTimeoutMs;
  if (quotaSignals !== undefined) combo.decisionQuotaSignals = quotaSignals === "-" ? null : quotaSignals === "on";
  if (quotaTiers !== undefined) combo.decisionQuotaTiers = parsedQuotaTiers;
  if (sessionPinRaw !== undefined) combo.sessionPin = sessionPinMs === undefined ? null : { ttlMs: sessionPinMs };
  if (strategy !== "jev") {
    delete combo.decisionProvider;
    delete combo.decisionModel;
    delete combo.decisionTimeoutMs;
    delete combo.decisionQuotaSignals;
    delete combo.decisionQuotaTiers;
    delete combo.sessionPin;
  }
  if (effortMode === undefined && existing?.defaultEffortMode === "force") {
    combo.defaultEffortMode = effort === "-" ? "fallback" : "force";
  }
  let result: unknown;
  try {
    result = await runtimeRequest("/api/combos", {
      method: "PUT", redirect: "error",
      body: serializeManagementJson({ id, combo, ...(renameFrom ? { renameFrom } : {}) }),
    }, deps);
  } catch (error) {
    const field = error instanceof RuntimeApiError && error.body !== null && typeof error.body === "object"
      ? (error.body as Record<string, unknown>).field : undefined;
    if (error instanceof RuntimeApiError && error.status === 400 && typeof field === "string" && KEPT_JEV_FIELDS.has(field)
      && replacingTargets && strategyRaw === undefined && strategy === "jev") {
      throw new RuntimeApiError(error.message, error.status, { code: KEPT_JEV_REJECTED });
    }
    throw error;
  }
  return printComboWriteResult(result, id, wantsJson);
}

async function remove(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const id = args.shift()?.trim();
  const wantsJson = takeFlag(args, "--json");
  const yes = takeFlag(args, "--yes");
  if (!id) throw new CliUsageError("combo id is required", USAGE);
  if (!yes) throw new CliUsageError("remove requires --yes", USAGE);
  rejectArgs(args, USAGE);
  const result = await runtimeRequest(`/api/combos?id=${encodeURIComponent(id)}`, { method: "DELETE" }, deps);
  printData(result, wantsJson, [`Removed combo ${id}.`]);
}

async function testDecision(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const comboId = takeOption(args, "--combo")?.trim();
  let decisionProvider = takeOption(args, "--decision-provider")?.trim();
  let decisionModel = takeOption(args, "--decision-model")?.trim();
  const timeoutRaw = takeOption(args, "--decision-timeout");
  rejectArgs(args, USAGE);
  if (decisionProvider && decisionModel) {
    throw new CliUsageError("use either --decision-provider or --decision-model", USAGE);
  }
  let decisionTimeoutMs: number | undefined = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
  if (decisionTimeoutMs !== undefined && (!Number.isInteger(decisionTimeoutMs)
    || decisionTimeoutMs < JEV_DECISION_TIMEOUT_MIN_MS || decisionTimeoutMs > JEV_DECISION_TIMEOUT_MAX_MS)) {
    throw new CliUsageError(
      `--decision-timeout must be an integer from ${JEV_DECISION_TIMEOUT_MIN_MS} to ${JEV_DECISION_TIMEOUT_MAX_MS}`,
      USAGE,
    );
  }
  if (comboId && !decisionProvider && !decisionModel) {
    // Without an override, probe the decision method the combo has saved.
    const current = await runtimeRequest<{ combos?: ComboRow[] }>("/api/combos", {}, deps);
    const row = (current.combos ?? []).find(item => item.id === comboId);
    if (!row) throw new CliUsageError(`unknown combo ${comboId}`, USAGE);
    if (row.strategy !== "jev") throw new CliUsageError(`combo ${comboId} does not use the jev strategy`, USAGE);
    if (typeof row.decisionModel === "string") decisionModel = row.decisionModel;
    else if (typeof row.decisionProvider === "string") decisionProvider = row.decisionProvider;
    if (decisionTimeoutMs === undefined && typeof row.decisionTimeoutMs === "number") decisionTimeoutMs = row.decisionTimeoutMs;
  }
  const result = await runtimeRequest<Record<string, unknown>>("/api/combos/decision-test", {
    method: "POST",
    body: JSON.stringify({
      ...(comboId ? { comboId } : {}),
      ...(decisionProvider ? { decisionProvider } : {}),
      ...(decisionModel ? { decisionModel } : {}),
      ...(decisionTimeoutMs !== undefined ? { decisionTimeoutMs } : {}),
    }),
  }, deps);
  const outcome = result.ok === true ? "Decision probe applied" : "Decision probe failed open";
  printData(result, wantsJson, [
    `${outcome} (${String(result.backend)}, gate ${String(result.gate)}, ${String(result.latencyMs)} ms).`,
  ]);
}

async function discover(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const query = takeOption(args, "--query")?.trim();
  rejectArgs(args, USAGE);
  const path = query ? `/api/combos/decision-discovery?q=${encodeURIComponent(query)}` : "/api/combos/decision-discovery";
  const result = await runtimeRequest<{
    configured?: Array<{ id: string; url: string; model?: string; usable: boolean; issue?: string }>;
    discovered?: Array<{ provider: string; model: string; endpoint: string }>;
  }>(path, {}, deps);
  const lines = [
    ...(result.configured ?? []).map(row => {
      const model = row.model ? ` (${row.model})` : "";
      const issue = row.usable ? "" : ` [${row.issue ?? "unusable"}]`;
      return `row ${row.id}: ${row.url}${model}${issue}`;
    }),
    ...(result.discovered ?? []).map(row => `catalog ${row.provider}/${row.model}: ${row.endpoint}`),
  ];
  printData(result, wantsJson, lines.length ? lines : ["No decision services found."]);
}

export async function handleComboCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  const [subcommand, ...writeArgs] = argv;
  if (subcommand === "set" || subcommand === "create" || subcommand === "update") return runCatalogAction(() => set(writeArgs, deps), SET_ERRORS);
  if (subcommand === "stats") {
    const { handleComboStatsCommand } = await import("./combo-stats");
    return handleComboStatsCommand(writeArgs, deps);
  }
  return runCliAction(async () => {
    const [sub = "list", ...rest] = argv;
    if (sub === "list") await list(rest, deps);
    else if (sub === "show") await show(rest, deps);
    else if (sub === "remove" || sub === "delete") await remove(rest, deps);
    else if (sub === "test") await testDecision(rest, deps);
    else if (sub === "discover") await discover(rest, deps);
    else throw new CliUsageError(`unknown combo command ${sub}`, USAGE);
  });
}

export const COMBO_USAGE = USAGE;
