import { CliUsageError, printData, rejectArgs, runCliAction, runtimeRequest, takeFlag, type RuntimeApiDeps } from "./runtime-api";

const USAGE = `Usage:
  ocx companion [show] [--json]
  ocx companion set <key>=<value> [...] [--json]
  ocx companion reset [--json]`;

function parseValue(raw: string): unknown {
  if (raw === "null") return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

async function show(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  printData(await runtimeRequest("/api/companion/settings", {}, deps), wantsJson);
}

async function set(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  if (args.length === 0) throw new CliUsageError("companion set requires key=value assignments", USAGE);
  const patch: Record<string, unknown> = {};
  for (const assignment of args) {
    const separator = assignment.indexOf("=");
    if (separator <= 0) throw new CliUsageError(`invalid companion setting "${assignment}"; use key=value`, USAGE);
    patch[assignment.slice(0, separator)] = parseValue(assignment.slice(separator + 1));
  }
  printData(await runtimeRequest("/api/companion/settings", {
    method: "PUT",
    body: JSON.stringify({ settings: patch }),
  }, deps), wantsJson, ["Companion settings saved."]);
}

async function reset(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  printData(await runtimeRequest("/api/companion/settings", {
    method: "PUT",
    body: JSON.stringify({ reset: true }),
  }, deps), wantsJson, ["Companion settings reset."]);
}

export async function handleCompanionCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "show", ...rest] = argv;
    if (sub === "show") await show(rest, deps);
    else if (sub === "set") await set(rest, deps);
    else if (sub === "reset") await reset(rest, deps);
    else throw new CliUsageError(`unknown companion command ${sub}`, USAGE);
  });
}

export const COMPANION_USAGE = USAGE;
