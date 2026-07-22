import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));

type HelpEntry = {
  usage: string;
  summary: string;
  details?: string[];
};

const helpEntries: Record<string, HelpEntry> = {
  init: { usage: "ocx init", summary: "Interactive setup for providers and Codex config injection." },
  start: { usage: "ocx start [--port <port>]", summary: "Start the proxy server and sync models to Codex." },
  stop: { usage: "ocx stop", summary: "Stop the proxy and restore native Codex config." },
  restore: {
    usage: "ocx restore [back]",
    summary: "Restore native Codex config without stopping the proxy; `restore back` re-points codex at the running proxy.",
  },
  eject: {
    usage: "ocx eject [back]",
    summary: "Restore native Codex config without stopping the proxy; `eject back` re-points codex at the running proxy.",
  },
  "recover-history": {
    usage: "ocx recover-history --legacy-openai",
    summary: "Explicitly recover pre-backup syncResumeHistory rows.",
  },
  uninstall: {
    usage: "ocx uninstall",
    summary: "Remove service/shim/config and restore native Codex.",
    details: ["Alias: ocx remove"],
  },
  remove: {
    usage: "ocx remove",
    summary: "Remove service/shim/config and restore native Codex.",
    details: ["Alias of: ocx uninstall"],
  },
  service: {
    usage: "ocx service [install|start|stop|status|uninstall|remove]",
    summary: "Run as a background service.",
    details: [
      "With no subcommand, installs/updates and starts the background service.",
      "Use `ocx service status` to see diagnostics and log paths.",
    ],
  },
  "codex-shim": {
    usage: "ocx codex-shim <install|status|uninstall|remove>",
    summary: "Auto-start the proxy when `codex` launches.",
    details: ["Use `remove` as an alias for `uninstall`."],
  },
  ensure: { usage: "ocx ensure", summary: "Ensure the proxy is running and Codex config/cache are current." },
  sync: { usage: "ocx sync", summary: "Fetch provider models and inject them into Codex config." },
  "sync-cache": { usage: "ocx sync-cache", summary: "Refresh Codex's model cache from the active catalog." },
  status: { usage: "ocx status", summary: "Check proxy server status." },
  doctor: { usage: "ocx doctor", summary: "Diagnose environment/network issues (paths, WSL /mnt, proxy env, ChatGPT reachability)." },
  debug: {
    usage: "ocx debug [provider on|off|status|reset|logs [-f]|usage on|off|status|reset|logs [-f]]",
    summary: "Show or toggle runtime provider debug logging on the running proxy.",
    details: [
      "Provider: ocx debug provider on | off | status | reset | logs [-f]",
      "Usage JSONL: ocx debug usage on | off | status | reset | logs [-f]",
      "Env default: OCX_DEBUG=1 (legacy OCX_DEBUG_FRAMES still works)",
    ],
  },
  login: { usage: "ocx login <provider>", summary: "OAuth or API-key login for a provider." },
  logout: { usage: "ocx logout <provider>", summary: "Remove a stored provider login." },
  gui: { usage: "ocx gui", summary: "Open the opencodex dashboard." },
  update: {
    usage: "ocx update [--tag latest|preview]",
    summary: "Update opencodex. Preview installs stay on the preview tag unless overridden.",
  },
  provider: {
    usage: "ocx provider <list|add|remove|show|set-default>",
    summary: "Non-interactive provider management.",
    details: [
      "Subcommands: list, add <name>, remove <name>, show <name>, set-default <name>",
      "Registry providers are auto-configured by name. Custom providers need --adapter and --base-url.",
      "Run `ocx provider --help` for full usage and examples.",
    ],
  },
  account: {
    usage: "ocx account <list|current|use|refresh|auto-switch|remove|add-key> ...",
    summary: "List and switch provider accounts and API-key pools (GUI parity).",
    details: [
      "list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).",
      "current <provider>  Show the active account or key.",
      "use <provider> <id> Switch the active credential; 'main' selects the Codex App login.",
      "refresh <provider>  Force-refresh Codex or provider quota reports.",
      "auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.",
      "remove <provider> <id> --yes  Remove a stored account or key after an existence check.",
      "add-key <provider> [--label <label>]  Add a key read only from piped stdin.",
      "Codex pool switches apply to new sessions; running threads keep their account.",
    ],
  },
  models: {
    usage: "ocx models [list] [--provider <name>] [--json] | add <provider> <modelId> [opts] | remove <id|provider/modelId> [--yes] | list-custom [--json]",
    summary: "List models and manage custom (manually registered) models.",
    details: [
      "List available models from static config with no subcommand (liveModels may add more at runtime).",
      "add: register a model the provider catalog does not advertise yet.",
      "  --display-name <name>     Human label (no slashes).",
      "  --context-window <tokens> e.g. 200000.",
      "  --modalities text,image   Comma-separated (text|image|audio).",
      "remove: delete a custom model by UUID or <provider>/<modelId>.",
      "list-custom: show all custom models.",
      "Changes apply immediately to a running proxy (catalog sync).",
    ],
  },
  claude: {
    usage: "ocx claude [claude args...]",
    summary: "Launch Claude Code wired to the proxy (env injection + gateway model discovery).",
    details: [
      "Ensures the proxy is running, then execs `claude` with ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN,",
      "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 and model slots from config.claudeCode.",
      "Routed models appear in the native /model picker as claude-ocx-<provider>--<model> (Claude Code >= 2.1.129).",
      "Older versions: pick models via ANTHROPIC_MODEL or /model <id> directly (any string passes through).",
      "User-exported ANTHROPIC_* variables always take precedence.",
    ],
  },
  restart: {
    usage: "ocx restart",
    summary: "Stop the proxy and restart it (background). Equivalent to stop + ensure.",
  },
  v2: {
    usage: "ocx v2 <status|on|off|mode <v1|default|v2>|threads <n>>",
    summary: "Toggle the Codex multi_agent_v2 feature (multi-agent surface).",
    details: [
      "status                Show flag, multi-agent mode, and thread limit.",
      "on | off              Enable/disable multi_agent_v2 (catalog resyncs).",
      "mode <v1|default|v2>  Force all models to one surface, or respect upstream pins.",
      "threads <n>           Set max_concurrent_threads_per_session (integer >= 1).",
      "Flips preserve the active thread limit while moving between v1/v2 modes.",
    ],
  },
  health: {
    usage: "ocx health [--json]",
    summary: "Check proxy health. Exits 0 if healthy, 1 otherwise.",
    details: ["Use --json for structured output: {ok, pid, port}."],
  },
};

