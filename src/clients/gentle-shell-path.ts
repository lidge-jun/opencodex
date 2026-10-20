import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";
import { ClientPathError, piAgentDir } from "./client-path";

interface BootstrapIO {
  readText(path: string): { kind: "text"; text: string } | { kind: "missing" } | { kind: "failed" };
}

function absolute(raw: string, label: string): string {
  // Unlike Pi's resolver, the Shell launcher does not expand a literal '~'.
  if (!isAbsolute(raw)) throw new ClientPathError(`${label} must be an absolute path; the proxy cannot infer the launcher's working directory.`);
  return resolve(raw);
}

function readBootstrap(path: string, io?: BootstrapIO): string | undefined {
  try {
    if (!io) return readBoundedRegularFileSync(path, 64 * 1024).toString("utf8");
    const read = io.readText(path);
    if (read.kind === "missing") return undefined;
    if (read.kind === "text" && Buffer.byteLength(read.text, "utf8") <= 64 * 1024) return read.text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  }
  throw new ClientPathError(`Cannot read Gentle Shell launcher config at ${path}; no catalog was selected.`);
}

/** Resolve existing ancestors too, so a not-yet-created catalog cannot hide a directory alias. */
function canonical(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      const value = join(realpathSync.native(current), ...missing);
      return process.platform === "win32" ? value.toLowerCase() : value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current) {
        throw new ClientPathError(`Cannot verify Gentle Shell destination ${path}.`);
      }
      missing.unshift(basename(current));
      current = dirname(current);
    }
  }
}

function sameFile(left: string, right: string): boolean {
  if (canonical(left) === canonical(right)) return true;
  // Hard-linked catalogs can have different canonical names but the same identity.
  try {
    const a = statSync(left, { bigint: true });
    const b = statSync(right, { bigint: true });
    return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ClientPathError("Cannot verify Gentle Shell and Pi catalog identities.");
  }
}

/** Persistent selectors only: a proxy cannot observe one-off `gentle-shell --home` flags. */
export function gentleShellPaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  io?: BootstrapIO,
): { configPath: string; detectDir: string } {
  const config = env.GENTLE_SHELL_CONFIG
    ? absolute(env.GENTLE_SHELL_CONFIG, "GENTLE_SHELL_CONFIG")
    : join(home, ".gentle-shell", "config.json");
  const text = readBootstrap(config, io);
  let selector: unknown;
  try {
    const parsed: unknown = text === undefined ? undefined : JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) selector = (parsed as Record<string, unknown>).home;
  } catch { /* The launcher also falls back to isolated for malformed JSON. */ }
  const shared = "Gentle Shell uses a Pi destination; use the Pi integration for link/shared homes.";
  if (selector === "link") throw new ClientPathError(shared);
  const dir = typeof selector === "string" && selector.length > 0 && selector !== "isolated"
    ? absolute(selector, "Gentle Shell saved home")
    : env.GENTLE_SHELL_HOME
      ? absolute(env.GENTLE_SHELL_HOME, "GENTLE_SHELL_HOME")
      : join(home, ".gentle-shell", "agent");
  const configPath = join(dir, "models.json");
  const piHomes = [join(home, ".pi", "agent"), piAgentDir(env, home)];
  if (env.GENTLE_SHELL_USER_PI_HOME) piHomes.push(absolute(env.GENTLE_SHELL_USER_PI_HOME, "GENTLE_SHELL_USER_PI_HOME"));
  if (piHomes.some(pi => sameFile(configPath, join(pi, "models.json")))) throw new ClientPathError(shared);
  return { configPath, detectDir: dir };
}
