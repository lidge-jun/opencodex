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
  ocx allowance [list] [--json]
  ocx allowance snapshot get <id> [--json]
  ocx allowance snapshot set <id> --snapshot-json <json> [--clear-reservations] [--json]
  ocx allowance snapshot clear <id> [--clear-reservations] [--json]`;

function parseSnapshotJson(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) throw new CliUsageError("--snapshot-json is required", USAGE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliUsageError(`--snapshot-json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`, USAGE);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliUsageError("--snapshot-json must be a JSON object", USAGE);
  }
  return parsed as Record<string, unknown>;
}

async function list(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<{ allowances?: Array<Record<string, unknown>> }>("/api/economic-allowances", {}, deps);
  const rows = result.allowances ?? [];
  printData(
    result,
    wantsJson,
    rows.length
      ? rows.map(row => `${String(row.id)}  ${String(row.state ?? "unknown")}  reservations=${String(row.activeReservations ?? 0)}`)
      : ["No economic allowances configured."],
  );
}

async function snapshotGet(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const id = args.shift()?.trim();
  const wantsJson = takeFlag(args, "--json");
  if (!id || id.startsWith("-")) throw new CliUsageError("allowance id is required", USAGE);
  rejectArgs(args, USAGE);
  const result = await runtimeRequest(`/api/economic-allowances/${encodeURIComponent(id)}/snapshot`, {}, deps);
  printData(result, wantsJson);
}

async function snapshotSet(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const id = args.shift()?.trim();
  const wantsJson = takeFlag(args, "--json");
  const clearReservations = takeFlag(args, "--clear-reservations");
  const snapshotJsonRaw = takeOption(args, "--snapshot-json");
  if (!id || id.startsWith("-")) throw new CliUsageError("allowance id is required", USAGE);
  rejectArgs(args, USAGE);
  const body = parseSnapshotJson(snapshotJsonRaw);
  if (clearReservations) body.clearReservations = true;
  const result = await runtimeRequest(`/api/economic-allowances/${encodeURIComponent(id)}/snapshot`, {
    method: "PUT",
    body: JSON.stringify(body),
  }, deps);
  printData(result, wantsJson, [`Saved snapshot for allowance ${id}.`]);
}

async function snapshotClear(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const id = args.shift()?.trim();
  const wantsJson = takeFlag(args, "--json");
  const clearReservations = takeFlag(args, "--clear-reservations");
  if (!id || id.startsWith("-")) throw new CliUsageError("allowance id is required", USAGE);
  rejectArgs(args, USAGE);
  const query = clearReservations ? "?clearReservations=true" : "";
  const result = await runtimeRequest(`/api/economic-allowances/${encodeURIComponent(id)}/snapshot${query}`, {
    method: "DELETE",
  }, deps);
  printData(result, wantsJson, [`Cleared snapshot for allowance ${id}.`]);
}

async function snapshot(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === "get") await snapshotGet(rest, deps);
  else if (sub === "set") await snapshotSet(rest, deps);
  else if (sub === "clear" || sub === "delete") await snapshotClear(rest, deps);
  else throw new CliUsageError(sub ? `unknown snapshot command ${sub}` : "snapshot subcommand required (get|set|clear)", USAGE);
}

export async function handleAllowanceCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "list", ...rest] = argv;
    if (sub === "list") await list(rest, deps);
    else if (sub === "snapshot") await snapshot(rest, deps);
    else throw new CliUsageError(`unknown allowance command ${sub}`, USAGE);
  });
}

export const ALLOWANCE_USAGE = USAGE;
