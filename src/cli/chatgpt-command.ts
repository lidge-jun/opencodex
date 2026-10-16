import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config";
import { readConfigFileSnapshot } from "../config/diagnostics";
import { chatgptDesktopConfigIssue } from "../config/schema/chatgpt-desktop";
import {
  chatgptShimLauncherPath,
  resolveChatgptCodexBinary,
  writeChatgptShimLauncher,
} from "../chatgpt/app-server-shim/launcher";
import { untrustedChatgptBundleReason } from "../chatgpt/app-server-shim/bundle-trust";
import { darwinDefaultExec, darwinDesktopAppAdapter } from "../codex/desktop-app/darwin";
import type { DesktopAppInstall } from "../codex/desktop-app/types";

const USAGE = `Usage (experimental, macOS only):
  ocx chatgpt launch   Relaunch ChatGPT with the experimental app-server shim (requires appServerShim: true)
  ocx chatgpt restore  Relaunch ChatGPT without the experimental shim and remove its launcher
  ocx chatgpt status   Inspect experimental flag, launcher and running app environment`;

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5000 });
  return { ok: result.status === 0, status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/**
 * Why the config file's `chatgptDesktop` block reads as absent, or null when it is valid, absent
 * or the file cannot be parsed (the config loader reports that case itself).
 */
function chatgptDesktopIssueInFile(): string | null {
  const { raw } = readConfigFileSnapshot();
  if (raw === undefined) return null;
  try {
    return chatgptDesktopConfigIssue(JSON.parse(raw.replace(/^\uFEFF/, "")));
  } catch {
    return null;
  }
}

/**
 * The installed app, found and confirmed by bundle identifier (com.openai.codex) the same way the
 * desktop restart adapter does. "ChatGPT" is a display name another app can share, so quitting,
 * relaunching and the binary path all key on this verified bundle rather than on the name.
 */
function discoverApp(): DesktopAppInstall | null | undefined {
  try {
    return darwinDesktopAppAdapter.discover(darwinDefaultExec);
  } catch {
    // An inspection error is not evidence that the app is uninstalled.
    return undefined;
  }
}

/**
 * Only inspect the verified bundle's own process; never print the environment being inspected.
 * `-a` keeps ancestors in the match: when ocx runs inside a ChatGPT/Codex session the app is
 * one of this process's ancestors, and plain `pgrep -x` would report it as not running.
 */
function appState(install: DesktopAppInstall, launcher: string): { running: boolean | null; shim: boolean | null } {
  const shell = join(install.root, "Contents", "MacOS", "ChatGPT");
  // Only this user's processes: another account's ChatGPT can neither be quit nor relaunched here.
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const pids = run("pgrep", [...(uid === undefined ? [] : ["-U", String(uid)]), "-a", "-x", "ChatGPT"]);
  // pgrep exit 1 means no match; timeout, signal, or command errors are unknown.
  if (!pids.ok) return pids.status === 1
    ? { running: false, shim: false } : { running: null, shim: null };
  const candidates = pids.output.split(/\s+/).filter(value => /^\d+$/.test(value));
  if (candidates.length === 0) return { running: null, shim: null };
  let unreadable = false;
  for (const pid of candidates) {
    const command = run("ps", ["eww", "-o", "command=", "-p", pid]);
    if (!command.ok || !command.output) unreadable = true;
    if (command.ok && (command.output === shell || command.output.startsWith(`${shell} `))) {
      const marker = `CODEX_CLI_PATH=${launcher}`;
      const start = command.output.indexOf(marker);
      return { running: true, shim: start >= 0 && (start === 0 || command.output[start - 1] === " ")
        && (start + marker.length === command.output.length || command.output[start + marker.length] === " ") };
    }
  }
  return unreadable ? { running: null, shim: null } : { running: false, shim: false };
}

/** Adapted from #5947: open ignores new launch settings until the previous app exits. */
async function quitApp(install: DesktopAppInstall, launcher: string): Promise<boolean> {
  const initial = appState(install, launcher).running;
  if (initial === false) return true;
  if (initial === null) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    run("/usr/bin/osascript", ["-e", `quit app id "${install.id}"`]);
    for (let poll = 0; poll < 20; poll++) {
      const running = appState(install, launcher).running;
      if (running === false) return true;
      if (running === null) return false;
      await Bun.sleep(250);
    }
  }
  return appState(install, launcher).running === false;
}

