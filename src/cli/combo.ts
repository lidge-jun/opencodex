import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeIntegerOption,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx combo [list] [--json]
  ocx combo show <id> [--json]
  ocx combo set <id> --targets <provider/model[:weight],...>
      [--strategy <failover|round-robin>] [--sticky <1-100>]
      [--effort <low|medium|high|xhigh|max|ultra|->] [--alias <name|->]
      [--native-alias] [--display-name <label|->]
      [--rename-from <id>] [--json]
  ocx combo remove <id> --yes [--json]`;

type ComboRow = Record<string, unknown> & { id?: string; model?: string };

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
  if (!targetsRaw) throw new CliUsageError("--targets is required", USAGE);
  const strategy = takeOption(args, "--strategy") ?? "failover";
  if (strategy !== "failover" && strategy !== "round-robin") throw new CliUsageError("--strategy must be failover or round-robin", USAGE);
  const stickyLimit = takeIntegerOption(args, "--sticky", { min: 1 }) ?? 1;
  if (stickyLimit > 100) throw new CliUsageError("--sticky must be <= 100", USAGE);
  const effort = takeOption(args, "--effort");
  const alias = takeOption(args, "--alias");
  const nativeAlias = takeFlag(args, "--native-alias");
  const displayName = takeOption(args, "--display-name");
  const renameFrom = takeOption(args, "--rename-from");
  rejectArgs(args, USAGE);
  const combo: Record<string, unknown> = {
    strategy,
    stickyLimit,
    targets: parseTargets(targetsRaw),
  };
  if (effort !== undefined) combo.defaultEffort = effort === "-" ? null : effort;
  if (alias !== undefined) combo.alias = alias === "-" ? "" : alias;
  if (nativeAlias) combo.nativeAlias = true;
  if (displayName !== undefined) combo.displayName = displayName === "-" ? "" : displayName;
  const current = await runtimeRequest<{ combos?: ComboRow[] }>("/api/combos", {}, deps);
  const existing = (current.combos ?? []).find(row => row.id === (renameFrom ?? id));
  if (existing?.imageInput === "disabled") combo.imageInput = "disabled";
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

export async function handleComboCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "list", ...rest] = argv;
    if (sub === "list") await list(rest, deps);
    else if (sub === "show") await show(rest, deps);
    else if (sub === "set" || sub === "create" || sub === "update") await set(rest, deps);
    else if (sub === "remove" || sub === "delete") await remove(rest, deps);
    else throw new CliUsageError(`unknown combo command ${sub}`, USAGE);
  });
}

export const COMBO_USAGE = USAGE;
