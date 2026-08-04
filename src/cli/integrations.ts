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
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const CLAUDE_USAGE = `Usage:
  ocx claude config [status] [--json]
  ocx claude config set [--enabled <on|off>] [--auth-mode <auto|proxy|subscription>]
      [--system-env <on|off>] [--fast-mode <on|off>] [--auto-context <on|off>]
      [--compact-window <tokens|default>] [--inject-agents <on|off>]
      [--small-fast-model <id|->] [--model-map <from=to,from=to|->]
      [--blocked-skills <name,name|->] [--web-model <id|->] [--web-backend <openai|anthropic|->]
      [--vision-model <id|->] [--vision-backend <openai|anthropic|->] [--json]`;

const GROK_USAGE = `Usage:
  ocx grok [status] [--json]
  ocx grok <exclude|include|set> <model,model...> [--json]
  ocx grok clear [--json]
  ocx grok apply [--json]`;

function parseMap(raw: string): Record<string, string> {
  if (raw === "-") return {};
  const map: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const index = pair.indexOf("=");
    if (index <= 0 || index === pair.length - 1) throw new CliUsageError(`invalid model map entry "${pair}"; use from=to`, CLAUDE_USAGE);
    map[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return map;
}

export async function handleClaudeConfigCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const args = [...argv];
    const action = (args.shift() ?? "status").toLowerCase();
    const wantsJson = takeFlag(args, "--json");
    if (action === "status" || action === "show") {
      rejectArgs(args, CLAUDE_USAGE);
      const result = await runtimeRequest("/api/claude-code", {}, deps);
      printData(result, wantsJson, summaryLines(result));
      return;
    }
    if (action !== "set") throw new CliUsageError(`unknown Claude config command ${action}`, CLAUDE_USAGE);
    const body: Record<string, unknown> = {};
    const enabled = takeBooleanOption(args, "--enabled");
    const authMode = takeOption(args, "--auth-mode");
    const systemEnv = takeBooleanOption(args, "--system-env");
    const fastMode = takeBooleanOption(args, "--fast-mode");
    const autoContext = takeBooleanOption(args, "--auto-context");
    const compact = takeOption(args, "--compact-window");
    const injectAgents = takeBooleanOption(args, "--inject-agents");
    const smallFastModel = takeOption(args, "--small-fast-model");
    const modelMap = takeOption(args, "--model-map");
    const blockedSkills = takeOption(args, "--blocked-skills");
    const webModel = takeOption(args, "--web-model");
    const webBackend = takeOption(args, "--web-backend");
    const visionModel = takeOption(args, "--vision-model");
    const visionBackend = takeOption(args, "--vision-backend");
    rejectArgs(args, CLAUDE_USAGE);
    if (enabled !== undefined) body.enabled = enabled;
    if (authMode !== undefined) body.authMode = authMode;
    if (systemEnv !== undefined) body.systemEnv = systemEnv;
    if (fastMode !== undefined) body.fastMode = fastMode;
    if (autoContext !== undefined) body.autoContext = autoContext;
    if (compact !== undefined) {
      if (compact === "default" || compact === "-") body.autoCompactWindow = null;
      else {
        const value = Number(compact.replace(/[_,]/g, ""));
        if (!Number.isInteger(value) || value <= 0) throw new CliUsageError("--compact-window must be a positive integer or default", CLAUDE_USAGE);
        body.autoCompactWindow = value;
      }
    }
    if (injectAgents !== undefined) body.injectAgents = injectAgents;
    if (smallFastModel !== undefined) body.smallFastModel = smallFastModel === "-" ? "" : smallFastModel;
    if (modelMap !== undefined) body.modelMap = parseMap(modelMap);
    if (blockedSkills !== undefined) body.blockedSkills = blockedSkills === "-" ? null : csv(blockedSkills);
    const sidecar = (model: string | undefined, backend: string | undefined): Record<string, unknown> | undefined => {
      if (model === undefined && backend === undefined) return undefined;
      const result: Record<string, unknown> = {};
      if (model !== undefined) result.model = model === "-" ? "" : model;
      if (backend !== undefined) result.backend = backend === "-" ? null : backend;
      return result;
    };
    const web = sidecar(webModel, webBackend);
    const vision = sidecar(visionModel, visionBackend);
    if (web) body.webSearchSidecar = web;
    if (vision) body.visionSidecar = vision;
    if (Object.keys(body).length === 0) throw new CliUsageError("at least one Claude setting is required", CLAUDE_USAGE);
    const result = await runtimeRequest("/api/claude-code", { method: "PUT", body: JSON.stringify(body) }, deps);
    printData(result, wantsJson, ["Claude Code settings updated."]);
  });
}

type GrokState = Record<string, unknown> & { excluded?: string[] };

export async function handleGrokCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const args = [...argv];
    const action = (args.shift() ?? "status").toLowerCase();
    const wantsJson = takeFlag(args, "--json");
    if (action === "status" || action === "show") {
      rejectArgs(args, GROK_USAGE);
      const result = await runtimeRequest("/api/grok", {}, deps);
      printData(result, wantsJson, summaryLines(result));
      return;
    }
    if (action === "apply") {
      rejectArgs(args, GROK_USAGE);
      const result = await runtimeRequest("/api/grok/apply", { method: "POST" }, deps);
      printData(result, wantsJson, [String((result as Record<string, unknown>).message ?? "Grok configuration applied.")]);
      return;
    }
    let excluded: string[];
    if (action === "clear") excluded = [];
    else if (["exclude", "include", "set"].includes(action)) {
      const raw = args.shift();
      if (!raw) throw new CliUsageError("comma-separated models are required", GROK_USAGE);
      const requested = csv(raw) ?? [];
      if (action === "set") excluded = requested;
      else {
        const state = await runtimeRequest<GrokState>("/api/grok", {}, deps);
        const current = new Set(state.excluded ?? []);
        for (const model of requested) action === "exclude" ? current.add(model) : current.delete(model);
        excluded = [...current].sort();
      }
    } else throw new CliUsageError(`unknown Grok command ${action}`, GROK_USAGE);
    rejectArgs(args, GROK_USAGE);
    const result = await runtimeRequest("/api/grok/selection", { method: "PUT", body: JSON.stringify({ excluded }) }, deps);
    printData(result, wantsJson, [`Grok exclusions: ${excluded.join(", ") || "none"}`]);
  });
}

export const INTEGRATION_USAGE = { claude: CLAUDE_USAGE, grok: GROK_USAGE };
