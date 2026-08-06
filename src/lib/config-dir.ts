/**
 * Dependency-free config-directory resolution shared by config.ts and the
 * reasoning replay spill (PR #1126): OPENCODEX_HOME (with `~` expansion) wins,
 * otherwise <home>/.opencodex. Kept primitive on purpose so leaf modules can
 * import it without pulling in the whole config surface.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveOpenCodexConfigDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env["OPENCODEX_HOME"]?.trim() || undefined;
  if (!raw) return join(homedir(), ".opencodex");
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(homedir(), raw.slice(2));
  return resolve(raw);
}
