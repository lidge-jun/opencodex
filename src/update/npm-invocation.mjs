import { existsSync, realpathSync } from "node:fs";
import { win32 } from "node:path";

const CMD_META = /([()%!^"`<>&|;, *?])/g;

function escapeCmdArg(arg) {
  let out = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${out}"`.replace(CMD_META, "^$1");
}

function escapeCmdCommand(command) {
  return command.replace(CMD_META, "^$1");
}

function isInside(root, candidate) {
  const relative = win32.relative(win32.resolve(root), win32.resolve(candidate));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${win32.sep}`)
    && !win32.isAbsolute(relative)
  );
}

function isSamePath(left, right) {
  return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
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
  const realpath = deps.realpath ?? realpathSync.native;
  const cwd = deps.cwd ?? process.cwd();
  const trustedRoots = [env.APPDATA, env.LOCALAPPDATA, env.ProgramFiles, env["ProgramFiles(x86)"],
    env.USERPROFILE && win32.join(env.USERPROFILE, "scoop", "shims")]
    .filter(root => typeof root === "string" && win32.isAbsolute(root));
  const trustedEntry = entry => trustedRoots.some(root => isInside(root, entry) && !isInside(root, cwd));
  // Scoop installs Node's npm in the app tree, not in scoop/shims. Admit only
  // the two Node apps' current npm directories, never arbitrary Scoop apps or
  // a launch directory inside the installation itself.
  const scoopNodeRoots = typeof env.USERPROFILE === "string" && win32.isAbsolute(env.USERPROFILE)
    ? ["nodejs", "nodejs-lts"].map(app => win32.join(env.USERPROFILE, "scoop", "apps", app))
    : [];
  const trustedScoopNodeEntry = (entry, candidate) => {
    const app = scoopNodeRoots.find(root => {
      const current = win32.join(root, "current");
      return isSamePath(current, entry) || isSamePath(win32.join(current, "bin"), entry);
    });
    if (!app) return null;
    try {
      const appPath = realpath(app);
      const currentPath = realpath(win32.join(app, "current"));
      const entryPath = realpath(entry);
      const candidatePath = realpath(candidate);
      const cwdPath = realpath(cwd);
      const persistBin = win32.join(realpath(env.USERPROFILE), "scoop", "persist", win32.basename(app), "bin");
      const insideInstall = isInside(currentPath, entryPath);
      const persistedBin = isSamePath(entry, win32.join(app, "current", "bin"))
        && isSamePath(entryPath, persistBin);
      return !isSamePath(appPath, currentPath) && isInside(appPath, currentPath)
        && (insideInstall || persistedBin) && isInside(entryPath, candidatePath)
        && !isInside(currentPath, cwdPath) && !isInside(entryPath, cwdPath);
    } catch {
      return false;
    }
  };
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  const pathEntries = (env.PATH ?? env.Path ?? "")
    .split(win32.delimiter)
    .map(cleanPathEntry)
    .filter(Boolean);

  for (const entry of pathEntries) {
    if (!win32.isAbsolute(entry)) continue;
    if (isSamePath(entry, cwd)) continue;
    for (const extension of extensions) {
      const candidate = win32.join(entry, `npm${extension.toLowerCase()}`);
      if (!exists(candidate)) continue;
      const scoopTrust = trustedScoopNodeEntry(entry, candidate);
      if (scoopTrust === false || (scoopTrust === null && isInside(cwd, entry) && !trustedEntry(entry))) continue;
      return win32.resolve(candidate);
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
