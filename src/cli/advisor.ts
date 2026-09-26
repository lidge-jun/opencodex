import { CliUsageError, printData, rejectArgs, runCliAction, runtimeRequest, takeFlag, type RuntimeApiDeps } from "./runtime-api";

const USAGE = `Usage:
  ocx advisor status [--json]
  ocx advisor on [--json]
  ocx advisor off [--json]
  ocx advisor set [--model <model>] [--effort <effort>] [--policy <manual|preflight>] [--timeout-ms <ms>] [--json]`;

const VALUED_FLAGS = new Set(["--model", "--effort", "--policy", "--timeout-ms"]);

interface SetOptions {
  model?: string;
  effort?: string;
  policy?: string;
  timeoutMs?: string;
}

function parseSetArgs(args: string[]): SetOptions {
  const options: SetOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!VALUED_FLAGS.has(arg)) throw new CliUsageError(`unknown advisor set option ${arg}`, USAGE);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new CliUsageError(`${arg} requires a value`, USAGE);
    if (arg === "--model") options.model = value;
    else if (arg === "--effort") options.effort = value;
    else if (arg === "--policy") options.policy = value;
    else options.timeoutMs = value;
  }
  if (Object.keys(options).length === 0) {
    throw new CliUsageError("advisor set requires at least one of --model, --effort, --policy, --timeout-ms", USAGE);
  }
  return options;
}

async function status(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  printData(await runtimeRequest("/api/advisor/settings", {}, deps), wantsJson);
}

async function setEnabled(enabled: boolean, argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  printData(await runtimeRequest("/api/advisor/settings", {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  }, deps), wantsJson, [`Advisor ${enabled ? "enabled" : "disabled"}.`]);
}

async function set(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const options = parseSetArgs(args);
  const patch: Record<string, unknown> = {};
  if (options.model !== undefined) patch.model = options.model;
  if (options.effort !== undefined) patch.effort = options.effort;
  if (options.policy !== undefined) patch.policy = options.policy;
  if (options.timeoutMs !== undefined) {
    const parsed = Number(options.timeoutMs);
    if (!Number.isFinite(parsed)) throw new CliUsageError("--timeout-ms must be a number", USAGE);
    patch.timeoutMs = parsed;
  }
  printData(await runtimeRequest("/api/advisor/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  }, deps), wantsJson, ["Advisor settings saved."]);
}

export async function handleAdvisorCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "status", ...rest] = argv;
    if (sub === "status") await status(rest, deps);
    else if (sub === "on") await setEnabled(true, rest, deps);
    else if (sub === "off") await setEnabled(false, rest, deps);
    else if (sub === "set") await set(rest, deps);
    else throw new CliUsageError(`unknown advisor command ${sub}`, USAGE);
  });
}

export const ADVISOR_USAGE = USAGE;