function packageVersion(): string {
  const raw = readFileSync(join(repoRoot, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : "unknown";
}

export function printVersion(): void {
  console.log(`opencodex ${packageVersion()}`);
}

export function printUsage(): void {
  console.log(`opencodex (ocx) — Universal provider proxy for Codex

Usage:
  ocx init                    Interactive setup (provider + Codex config injection)
  ocx start [--port <port>]   Start the proxy server (auto-syncs models to Codex)
  ocx stop                    Stop the proxy AND restore native Codex (plain codex works again)
  ocx restore                 Restore native Codex without stopping (alias: eject)
  ocx restore back            Re-point codex at the running proxy (undo restore)
  ocx recover-history --legacy-openai
                               Explicitly recover pre-backup syncResumeHistory rows
  ocx uninstall               Remove service/shim/config and restore native Codex (alias: remove)
  ocx service [sub]           Run as a background service (default: install/update/start)
  ocx codex-shim <sub>        Auto-start proxy when \`codex\` launches (install|status|uninstall|remove)
  ocx ensure                  Ensure the proxy is running and Codex config/cache are current
  ocx sync                    Fetch models from providers and inject into Codex config
  ocx sync-cache              Refresh Codex's model cache from the active catalog
  ocx status                  Check proxy server status
  ocx doctor                  Diagnose environment/network issues (WSL, proxy, ChatGPT reachability)
  ocx debug [provider|usage ...]
                              provider/usage on|off|status|reset|logs [-f]
  ocx login <provider>        OAuth login (xai) — opens browser, stores token in ~/.opencodex/auth.json
  ocx logout <provider>       Remove a stored OAuth login
  ocx gui                     Open the opencodex dashboard
  ocx update [--tag <tag>]    Update opencodex (keeps preview installs on @preview)
  ocx restart                  Stop and restart the proxy
  ocx v2 <sub>                multi_agent_v2 surface (status|on|off|mode|threads)
  ocx health [--json]          Check proxy health (exit 0=healthy, 1=not)
  ocx provider <sub>          Manage providers (list|add|remove|show|set-default)
  ocx account <sub>           Accounts/keys (list|current|use|refresh|auto-switch|remove|add-key)
  ocx models <sub>            List models; manage custom models (add|remove|list-custom)
  ocx claude [args...]        Launch Claude Code wired to the proxy (model discovery on)
  ocx help [command]          Show help
  ocx --version | -v          Print version

Examples:
  ocx init                    Set up provider and inject into Codex
  ocx start                   Start on default port (10100)
  ocx start --port 8080       Start on custom port
  ocx help service            Show service command help
  ocx sync                    Sync available models to Codex`);
}

export function hasHelpFlag(values: string[]): boolean {
  return values.some(value => value === "--help" || value === "-h" || value === "help");
}

export function printSubcommandUsage(name: string | undefined): void {
  const entry = name ? helpEntries[name] : undefined;
  if (!entry) {
    console.error(`Unknown command: ${name ?? ""}`.trim());
    printUsage();
    process.exit(1);
  }
  console.log(`Usage: ${entry.usage}\n\n${entry.summary}`);
  if (entry.details?.length) console.log(`\n${entry.details.join("\n")}`);
}
