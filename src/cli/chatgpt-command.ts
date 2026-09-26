import { loadConfig } from "../config";
import { findLiveProxy } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";
import {
  chatgptAppCommandLine,
  chatgptCommandLineHasRule,
  chatgptUnblockWatcherStatus,
  installChatgptUnblockWatcher,
  launchChatgptWithRule,
  probeChatgptUnblockListener,
  restoreChatgptNative,
  uninstallChatgptUnblockWatcher,
} from "../chatgpt/desktop-unblock/launch-watcher";
import { chatgptPacFallbackEnabled, chatgptUnblockEntryPort, chatgptUnblockPacArg, chatgptUnblockPort, chatgptUnblockResolverArg } from "../chatgpt/desktop-unblock/runtime";
import { chatgptCommandLineHasPac } from "../chatgpt/desktop-unblock/launch-watcher";
import { chatgptCaTrustCommand, inspectChatgptCaTrust } from "../chatgpt/desktop-unblock/ca-trust";
import { claudeInterceptCaCertPath } from "../claude/intercept/local-ca";
import { getConfigDir } from "../config/paths";
import { interactiveConfirm } from "./interactive-confirm";

/**
 * `ocx chatgpt` — inspect and operate the ChatGPT desktop send-unblock integration (macOS).
 *
 *   ocx chatgpt status                   Feature, listener, trust, watcher and app state
 *   ocx chatgpt install-watcher [--yes]  Install the launch watcher (Dock/Spotlight launches too)
 *   ocx chatgpt uninstall-watcher        Remove the launch watcher
 *   ocx chatgpt launch                   Launch the app with the intercept switches
 *   ocx chatgpt restore                  Relaunch a switched app with native networking
 */

const USAGE = `Usage:
  ocx chatgpt status                   Feature, listener, certificate trust, watcher and app state
  ocx chatgpt install-watcher [--yes]  Install the launch watcher (covers Dock/Spotlight launches)
  ocx chatgpt uninstall-watcher        Remove the launch watcher
  ocx chatgpt launch                   Launch the ChatGPT app with the intercept switches
  ocx chatgpt restore                  Relaunch a switched ChatGPT app with native networking`;

/** Port the intercept listens on: explicit config, else live proxy + offset, else default + offset. */
export function resolveChatgptUnblockPort(config: OcxConfig, livePort: number | undefined): number {
  return chatgptUnblockPort(config, livePort ?? (typeof config.port === "number" ? config.port : 10100));
}

const WATCHER_CONSENT = `The launch watcher runs each time the ChatGPT app starts. If the app was opened
normally (Dock, Spotlight) while opencodex is running, it quits the app right after launch
and reopens it with the opencodex route. It never acts on an app that is already in use,
and does nothing while opencodex is not running. Remove it any time with
'ocx chatgpt uninstall-watcher'.`;

