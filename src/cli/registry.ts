export interface CliCommandEntry {
  name: string;
  aliases?: string[];
  usage: string;
  summary: string;
  details?: string[];
  hidden?: boolean;
}

export const CLI_COMMANDS: CliCommandEntry[] = [
  {
    name: "init",
    aliases: ["setup"],
    usage: "ocx init",
    summary: "Interactive setup for providers and Codex config injection.",
  },
  {
    name: "setup",
    aliases: [],
    usage: "ocx setup",
    summary: "Interactive setup for providers and Codex config injection (alias of init).",
  },
  { name: "start", usage: "ocx start [--port <port>]", summary: "Start the proxy server and sync models to Codex." },
  { name: "stop", usage: "ocx stop", summary: "Stop the proxy and restore native Codex config." },
  {
    name: "restore",
    aliases: ["eject"],
    usage: "ocx restore [back]",
    summary: "Restore native Codex config without stopping the proxy; `restore back` re-points codex at the running proxy.",
  },
  {
    name: "eject",
    aliases: [],
    usage: "ocx eject [back]",
    summary: "Restore native Codex config without stopping the proxy; `eject back` re-points codex at the running proxy.",
  },
  {
    name: "recover-history",
    usage: "ocx recover-history --legacy-openai --yes",
    summary: "Force all user-message opencodex rows to OpenAI for legacy recovery.",
  },
  {
    name: "uninstall",
    aliases: ["remove"],
    usage: "ocx uninstall",
    summary: "Remove service/shim/config and restore native Codex.",
    details: [
      "Alias: ocx remove",
      "Config cleanup requires ownership metadata created by a fresh install; legacy or shared directories are left in place.",
    ],
  },
  {
    name: "remove",
    aliases: [],
    usage: "ocx remove",
    summary: "Remove service/shim/config and restore native Codex.",
    details: [
      "Alias of: ocx uninstall",
      "Config cleanup requires ownership metadata created by a fresh install; legacy or shared directories are left in place.",
    ],
  },
  {
    name: "service",
    usage: "ocx service [install|repair|restart|start|stop|status|uninstall|remove]",
    summary: "Run as a background service.",
    details: [
      "With no subcommand, installs when absent or repairs/restarts an existing service.",
      "`restart` is an alias of `repair` and does not re-register an installed service.",
      "Use `ocx service status` to see diagnostics and log paths.",
    ],
  },
  {
    name: "codex-shim",
    usage: "ocx codex-shim <install|status|uninstall|remove>",
    summary: "Auto-start the proxy when `codex` launches.",
    details: ["Use `remove` as an alias for `uninstall`."],
  },
  {
    name: "tray",
    usage: "ocx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]",
    summary: "Install and control the Windows status tray icon.",
    details: [
      "The tray starts at Windows login and provides one-click proxy controls.",
      "Tray start/stop controls the icon only; use its menu to start or stop the proxy.",
      "--no-start (install only) installs the tray without launching it immediately.",
    ],
  },
  { name: "ensure", usage: "ocx ensure", summary: "Ensure the proxy is running and Codex config/cache are current." },
  {
    name: "sync",
    usage: "ocx sync [--restart-codex] [--restart-desktop-app]",
    summary: "Fetch provider models and inject them into Codex config.",
    details: [
      "After writing the catalog, warns if long-lived Codex app-server processes are still running.",
      "--restart-codex sends SIGTERM only to matching app-server / code-mode-host processes (may interrupt active turns).",
      "--restart-desktop-app (Windows only, opt-in) fully restarts the Codex desktop app so its model picker re-reads the catalog. Never implied by --restart-codex: it ends live conversations.",
    ],
  },
  {
    name: "sync-cache",
    usage: "ocx sync-cache [--restart-codex] [--restart-desktop-app]",
    summary: "Refresh Codex's model cache from the active catalog.",
    details: [
      "Warns when Codex app-server processes still hold an in-memory model list.",
      "--restart-codex sends SIGTERM only to matching app-server / code-mode-host processes (may interrupt active turns).",
      "--restart-desktop-app (Windows only, opt-in) fully restarts the Codex desktop app so its model picker re-reads the catalog. Never implied by --restart-codex: it ends live conversations.",
    ],
  },
  { name: "status", usage: "ocx status", summary: "Check proxy server status." },
  {
    name: "doctor",
    usage: "ocx doctor",
    summary: "Diagnose environment/network issues (paths, WSL /mnt, proxy env, ChatGPT reachability).",
    details: [
      "Default mode is observe-only and reports the native-write coordinator state and exact path.",
      "After stopping the proxy/service, `--recover-zero-byte-coordinator --yes` moves only a proven zero-byte coordinator to a same-directory backup.",
    ],
  },
  {
    name: "debug",
    usage: "ocx debug <provider|usage|injection|claude> <on|off|status|reset|logs [-f]>",
    summary: "Show or toggle runtime provider, usage, injection, and Claude debug capture.",
    details: [
      "Provider: ocx debug provider on | off | status | reset | logs [-f]",
      "Usage JSONL: ocx debug usage on | off | status | reset | logs [-f]",
      "Env default: OCX_DEBUG=1 (legacy OCX_DEBUG_FRAMES still works)",
    ],
  },
  { name: "login", usage: "ocx login <provider>", summary: "OAuth or API-key login for a provider." },
  { name: "logout", usage: "ocx logout <provider>", summary: "Remove a stored provider login." },
  { name: "gui", usage: "ocx gui", summary: "Open the opencodex dashboard." },
  {
    name: "update",
    usage: "ocx update [--tag latest|preview]",
    summary: "Update opencodex. Preview installs stay on the preview tag unless overridden.",
  },
  {
    name: "provider",
    usage: "ocx provider <list|add|edit|test|remove|show|set-default|selected|quota|presets|account-mode>",
    summary: "Non-interactive provider management.",
    details: [
      "Subcommands: list, add/edit/test/remove/show, set-default, selected, quota, presets, account-mode",
      "Registry providers are auto-configured by name. Custom providers need --adapter and --base-url.",
      "Run `ocx provider --help` for full usage and examples.",
    ],
  },
  {
    name: "account",
    usage: "ocx account <list|current|use|refresh|auto-switch|priority|login|reauth|code|cancel|remove|add-key|reset-credits|main> ...",
    summary: "List and switch provider accounts and API-key pools (GUI parity).",
    details: [
      "list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).",
      "current <provider>  Show the active account or key.",
      "use <provider> <id> Switch the active credential; 'main' selects the Codex App login.",
      "refresh <provider>  Force-refresh Codex or provider quota reports.",
      "auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.",
      "priority <provider> <id|main> [first|earlier|normal|later|last|-100..100|reset]  Selection order; omit the value to read it.",
      "remove <provider> <id> --yes  Remove a stored account or key after an existence check.",
      "add-key <provider> [--label <label>]  Add a key read only from piped stdin.",
      "login/reauth/code/cancel  Run browser or manual-code auth from a headless shell.",
      "reset-credits <id|main> [--consume --yes]  Inspect or consume Codex reset credits.",
      "main <subcommand>     Manage the physical native Codex login separately from Pool routing.",
      "Switching the active account takes effect immediately; running threads move on their next request, and in-flight requests keep the account they captured.",
      "A selection-order change applies from the next unbound request and never moves a bound thread.",
    ],
  },
  {
    name: "alias",
    usage: "ocx alias <list|set|rm|defaults> ...",
    summary: "Manage short provider and model names.",
  },
  {
    name: "models",
    aliases: ["model"],
    usage: "ocx models <list|live|add|edit|remove|enable|disable|provider|selected|preset|context|shadow> ...",
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
  {
    name: "model",
    aliases: [],
    usage: "ocx model <subcommand>",
    summary: "Alias of ocx models.",
  },
  {
    name: "combo",
    usage: "ocx combo <list|show|set|remove> ...",
    summary: "Manage combo virtual models and routing strategies.",
    details: ["Alias hierarchy: ocx route combo ...", "Use --targets provider/model[:weight],provider/model[:weight]."],
  },
  {
    name: "route",
    usage: "ocx route combo <list|show|set|remove> ...",
    summary: "Manage routing features; combo is currently the supported routing resource.",
  },
  {
    name: "agent",
    usage: "ocx agent <status|injection|effort|subagents|fallback|sidecar> ...",
    summary: "Manage headless multi-agent, roster, effort, injection, and sidecar settings.",
  },
  {
    name: "observe",
    usage: "ocx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...",
    summary: "Inspect proxy requests, usage, storage, memory, and debug data.",
  },
  {
    name: "inspect",
    usage: "ocx inspect <config|catalog|routing-analytics|pacing|key-providers|codex-prompt|client-config|star|windows-tray> ...",
    summary: "Read effective config, catalog, analytics, pacing, and the generated client-config snippet.",
    details: [
      "`inspect star` reads the repository star status only. Starring uses your GitHub identity and is available from the dashboard alone.",
    ],
  },
  { name: "logs", usage: "ocx logs [filters] [--follow] [--json|--jsonl]", summary: "Alias of ocx observe logs." },
  {
    name: "usage",
    usage: "ocx usage [--range <today|1d|7d|30d|all>] [--surface <all|codex|claude|grok>] [--provider <name>] [--model <id>] [--json]",
    summary: "Alias of ocx observe usage.",
  },
  {
    name: "storage",
    usage: "ocx storage <report|cleanup|trash|policy> ...",
    summary: "Storage report, archived-session cleanup, trash restore, and the cleanup policy.",
    details: [
      "A bare `ocx storage` prints the report, as it did when this was an alias of `observe storage`.",
      "`cleanup` previews by default and only deletes under --yes; `trash restore` and `policy run` also require --yes.",
    ],
  },
  { name: "memory", usage: "ocx memory [--json]", summary: "Alias of ocx observe memory." },
  {
    name: "access",
    usage: "ocx access <key|endpoints|models|test> ...",
    summary: "Manage OpenCodex admission API keys and inspect external endpoints.",
  },
  { name: "api-key", usage: "ocx api-key <list|create|remove> ...", summary: "Alias of ocx access key." },
  {
    name: "export",
    usage: "ocx export --client <opencode|pi|omp|hermes|openclaw|kimi|gajae|dsh|mcode|zcode|prime> [--json] [--out <path>] [--force]",
    summary: "Print a client config (OpenCode, Pi, OMP, Hermes, OpenClaw, Kimi Code, Gajae Code, DeepSeek Harness, MiniMax Code, ZCode, Prime Agent) wired to the running proxy.",
    details: [
      "--json prints the generated document as JSON on stdout; use --out for the client's native format.",
      "--out <path> writes the native config there and refuses to replace an existing file without --force.",
      "The config never contains a real key; it carries a documented env reference or a non-secret loopback placeholder.",
      "The destination path is printed for merging by hand — ocx never writes your real client config.",
    ],
  },
  {
    name: "grok",
    usage: "ocx grok <status|exclude|include|set|clear|apply> ...",
    summary: "Manage and apply the Grok Build model fence.",
  },
  {
    name: "integration",
    usage: "ocx integration <claude|grok|client|native> ...",
    summary: "Manage supported client integrations, and the native client toggles.",
    details: [
      "`native` shows or flips the native Claude/Claude Desktop/Codex/Grok toggles; the other subcommands manage the reversible file integrations.",
    ],
  },
  {
    name: "system",
    usage: "ocx system <status|settings|startup|diagnostics|sync|update> ...",
    summary: "Manage headless runtime settings, startup, sync, diagnostics, and updates.",
  },
  {
    name: "config",
    usage: "ocx config <show|get|set|unset|validate|export|import> ...",
    summary: "Inspect and safely modify validated OpenCodex configuration.",
    details: ["Secrets are masked by show/get. Import requires --yes and validates before writing."],
  },
  {
    name: "claude",
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
      "  ocx claude desktop status [--json]                 Show applied state, drift, and health",
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
  {
    name: "opencode",
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
  {
    name: "mcode",
    usage: "ocx mcode [mcode args...]",
    summary: "Launch MiniMax Code through its managed OpenCodex provider.",
    details: [
      "First connect the reversible file integration: ocx integration client enable --client mcode",
      "The launcher verifies that custom_provider.opencodex targets the current loopback proxy before starting MCode.",
      "Select custom_provider:opencodex/<model> from MCode's model picker.",
    ],
  },
  {
    name: "mmx",
    usage: "ocx mmx text <chat|repl> [mmx args...]",
    summary: "Launch MiniMax CLI text commands through the proxy.",
    details: [
      "Only the official MMX Anthropic-compatible text surface is proxied.",
      "Use plain mmx for MiniMax-native image, video, speech, music, vision, search, quota, auth, config, file, and update commands.",
      "The wrapper isolates ~/.mmx credentials and refuses --api-key/--base-url overrides.",
    ],
  },
  {
    name: "zcode",
    usage: "ocx zcode [status|enable|disable|history|restore] [--json]",
    summary: "Connect ZCode (Z.ai desktop client) to the proxy via its managed provider.",
    details: [
      "Alias of ocx integration client <sub> --client zcode.",
      "enable writes the managed provider.opencodex block into ~/.zcode/v2/config.json; disable removes only that block.",
      "ZCode reads its config at startup — restart ZCode after enable/disable.",
      "Select OpenCodex Proxy/<provider>/<model> from ZCode's model picker.",
    ],
  },
  {
    name: "restart",
    usage: "ocx restart",
    summary: "Stop the proxy and restart it (background). Equivalent to stop + ensure.",
  },
  {
    name: "v2",
    usage: "ocx v2 <status|on|off|mode <v1|default|v2>|keep-native-v1 <on|off>|threads <n>>",
    summary: "Toggle the Codex multi_agent_v2 feature (multi-agent surface).",
    details: [
      "status                Show flag, multi-agent mode, and thread limit.",
      "on | off              Enable/disable multi_agent_v2 (catalog resyncs).",
      "mode <v1|default|v2>  Force all models to one surface, or respect upstream pins.",
      "keep-native-v1 <on|off>  Under mode v2, keep ChatGPT-native models on v1.",
      "threads <n>           Set max_concurrent_threads_per_session (integer >= 1).",
      "Flips preserve the active thread limit while moving between v1/v2 modes.",
    ],
  },
  {
    name: "health",
    usage: "ocx health [--json]",
    summary: "Check proxy health. Exits 0 if healthy, 1 otherwise.",
    details: ["Use --json for structured output: {ok, pid, port}."],
  },
  {
    name: "capabilities",
    usage: "ocx capabilities [--json] [--mutating-only] [--route <path>]",
    summary: "List the declared CLI capabilities and the management routes they drive.",
    details: [
      "The machine-readable surface index: start here when driving ocx programmatically instead of parsing help text.",
      "--route <path> answers the inverse question: which commands drive this management route.",
    ],
  },
  {
    name: "ready",
    usage: "ocx ready [--json] [--wait [--timeout <seconds>]]",
    summary: "Check post-sync readiness. Exits 0 only when ready.",
    details: [
      "Exact unauthenticated GET /readyz returns HTTP 200 when ready, or 503 with Retry-After: 1 for pending or failed.",
      "Its sanitized HTTP identity is {service, version, uptime, pid, port, status}; /healthz is separate liveness, not readiness.",
      "Default is a single identity-checked /readyz probe; old proxies without /readyz fail closed as unreachable.",
      "--wait polls until ready or timeout, but exits immediately on terminal failed (default 45s, max 300s).",
      "--timeout requires --wait and accepts a positive integer (1..300).",
      "--json emits {ready, status, pid, port}; status is one of ready|pending|failed|unreachable.",
      "Invalid or unknown arguments exit 64. Not-ready, pending, failed, timeout, and unreachable exit 1.",
    ],
  },
  {
    name: "lab",
    usage: "ocx lab <status|verdicts|subjects|subject|observations|events|event|artifacts|artifact|catalog> [options] [--json]",
    summary: "Read-only Compatibility Lab projection inspection (local SQLite; no daemon).",
    details: [
      "status                Projection availability, schema versions, and row counts.",
      "verdicts              Paginated derived compatibility verdicts with filters.",
      "subjects              List subjects; subject <id> returns one typed subject.",
      "observations          Paginated observation rows from the projection.",
      "events                Event history; event <id> returns one safe typed event.",
      "artifacts             Artifact metadata only (no content download).",
      "catalog               Packaged protocol/live scenario catalog metadata.",
      "Reads never rebuild the projection, trigger probes, or require the proxy.",
    ],
  },
  {
    name: "__refresh-version",
    hidden: true,
    usage: "ocx __refresh-version [preview|latest]",
    summary: "Hidden detached helper: refresh the cached latest version.",
  },
  {
    name: "__tray-start",
    hidden: true,
    usage: "ocx __tray-start",
    summary: "Hidden internal: start the tray proxy.",
  },
  {
    name: "__tray-restart",
    hidden: true,
    usage: "ocx __tray-restart",
    summary: "Hidden internal: restart the tray proxy.",
  },
  {
    name: "__startup-health",
    hidden: true,
    usage: "ocx __startup-health",
    summary: "Hidden internal: print startup health JSON.",
  },
  {
    name: "__tray-host",
    hidden: true,
    usage: "ocx __tray-host",
    summary: "Hidden internal: run the Windows tray host.",
  },
  {
    name: "__gui-update-worker",
    hidden: true,
    usage: "ocx __gui-update-worker <jobId> [channel] [restart]",
    summary: "Hidden internal: run the GUI update worker.",
  },
];

export function findCommand(name: string): CliCommandEntry | undefined {
  // Exact-name wins so alias-name entries (setup/eject/remove/model) keep their
  // own help text; the canonical entry is the fallback for alias lookups.
  return CLI_COMMANDS.find(entry => entry.name === name)
    ?? CLI_COMMANDS.find(entry => entry.aliases?.includes(name));
}

export function commandNames(): string[] {
  return CLI_COMMANDS.map(entry => entry.name);
}
