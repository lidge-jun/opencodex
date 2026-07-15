/**
 * Cross-platform command launching (devlog 260715_cross_platform_audit/020).
 *
 * Windows npm installs expose CLIs as `.cmd` shims, and Node/Bun refuse shell-less
 * `.cmd` spawns (CVE-2024-27980 hardening). Bare names like `spawn("claude")` also
 * skip PATHEXT resolution entirely, so they ENOENT even when `claude.cmd` is on PATH.
 * This module mirrors the battle-tested cross-spawn approach: resolve the real target
 * via PATH×PATHEXT, launch `.exe` targets directly (argument boundaries preserved by
 * the normal shell-less spawn), and route `.cmd`/`.bat` targets through
 * `cmd.exe /d /s /c "<escaped line>"` with `windowsVerbatimArguments: true`.
 */
import { existsSync } from "node:fs";
import { win32 } from "node:path";

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
/** cross-spawn parse.js: only npm local-bin shims get double escaping. */
const IS_CMD_SHIM = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;

/** cross-spawn escape.js argument(): quote + escape one argument for cmd.exe /d /s /c. */
export function escapeCmdArg(arg: string, doubleEscape = false): string {
  let out = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  out = `"${out}"`.replace(CMD_META, "^$1");
  return doubleEscape ? out.replace(CMD_META, "^$1") : out;
}

/** cross-spawn escape.js command(): escape the command token itself (no quoting). */
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, "^$1");
}

export interface ResolveDeps {
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
}

/**
 * Resolve a bare command name to its first PATH×PATHEXT hit (win32 semantics).
 * Commands that already carry an extension, a separator, or an absolute prefix are
 * returned unchanged; unresolvable names fall back unchanged (spawn will surface it).
 */
export function resolveWindowsCommand(command: string, deps: ResolveDeps = {}): string {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  if (win32.extname(command) || command.includes("\\") || command.includes("/") || win32.isAbsolute(command)) {
    return command;
  }
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of (env.PATH ?? env.Path ?? "").split(win32.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = win32.join(dir, command + ext.toLowerCase());
      if (exists(candidate)) return candidate;
    }
  }
  return command;
}

export interface SpawnInvocation {
  file: string;
  args: string[];
  options: { windowsVerbatimArguments?: boolean };
}

/**
 * Platform-safe invocation preserving argument boundaries (cross-spawn parse.js).
 * POSIX: passthrough. win32 `.exe`: resolved direct spawn. win32 `.cmd`/`.bat`:
 * `ComSpec /d /s /c "<escaped command line>"` with verbatim args; npm local-bin
 * shims get cross-spawn's double escaping, all other batch targets single.
 */
export function commandInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  deps: ResolveDeps = {},
): SpawnInvocation {
  if (platform !== "win32") return { file: command, args: [...args], options: {} };
  const resolved = resolveWindowsCommand(command, deps);
  if (!/\.(cmd|bat)$/i.test(resolved)) return { file: resolved, args: [...args], options: {} };
  const env = deps.env ?? process.env;
  const doubleEscape = IS_CMD_SHIM.test(resolved);
  const line = [escapeCmdCommand(resolved), ...args.map(a => escapeCmdArg(a, doubleEscape))].join(" ");
  return {
    file: env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

/**
 * `sh -c <command>` analog per platform. The configured command string is passed
 * VERBATIM in content; on win32 it gets the outer quotes `/s` requires, so
 * `"C:\Program Files\x.exe" --json` runs as `cmd.exe /d /s /c ""C:\Program Files\x.exe" --json"`.
 * Contract: the command is platform-native shell syntax (sh on POSIX, CMD on Windows).
 */
export function shellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): SpawnInvocation {
  if (platform !== "win32") return { file: "sh", args: ["-c", command], options: {} };
  return {
    file: env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${command}"`],
    options: { windowsVerbatimArguments: true },
  };
}
