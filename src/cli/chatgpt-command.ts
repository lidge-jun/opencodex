import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { loadConfig } from "../config";
import type { OcxConfig } from "../types";
import { findLiveProxy } from "../server/proxy-liveness";
import { getConfigDir } from "../config/paths";
import { claudeInterceptCaCertPath } from "../claude/intercept/local-ca";
import { chatgptCaTrustCommand, inspectChatgptCaTrust } from "../chatgpt/desktop-unblock/ca-trust";
import { chatgptUnblockPort, chatgptUnblockResolverArg } from "../chatgpt/desktop-unblock/runtime";
import {
  chatgptAppCommandLine, chatgptCommandLineHasRule, chatgptUnblockWatcherStatus,
  installChatgptUnblockWatcher, launchChatgptWithRule, probeChatgptUnblockListener,
  uninstallChatgptUnblockWatcher,
} from "../chatgpt/desktop-unblock/launch-watcher";
import { interactiveConfirm } from "./interactive-confirm";
import { chatgptShimLauncherPath, writeChatgptShimLauncher } from "../chatgpt/app-server-shim/launcher";

const USAGE = `Usage (experimental, macOS only):
  ocx chatgpt launch                 Relaunch with configured app-server shim and/or TLS intercept
  ocx chatgpt restore                Relaunch with native networking and remove the shim launcher
  ocx chatgpt status                 Inspect flags, listener, CA trust, watcher and app environment
  ocx chatgpt install-watcher [--yes] Install the intercept launch watcher (requires unblockSend: true)
  ocx chatgpt uninstall-watcher      Remove the intercept launch watcher`;

export function resolveChatgptUnblockPort(config: OcxConfig, livePort: number | undefined): number {
  return chatgptUnblockPort(config, livePort ?? config.port ?? 10100);
}

const WATCHER_CONSENT = `The experimental watcher quits and reopens ChatGPT after a Dock/Spotlight launch
without intercept switches while opencodex's listener is running. This can interrupt
startup work. It manages the TLS intercept only; use 'ocx chatgpt launch' for the shim.
Remove it with 'ocx chatgpt uninstall-watcher'.`;

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5000 });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/**
 * Only inspect the named bundle process; never print the environment being inspected.
 * `-a` keeps ancestors in the match: when ocx runs inside a ChatGPT/Codex session the app is
 * one of this process's ancestors, and plain `pgrep -x` would report it as not running.
 */
function appState(launcher: string): { running: boolean; shim: boolean } {
  const pids = run("pgrep", ["-a", "-x", "ChatGPT"]);
  if (!pids.ok) return { running: false, shim: false };
  for (const pid of pids.output.split(/\s+/).filter(value => /^\d+$/.test(value))) {
    const command = run("ps", ["eww", "-o", "command=", "-p", pid]);
    if (command.ok && command.output.includes("ChatGPT.app/Contents/MacOS/ChatGPT")) {
      const marker = `CODEX_CLI_PATH=${launcher}`;
      const start = command.output.indexOf(marker);
      return { running: true, shim: start >= 0 && (start === 0 || command.output[start - 1] === " ")
        && (start + marker.length === command.output.length || command.output[start + marker.length] === " ") };
    }
  }
  return { running: false, shim: false };
}

/** Adapted from #5947: open ignores new launch settings until the previous app exits. */
async function quitApp(launcher: string): Promise<boolean> {
  if (!appState(launcher).running) return true;
  for (let attempt = 0; attempt < 3; attempt++) {
    run("osascript", ["-e", 'quit app "ChatGPT"']);
    for (let poll = 0; poll < 20; poll++) {
      if (!appState(launcher).running) return true;
      await Bun.sleep(250);
    }
  }
  return !appState(launcher).running;
}

