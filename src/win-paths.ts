/**
 * Windows path → batch-safe env indirection.
 *
 * cmd.exe parses .cmd files in the console's OEM codepage (CP949/GBK/CP437…), NOT UTF-8.
 * Any absolute path we bake into a generated batch file breaks for users whose profile
 * directory contains non-ASCII characters (e.g. Korean/Chinese usernames), because the
 * UTF-8 bytes we wrote are decoded as mojibake at parse time. Instead of baking the
 * profile prefix literally, rewrite it as a `%USERPROFILE%`-style token: cmd expands the
 * variable natively at parse time in the correct codepage, so the non-ASCII prefix never
 * has to survive a file-encoding round trip.
 */

export type WindowsEnvMap = Record<string, string | undefined>;

/** Ordered by specificity; longest resolved prefix wins regardless of this order. */
const INDIRECTION_VARS = ["LOCALAPPDATA", "APPDATA", "USERPROFILE"] as const;

/** True when `prefix` matches a leading whole-component span of `path` (case-insensitive). */
function isComponentPrefix(path: string, prefix: string): boolean {
  if (path.length < prefix.length) return false;
  if (path.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return false;
  if (path.length === prefix.length) return true;
  const next = path[prefix.length];
  return next === "\\" || next === "/";
}

/**
 * Split a Windows path into an env-token prefix and the remaining literal suffix.
 * Returns `token: ""` (and the full path as `rest`) when no known prefix applies.
 */
export function splitWindowsEnvPrefix(path: string, env: WindowsEnvMap = process.env): { token: string; rest: string } {
  let best: { name: string; value: string } | null = null;
  for (const name of INDIRECTION_VARS) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const value = raw.replace(/[\\/]+$/, "");
    if (!value || !isComponentPrefix(path, value)) continue;
    if (!best || value.length > best.value.length) best = { name, value };
  }
  if (!best) return { token: "", rest: path };
  return { token: `%${best.name}%`, rest: path.slice(best.value.length) };
}

/**
 * Render a single path for embedding in a batch `set "X=…"` line: env-token prefix kept
 * verbatim (cmd must expand it), remaining literal suffix run through the caller's batch
 * escaping (which doubles `%` and would otherwise destroy the token itself).
 */
export function windowsEnvIndirectBatchValue(
  path: string,
  escape: (value: string) => string,
  env: WindowsEnvMap = process.env,
): string {
  const { token, rest } = splitWindowsEnvPrefix(path, env);
  return token + escape(rest);
}

/** Same as {@link windowsEnvIndirectBatchValue} for `;`-separated path lists (PATH). */
export function windowsEnvIndirectBatchPathList(
  value: string,
  escape: (value: string) => string,
  env: WindowsEnvMap = process.env,
): string {
  return value
    .split(";")
    .map(part => (part ? windowsEnvIndirectBatchValue(part, escape, env) : part))
    .join(";");
}