export async function handleChatgptCommand(args: string[], platform: NodeJS.Platform = process.platform): Promise<number> {
  const sub = args[0];
  if (!sub || ["help", "--help", "-h"].includes(sub)) {
    console.log(USAGE);
    return sub ? 0 : 64;
  }
  if (!["launch", "restore", "status"].includes(sub) || args.length !== 1) {
    console.error(USAGE);
    return 64;
  }
  if (platform !== "darwin") {
    console.error("ChatGPT app-server shim (experimental): macOS only.");
    return 1;
  }
  try {
    const config = loadConfig();
    const launcher = chatgptShimLauncherPath();
    const install = discoverApp();
    if (sub === "status") {
      const app = install ? appState(install, launcher)
        : install === undefined ? { running: null, shim: null } : { running: false, shim: false };
      const configIssue = config.chatgptDesktop?.appServerShim === true ? null : chatgptDesktopIssueInFile();
      const flag = config.chatgptDesktop?.appServerShim === true ? "on"
        : configIssue ? `off (config.json ${configIssue}; the whole chatgptDesktop block is ignored)` : "off";
      console.log(`app-server shim (experimental): ${flag}
launcher: ${existsSync(launcher) ? "present" : "absent"}
app: ${install === undefined ? "unknown (app discovery failed)" : install ? (app.running === null ? "unknown (process inspection failed)" : app.running ? "running" : "not running") : "not installed"}
CODEX_CLI_PATH launcher: ${app.shim === null ? "unknown" : app.shim ? "yes" : "no"}`);
      return 0;
    }
    if (install === undefined) {
      console.error("ChatGPT app discovery failed; no launcher was changed and no app was opened. Retry after resolving discovery.");
      return 1;
    }
    if (!install) {
      if (sub === "restore") rmSync(launcher, { force: true });
      console.error("ChatGPT (com.openai.codex) was not found; install or open it once, then retry.");
      return 1;
    }
    let binary: string | undefined;
    if (sub === "launch") {
      if (config.chatgptDesktop?.appServerShim !== true) {
        // Read the file only to explain a refusal; restore and a valid launch never touch it.
        const configIssue = chatgptDesktopIssueInFile();
        console.error(configIssue
          ? `Experimental shim disabled: config.json ${configIssue}. The whole chatgptDesktop block is ignored until that is fixed.`
          : "Experimental shim disabled; set chatgptDesktop.appServerShim: true before launching.");
        return 1;
      }
      binary = resolveChatgptCodexBinary(install.root) ?? undefined;
      if (!binary) {
        console.error(`No bundled app-server binary was found in ${install.root}; the shim cannot launch this build.`);
        return 1;
      }
    }
    // Both relaunch paths execute the discovered bundle. Restore validates the app
    // shell without requiring an app-server binary or the experimental opt-in flag.
    const untrusted = untrustedChatgptBundleReason(install.root, binary);
    if (untrusted) {
      console.error(`Refusing to ${sub === "launch" ? "launch the shim" : "restore ChatGPT"}: ${untrusted}.`);
      return 1;
    }
    // Preflight before changing the launcher. quitApp rechecks at the action boundary.
    if (appState(install, launcher).running === null) {
      console.error("ChatGPT process inspection failed; no launcher was changed and no app was opened. Retry after resolving inspection.");
      return 1;
    }
    if (binary) writeChatgptShimLauncher(undefined, binary);
    if (!(await quitApp(install, launcher))) {
      console.error("ChatGPT exit could not be confirmed; no new app was opened. Check the running app and retry.");
      return 1;
    }
    // Remove an inherited override too: restore must launch without CODEX_CLI_PATH.
    const env = { ...process.env };
    delete env.CODEX_CLI_PATH;
    // Open the verified bundle by path, so the relaunch is the same app that was quit.
    const result = spawnSync("/usr/bin/open", ["-a", install.root, ...(sub === "launch" ? ["--env", `CODEX_CLI_PATH=${launcher}`] : [])], {
      encoding: "utf8", env, timeout: 10000,
    });
    if (result.status !== 0) throw new Error(result.error?.message ?? (result.stderr?.trim() || "open failed"));
    if (sub === "restore") rmSync(launcher, { force: true });
    console.log(`ChatGPT relaunched ${sub === "launch" ? "with" : "without"} the experimental app-server shim.`);
    return 0;
  } catch (error) {
    console.error(`ChatGPT shim (experimental): ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
