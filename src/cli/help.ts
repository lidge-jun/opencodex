import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findCommand } from "./registry";

const repoRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));

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
  ocx doctor --reclaim-response-temps
                              Reclaim abandoned response-state temp files (works without a running proxy)
  ocx debug <scope>           provider/usage/injection/claude on|off|status|reset
  ocx login <provider>        OAuth or API-key provider login
  ocx logout <provider>       Remove a stored OAuth login
  ocx gui                     Open the opencodex dashboard
  ocx update [--tag <tag>]    Update opencodex (keeps preview installs on @preview)
  ocx restart                  Stop and restart the proxy
  ocx v2 <sub>                multi_agent_v2 surface (status|on|off|mode|keep-native-v1|threads|mode-hint)
  ocx health [--json]          Check proxy health (exit 0=healthy, 1=not)
  ocx ready [--json] [--wait [--timeout <s>]]  Check post-sync readiness (exit 0 only when ready)
  ocx provider <sub>          Providers, connectivity, quota, and selected models
  ocx account <sub>           Accounts, login/reauth, key pools, and quota controls
  ocx models <sub>            Live/custom models, visibility, context, and shadow calls
  ocx combo <sub>             Combo failover/round-robin routing
  ocx agent <sub>             Subagents, injection, effort caps, and sidecars
  ocx observe <sub>           Logs, usage, storage, memory, and debug data
  ocx route <sub>             Routing features (combo, policy)
  ocx logs [filters]          Alias of ocx observe logs
  ocx usage [--range <7d|30d|all>]  Alias of ocx observe usage
  ocx storage [--json]        Alias of ocx observe storage
  ocx memory [--json]         Alias of ocx observe memory
  ocx api-key <sub>           Alias of ocx access key
  ocx access <sub>            External API keys and endpoint information
  ocx export --client <id>    Print a client config wired to the running proxy (11 clients)
  ocx integration client <sub> Enable, disable, inspect or roll back a client integration
  ocx grok <sub>              Grok Build model selection and apply
  ocx system <sub>            Runtime settings, startup, sync, and updates
  ocx config <sub>            Validated configuration show/get/set/import/export
  ocx lab <sub>               Read-only Compatibility Lab projection inspection
  ocx claude [args...]        Launch Claude Code wired to the proxy (model discovery on)
  ocx claude desktop [sub]    Manage and apply Claude Desktop's four-family profile
  ocx opencode [args...]      Launch opencode wired to the proxy (runtime provider config)
  ocx mcode [args...]         Launch MiniMax Code through its managed provider
  ocx mmx text <sub> [args]   Launch MiniMax CLI text through the proxy
  ocx zcode [sub]             Connect ZCode to the proxy (managed provider)
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
  const entry = name ? findCommand(name) : undefined;
  if (!entry) {
    console.error(`Unknown command: ${name ?? ""}`.trim());
    printUsage();
    process.exit(1);
  }
  console.log(`Usage: ${entry.usage}\n\n${entry.summary}`);
  if (entry.details?.length) console.log(`\n${entry.details.join("\n")}`);
}
