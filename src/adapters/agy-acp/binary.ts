/**
 * Locating the official Antigravity CLI and checking that it is new enough to serve ACP.
 *
 * The version probe runs `agy --version` with no shell, a scoped environment, a private working
 * directory, bounded output and a timeout, and is cached by the resolved executable's real path and
 * modification time so an upgrade or a different override is probed again. It never runs for a turn
 * the policy gate already refused.
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

/** 1.5.1 ensures session/update notifications precede the session/prompt reply. */
export const AGY_ACP_MIN_VERSION: readonly [number, number, number] = [1, 5, 1];
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

const cache = new Map<string, AgyVersionProbe>();

function cacheKey(binary: string): string | undefined {
  try {
    const real = realpathSync(binary);
    return `${real}\0${statSync(real).mtimeMs}`;
  } catch {
    return undefined;
  }
}

/** Probe once per executable identity; an unreadable probe is not cached so a fixed install recovers. */
export async function probeAgyVersion(binary: string, run: RunVersion): Promise<AgyVersionProbe> {
  const key = cacheKey(binary);
  const cached = key ? cache.get(key) : undefined;
  if (cached) return cached;
  const output = await run(binary);
  const version = output === undefined ? undefined : parseAgyVersion(output);
  if (!version) return { ok: false, reason: "unreadable" };
  const text = version.join(".");
  const result: AgyVersionProbe = versionAtLeast(version, AGY_ACP_MIN_VERSION) ? { ok: true, version: text } : { ok: false, reason: "too_old", version: text };
  if (key) cache.set(key, result);
  return result;
}

export function clearAgyVersionCacheForTests(): void {
  cache.clear();
}
