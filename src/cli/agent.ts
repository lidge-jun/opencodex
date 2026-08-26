import {
  CliUsageError,
  csv,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  summaryLines,
  takeBooleanOption,
  takeFlag,
  takeIntegerOption,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

interface WebSearchModelOption {
  value: string;
  model: string;
  backend: "openai" | "anthropic";
  authSlot?: boolean;
}

const USAGE = `Usage:
  ocx agent [status] [--json]
  ocx agent injection <status|set> [--model <id|->] [--effort <level|->]
      [--prompt <text|->] [--guidance <on|off>] [--json]
  ocx agent effort <status|set> [--main <level|->] [--subagent <level|->] [--json]
  ocx agent subagents <status|set|clear> [model,model...] [--json]
  ocx agent fallback <status|set|clear> [model,model...] [--poll-ms <5000-600000>] [--json]
  ocx agent sidecar <status|web|vision> [--list] [--model <id|->]
      [--backend web:<openai|anthropic|xai|gemini|exa|-> vision:<openai|anthropic|routed|->]
      [--reasoning <level>] [--max-descriptions <n>] [--json]`;

function clearable(value: string | undefined): string | null | undefined {
  return value === "-" ? null : value;
}

async function status(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const [v2, injection, caps, subagents, fallback, sidecars] = await Promise.all([
    runtimeRequest("/api/v2", {}, deps),
    runtimeRequest("/api/injection-model", {}, deps),
    runtimeRequest("/api/effort-caps", {}, deps),
    runtimeRequest("/api/subagent-models", {}, deps),
    runtimeRequest("/api/subagent-model-fallback", {}, deps),
    runtimeRequest("/api/sidecar-settings", {}, deps),
  ]);
  const result = { v2, injection, caps, subagents, fallback, sidecars };
  printData(result, wantsJson, summaryLines(result));
}

async function injection(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const action = (args.shift() ?? "status").toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  if (action === "status") {
    rejectArgs(args, USAGE);
    const result = await runtimeRequest("/api/injection-model", {}, deps);
    printData(result, wantsJson, summaryLines(result));
    return;
  }
  if (action !== "set") throw new CliUsageError(`unknown injection action ${action}`, USAGE);
  const model = clearable(takeOption(args, "--model"));
  const effort = clearable(takeOption(args, "--effort"));
  const prompt = clearable(takeOption(args, "--prompt"));
  const guidance = takeBooleanOption(args, "--guidance");
  rejectArgs(args, USAGE);
  const body: Record<string, unknown> = {};
  if (model !== undefined) body.model = model;
  if (effort !== undefined) body.effort = effort;
  if (prompt !== undefined) body.prompt = prompt;
  if (guidance !== undefined) body.multiAgentGuidanceEnabled = guidance;
  if (Object.keys(body).length === 0) throw new CliUsageError("at least one injection option is required", USAGE);
  const result = await runtimeRequest("/api/injection-model", { method: "PUT", body: JSON.stringify(body) }, deps);
  printData(result, wantsJson, ["Agent injection settings updated."]);
}

async function effort(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const action = (args.shift() ?? "status").toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  if (action === "status") {
    rejectArgs(args, USAGE);
    const result = await runtimeRequest("/api/effort-caps", {}, deps);
    printData(result, wantsJson, summaryLines(result));
    return;
  }
  if (action !== "set") throw new CliUsageError(`unknown effort action ${action}`, USAGE);
  const main = clearable(takeOption(args, "--main"));
  const subagent = clearable(takeOption(args, "--subagent"));
  rejectArgs(args, USAGE);
  const body: Record<string, unknown> = {};
  if (main !== undefined) body.effortCap = main;
  if (subagent !== undefined) body.subagentEffortCap = subagent;
  if (Object.keys(body).length === 0) throw new CliUsageError("--main and/or --subagent is required", USAGE);
  const result = await runtimeRequest("/api/effort-caps", { method: "PUT", body: JSON.stringify(body) }, deps);
  printData(result, wantsJson, ["Agent effort caps updated."]);
}

async function subagents(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const action = (args.shift() ?? "status").toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  if (action === "status") {
    rejectArgs(args, USAGE);
    const result = await runtimeRequest("/api/subagent-models", {}, deps);
    printData(result, wantsJson, summaryLines(result));
    return;
  }
  let models: string[];
  if (action === "clear") models = [];
  else if (action === "set") {
    const raw = args.shift();
    if (!raw) throw new CliUsageError("comma-separated subagent models are required", USAGE);
    models = csv(raw) ?? [];
  } else throw new CliUsageError(`unknown subagents action ${action}`, USAGE);
  rejectArgs(args, USAGE);
  if (models.length > 5) throw new CliUsageError("at most 5 subagent models are allowed", USAGE);
  const result = await runtimeRequest("/api/subagent-models", { method: "PUT", body: JSON.stringify({ models }) }, deps);
  printData(result, wantsJson, [`Subagent roster: ${models.join(", ") || "cleared"}`]);
}

async function fallback(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const action = (args.shift() ?? "status").toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  if (action === "status") {
    rejectArgs(args, USAGE);
    const result = await runtimeRequest("/api/subagent-model-fallback", {}, deps);
    printData(result, wantsJson, summaryLines(result));
    return;
  }
  const body: Record<string, unknown> = {};
  if (action === "clear") body.models = [];
  else if (action === "set") {
    const raw = args[0] && !args[0].startsWith("--") ? args.shift() : undefined;
    if (raw) body.models = csv(raw) ?? [];
  } else throw new CliUsageError(`unknown fallback action ${action}`, USAGE);
  const pollMs = takeIntegerOption(args, "--poll-ms", { min: 5_000 });
  if (pollMs !== undefined) {
    if (pollMs > 600_000) throw new CliUsageError("--poll-ms must be <= 600000", USAGE);
    body.pollMs = pollMs;
  }
  rejectArgs(args, USAGE);
  if (Object.keys(body).length === 0) throw new CliUsageError("models and/or --poll-ms is required", USAGE);
  const result = await runtimeRequest("/api/subagent-model-fallback", { method: "PUT", body: JSON.stringify(body) }, deps);
  printData(result, wantsJson, ["Subagent fallback settings updated."]);
}

async function sidecar(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const section = (args.shift() ?? "status").toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  if (section === "status") {
    rejectArgs(args, USAGE);
    const result = await runtimeRequest("/api/sidecar-settings", {}, deps);
    printData(result, wantsJson, summaryLines(result));
    return;
  }
  if (section !== "web" && section !== "vision") throw new CliUsageError("sidecar must be web, vision, or status", USAGE);
  // --list must be consumed BEFORE rejectArgs sees it. It prints the server's
  // candidate set — the exact list the GUI picker shows (#2188): the server
  // computes it once and every surface consumes it, so the CLI cannot drift.
  const wantsList = takeFlag(args, "--list");
  if (wantsList) {
    rejectArgs(args, USAGE);
    const settings = await runtimeRequest("/api/sidecar-settings", {}, deps) as {
      webSearchModels?: WebSearchModelOption[];
      visionModels?: Array<{ value: string; backend?: string; baseline?: boolean }>;
    };
    if (section === "web") {
      const options = settings.webSearchModels ?? [];
      printData(options, wantsJson, options.length === 0
        ? ["no runnable web-search sidecar models (log in to ChatGPT or Anthropic)"]
        : options.map(option => `${option.value} [${option.backend}]${option.authSlot ? " (auth slot)" : ""}`));
    } else {
      const options = settings.visionModels ?? [];
      printData(options, wantsJson, options.length === 0
        ? ["no eligible vision describers"]
        : options.map(option => `${option.value}${option.backend ? ` [${option.backend}]` : ""}${option.baseline ? " (baseline)" : ""}`));
    }
    return;
  }
  const model = takeOption(args, "--model");
  const backend = takeOption(args, "--backend");
  const reasoning = takeOption(args, "--reasoning");
  const maxDescriptionsPerTurn = takeIntegerOption(args, "--max-descriptions", { min: 1 });
  rejectArgs(args, USAGE);
  const settings: Record<string, unknown> = {};
  if (model !== undefined) settings.model = model === "-" ? "" : model;
  if (backend !== undefined) settings.backend = backend === "-" ? null : backend;
  if (reasoning !== undefined) settings.reasoning = reasoning;
  if (maxDescriptionsPerTurn !== undefined) settings.maxDescriptionsPerTurn = maxDescriptionsPerTurn;
  if (Object.keys(settings).length === 0) throw new CliUsageError("at least one sidecar option is required", USAGE);
  if (section === "web" && model !== undefined && model !== "-") {
    const offered = await runtimeRequest("/api/sidecar-settings", {}, deps) as {
      webSearchModels?: WebSearchModelOption[];
    };
    const requestedBackend = backend === "-" ? "openai" : backend;
    const option = offered.webSearchModels?.find(candidate =>
      (candidate.value === model || candidate.model === model)
      && (requestedBackend === undefined || candidate.backend === requestedBackend));
    if (option) {
      settings.model = option.model;
      if (backend !== "-") settings.backend = option.backend;
    }
  }
  const body = section === "web" ? { webSearch: settings } : { vision: settings };
  const result = await runtimeRequest("/api/sidecar-settings", { method: "PUT", body: JSON.stringify(body) }, deps);
  printData(result, wantsJson, [`${section} sidecar settings updated.`]);
}

export async function handleAgentCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "status", ...rest] = argv;
    if (sub === "status") await status(rest, deps);
    else if (sub === "injection" || sub === "guidance") await injection(rest, deps);
    else if (sub === "effort") await effort(rest, deps);
    else if (sub === "subagents" || sub === "roster") await subagents(rest, deps);
    else if (sub === "fallback") await fallback(rest, deps);
    else if (sub === "sidecar") await sidecar(rest, deps);
    else throw new CliUsageError(`unknown agent command ${sub}`, USAGE);
  });
}

export const AGENT_USAGE = USAGE;
