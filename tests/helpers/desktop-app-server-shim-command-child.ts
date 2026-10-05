// Isolated command fixture: real trust policy, synthetic metadata/signatures and app processes.
import { mock } from "bun:test";
import * as fs from "node:fs";
import * as childProcess from "node:child_process";
import { dirname, join } from "node:path";

const [dir, encoded] = process.argv.slice(2);
if (!dir || !encoded) throw new Error("isolated fixture directory and scenario required");
const scenario = JSON.parse(encoded);
const root = join(dir, "ChatGPT.app");
const shell = join(root, "Contents", "MacOS", "ChatGPT");
const binary = join(root, "Contents", "Resources", "codex");
const launcher = join(dir, "launcher.sh");
const realLstat = fs.lstatSync;
const ancestors = new Set<string>();
for (let parent = dirname(root); ; parent = dirname(parent)) {
  ancestors.add(parent);
  if (dirname(parent) === parent) break;
}
const calls: Array<{ command: string; args: string[]; override?: string }> = [];
let running = scenario.running === true;
const uid = typeof process.getuid === "function" ? process.getuid() : -1;

mock.module("node:fs", () => ({ ...fs, lstatSync(path: string, ...args: unknown[]) {
  if (path === dir && scenario.adminParent) return {
    uid: 0, gid: 80, mode: 0o775,
    isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false,
  };
  if (path === dir && scenario.trust === "foreign-parent") return {
    uid: uid + 2, gid: 20, mode: 0o755,
    isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false,
  };
  if (ancestors.has(path) || path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)) {
    return {
      uid: scenario.trust === "foreign-owner" && path === root ? uid + 2 : uid,
      mode: scenario.trust === "writable" ? 0o777 : 0o755,
      isFile: () => path === shell || path === binary,
      isDirectory: () => path !== shell && path !== binary,
      isSymbolicLink: () => scenario.trust === "symlink" && path === shell,
    };
  }
  return (realLstat as Function)(path, ...args);
} }));
mock.module("node:child_process", () => ({ ...childProcess, spawnSync(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) {
  calls.push({ command, args, override: options?.env?.CODEX_CLI_PATH });
  if (command === "/usr/bin/dscl") return { status: scenario.adminLookupFails ? 1 : 0, stdout: "PrimaryGroupID: 80\n", stderr: "" };
  if (command === "/usr/bin/codesign") return {
    status: scenario.trust === "unsigned" ? 1 : 0,
    stdout: args[0] === "--verify" ? "" : `TeamIdentifier=${scenario.trust === "foreign-team" ? "OTHERTEAM" : "2DC432GLL2"}\n`, stderr: "",
  };
  if (command === "pgrep") return { status: running ? 0 : 1, stdout: running ? "123" : "", stderr: "" };
  if (command === "ps") return { status: 0, stdout: shell, stderr: "" };
  if (command === "/usr/bin/osascript") running = false;
  if (command === "/usr/bin/open" && scenario.openFails) return { status: 1, stdout: "", stderr: "fixture open failed" };
  return { status: 0, stdout: "", stderr: "" };
} }));
mock.module("../../src/config", () => ({ loadConfig: () => ({ chatgptDesktop: { appServerShim: scenario.flag === true } }) }));
// A refused launch explains a dropped chatgptDesktop block from the config file; never read this
// machine's config here.
mock.module("../../src/config/diagnostics", () => ({ readConfigFileSnapshot: () => ({ raw: scenario.configRaw }) }));
mock.module("../../src/codex/desktop-app/darwin", () => ({
  darwinDefaultExec: () => "",
  darwinDesktopAppAdapter: { discover: () => scenario.noInstall ? null : { id: "com.openai.codex", root, relaunch: "com.openai.codex" } },
}));
mock.module("../../src/chatgpt/app-server-shim/launcher", () => ({
  chatgptShimLauncherPath: () => launcher,
  resolveChatgptCodexBinary: () => scenario.missingBinary ? null : binary,
  writeChatgptShimLauncher: () => { fs.writeFileSync(launcher, "new launcher"); },
}));
// The send-unblock intercept is out of scope here, and its live probes (listening port, launchd agent,
// keychain trust, a running opencodex) must never reach this machine. Its watcher is absent unless
// the scenario loads one.
mock.module("../../src/chatgpt/desktop-unblock/launch-watcher", () => ({
  chatgptAppCommandLine: () => null,
  chatgptCommandLineHasPac: () => false,
  chatgptCommandLineHasRule: () => false,
  chatgptUnblockWatcherStatus: () => ({
    scriptInstalled: false, plistInstalled: false, agentLoaded: scenario.watcherLoaded === true,
    scriptUpToDate: false, plistUpToDate: false,
  }),
  installChatgptUnblockWatcher: () => { throw new Error("fixture: the watcher is out of scope"); },
  launchChatgptWithRule: () => ({ ok: false, output: "fixture: the intercept launch is out of scope" }),
  probeChatgptUnblockListener: async () => ({ state: "down" }),
  uninstallChatgptUnblockWatcher: () => undefined,
}));
mock.module("../../src/server/proxy-liveness", () => ({ findLiveProxy: async () => null }));
mock.module("../../src/chatgpt/desktop-unblock/ca-trust", () => ({
  inspectChatgptCaTrust: async () => "missing",
  chatgptCaTrustCommand: () => "",
}));
const { handleChatgptCommand } = await import("../../src/cli/chatgpt-command");
const code = await handleChatgptCommand([scenario.sub ?? "restore"], "darwin");
console.log(JSON.stringify({ code, calls, launcherExists: fs.existsSync(launcher), root, shell, binary }));
