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
  setup: { usage: "ocx setup", summary: "Interactive setup for providers and Codex config injection (alias of init)." },
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
    details: [
      "Alias: ocx remove",
      "Config cleanup requires ownership metadata created by a fresh install; legacy or shared directories are left in place.",
    ],
  },
  remove: {
    usage: "ocx remove",
    summary: "Remove service/shim/config and restore native Codex.",
    details: [
      "Alias of: ocx uninstall",
      "Config cleanup requires ownership metadata created by a fresh install; legacy or shared directories are left in place.",
    ],
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
  tray: {
    usage: "ocx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]",
    summary: "Install and control the Windows status tray icon.",
    details: [
      "The tray starts at Windows login and provides one-click proxy controls.",
      "Tray start/stop controls the icon only; use its menu to start or stop the proxy.",
      "--no-start (install only) installs the tray without launching it immediately.",
    ],
  },
  ensure: { usage: "ocx ensure", summary: "Ensure the proxy is running and Codex config/cache are current." },
  sync: {
    usage: "ocx sync [--restart-codex]",
    summary: "Fetch provider models and inject them into Codex config.",
    details: [
      "After writing the catalog, warns if long-lived Codex app-server processes are still running.",
      "--restart-codex sends SIGTERM only to matching app-server / code-mode-host processes (may interrupt active turns).",
    ],
  },
  "sync-cache": {
    usage: "ocx sync-cache [--restart-codex]",
    summary: "Refresh Codex's model cache from the active catalog.",
    details: [
      "Warns when Codex app-server processes still hold an in-memory model list.",
      "--restart-codex sends SIGTERM only to matching app-server / code-mode-host processes (may interrupt active turns).",
    ],
  },
  status: { usage: "ocx status", summary: "Check proxy server status." },
  doctor: { usage: "ocx doctor", summary: "Diagnose environment/network issues (paths, WSL /mnt, proxy env, ChatGPT reachability)." },
  debug: {
    usage: "ocx debug <provider|usage|injection|claude> <on|off|status|reset|logs [-f]>",
    summary: "Show or toggle runtime provider, usage, injection, and Claude debug capture.",
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
    usage: "ocx provider <list|add|edit|test|remove|show|set-default|selected|quota|presets|account-mode>",
    summary: "Non-interactive provider management.",
    details: [
      "Subcommands: list, add/edit/test/remove/show, set-default, selected, quota, presets, account-mode",
      "Registry providers are auto-configured by name. Custom providers need --adapter and --base-url.",
      "Run `ocx provider --help` for full usage and examples.",
    ],
  },
  account: {
    usage: "ocx account <list|current|use|refresh|auto-switch|login|reauth|code|cancel|remove|add-key|reset-credits> ...",
    summary: "List and switch provider accounts and API-key pools (GUI parity).",
    details: [
      "list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).",
      "current <provider>  Show the active account or key.",
      "use <provider> <id> Switch the active credential; 'main' selects the Codex App login.",
      "refresh <provider>  Force-refresh Codex or provider quota reports.",
      "auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.",
      "remove <provider> <id> --yes  Remove a stored account or key after an existence check.",
      "add-key <provider> [--label <label>]  Add a key read only from piped stdin.",
      "login/reauth/code/cancel  Run browser or manual-code auth from a headless shell.",
      "reset-credits <id|main> [--consume --yes]  Inspect or consume Codex reset credits.",
      "Codex pool switches apply to new sessions; running threads keep their account.",
    ],
  },
  models: {
    usage: "ocx models <list|live|add|edit|remove|enable|disable|provider|selected|context|shadow> ...",
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
  model: {
    usage: "ocx model <subcommand>",
    summary: "Alias of ocx models.",
  },
  combo: {
    usage: "ocx combo <list|show|set|remove> ...",
    summary: "Manage combo failover and round-robin virtual models.",
    details: ["Alias hierarchy: ocx route combo ...", "Use --targets provider/model[:weight],provider/model[:weight]."],
  },
  route: {
    usage: "ocx route combo <list|show|set|remove> ...",
    summary: "Manage routing features; combo is currently the supported routing resource.",
  },
  agent: {
    usage: "ocx agent <status|injection|effort|subagents|fallback|sidecar> ...",
    summary: "Manage headless multi-agent, roster, effort, injection, and sidecar settings.",
  },
  observe: {
    usage: "ocx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...",
    summary: "Inspect proxy requests, usage, storage, memory, and debug data.",
  },
  logs: { usage: "ocx logs [filters] [--follow] [--json|--jsonl]", summary: "Alias of ocx observe logs." },
  usage: { usage: "ocx usage [--range <7d|30d|all>] [--surface <all|codex|claude|grok>] [--json]", summary: "Alias of ocx observe usage." },
  storage: { usage: "ocx storage [--json]", summary: "Alias of ocx observe storage." },
  memory: { usage: "ocx memory [--json]", summary: "Alias of ocx observe memory." },
  access: {
    usage: "ocx access <key|endpoints|models|test> ...",
    summary: "Manage OpenCodex admission API keys and inspect external endpoints.",
  },
  "api-key": { usage: "ocx api-key <list|create|remove> ...", summary: "Alias of ocx access key." },
  export: {
    usage: "ocx export --client <opencode|pi> [--json] [--out <path>] [--force]",
    summary: "Print a client config (opencode, Pi) wired to the running proxy.",
    details: [
      "--json prints only the config JSON on stdout, so it is safe to redirect to a file.",
      "--out <path> writes the config there and refuses to replace an existing file without --force.",
      "The config never contains a key; it references the client's env var, which you export before launching.",
      "The destination path is printed for merging by hand — ocx never writes your real client config.",
    ],
  },
  grok: { usage: "ocx grok <status|exclude|include|set|clear|apply> ...", summary: "Manage and apply the Grok Build model fence." },
  integration: { usage: "ocx integration <claude|grok> ...", summary: "Manage supported client integrations." },
  system: {
    usage: "ocx system <status|settings|startup|diagnostics|sync|update> ...",
    summary: "Manage headless runtime settings, startup, sync, diagnostics, and updates.",
  },
  config: {
    usage: "ocx config <show|get|set|unset|validate|export|import> ...",
    summary: "Inspect and safely modify validated OpenCodex configuration.",
    details: ["Secrets are masked by show/get. Import requires --yes and validates before writing."],
  },
  claude: {
    usage: "ocx claude [claude args...]",
    summary: "Launch Claude Code wired to the proxy (env injection + gateway model discovery).",
    details: [
      "Ensures the proxy is running, then execs `claude` with ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN,",
      "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 and model slots from config.claudeCode.",
      "Routed models appear in the native /model picker with stable claude-opus-4-8-2026MMDD slot aliases (Claude Code >= 2.1.129).",
      "Older versions: pick models via ANTHROPIC_MODEL or /model <id> directly (any string passes through).",
      "User-exported ANTHROPIC_* variables always take precedence.",
      "",
      "Claude Desktop profile:",
      "  ocx claude desktop [apply]                         Save and apply the four-family profile",
      "  ocx claude desktop show [--json]                   Show routes, families, and defaults",
      "  ocx claude desktop move <route> <family> [--default]",
      "  ocx claude desktop default <family> <route|none>",
      "  ocx claude desktop export <path|->                 Export versioned JSON (`-` = stdout)",
      "  ocx claude desktop import <path> [--apply]         Validate and import JSON",
      "Families: opus, fable, sonnet, haiku. New routes start in opus.",
      "`none` is valid only when that family is empty.",
      "Legacy apply flags remain supported: --static, --hybrid, --discovery-only.",
      "",
      "Claude Code settings: ocx claude config <status|set> ...",
    ],
  },
  opencode: {
    usage: "ocx opencode [opencode args...]",
    summary: "Launch opencode wired to the proxy (runtime provider config).",
    details: [
      "Ensures the proxy is running, then execs `opencode` with the generated `provider.opencodex`",
      "block injected through OpenCode's inline runtime layer (`OPENCODE_CONFIG_CONTENT`). Any",
      "existing inline config in the environment is preserved and only `provider.opencodex` is",
      "overwritten for this launch.",
      "Global/project opencode.json may be read to warn about an existing provider.opencodex",
      "override; on-disk files are never modified.",
      "Routed models appear in the model picker as opencodex/<provider>/<model>.",
      "Stop using `ocx opencode` and plain `opencode` behaves exactly as before.",
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
  ocx setup                   Interactive setup (alias: init)
  ocx start [--port <port>]   Start the proxy server (auto-syncs models to Codex)
  ocx stop                    Stop the proxy AND restore native Codex (plain codex works again)
  ocx restore                 Restore native Codex without stopping (alias: eject)
  ocx restore back            Re-point codex at the running proxy (undo restore)
  ocx recover-history --legacy-openai
                               Explicitly recover pre-backup syncResumeHistory rows
  ocx uninstall               Remove service/shim/config and restore native Codex (alias: remove)
  ocx service [sub]           Run as a background service (default: install/update/start)
  ocx codex-shim <sub>        Auto-start proxy when \`codex\` launches (install|status|uninstall|remove)
  ocx tray <sub>              Windows status tray (install|start|stop|status|uninstall)
  ocx ensure                  Ensure the proxy is running and Codex config/cache are current
  ocx sync [--restart-codex]  Fetch models from providers and inject into Codex config
  ocx sync-cache [--restart-codex]
                              Refresh Codex's model cache from the active catalog
  ocx status                  Check proxy server status
  ocx doctor                  Diagnose environment/network issues (WSL, proxy, ChatGPT reachability)
  ocx debug <scope>           provider/usage/injection/claude on|off|status|reset
  ocx login <provider>        OAuth or API-key provider login
  ocx logout <provider>       Remove a stored OAuth login
  ocx gui                     Open the opencodex dashboard
  ocx update [--tag <tag>]    Update opencodex (keeps preview installs on @preview)
  ocx restart                  Stop and restart the proxy
  ocx v2 <sub>                multi_agent_v2 surface (status|on|off|mode|threads)
  ocx health [--json]          Check proxy health (exit 0=healthy, 1=not)
  ocx provider <sub>          Providers, connectivity, quota, and selected models
  ocx account <sub>           Accounts, login/reauth, key pools, and quota controls
  ocx models <sub>            Live/custom models, visibility, context, and shadow calls
  ocx combo <sub>             Combo failover/round-robin routing
  ocx agent <sub>             Subagents, injection, effort caps, and sidecars
  ocx observe <sub>           Logs, usage, storage, memory, and debug data
  ocx access <sub>            External API keys and endpoint information
  ocx export --client <id>    Print an opencode/Pi config wired to the running proxy
  ocx grok <sub>              Grok Build model selection and apply
  ocx system <sub>            Runtime settings, startup, sync, and updates
  ocx config <sub>            Validated configuration show/get/set/import/export
  ocx claude [args...]        Launch Claude Code wired to the proxy (model discovery on)
  ocx claude desktop [sub]    Manage and apply Claude Desktop's four-family profile
  ocx opencode [args...]      Launch opencode wired to the proxy (runtime provider config)
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
