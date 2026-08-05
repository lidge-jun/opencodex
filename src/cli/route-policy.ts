import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeIntegerOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx route policy list [--json]
  ocx route policy show <id> [--json]
  ocx route policy dry-run <id> [--model-context <tokens>] [--tools]
      [--image] [--structured-output] [--json]
  ocx route policy evaluate <id> [--model-context <tokens>] [--tools]
      [--image] [--structured-output] [--json]`;

interface ProfileRow {
  id?: string;
  model?: string;
  revision?: string;
}

async function list(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<{ profiles?: ProfileRow[] }>("/api/routing-profiles", {}, deps);
  const rows = result.profiles ?? [];
  printData(
    result,
    wantsJson,
    rows.length
      ? rows.map(row => `${String(row.id)}  ${String(row.model ?? `policy/${row.id}`)}  rev:${String(row.revision ?? "-")}`)
      : ["No routing profiles configured."],
  );
}

async function show(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const id = args.shift();
  const wantsJson = takeFlag(args, "--json");
  if (!id || id.startsWith("-")) throw new CliUsageError("profile id is required", USAGE);
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<{ profiles?: ProfileRow[] }>("/api/routing-profiles", {}, deps);
  const profile = (result.profiles ?? []).find(candidate => candidate.id === id);
  if (!profile) throw new CliUsageError(`unknown routing profile: ${id}`, USAGE);
  printData(profile, wantsJson);
}

async function dryRun(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const id = args.shift();
  const wantsJson = takeFlag(args, "--json");
  if (!id || id.startsWith("-")) throw new CliUsageError("profile id is required", USAGE);
  const modelContext = takeIntegerOption(args, "--model-context", { min: 1 });
  const tools = takeFlag(args, "--tools");
  const image = takeFlag(args, "--image");
  const structuredOutput = takeFlag(args, "--structured-output");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest(
    "/api/routing-profiles/dry-run",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile: id,
        evidence: {
          ...(modelContext !== undefined ? { contextWindow: modelContext } : {}),
          ...(tools ? { toolsRequired: true } : {}),
          ...(image ? { imageInputRequired: true } : {}),
          ...(structuredOutput ? { structuredOutputRequired: true } : {}),
        },
      }),
    },
    deps,
  );
  printData(result, wantsJson);
}

export async function handleRoutePolicyCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub, ...rest] = argv;
    if (!sub) throw new CliUsageError("route policy requires a subcommand (list, show, dry-run, evaluate)", USAGE);
    if (sub === "list") await list(rest, deps);
    else if (sub === "show") await show(rest, deps);
    else if (sub === "dry-run" || sub === "evaluate") await dryRun(rest, deps);
    else throw new CliUsageError(`unknown route policy command: ${sub}`, USAGE);
  });
}
