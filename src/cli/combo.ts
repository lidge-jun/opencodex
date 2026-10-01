import { JEV_DECISION_TIMEOUT_MAX_MS, JEV_DECISION_TIMEOUT_MIN_MS } from "../combos/types";
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

const USAGE = `Usage:
  ocx combo [list] [--json]
  ocx combo show <id> [--json]
  ocx combo set <id> [--targets <provider/model[:weight],...>]
      [--strategy <failover|round-robin|random|least-used|reset-window|jev>] [--sticky <1-100|->]
      [--effort <low|medium|high|xhigh|max|ultra|->] [--effort-mode <fallback|force|->]
      (force overrides valid client effort and can increase cost/latency) [--alias <name|->]
      [--native-alias] [--display-name <label|->]
      [--decision-provider <provider|-> | --decision-model <route|->] [--decision-timeout <ms|->]
      (jev only; the provider must be a configured jev-decision row)
      [--rename-from <id>] [--json]
  ocx combo remove <id> --yes [--json]
  ocx combo test [--combo <id>] [--decision-provider <provider|jev> | --decision-model <route>]
      [--decision-timeout <ms>] [--json]
      (one synthetic decision probe through the decision method; may spend a decision call)
  ocx combo discover [--query <text>] [--json]`;

type ComboRow = Record<string, unknown> & { id?: string; model?: string; strategy?: string };

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

async function set(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const id = args.shift()?.trim();
  const wantsJson = takeFlag(args, "--json");
  if (!id) throw new CliUsageError("combo id is required", USAGE);
  const targetsRaw = takeOption(args, "--targets");
  const renameFrom = takeOption(args, "--rename-from");
  const partialCurrent = targetsRaw === undefined
    ? await runtimeRequest<{ combos?: ComboRow[] }>("/api/combos", {}, deps)
    : undefined;
  const partialExisting = partialCurrent?.combos?.find(row => row.id === (renameFrom ?? id));
  if (targetsRaw === undefined && !partialExisting) {
    throw new CliUsageError("--targets is required when creating a combo", USAGE);
  }
  const strategyRaw = takeOption(args, "--strategy");
  const strategy = strategyRaw ?? partialExisting?.strategy ?? "failover";
  if (strategy !== "failover" && strategy !== "round-robin" && strategy !== "random" && strategy !== "least-used" && strategy !== "reset-window" && strategy !== "jev") throw new CliUsageError("--strategy must be failover, round-robin, random, least-used, reset-window, or jev", USAGE);
  const stickyRaw = takeOption(args, "--sticky");
  const stickyLimit = stickyRaw === undefined ? undefined : stickyRaw === "-" ? 1 : Number(stickyRaw);
  if (stickyLimit !== undefined && (!Number.isInteger(stickyLimit) || stickyLimit < 1)) {
    throw new CliUsageError("--sticky must be an integer from 1 to 100, or -", USAGE);
  }
  if (stickyLimit !== undefined) {
    if (stickyLimit > 100) throw new CliUsageError("--sticky must be <= 100", USAGE);
    if (strategy !== "round-robin") throw new CliUsageError("--sticky applies only to round-robin", USAGE);
  }
  const effort = takeOption(args, "--effort");
  const effortMode = takeOption(args, "--effort-mode");
  if (effortMode !== undefined && effortMode !== "fallback" && effortMode !== "force" && effortMode !== "-") {
    throw new CliUsageError("--effort-mode must be fallback, force, or -", USAGE);
  }
  const alias = takeOption(args, "--alias");
  const nativeAlias = takeFlag(args, "--native-alias");
  const displayName = takeOption(args, "--display-name");
  const decisionProvider = takeOption(args, "--decision-provider");
  const decisionModel = takeOption(args, "--decision-model");
  if (decisionModel !== undefined && decisionModel !== "-" && decisionProvider !== undefined && decisionProvider !== "-") {
    throw new CliUsageError("--decision-model cannot be combined with --decision-provider", USAGE);
  }
  if (decisionModel !== undefined && decisionModel !== "-" && strategy !== "jev") {
    throw new CliUsageError("--decision-model applies only to the jev strategy", USAGE);
  }
  if (decisionProvider !== undefined && decisionProvider !== "-" && strategy !== "jev") {
    throw new CliUsageError("--decision-provider applies only to the jev strategy", USAGE);
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
    if (decisionTimeoutMs !== null && strategy !== "jev") {
      throw new CliUsageError("--decision-timeout applies only to the jev strategy", USAGE);
    }
  }
  rejectArgs(args, USAGE);
  // Listing-only nulls must not be resent as explicit clears (alias rejects null).
  const combo: Record<string, unknown> = partialExisting
    ? Object.fromEntries(Object.entries(partialExisting).filter(([, value]) => value !== null))
    : { strategy, stickyLimit: stickyLimit ?? 1, targets: parseTargets(targetsRaw!) };
  delete combo.id;
  delete combo.model;
  if (strategyRaw !== undefined) combo.strategy = strategy;
  if (stickyLimit !== undefined) combo.stickyLimit = stickyLimit;
  if (effort !== undefined) combo.defaultEffort = effort === "-" ? null : effort;
  if (effortMode !== undefined) combo.defaultEffortMode = effortMode === "-" ? "fallback" : effortMode;
  if (alias !== undefined) combo.alias = alias === "-" ? "" : alias;
  if (nativeAlias) combo.nativeAlias = true;
  if (displayName !== undefined) combo.displayName = displayName === "-" ? "" : displayName;
  if (decisionProvider !== undefined) combo.decisionProvider = decisionProvider === "-" ? null : decisionProvider;
  if (decisionModel !== undefined) combo.decisionModel = decisionModel === "-" ? null : decisionModel;
  if (decisionProvider !== undefined && decisionProvider !== "-") combo.decisionModel = null;
  if (decisionModel !== undefined && decisionModel !== "-") combo.decisionProvider = null;
  if (decisionTimeoutMs !== undefined) combo.decisionTimeoutMs = decisionTimeoutMs;
  if (strategy !== "jev") {
    delete combo.decisionProvider;
    delete combo.decisionModel;
    delete combo.decisionTimeoutMs;
  }
  const current = partialCurrent ?? await runtimeRequest<{ combos?: ComboRow[] }>("/api/combos", {}, deps);
  const existing = (current.combos ?? []).find(row => row.id === (renameFrom ?? id));
  if (existing?.imageInput === "disabled") combo.imageInput = "disabled";
  if (effortMode === undefined && existing?.defaultEffortMode === "force") {
    combo.defaultEffortMode = effort === "-" ? "fallback" : "force";
  }
  const result = await runtimeRequest("/api/combos", {
    method: "PUT",
    body: JSON.stringify({ id, combo, ...(renameFrom ? { renameFrom } : {}) }),
  }, deps);
  printData(result, wantsJson, [`Saved combo ${id}.`]);
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
  return runCliAction(async () => {
    const [sub = "list", ...rest] = argv;
    if (sub === "list") await list(rest, deps);
    else if (sub === "show") await show(rest, deps);
    else if (sub === "set" || sub === "create" || sub === "update") await set(rest, deps);
    else if (sub === "remove" || sub === "delete") await remove(rest, deps);
    else if (sub === "test") await testDecision(rest, deps);
    else if (sub === "discover") await discover(rest, deps);
    else throw new CliUsageError(`unknown combo command ${sub}`, USAGE);
  });
}

export const COMBO_USAGE = USAGE;
