import { existsSync } from "node:fs";
import { win32 } from "node:path";

const CMD_META = /([()%!^"`<>&|;, *?])/g;

function escapeCmdArg(arg) {
  const out = String(arg).replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\*)$/, "$1$1");
  return `"${out}"`.replace(CMD_META, "^$1");
}

function escapeCmdCommand(command) {
  return command.replace(CMD_META, "^$1");
}

function cleanPathEntry(entry) {
  const trimmed = entry.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

function pathEntries(platform, env) {
  const raw = env.PATH ?? env.Path ?? "";
  const delimiter = platform === "win32" ? win32.delimiter : ":";
  return raw.split(delimiter).map(cleanPathEntry).filter(Boolean);
}

function isCurrentDirectory(cwd, entry) {
  const left = win32.resolve(entry);
  const right = win32.resolve(cwd);
  return left.toLowerCase() === right.toLowerCase();
}

function systemCommandProcessor(env) {
  const systemRoot = env.SystemRoot ?? env.windir;
  if (systemRoot && win32.isAbsolute(systemRoot)) {
    return win32.join(systemRoot, "System32", "cmd.exe");
  }
  const comSpec = env.ComSpec;
  return comSpec && win32.isAbsolute(comSpec) ? win32.resolve(comSpec) : null;
}

function commandPaths(platform, env, deps) {
  const exists = deps.exists ?? existsSync;
  const cwd = deps.cwd ?? process.cwd();
  const entries = pathEntries(platform, env);
  const paths = [];

  if (platform !== "win32") {
    for (const entry of entries) {
      if (!entry.startsWith("/")) continue;
      const candidate = `${entry}/pnpm`;
      if (exists(candidate) && !paths.includes(candidate)) paths.push(candidate);
    }
    return paths;
  }

  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  for (const entry of entries) {
    if (!win32.isAbsolute(entry) || isCurrentDirectory(cwd, entry)) continue;
    for (const extension of extensions) {
      const candidate = win32.join(entry, `pnpm${extension.toLowerCase()}`);
      if (exists(candidate)) {
        const resolved = win32.resolve(candidate);
        if (!paths.some(path => path.toLowerCase() === resolved.toLowerCase())) paths.push(resolved);
      }
    }
  }
  return paths;
}

function invocationForPath(pnpm, args, platform, env) {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(pnpm)) {
    return { file: pnpm, args: [...args], options: {} };
  }

  const commandProcessor = systemCommandProcessor(env);
  if (!commandProcessor) return null;
  const line = [escapeCmdCommand(pnpm), ...args.map(escapeCmdArg)].join(" ");
  return {
    file: commandProcessor,
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

/** Return every absolute pnpm executable candidate in PATH, in shell order. */
export function resolvePnpmCommands(
  platform = process.platform,
  env = process.env,
  deps = {},
) {
  return commandPaths(platform, env, deps);
}

/** Build an invocation for one already-selected pnpm executable. */
export function pnpmInvocationForPath(
  pnpm,
  args,
  platform = process.platform,
  env = process.env,
) {
  return invocationForPath(pnpm, args, platform, env);
}

/**
 * Resolve pnpm without relying on cmd.exe's implicit current-directory lookup on Windows.
 * POSIX returns an absolute PATH candidate as well, so a service receives the same
 * executable that the interactive shell selected.
 */
export function resolvePnpmCommand(
  platform = process.platform,
  env = process.env,
  deps = {},
) {
  return resolvePnpmCommands(platform, env, deps)[0] ?? null;
}

export function pnpmInvocation(
  args,
  platform = process.platform,
  env = process.env,
  deps = {},
) {
  const pnpm = resolvePnpmCommand(platform, env, deps);
  if (!pnpm) return null;
  return invocationForPath(pnpm, args, platform, env);
}

/** Return invocations for every absolute pnpm candidate in PATH. */
export function pnpmInvocations(
  args,
  platform = process.platform,
  env = process.env,
  deps = {},
) {
  return resolvePnpmCommands(platform, env, deps)
    .map(command => invocationForPath(command, args, platform, env))
    .filter(Boolean);
}
