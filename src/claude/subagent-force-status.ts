import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeConfigDir } from "./gateway-cache";
import { findNativePosixClaude, supportsClaudeShim } from "./native-executable";
import { commandInvocation } from "../lib/win-exec";

const VERSION_PROBE_TIMEOUT_MS = 1_500;
const VERSION_PROBE_CACHE_MS = 30_000;
let cachedProbe: { key: string; expiresAt: number; result: Promise<string | null> } | undefined;

export interface SubagentForceStatus {
  targetValid: boolean;
  version: string | null;
  support: "supported" | "unsupported" | "unknown";
  settingsOverride: boolean;
  settingsReadable: boolean;
}

export function subagentForceSupport(version: string | null): SubagentForceStatus["support"] {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return "unknown";
  const [major, minor, patch] = match.slice(1).map(Number);
  return major! > 2 || (major === 2 && (minor! > 1 || (minor === 1 && patch! >= 257))) ? "supported" : "unsupported";
}

export function probeInstalledClaudeCodeVersion(): Promise<string | null> {
  // Reuse the in-flight or recent result (including unknown) within the same executable lookup context.
  const { PATH, PATHEXT, ComSpec } = process.env;
  const key = JSON.stringify([process.platform, process.cwd(), PATH, PATHEXT, ComSpec]);
  const now = performance.now();
  if (cachedProbe?.key === key && cachedProbe.expiresAt > now) return cachedProbe.result;

  const executable = supportsClaudeShim() ? findNativePosixClaude() : "claude";
  if (!executable) return Promise.resolve(null);
  const invocation = commandInvocation(executable, ["--version"]);
  const result = new Promise<string | null>(resolve => {
    const child = execFile(invocation.file, invocation.args, { ...invocation.options, maxBuffer: 4096 }, (error, stdout) => {
      clearTimeout(deadline);
      resolve(error ? null : /^\s*(\d+\.\d+\.\d+)(?:\s|$)/.exec(String(stdout))?.[1] ?? null);
    });
    const deadline = setTimeout(() => {
      resolve(null);
      try { child.kill("SIGKILL"); } catch { /* child already exited */ }
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, VERSION_PROBE_TIMEOUT_MS);
  }).catch(() => null);
  cachedProbe = { key, expiresAt: now + VERSION_PROBE_CACHE_MS, result };
  return result;
}

/** Server-local observation only: never returns settings values or modifies settings. */
export async function inspectSubagentForceStatus(
  targetValid: boolean,
  configDir = claudeConfigDir(),
  versionProbe: () => Promise<string | null> = probeInstalledClaudeCodeVersion,
): Promise<SubagentForceStatus> {
  const version = await versionProbe().catch(() => null);
  let settingsOverride = false;
  let settingsReadable = true;
  try {
    const path = join(configDir, "settings.json");
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 1_048_576) throw new Error("settings unavailable");
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid settings");
    const env = parsed.env;
    settingsOverride = !!env && typeof env === "object" && !Array.isArray(env)
      && (Object.hasOwn(env, "CLAUDE_CODE_SUBAGENT_MODEL") || Object.hasOwn(env, "CLAUDE_CODE_SUBAGENT_MODEL_FORCE"));
  } catch (error) {
    settingsReadable = (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  return { targetValid, version, support: subagentForceSupport(version), settingsOverride, settingsReadable };
}
