import { existsSync } from "node:fs";
import { win32 } from "node:path";

const CMD_META = /([()%!^"`<>&|;, *?])/g;

function escapeCmdArg(arg) {
  let out = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${out}"`.replace(CMD_META, "^$1");
}

function escapeCmdCommand(command) {
  return command.replace(CMD_META, "^$1");
}

/**
 * Whether a PATH entry *is* the current directory. The hijack this guards against is
 * cmd.exe resolving a bare `npm` out of the directory opencodex was launched from, so
 * only that exact directory has to be skipped — every candidate we hand to spawn is an
 * absolute path, which is what actually defeats the implicit cwd-first search.
 *
 * Deliberately not a subtree test: npm's default Windows global prefix is
 * `%AppData%\npm` (`C:\Users\x\AppData\Roaming\npm`), so excluding everything under the
 * cwd would fail closed for anyone whose shell sits in their home directory — a normal
 * setup, not the untrusted-project case this hardening is for.
 */
function isCurrentDirectory(cwd, entry) {
  const left = win32.resolve(entry);
  const right = win32.resolve(cwd);
  return left.toLowerCase() === right.toLowerCase();
}

function cleanPathEntry(entry) {
  const trimmed = entry.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

export function resolveNpmCommand(
  platform = process.platform,
  env = process.env,
  deps = {},
) {
  if (platform !== "win32") return "npm";
  const exists = deps.exists ?? existsSync;
  const cwd = deps.cwd ?? process.cwd();
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  const pathEntries = (env.PATH ?? env.Path ?? "")
    .split(win32.delimiter)
    .map(cleanPathEntry)
    .filter(Boolean);

  for (const entry of pathEntries) {
    if (!win32.isAbsolute(entry)) continue;
    if (isCurrentDirectory(cwd, entry)) continue;
    for (const extension of extensions) {
      const candidate = win32.join(entry, `npm${extension.toLowerCase()}`);
      if (exists(candidate)) return win32.resolve(candidate);
    }
  }
  return null;
}

function systemCommandProcessor(env) {
  const systemRoot = env.SystemRoot ?? env.windir;
  if (systemRoot && win32.isAbsolute(systemRoot)) {
    return win32.join(systemRoot, "System32", "cmd.exe");
  }
  const comSpec = env.ComSpec;
  return comSpec && win32.isAbsolute(comSpec) ? win32.resolve(comSpec) : null;
}

export function npmInvocation(
  args,
  platform = process.platform,
  env = process.env,
  deps = {},
) {
  const npm = resolveNpmCommand(platform, env, deps);
  if (!npm) return null;
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(npm)) {
    return { file: npm, args: [...args], options: {} };
  }

  const commandProcessor = systemCommandProcessor(env);
  if (!commandProcessor) return null;
  const line = [escapeCmdCommand(npm), ...args.map(escapeCmdArg)].join(" ");
  return {
    file: commandProcessor,
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}
