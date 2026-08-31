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
      [--blocked-skills <name,name|->] [--web-model <id|->] [--web-backend <openai|anthropic|xai|gemini|exa|->]
      [--vision-model <id|->] [--vision-backend <openai|anthropic|->] [--json]`;

const GROK_USAGE = `Usage:
  ocx grok [status] [--json]
  ocx grok <exclude|include|set> <model,model...> [--json]
  ocx grok clear [--json]
  ocx grok apply [--json]`;

const CLIENT_USAGE = `Usage:
  ocx integration client [status] [--client <id>] [--json]
  ocx integration client <enable|disable> --client <id> [--overwrite-conflict] [--json]
  ocx integration client history [--client <id>] [--json]
  ocx integration client restore --op <opId> [--confirm-drift] [--json]`;

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

/**
 * The headless half of the client-integration toggle.
 *
 * Every safety property lives behind the management API — ownership, the
 * pre-write snapshot, the journal, the drift refusal — so this command is a
 * thin caller and deliberately re-implements none of it. That is also why
 * `restore` surfaces the drift refusal as an error telling the user to pass
 * `--confirm-drift` rather than retrying on their behalf: replacing edits a
 * user made after the snapshot is exactly the decision they have to make.
 */
export async function handleClientIntegrationCommand(
  argv: string[],
  deps: RuntimeApiDeps = {},
): Promise<number> {
  return runCliAction(async () => {
    const args = [...argv];
    const action = (args.shift() ?? "status").toLowerCase();
    const wantsJson = takeFlag(args, "--json");

    if (action === "status" || action === "show" || action === "list") {
      const client = takeOption(args, "--client");
      rejectArgs(args, CLIENT_USAGE);
      const path = client
        ? `/api/client-integrations/${encodeURIComponent(client)}`
        : "/api/client-integrations";
      const result = await runtimeRequest(path, {}, deps);
      const rows = (result as { clients?: Array<Record<string, unknown>> }).clients;
      printData(result, wantsJson, rows
        ? rows.map(row => `${String(row.clientId)}: ${String(row.state)}${row.installed ? "" : " (not installed)"}`)
        : summaryLines(result));
      return;
    }

    if (action === "history" || action === "journal") {
      const client = takeOption(args, "--client");
      rejectArgs(args, CLIENT_USAGE);
      const query = client ? `?client=${encodeURIComponent(client)}` : "";
      const result = await runtimeRequest(`/api/client-integrations/journal${query}`, {}, deps);
      const operations = (result as { operations?: Array<Record<string, unknown>> }).operations ?? [];
      printData(result, wantsJson, operations.length === 0
        ? ["No integration operations recorded yet."]
        : operations.map(row => {
          // `snapshot` is resolved against the disk by the route, so "expired"
          // here means the bytes are genuinely gone, not merely old.
          const backup = row.snapshot === "expired" ? "backup expired" : `op ${String(row.opId)}`;
          return `${String(row.at)}  ${String(row.clientId)}  ${String(row.kind)}  (${backup})`;
        }));
      return;
    }

    if (action === "restore") {
      const opId = takeOption(args, "--op") ?? takeOption(args, "--op-id");
      const confirmDrift = takeFlag(args, "--confirm-drift");
      rejectArgs(args, CLIENT_USAGE);
      if (!opId) throw new CliUsageError("--op <opId> is required", CLIENT_USAGE);
      const result = await runtimeRequest("/api/client-integrations/restore", {
        method: "POST",
        body: JSON.stringify({ opId, confirmDrift }),
      }, deps);
      printData(result, wantsJson, [String((result as Record<string, unknown>).message ?? "Restored.")]);
      return;
    }

    if (action !== "enable" && action !== "disable") {
      throw new CliUsageError(`unknown client integration command ${action}`, CLIENT_USAGE);
    }
    const client = takeOption(args, "--client");
    /*
     * The conflict escape hatch, spelled the way `restore --confirm-drift` is: the
     * refusal is the default and the waiver has to be typed.
     *
     * Without it the dashboard could resolve a conflict and the CLI could not,
     * which strands exactly the user who cannot open a browser -- an SSH session,
     * or an agent driving the proxy. That dead end is the reason the overwrite
     * path exists at all.
     */
    const overwriteConflict = takeFlag(args, "--overwrite-conflict");
    rejectArgs(args, CLIENT_USAGE);
    if (!client) throw new CliUsageError("--client <id> is required", CLIENT_USAGE);
    /*
     * Refused here rather than forwarded. The route answers 400 for this pair, but
     * a local usage error names the flag that is wrong, where the route's reply
     * arrives as a generic failed request.
     */
    if (overwriteConflict && action === "disable") {
      throw new CliUsageError("--overwrite-conflict applies only to enable", CLIENT_USAGE);
    }
    const result = await runtimeRequest(`/api/client-integrations/${encodeURIComponent(client)}`, {
      method: "PUT",
      // Sent only when asked for, so a proxy on an older build sees the request it
      // has always seen rather than an unknown field.
      body: JSON.stringify(overwriteConflict
        ? { enabled: true, overwriteConflict: true }
        : { enabled: action === "enable" }),
    }, deps);
    printData(result, wantsJson, [String((result as Record<string, unknown>).message ?? `${client} ${action}d.`)]);
  });
}

export const INTEGRATION_USAGE = { claude: CLAUDE_USAGE, grok: GROK_USAGE, client: CLIENT_USAGE };

const ZCODE_USAGE = `Usage:
  ocx zcode [status] [--json]
  ocx zcode <enable|disable> [--json]
  ocx zcode history [--json]
  ocx zcode restore --op <opId> [--confirm-drift] [--json]`;

/**
 * Thin alias over the client-integration surface for ZCode (Z.ai's desktop
 * client). ZCode is a GUI app with no launch surface to wrap, so unlike
 * `ocx mcode` there is no exec step: connecting the managed provider block is
 * the whole integration, and every safety property (ownership, snapshots,
 * journal, drift refusal) stays behind the shared management API. ZCode reads
 * its config at startup, so enable/disable print a restart reminder.
 */
export async function handleZcodeCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  const args = [...argv];
  // Find the first non-flag token so `ocx zcode --json enable` still enables.
  const verbIndex = args.findIndex(arg => !arg.startsWith("-"));
  const action = (verbIndex === -1 ? "status" : args[verbIndex]).toLowerCase();
  const known = ["status", "show", "list", "enable", "disable", "history", "journal", "restore"];
  if (!known.includes(action)) {
    console.error(`unknown zcode command ${action}`);
    console.error(ZCODE_USAGE);
    return 2;
  }
  const rest = verbIndex === -1 ? args : [...args.slice(0, verbIndex), ...args.slice(verbIndex + 1)];
  // `restore` addresses an operation id, not a client, so nothing is injected.
  const forwarded = action === "restore" ? [action, ...rest] : [action, ...rest, "--client", "zcode"];
  const code = await handleClientIntegrationCommand(forwarded, deps);
  if (code === 0 && (action === "enable" || action === "disable")) {
    console.error("Restart ZCode to pick up the provider change.");
  }
  return code;
}