export async function handleChatgptCommand(args: string[], platform: NodeJS.Platform = process.platform): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return sub ? 0 : 64;
  }
  if (!["status", "install-watcher", "uninstall-watcher", "launch", "restore"].includes(sub)) {
    console.error(`unknown subcommand: ${sub}`);
    return 64;
  }
  if (platform !== "darwin") {
    // lsof/pgrep/launchd do not exist elsewhere; answering "not running" would be a false report.
    console.error("The ChatGPT desktop send-unblock integration is only supported on macOS.");
    return sub === "status" ? 0 : 1;
  }

  // uninstall-watcher must work even when the port cannot be resolved: the operator may need
  // to remove the watcher precisely because the configuration no longer resolves.
  if (sub === "uninstall-watcher") {
    try {
      uninstallChatgptUnblockWatcher();
    } catch (error) {
      console.error(`Launch watcher not removed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    console.log("Launch watcher removed.");
    return 0;
  }

  const config = loadConfig();
  const live = await findLiveProxy().catch(() => null);
  let port: number;
  try {
    port = resolveChatgptUnblockPort(config, live?.port);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (sub === "status") return await printStatus(config, port, live?.port);

  if (sub === "install-watcher") {
    if (config.chatgptDesktop?.unblockSend !== true) {
      console.error("chatgptDesktop.unblockSend is not enabled; add it to ~/.opencodex/config.json first:");
      console.error('  { "chatgptDesktop": { "unblockSend": true } }');
      return 1;
    }
    console.log(WATCHER_CONSENT);
    if (!args.includes("--yes")) {
      if (!process.stdin.isTTY) {
        console.error("Re-run with --yes to confirm installing the launch watcher.");
        return 1;
      }
      if (!(await interactiveConfirm({ question: "Install the launch watcher?", defaultYes: false }))) {
        console.log("Launch watcher not installed.");
        return 1;
      }
    }
    try {
      const pacMode = chatgptPacFallbackEnabled(config);
      installChatgptUnblockWatcher({
        port,
        ...(pacMode ? { entryPort: chatgptUnblockEntryPort(config, live?.port ?? (typeof config.port === "number" ? config.port : 10100)) } : {}),
      });
    } catch (error) {
      console.error(`Launch watcher not installed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    console.log(`🛰 Launch watcher installed for port ${port}.`);
    return 0;
  }

  const pacMode = chatgptPacFallbackEnabled(config);
  const entryPort = pacMode ? chatgptUnblockEntryPort(config, live?.port ?? (typeof config.port === "number" ? config.port : 10100)) : undefined;

  if (sub === "launch") return report(launchChatgptWithRule(port, undefined, pacMode, entryPort));

  // restore: the watcher would put the switches straight back on the relaunch while opencodex runs.
  const watcher = chatgptUnblockWatcherStatus(port, undefined, pacMode, entryPort);
  if (watcher.agentLoaded && (await probeChatgptUnblockListener(port)).state === "ours") {
    console.error("The launch watcher would re-apply the opencodex route on relaunch while opencodex is running.");
    console.error("Run 'ocx chatgpt uninstall-watcher' first, or stop opencodex, then 'ocx chatgpt restore'.");
    return 1;
  }
  return report(restoreChatgptNative(port, undefined, pacMode, entryPort));
}

function report(result: { ok: boolean; output: string }): number {
  if (result.output) (result.ok ? console.log : console.error)(result.output);
  return result.ok ? 0 : 1;
}

async function printStatus(config: OcxConfig, port: number, livePort: number | undefined): Promise<number> {
  const enabled = config.chatgptDesktop?.unblockSend === true;
  const pacMode = chatgptPacFallbackEnabled(config);
  const configDir = getConfigDir();
  const entryPort = pacMode ? chatgptUnblockEntryPort(config, livePort ?? (typeof config.port === "number" ? config.port : 10100)) : undefined;
  const listener = await probeChatgptUnblockListener(port);
  const watcher = chatgptUnblockWatcherStatus(port, configDir, pacMode, entryPort);
  const appCommandLine = chatgptAppCommandLine();
  const appRunning = appCommandLine !== null;
  const appFlagged = appRunning
    && (pacMode ? chatgptCommandLineHasPac(appCommandLine, configDir) : chatgptCommandLineHasRule(appCommandLine, port));
  const caPath = claudeInterceptCaCertPath(configDir);
  const trust = await inspectChatgptCaTrust(caPath);
  const listenerLine = {
    ours: "listening",
    foreign: "held by ANOTHER process (not opencodex); set chatgptDesktop.port to a free port",
    down: "not listening",
  }[listener.state];
  const trustLine = {
    trusted: "trusted",
    untrusted: "NOT trusted (account, usage and settings pages will fail to load)",
    missing: "not created yet (start opencodex with the feature enabled)",
    unknown: "could not be checked",
    unsupported: "not applicable on this platform",
  }[trust];
  const launchSwitch = pacMode ? chatgptUnblockPacArg(configDir) : chatgptUnblockResolverArg(port);
  console.log(`ChatGPT send-unblock:
  feature enabled:     ${enabled ? "yes" : "no (set chatgptDesktop.unblockSend: true)"}${pacMode ? "\n  PAC fallback:        on (auto-fallback to the VPN chain / direct when opencodex is down)" : ""}
  listener port:       ${port} (${listenerLine})${pacMode && entryPort ? `\n  entry port:          ${entryPort}` : ""}
  launch switch:       ${launchSwitch}
  CA trust:            ${trustLine}
  watcher script:      ${watcher.scriptInstalled ? (watcher.scriptUpToDate ? "installed" : "installed (outdated; reinstall)") : "not installed"}
  watcher agent:       ${watcher.agentLoaded ? "loaded" : watcher.plistInstalled ? "installed but not loaded" : "not installed"}
  app:                 ${appRunning ? (appFlagged ? "running with switches" : "running WITHOUT switches (composer will lock)") : "not running"}`);
  if (trust === "untrusted") console.log(`  restore trust with:  ${chatgptCaTrustCommand(caPath)}`);
  if (listener.state === "ours" && listener.preservedSendBlocks.length > 0) {
    // Non-quota send blocks are deliberately left in place; name them so a locked composer has a cause.
    console.log("  send blocks kept:    (not usage quota, so not lifted)");
    for (const block of listener.preservedSendBlocks) console.log(`    - ${block.name}: ${block.reason} (last seen ${block.lastSeen})`);
  }
  if (appFlagged && listener.state !== "ours") {
    console.log(pacMode ? `
  ⚠ The app is routed through opencodex's PAC, but the listener is not answering. ChatGPT
    falls back to the system chain automatically; until the PAC is refreshed it may bypass
    opencodex on the next launches. Run 'ocx chatgpt restore' for clean native networking.` : `
  ⚠ The app is routed to port ${port}, but opencodex's listener is not answering there.
    Every chatgpt.com request from the app fails until opencodex runs again, or run
    'ocx chatgpt restore' to relaunch the app with native networking.`);
  }
  return 0;
}