export async function handleChatgptCommand(args: string[], platform: NodeJS.Platform = process.platform): Promise<number> {
  const sub = args[0];
  if (!sub || ["help", "--help", "-h"].includes(sub)) {
    console.log(USAGE);
    return sub ? 0 : 64;
  }
  if (!["launch", "restore", "status", "install-watcher", "uninstall-watcher"].includes(sub)
    || (sub === "install-watcher" ? args.slice(1).some(arg => arg !== "--yes") || args.length > 2 : args.length !== 1)) {
    console.error(USAGE);
    return 64;
  }
  if (platform !== "darwin") {
    console.error("ChatGPT desktop integrations (experimental): macOS only.");
    return 1;
  }
  try {
    // Removal remains available even if the hand-edited config or derived port is invalid.
    if (sub === "uninstall-watcher") {
      uninstallChatgptUnblockWatcher();
      console.log("Experimental intercept launch watcher removed.");
      return 0;
    }
    const config = loadConfig();
    const intercept = config.chatgptDesktop?.unblockSend === true;
    const shim = config.chatgptDesktop?.appServerShim === true;
    const live = intercept || sub === "status" ? await findLiveProxy().catch(() => null) : null;
    const port = intercept && sub !== "restore" && sub !== "status" ? resolveChatgptUnblockPort(config, live?.port) : undefined;
    const launcher = chatgptShimLauncherPath();
    if (sub === "status") {
      const app = appState(launcher);
      console.log(`app-server shim (experimental): ${config.chatgptDesktop?.appServerShim === true ? "on" : "off"}
launcher: ${existsSync(launcher) ? "present" : "absent"}
app: ${app.running ? "running" : "not running"}
CODEX_CLI_PATH launcher: ${app.shim ? "yes" : "no"}`);
      try {
        await printInterceptStatus(config, resolveChatgptUnblockPort(config, live?.port));
      } catch (error) {
        console.log(`Intercept status unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      return 0;
    }
    if (sub === "install-watcher") {
      if (!intercept || config.runtimeRole === "client") {
        console.error("Enable chatgptDesktop.unblockSend in a server config before installing the watcher.");
        return 1;
      }
      console.log(WATCHER_CONSENT);
      if (!args.includes("--yes") && (!process.stdin.isTTY
        || !(await interactiveConfirm({ question: "Install the experimental intercept watcher?", defaultYes: false })))) {
        console.error("Watcher not installed; re-run with --yes to confirm.");
        return 1;
      }
      installChatgptUnblockWatcher({ port: port! });
      console.log(`Experimental intercept launch watcher installed for port ${port}.`);
      return 0;
    }
    if (sub === "launch") {
      if (!shim && !intercept) {
        console.error("Enable chatgptDesktop.appServerShim or chatgptDesktop.unblockSend before launching.");
        return 1;
      }
      if (intercept) {
        if (config.runtimeRole === "client" || (await probeChatgptUnblockListener(port!)).state !== "ours") {
          console.error("Experimental intercept listener is not answering; start opencodex in server mode first.");
          return 1;
        }
      }
      if (shim) writeChatgptShimLauncher();
    }
    // A loaded watcher would immediately put the intercept switches back on restore.
    if (sub === "restore") {
      if (chatgptUnblockWatcherStatus(0).agentLoaded) {
        console.error("Uninstall the launch watcher before restoring native networking.");
        return 1;
      }
    }
    if (sub === "launch" && intercept) {
      // The intercept script owns the restart under its lock so the watcher cannot race it.
      const result = launchChatgptWithRule(port!, undefined, shim ? ["--env", `CODEX_CLI_PATH=${launcher}`] : []);
      if (result.output) (result.ok ? console.log : console.error)(result.output);
      return result.ok ? 0 : 1;
    }
    if (!(await quitApp(launcher))) {
      console.error("ChatGPT did not quit; quit it manually and retry.");
      return 1;
    }
    // Remove an inherited override too: restore must launch without CODEX_CLI_PATH.
    const env = { ...process.env };
    delete env.CODEX_CLI_PATH;
    const result = spawnSync("open", ["-a", "ChatGPT", ...(sub === "launch" && shim ? ["--env", `CODEX_CLI_PATH=${launcher}`] : [])], {
      encoding: "utf8", env, timeout: 10000,
    });
    if (result.status !== 0) throw new Error(result.error?.message ?? (result.stderr?.trim() || "open failed"));
    if (sub === "restore") rmSync(launcher, { force: true });
    console.log(`ChatGPT relaunched ${sub === "launch" ? "with" : "without"} the configured experimental integrations.`);
    return 0;
  } catch (error) {
    console.error(`ChatGPT desktop (experimental): ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function printInterceptStatus(config: OcxConfig, port: number): Promise<void> {
  const listener = await probeChatgptUnblockListener(port);
  const watcher = chatgptUnblockWatcherStatus(port);
  const app = chatgptAppCommandLine();
  const flagged = app !== null && chatgptCommandLineHasRule(app, port);
  const caPath = claudeInterceptCaCertPath(getConfigDir());
  const trust = await inspectChatgptCaTrust(caPath);
  console.log(`send-unblock TLS intercept (experimental): ${config.chatgptDesktop?.unblockSend === true ? "on" : "off"}
listener: ${port} (${listener.state === "ours" ? "listening" : listener.state === "foreign" ? "held by another process" : "not listening"})
resolver switch: ${chatgptUnblockResolverArg(port)}
CA trust: ${trust}
watcher script: ${watcher.scriptInstalled ? watcher.scriptUpToDate ? "installed" : "outdated; reinstall" : "absent"}
watcher agent: ${watcher.agentLoaded ? "loaded" : watcher.plistInstalled ? "installed but not loaded" : "absent"}
app intercept switches: ${flagged ? "yes" : "no"}`);
  if (trust === "untrusted") console.log(`Trust manually with: ${chatgptCaTrustCommand(caPath)}`);
  if (listener.state === "ours") {
    for (const block of listener.preservedSendBlocks) console.log(`Send block kept: ${block.name}: ${block.reason} (last seen ${block.lastSeen})`);
  }
  if (flagged && listener.state !== "ours") console.log("ChatGPT is routed to a closed or foreign port; start opencodex again or run ocx chatgpt restore.");
}
