import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import type { OpencodeLaunchEnv } from "./config-export/contracts";

// Leaf owner of client path validation, shared by config-export and gentle-shell-path
// without an import cycle between them.

/**
 * Expand `~` against the effective home; REFUSE anything still relative.
 *
 * A first attempt at this called `resolve()` and claimed the path would "mean
 * the same thing next time". It does not: `resolve()` only anchors the current
 * invocation, so applying from one directory and disabling from another still
 * resolved two different files — the second reported "not applied" and left
 * the managed block behind with nothing claiming it.
 *
 * There is no honest way to recover the other process's cwd, so a relative
 * selector is refused at the boundary instead of being silently anchored to
 * whichever directory we happened to start in. A `~` path IS stable, because
 * it anchors to the effective home rather than the cwd.
 */
export class ClientPathError extends Error {}

/** Windows rooted paths without a drive still depend on the process's current drive. */
export function isAbsoluteClientPath(raw: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32"
    ? win32.isAbsolute(raw) && win32.parse(raw).root.length > 1
    : posix.isAbsolute(raw);
}

export function absoluteClientPath(raw: string, home: string, variable: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return (platform === "win32" ? win32 : posix).join(home, trimmed.slice(2));
  if (!isAbsoluteClientPath(trimmed, platform)) {
    throw new ClientPathError(
      `${variable} must be an absolute path or start with ~; "${trimmed}" depends on the working directory, `
      + "so opencodex and the client would disagree about which file it names."
      + (platform === "win32" ? " Use a drive letter or UNC share; drive-less rooted paths depend on the current drive." : ""),
    );
  }
  return trimmed;
}

/**
 * Pi resolves its agent directory from `PI_CODING_AGENT_DIR`, falling back to
 * `~/.pi/agent`. `ompAgentDir` below already reads that variable — OMP is a Pi
 * derivative — so Pi's own resolver honoring it is what makes the two agree
 * rather than a new claim about Pi's contract.
 *
 * A relative override is refused for the same reason MCode's and ZCode's are: a
 * background proxy and a foreground client can have different working
 * directories, and would otherwise disagree about which file is named.
 */
export function piAgentDir(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  if (override) return absoluteClientPath(override, home, "PI_CODING_AGENT_DIR");
  return join(home, ".pi", "agent");
}
