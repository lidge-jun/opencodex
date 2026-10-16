import { spawnSync } from "node:child_process";
import { isAbsolute, join, normalize } from "node:path";
import { untrustedChatgptBundleReason } from "../app-server-shim/bundle-trust";

export interface WatcherBundlePreflightDeps {
  platform: NodeJS.Platform;
  trustReason(path: string): string | null;
  bundleIdentifier(path: string): string | null;
}

const defaults: WatcherBundlePreflightDeps = {
  platform: process.platform,
  trustReason: untrustedChatgptBundleReason,
  bundleIdentifier(path) {
    const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(path, "Contents", "Info.plist")], {
      encoding: "utf8", timeout: 5000,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  },
};

/** Recheck the recorded bundle on each watcher wake, before either quit or open. */
export function chatgptWatcherBundleProblem(path: string, deps: WatcherBundlePreflightDeps = defaults): string | null {
  if (deps.platform !== "darwin") return "the ChatGPT launch watcher is only supported on macOS";
  if (!isAbsolute(path) || normalize(path) !== path) return "the ChatGPT bundle path must be absolute and normalized";
  const reason = deps.trustReason(path);
  if (reason) return reason;
  if (deps.bundleIdentifier(path) !== "com.openai.codex") return "the bundle identifier is not com.openai.codex";
  return null;
}

export function runChatgptWatcherBundlePreflight(path: string): number {
  const problem = chatgptWatcherBundleProblem(path);
  if (!problem) return 0;
  console.error(`Refusing the ChatGPT watcher action: ${problem}.`);
  return 1;
}
