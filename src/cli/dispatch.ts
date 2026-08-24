/**
 * Registry-driven command dispatch (Phase 3 of the CLI deepening).
 *
 * The command switch moved out of src/cli/index.ts into a runner table keyed
 * by command name. Aliases resolve through the registry's alias pairs
 * (init/setup, restore/eject, uninstall/remove, models/model); the registry
 * remains the single source of command metadata. index.ts passes its local
 * helpers (start/stop/ensure/status/...) through CliDispatchDeps so dispatch
 * never needs to import the entry module back (no cycle).
 */
import { CLI_COMMANDS } from "./registry";
import type { CliHead } from "./root";
import type { ReadyArgs } from "./ready";
import type { LiveProxy } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";
import { hasHelpFlag, printSubcommandUsage, printUsage } from "./help";
import { setIntegrationEnabled, shouldSyncCodexOnStart } from "../codex/desired-state";
import { syncModelsToCodex } from "../codex/sync";
import { collectOrcaCodexHomeDiagnostic } from "../codex/home";
import { restoreNativeCodexAsync } from "../codex/inject";
import { stripGrokConfig } from "../grok/inject";
import { afterCatalogWriteHandleAppServers } from "../codex/app-server-processes";
import { normalizeUpdateChannel, runGuiUpdateWorker } from "../update/job";

export interface CliDispatchDeps {
  args: string[];
  command: string | undefined;
  head: CliHead;
  loadConfig: () => OcxConfig;
  findLiveProxy: () => Promise<LiveProxy | null>;
  probeHostname: (hostname: string | undefined) => string;
  waitForProxy: (timeoutMs?: number) => Promise<LiveProxy | null>;
  startArgv: (port?: number) => string[];
  /** Spawn a detached proxy child (stdio ignore, unref'd, provenance env). */
  spawnDetached: (argv: readonly string[]) => void;
  handleStart: () => Promise<void>;
  handleStop: () => Promise<boolean>;
  handleEnsure: (options?: { existingIsSuccess?: boolean }) => Promise<boolean>;
  handleTrayProxyStart: (existingIsSuccess?: boolean) => Promise<boolean>;
  handleTrayProxyRestart: () => Promise<void>;
  handleRestartStartWhenStopped: () => Promise<boolean | "skipped">;
  handleProxyRestart: (startWhenStopped: () => Promise<boolean | "skipped">) => Promise<boolean>;
  handleUninstall: () => Promise<void>;
  handleStatus: () => Promise<void>;
  handleRecoverHistory: () => Promise<void>;
  handleReady: (args: ReadyArgs) => Promise<number>;
  serviceCommand: (...args: string[]) => Promise<void>;
}

type CommandRunner = (deps: CliDispatchDeps) => Promise<number>;

