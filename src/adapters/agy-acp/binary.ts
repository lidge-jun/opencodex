/**
 * Locating the official Antigravity CLI and checking that it is new enough to serve ACP.
 *
 * The version probe runs `agy --version` with no shell, a scoped environment, a private working
 * directory, bounded output and a timeout. A verdict is cached against the real path and file
 * identity, so a replaced or modified binary must be probed again. It never runs for a turn
 * the policy gate already refused.
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Includes the terminal sandbox security fix documented in the CLI 1.5.3 changelog. */
export const AGY_ACP_MIN_VERSION: readonly [number, number, number] = [1, 5, 3];
export const MAX_AGY_VERSION_OUTPUT_LENGTH = 4096;
export const AGY_BIN_ENV = "OPENCODEX_AGY_BIN";
export const AGY_INSTALL_HINT = `Install the Antigravity CLI (agy) ${AGY_ACP_MIN_VERSION.join(".")} or newer and sign in with \`agy acp --login\`, or set OPENCODEX_AGY_BIN to its absolute path.`;

/** The configured absolute override, else `agy` on PATH; undefined when neither resolves. */
export function resolveAgyBinary(env: NodeJS.ProcessEnv = process.env, which: (name: string) => string | null = name => Bun.which(name)): string | undefined {
  const override = env[AGY_BIN_ENV]?.trim();
  if (override) return isAbsolute(override) ? override : undefined;
  return which("agy") ?? undefined;
}

/** agy --version prints a single line containing the numeric version. */
export function parseAgyVersion(output: string): [number, number, number] | undefined {
  if (output.length > MAX_AGY_VERSION_OUTPUT_LENGTH) return undefined;
  const match = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(output.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function versionAtLeast(found: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if ((found[i] ?? 0) !== (min[i] ?? 0)) return (found[i] ?? 0) > (min[i] ?? 0);
  }
  return true;
}

export type AgyVersionProbe =
  | { ok: true; version: string }
  | { ok: false; reason: "too_old"; version: string }
  | { ok: false; reason: "unreadable" };

export type RunVersion = (binary: string) => Promise<string | undefined>;

export interface AgyExecutable { path: string; identity: string }

const cache = new Map<string, { identity: string; verdict: AgyVersionProbe }>();

export function readAgyExecutable(binary: string): AgyExecutable | undefined {
  try {
    const path = realpathSync(binary);
    const stat = statSync(path, { bigint: true });
    if (!stat.isFile()) return undefined;
    return { path, identity: [path, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join("\0") };
  } catch {
    return undefined;
  }
}

/** Probe once per executable identity; an unreadable probe is not cached so a fixed install recovers. */
export async function probeAgyVersion(binary: string, run: RunVersion): Promise<AgyVersionProbe> {
  const executable = readAgyExecutable(binary);
  if (!executable) return { ok: false, reason: "unreadable" };
  const cached = cache.get(executable.path);
  if (cached?.identity === executable.identity) return cached.verdict;
  const output = await run(executable.path);
  if (readAgyExecutable(binary)?.identity !== executable.identity) return { ok: false, reason: "unreadable" };
  const version = output === undefined ? undefined : parseAgyVersion(output);
  if (!version) return { ok: false, reason: "unreadable" };
  const text = version.join(".");
  const result: AgyVersionProbe = versionAtLeast(version, AGY_ACP_MIN_VERSION) ? { ok: true, version: text } : { ok: false, reason: "too_old", version: text };
  cache.set(executable.path, { identity: executable.identity, verdict: result });
  return result;
}

export function clearAgyVersionCacheForTests(): void {
  cache.clear();
}
