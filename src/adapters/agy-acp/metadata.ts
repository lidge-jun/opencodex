import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfigDir } from "../../config/paths";
import type { ProviderQuotaWindow } from "../../providers/quota-types";
import { baseScopedEnv } from "../coding-agent/turn";
import { parseAgyVersion, probeAgyVersion, readAgyExecutable, resolveAgyBinary, versionAtLeast } from "./binary";
import { createTurnWorkspace } from "./process";

const run = promisify(execFile);

/** Only fixed CLI metadata commands run here. Google credentials stay with the CLI. */
export async function readAgyMetadata(kind: "models" | "quota"): Promise<string> {
  const binary = resolveAgyBinary();
  if (!binary) throw new Error("Antigravity CLI unavailable");
  const workspace = await createTurnWorkspace(getConfigDir());
  try {
    const executable = readAgyExecutable(binary);
    if (!executable) throw new Error("Antigravity CLI unavailable");
    const options = {
      cwd: workspace.dir, env: { ...baseScopedEnv(), NO_COLOR: "1", TMPDIR: workspace.tmp, TEMP: workspace.tmp, TMP: workspace.tmp },
      timeout: 15000, killSignal: "SIGKILL" as const, maxBuffer: 128 * 1024, windowsHide: true,
    };
    const version = await probeAgyVersion(executable.path, async path => (await run(path, ["--version"], options)).stdout);
    if (!version.ok || readAgyExecutable(binary)?.identity !== executable.identity) throw new Error("Unsupported CLI");
    // Headless /usage TSV verified with 1.5.13. Older CLIs may interpret slash input differently.
    if (kind === "quota" && !versionAtLeast(parseAgyVersion(version.version)!, [1, 5, 13])) throw new Error("Unsupported quota command");
    const args = kind === "models" ? ["models"] : ["--sandbox", "--print-timeout", "12s", "-p", "/usage"];
    const { stdout } = await run(executable.path, args, options);
    return stdout;
  } catch {
    throw new Error("Antigravity CLI metadata unavailable");
  } finally {
    await workspace.remove();
  }
}

export function agyModelIds(stdout: string): string[] {
  const ids = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(gemini-[a-z0-9][a-z0-9.-]{0,120})\t[^\t]+$/.exec(line);
    if (match) ids.add(match[1]!.replace(/-(low|medium|high|xhigh|max)$/, ""));
  }
  return [...ids];
}

export function agyQuotaWindows(stdout: string): ProviderQuotaWindow[] {
  const windows: ProviderQuotaWindow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.split("\t");
    if (fields.length !== 4) continue;
    const [group, period, remaining, reset] = fields as [string, string, string, string];
    if (!/^[\w ().-]{1,80}$/.test(group) || !/^[\w ().-]{1,100}$/.test(period)) continue;
    if (!/^\d{1,3}(?:\.\d+)?%$/.test(remaining)) continue;
    const percent = 100 - Number.parseFloat(remaining);
    const resetAt = Date.parse(reset);
    if (percent < 0 || !Number.isFinite(resetAt)) continue;
    const window = /weekly/i.test(period) ? "Weekly" : /five hour/i.test(period) ? "5h" : period;
    windows.push({ label: group + " (" + window + ")", percent, resetAt });
  }
  return windows;
}