const commandRunners: Record<string, CommandRunner> = {
  init: async () => {
    const { runInit } = await import("./init");
    await runInit();
    // runInit sets process.exitCode = 1 on stdin EOF/closed; preserve it.
    return Number(process.exitCode ?? 0);
  },
  start: async deps => {
    await deps.handleStart();
    return Number(process.exitCode ?? 0);
  },
  stop: async deps => {
    // Downtime warning lives HERE, not in handleStop: `restart`/tray-restart callers
    // re-start the proxy immediately, so warning there would contradict the next line.
    if (await deps.handleStop()) {
      console.log("⚠️  Codex/Claude requests through the proxy will fail until it is restarted ('ocx start' or 'ocx service start').");
    }
    return Number(process.exitCode ?? 0);
  },
  restore: async deps => {
    const restoreJson = deps.args[1] === "--json";
    if (deps.args[1] === "back") {
      // Reverse switch: re-point plain `codex` at the RUNNING proxy without touching its
      // lifecycle — the counterpart of `ocx restore`. Start/stop triggers are unchanged;
      // this only re-runs the same inject (config + catalog + history) `ocx start` does.
      const live = await deps.findLiveProxy();
      if (!live) {
        console.error("No running proxy found. Run 'ocx start' — it injects opencodex automatically.");
        return 1;
      }
      const desired = setIntegrationEnabled("codex", true);
      if (!desired.ok) {
        console.error(`Codex desired state was not saved (${desired.reason}).`);
        return desired.reason === "conflict" ? 2 : 1;
      }
      const synced = await syncModelsToCodex(live.port);
      if (synced.status === "skipped") {
        console.error("Codex integration is OFF; restore back did not change Codex. Retry after the competing integration change finishes.");
        return 2;
      }
      if (!synced.ok) {
        console.error("Plain `codex` was not switched back to opencodex. Fix the reported Codex config issue and retry.");
        return 1;
      }
      const target = collectOrcaCodexHomeDiagnostic();
      console.log(`Plain \`codex\` now routes through opencodex in ${target.effectiveCodexHome} (undo with: ocx restore).`);
      return 0;
    }
    const desired = setIntegrationEnabled("codex", false);
    if (!desired.ok) {
      if (restoreJson) {
        // Machine-readable contract: every restore --json outcome emits one
        // schema-complete envelope on stdout, including pre-machinery failures.
        const { skippedRestoreEnvelope } = await import("../codex/inject");
        console.log(JSON.stringify(skippedRestoreEnvelope(false, `Codex desired state was not saved (${desired.reason}).`)));
      } else {
        console.error(`Codex desired state was not saved (${desired.reason}).`);
      }
      return desired.reason === "conflict" ? 2 : 1;
    }
    // A repeated OFF on an already-clean home is a policy no-op. Do not enter
    // restore's native-profile machinery merely to prove there is nothing to
    // restore: those locks live in CODEX_HOME and a skip must create nothing.
    if (desired.status === "unchanged") {
      const { classifyNativeRoutedResidue } = await import("../codex/native-residue");
      if (classifyNativeRoutedResidue().kind === "clean") {
        const alreadyOff = "Codex integration is already OFF and native; no Codex files changed.";
        if (restoreJson) {
          const { skippedRestoreEnvelope } = await import("../codex/inject");
          console.log(JSON.stringify(skippedRestoreEnvelope(true, alreadyOff)));
        } else {
          console.log(alreadyOff);
        }
        return 0;
      }
    }
    let r: { success: boolean; message: string };
    try {
      r = await restoreNativeCodexAsync({ revalidateDesiredState: true });
    } catch (err) {
      r = { success: false, message: err instanceof Error ? err.message : String(err) };
    }
    if (restoreJson) {
      // Spawned callers need the artifact-level result to distinguish a busy
      // history worker from a successful native restore. Keep stdout machine
      // readable; human framing remains the default command contract.
      console.log(JSON.stringify(r));
      return r.success ? 0 : 1;
    }
    if (r.success) console.log(`✅ ${r.message}`);
    else {
      console.error(`⚠️  ${r.message}`);
    }
    let code = r.success ? 0 : 1;
    try {
      const g = stripGrokConfig();
      if (g.changed) console.log(`✅ ${g.message}`);
      else if (!g.ok) {
        console.error(`⚠️  ${g.message}`);
        code = 1;
      }
    } catch { /* best-effort */ }
    if (r.success) {
      console.log("Codex integration is OFF and plain `codex` now runs natively. Switch back with: ocx restore back");
    } else {
      console.error("Plain `codex` was not fully restored. Inspect $CODEX_HOME/config.toml before using native Codex.");
    }
    return code;
  },
  "recover-history": async deps => {
    await deps.handleRecoverHistory();
    return Number(process.exitCode ?? 0);
  },
  uninstall: async deps => {
    await deps.handleUninstall();
    return Number(process.exitCode ?? 0);
  },
  status: async deps => {
    await deps.handleStatus();
    return Number(process.exitCode ?? 0);
  },
  doctor: async deps => {
    const doctorArgs = deps.args.slice(1);
    const { RECOVER_ZERO_BYTE_COORDINATOR_FLAG, runDoctor } = await import("./doctor");
    await runDoctor(doctorArgs);
    if (!doctorArgs.includes("--fix-codex-runtime") && !doctorArgs.includes(RECOVER_ZERO_BYTE_COORDINATOR_FLAG)) {
      console.log("");
      const { printCodexLogGuardDoctor } = await import("./codex-log-guard-doctor");
      printCodexLogGuardDoctor();
    }
    return 0;
  },
  debug: async deps => {
    const { handleDebugCommand } = await import("./debug");
    await handleDebugCommand(deps.args.slice(1));
    return 0;
  },
  ensure: async deps => {
    await deps.handleEnsure();
    return Number(process.exitCode ?? 0);
  },
  login: async deps => {
    const { handleLogin } = await import("../oauth/login-cli");
    await handleLogin(deps.args[1]);
    return 0;
  },
  logout: async deps => {
    const { removeCredential } = await import("../oauth/store");
    const name = (deps.args[1] ?? "").trim().toLowerCase();
    await removeCredential(name);
    console.log(`Logged out of ${name || "(none)"}.`);
    return 0;
  },
  sync: async deps => {
    const syncArgs = deps.args.slice(1);
    const restartCodex = syncArgs.includes("--restart-codex");
    // Separate flag on purpose: --restart-codex promises app-server-only scope,
    // and quitting the desktop app ends live conversations.
    const restartDesktopApp = syncArgs.includes("--restart-desktop-app");
    const live = await deps.findLiveProxy();
    const synced = await syncModelsToCodex(
      live?.port,
      undefined,
      undefined,
      undefined,
      { catalogEvenWhenNotInjected: true },
    );
    let code = 0;
    if (synced.status === "skipped") {
      console.log("Codex integration is OFF; sync skipped and no Codex files changed.");
    } else if (synced.status === "catalog-only") {
      // Explicit sync with the integration OFF still refreshes the catalog/cache
      // for side profiles that consume the proxy without injection.
      console.log(synced.message ?? "Codex integration is OFF; catalog refreshed, Codex config untouched.");
    } else if (!synced.ok) {
      code = 1;
      console.error("Codex sync did not complete. Fix the reported Codex config issue and retry.");
    }
    // Only warn/restart when a catalog or models_cache write actually happened. This is
    // deliberately not an `else`: refreshCodexModelCatalog runs before injectCodexConfig,
    // so a sync can fail (`ok: false`) after the catalog was already rewritten — which is
    // exactly when a long-lived app-server is holding the stale list.
    if (synced.catalogWritten || synced.cacheSynced) {
      afterCatalogWriteHandleAppServers({ restart: restartCodex, log: console });
      if (restartDesktopApp) await handleDesktopAppRestart(console);
    }
    // `ocx sync` is a direct CLI path; it does not call the management
    // `/api/sync` route. Refresh the already-connected MCode block here too,
    // after Codex has published the catalog that supplies its capabilities.
    if (synced.status !== "refused" && live) {
      try {
        const config = deps.loadConfig();
        const { refreshOwnedIntegration } = await import("../integrations/owned-refresh");
        const result = await refreshOwnedIntegration({
          clientId: "mcode",
          models: async () => {
            const { loadExportModels } = await import("../server/management/model-rows");
            return loadExportModels(config);
          },
          config,
          port: live.port,
        });
        if (result?.changed) console.log("MCode integration refreshed from the current catalog.");
        else if (result?.reason) console.warn(`MCode integration was not refreshed: ${result.reason}`);
      } catch (error) {
        console.warn(`MCode integration was not refreshed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return code;
  },
  v2: async deps => {
    const { cmdV2 } = await import("./v2");
    return await cmdV2(deps.args.slice(1), {}, async () => (await deps.findLiveProxy())?.port);
  },
  "sync-cache": async deps => {
    const cacheArgs = deps.args.slice(1);
    const restartCodex = cacheArgs.includes("--restart-codex");
    const restartDesktopApp = cacheArgs.includes("--restart-desktop-app");
    const { withCatalogWriteSerialization } = await import("../codex/catalog-write-serialization");
    const { invalidateCodexModelsCacheWithPermit } = await import("../codex/catalog/sync");
    const { getCodexHome } = await import("../codex/paths");
    const owningCodexHome = getCodexHome();
    const desiredDisabled = !shouldSyncCodexOnStart(deps.loadConfig());
    const invalidated = withCatalogWriteSerialization(owningCodexHome, permit =>
      invalidateCodexModelsCacheWithPermit(permit, owningCodexHome, { allowWhenDesiredDisabled: true }));
    // Only warn/restart when models_cache was actually rewritten from a readable catalog.
    if (invalidated.kind === "completed" && invalidated.value) {
      afterCatalogWriteHandleAppServers({ restart: restartCodex, log: console });
      if (restartDesktopApp) await handleDesktopAppRestart(console);
    } else if (desiredDisabled) {
      console.log("Codex integration is OFF; cache sync skipped (no catalog or cache write).");
    }
    return 0;
  },
  gui: async deps => {
    const config = deps.loadConfig();
    // Identity-checked liveness (not the pid file + a fixed sleep): finds a fallback-port
    // proxy and waits until the spawned one actually answers before opening the browser.
    let live = await deps.findLiveProxy();
    if (!live) {
      console.log("Proxy not running. Starting...");
      deps.spawnDetached(deps.startArgv((config.port ?? 10100) > 0 ? (config.port ?? 10100) : undefined));
      live = await deps.waitForProxy();
      if (!live) {
        console.error("❌ Proxy did not become healthy after starting. Not opening the GUI.");
        return 1;
      }
    }
    // Open the host the proxy actually binds — `localhost` only answers for
    // loopback/wildcard binds, not a concrete LAN/IPv6 hostname.
    const guiHost = deps.probeHostname(live?.hostname ?? config.hostname);
    const guiUrl = `http://${guiHost === "127.0.0.1" ? "localhost" : guiHost}:${live?.port ?? config.port}`;
    console.log(`Opening ${guiUrl}`);
    const { openUrl } = await import("../lib/open-url");
    openUrl(guiUrl);
    return 0;
  },
  service: async deps => {
    process.exitCode = 0;
    await deps.serviceCommand(...deps.args.slice(1));
    // serviceCommand uses process.exitCode for recoverable install/stop failures
    // that must finish cleanup before the single top-level process.exit runs.
    return Number(process.exitCode ?? 0);
  },
  tray: async deps => {
    const { windowsTrayCommand } = await import("../tray/windows");
    await windowsTrayCommand(deps.args.slice(1));
    return 0;
  },
  "codex-shim": async deps => {
    const { codexShimStatus, diagnoseCodexShim, installCodexShim, uninstallCodexShim } = await import("../codex/shim");
    switch (deps.args[1]) {
      case "install": {
        const r = installCodexShim();
        const { collectCodexShimReadinessWarnings } = await import("./codex-shim-readiness");
        const warnings = diagnoseCodexShim().healthy
          ? collectCodexShimReadinessWarnings()
          : [];
        console.log(`${r.installed && warnings.length === 0 ? "✅ " : "⚠️  "}${r.message}`);
        for (const warning of warnings) console.warn(`   ${warning}`);
        break;
      }
      case "status":
        console.log(codexShimStatus());
        break;
      case "uninstall":
      case "remove": {
        const r = uninstallCodexShim();
        console.log(r.removed ? `✅ ${r.message}` : `⚠️  ${r.message}`);
        break;
      }
      default:
        console.error("Usage: ocx codex-shim <install|status|uninstall|remove>");
        return 1;
    }
    return 0;
  },
  update: async deps => {
    // `ocx update --help` must print usage and exit WITHOUT side effects — running the
    // real self-update stops the proxy and drops in-flight routed streams (issue #168).
    if (hasHelpFlag(deps.args.slice(1))) {
      printSubcommandUsage("update");
      return 0;
    }
    const { runUpdate } = await import("../update");
    await runUpdate();
    return 0;
  },
  "__refresh-version": async deps => {
    // Hidden, detached helper spawned by the update prompt to refresh the
    // cached latest version without blocking the foreground start. Not in help.
    const { refreshVersionCache } = await import("../update/notify");
    const channel = deps.args[1] === "preview" ? "preview" : "latest";
    await refreshVersionCache(channel);
    return 0;
  },
  "__tray-start": async deps => {
    return (await deps.handleTrayProxyStart()) ? 0 : 1;
  },
  "__tray-restart": async deps => {
    await deps.handleTrayProxyRestart();
    return Number(process.exitCode ?? 0);
  },
  "__startup-health": async deps => {
    const { collectStartupHealth } = await import("../codex/autostart-health");
    console.log(JSON.stringify(collectStartupHealth(deps.loadConfig())));
    return 0;
  },
  "__tray-host": async () => {
    const { runWindowsTrayHost } = await import("../tray/windows");
    await runWindowsTrayHost();
    return 0;
  },
  "__gui-update-worker": async deps => {
    const jobId = deps.args[1];
    if (!jobId) return 1;
    const channel = normalizeUpdateChannel(deps.args[2]);
    await runGuiUpdateWorker(jobId, channel, deps.args[3] === "restart");
    return 0;
  },
  restart: async deps => {
    // The running proxy owns its drain and replacement through /api/system/restart.
    // If nothing is live, restart degrades to the documented `ensure` start behavior.
    await deps.handleProxyRestart(deps.handleRestartStartWhenStopped);
    return Number(process.exitCode ?? 0);
  },
  health: async deps => {
    const healthArgs = deps.args.slice(1);
    const wantsHealthJson = healthArgs.includes("--json");
    const live = await deps.findLiveProxy();
    if (wantsHealthJson) {
      console.log(JSON.stringify({ ok: !!live, pid: live?.pid ?? null, port: live?.port ?? null }));
    } else {
      console.log(live ? `Proxy healthy (PID ${live.pid}, port ${live.port})` : "Proxy not healthy");
    }
    return live ? 0 : 1;
  },
  ready: async deps => {
    // Fail-closed impossible-state guard: readyArgs is populated by the
    // preparse block in src/cli/root.ts before maybeAutoRestoreCodexShim, so
    // reaching here without it means dispatch diverged. Refuse with code 64
    // and perform NO I/O (no discovery/probe). process.exit is `never`,
    // narrowing below.
    const readyArgs = deps.head.readyArgs;
    if (!readyArgs) return 64;
    return await deps.handleReady(readyArgs);
  },
  provider: async deps => {
    const { handleProviderCommand } = await import("./provider");
    await handleProviderCommand(deps.args.slice(1));
    return 0;
  },
  account: async deps => {
    const { cmdAccount } = await import("./account");
    return await cmdAccount(deps.args.slice(1));
  },
  models: async deps => {
    const { handleModels } = await import("./models");
    await handleModels(deps.args.slice(1));
    return 0;
  },
  combo: async deps => {
    const { handleComboCommand } = await import("./combo");
    return await handleComboCommand(deps.args.slice(1));
  },
  route: async deps => {
    if (deps.args[1] !== "combo" && deps.args[1] !== "policy") {
      console.error("Usage: ocx route <combo|policy> <subcommand>");
      return 2;
    }
    if (deps.args[1] === "combo") {
      const { handleComboCommand } = await import("./combo");
      return await handleComboCommand(deps.args.slice(2));
    } else {
      const { handleRoutePolicyCommand } = await import("./route-policy");
      return await handleRoutePolicyCommand(deps.args.slice(2));
    }
  },
  agent: async deps => {
    const { handleAgentCommand } = await import("./agent");
    return await handleAgentCommand(deps.args.slice(1));
  },
  observe: async deps => {
    const { handleObserveCommand } = await import("./observe");
    return await handleObserveCommand(deps.args.slice(1));
  },
  logs: async deps => {
    const { handleObserveCommand } = await import("./observe");
    return await handleObserveCommand([deps.command!, ...deps.args.slice(1)]);
  },
  usage: async deps => {
    const { handleObserveCommand } = await import("./observe");
    return await handleObserveCommand([deps.command!, ...deps.args.slice(1)]);
  },
  storage: async deps => {
    const { handleObserveCommand } = await import("./observe");
    return await handleObserveCommand([deps.command!, ...deps.args.slice(1)]);
  },
  memory: async deps => {
    const { handleObserveCommand } = await import("./observe");
    return await handleObserveCommand([deps.command!, ...deps.args.slice(1)]);
  },
  access: async deps => {
    const { handleAccessCommand } = await import("./access");
    return await handleAccessCommand(deps.args.slice(1));
  },
  "api-key": async deps => {
    const { handleAccessCommand } = await import("./access");
    return await handleAccessCommand(["key", ...deps.args.slice(1)]);
  },
  export: async deps => {
    const { handleExportCommand } = await import("./export-command");
    return await handleExportCommand(deps.args.slice(1));
  },
  grok: async deps => {
    const { handleGrokCommand } = await import("./integrations");
    return await handleGrokCommand(deps.args.slice(1));
  },
  integration: async deps => {
    const integration = deps.args[1];
    if (integration === "grok") {
      const { handleGrokCommand } = await import("./integrations");
      return await handleGrokCommand(deps.args.slice(2));
    } else if (integration === "claude") {
      const { handleClaudeConfigCommand } = await import("./integrations");
      return await handleClaudeConfigCommand(deps.args.slice(2));
    } else if (integration === "client") {
      const { handleClientIntegrationCommand } = await import("./integrations");
      return await handleClientIntegrationCommand(deps.args.slice(2));
    } else {
      console.error("Usage: ocx integration <claude|grok|client> <subcommand>");
      return 2;
    }
  },
  system: async deps => {
    const { handleSystemCommand } = await import("./system-command");
    return await handleSystemCommand(deps.args.slice(1));
  },
  config: async deps => {
    const { handleConfigCommand } = await import("./config-command");
    return await handleConfigCommand(deps.args.slice(1));
  },
  lab: async deps => {
    const { handleLabCommand } = await import("./lab");
    return await handleLabCommand(deps.args.slice(1));
  },
  claude: async deps => {
    const { cmdClaude } = await import("./claude");
    // "ocx claude desktop" → write Desktop 3P config
    if (deps.args[1] === "desktop") {
      const { handleClaudeDesktopCommand } = await import("./claude-desktop");
      const exitCode = await handleClaudeDesktopCommand(deps.args.slice(2));
      if (exitCode !== 0) return exitCode;
      return 0;
    }
    if (deps.args[1] === "config") {
      const { handleClaudeConfigCommand } = await import("./integrations");
      return await handleClaudeConfigCommand(deps.args.slice(2));
    }
    return await cmdClaude(deps.args.slice(1));
  },
  opencode: async deps => {
    const { cmdOpencode } = await import("./opencode");
    return await cmdOpencode(deps.args.slice(1));
  },
  mcode: async deps => {
    const { cmdMcode } = await import("./minimax");
    return await cmdMcode(deps.args.slice(1));
  },
  mmx: async deps => {
    const { cmdMmx } = await import("./minimax");
    return await cmdMmx(deps.args.slice(1));
  },
  zcode: async deps => {
    const { handleZcodeCommand } = await import("./integrations");
    return await handleZcodeCommand(deps.args.slice(1));
  },
  help: async () => {
    printUsage();
    return 0;
  },
  "--help": async () => {
    printUsage();
    return 0;
  },
  "-h": async () => {
    printUsage();
    return 0;
  },
};

/** Registry alias pairs → canonical dispatch name (init/setup, restore/eject, …). */
const aliasTargets = new Map<string, string>();
for (const entry of CLI_COMMANDS) {
  for (const alias of entry.aliases ?? []) aliasTargets.set(alias, entry.name);
}

export const DISPATCH_COMMANDS: ReadonlySet<string> = new Set(Object.keys(commandRunners));
export const DISPATCH_ALIASES: ReadonlyMap<string, string> = aliasTargets;

/** Resolve the runner key for a command, following registry aliases to the
 * canonical runner. Returns undefined when the command is unknown. */
export function resolveDispatchCommand(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  if (Object.prototype.hasOwnProperty.call(commandRunners, command)) return command;
  return aliasTargets.get(command);
}

export async function dispatchCommand(head: CliHead, deps: CliDispatchDeps): Promise<number> {
  const command = head.command;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return 0;
  }
  const runner = commandRunners[resolveDispatchCommand(command) ?? ""];
  if (!runner) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    return 1;
  }
  return await runner(deps);
}

/**
 * Report the outcome of an opt-in desktop-app restart. Kept next to the two
 * callers so `sync` and `sync-cache` cannot drift in what they tell the user.
 */
async function handleDesktopAppRestart(log: Pick<Console, "log" | "error">): Promise<void> {
  const { restartCodexDesktopApp } = await import("../codex/desktop-app-restart");
  const result = restartCodexDesktopApp();
  switch (result.reason) {
    case "windows_only":
      log.error("--restart-desktop-app is supported on Windows only; nothing was stopped.");
      return;
    case "package_discovery_failed":
      log.error(
        "Could not identify the installed Codex desktop package. Quit and relaunch the desktop app "
        + "manually to refresh the model picker.",
      );
      return;
    case "self_ancestry":
      log.error(
        "Refusing to restart the desktop app because this command is running inside it. "
        + "Run 'ocx sync --restart-desktop-app' from an external terminal instead.",
      );
      return;
    case "no_targets":
      log.log("Codex desktop app is not running; nothing to restart.");
      return;
    case "targets_survived":
      log.error(
        `Codex desktop app PID(s) ${result.surviving.join(", ")} did not exit, so it was not relaunched. `
        + "Quit the desktop app manually to refresh the model picker.",
      );
      return;
    default:
      if (result.relaunch === "started") {
        log.log("Codex desktop app restarted; its model picker will re-read the catalog.");
      }
  }
}

