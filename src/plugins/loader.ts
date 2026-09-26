/**
 * Local plugin loader.
 *
 * `ocx start` imports every `*.ts`, `*.js` and `*.mjs` file in `$OPENCODEX_HOME/plugins/`
 * before the server binds, so a plugin's hooks are in place for the first request. A missing
 * directory means no plugins and no work. `OCX_PLUGINS=0` disables loading for one start.
 *
 * A plugin is a module whose default export is `{ name?, setup(ctx) }`. It runs in the proxy
 * process with the operator's credentials, so the loader accepts only files owned by the
 * current user that no other user can write — the same trust boundary as `config.json`.
 * Plugins cannot import ocx internals (a compiled binary keeps them inside `$bunfs`); they
 * receive everything they may use through `OcxPluginContext`.
 *
 * Failures are contained: a plugin that throws, times out or has the wrong shape is reported
 * and skipped, its context stops accepting registrations, and the remaining plugins and the
 * proxy start normally. The setup deadline bounds setup that yields to the event loop; plugins
 * run in the proxy's own thread, so synchronous work that never yields cannot be interrupted.
 */

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getConfigDir } from "../config/paths";
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import { registerUpstreamRewriter, type UpstreamRewriter } from "./upstream-hooks";

export type { UpstreamRewriter, UpstreamTarget, UpstreamTransport } from "./upstream-hooks";

export interface OcxPluginContext {
  /** The plugin's own name, as reported in logs. */
  readonly name: string;
  /** `$OPENCODEX_HOME`, for plugins that keep state next to the proxy's. */
  readonly configDir: string;
  /** `$OPENCODEX_HOME/plugins`. */
  readonly pluginDir: string;
  log(message: string): void;
  /** See `src/plugins/upstream-hooks.ts`. Called synchronously on every provider send. */
  registerUpstreamRewriter(rewrite: UpstreamRewriter): void;
  /** Runs once when the proxy shuts down. Must not throw or block. */
  onShutdown(teardown: () => void): void;
}

export interface OcxPlugin {
  name?: string;
  setup(context: OcxPluginContext): void | Promise<void>;
}

export interface PluginLoadResult {
  file: string;
  name: string;
  loaded: boolean;
  error?: string;
}

const PLUGIN_EXTENSIONS = [".ts", ".js", ".mjs"];
const SETUP_TIMEOUT_MS = 5_000;

export function pluginDirectory(): string {
  return join(getConfigDir(), "plugins");
}

/** A missing directory is "no plugins"; any other read failure propagates to be reported. */
function listPluginFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter(entry => !entry.startsWith(".") && !entry.startsWith("_") && !entry.endsWith(".d.ts"))
    .filter(entry => PLUGIN_EXTENSIONS.some(extension => entry.endsWith(extension)))
    .sort()
    .map(entry => join(dir, entry));
}

/**
 * Null when `path` is safe to trust, otherwise the reason it is refused. `lstat` is used so a
 * symbolic link is judged as a link — and refused — rather than as the file it points to: a
 * link to a file you own would otherwise pass the owner and mode checks. Windows has no
 * POSIX owner or mode bits, so there only the file type is checked.
 */
function trustError(path: string, kind: "file" | "directory"): string | null {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (stats.isSymbolicLink()) return "is a symbolic link";
  if (kind === "file" ? !stats.isFile() : !stats.isDirectory()) return `not a regular ${kind}`;
  if (process.platform === "win32") return null;
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) return "owned by another user";
  if ((stats.mode & 0o022) !== 0) return "writable by group or others (chmod go-w)";
  return null;
}

/** Null when the file is safe to execute, otherwise the reason it is refused. */
export function pluginFileTrustError(file: string): string | null {
  return trustError(file, "file");
}

/**
 * A directory another user can write lets them add or swap plugin files, so its owner and
 * mode are checked like each file's.
 */
export function pluginDirectoryTrustError(dir: string): string | null {
  return trustError(dir, "directory");
}

/**
 * Every directory above the (resolved) plugin directory, up to `/`, must be owned by the user
 * or root and not writable by group or others unless it is sticky (like `/tmp`), where others
 * cannot rename or replace entries they do not own. With no writable component on the path, no
 * other user can swap what the loader checked for something else before it is imported
 * (OpenSSH StrictModes applies the same rule). POSIX only.
 */
export function pluginAncestorsTrustError(realDir: string): string | null {
  if (process.platform === "win32") return null;
  const uid = process.getuid?.();
  let current = dirname(realDir);
  for (;;) {
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(current);
    } catch (error) {
      return `${current}: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (uid !== undefined && stats.uid !== uid && stats.uid !== 0) return `${current} is owned by another user`;
    if ((stats.mode & 0o022) !== 0 && (stats.mode & 0o1000) === 0) {
      return `${current} is writable by group or others`;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isPlugin(value: unknown): value is OcxPlugin {
  return typeof value === "object" && value !== null && typeof (value as OcxPlugin).setup === "function";
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface LoadOcxPluginsOptions {
  /** Deadline for a setup that yields; see the module comment. */
  setupTimeoutMs?: number;
}

export async function loadOcxPlugins(
  dir = pluginDirectory(),
  options: LoadOcxPluginsOptions = {},
): Promise<PluginLoadResult[]> {
  if (process.env["OCX_PLUGINS"] === "0") return [];
  let files: string[];
  try {
    files = listPluginFiles(dir);
  } catch (error) {
    return [{ file: dir, name: "plugins directory", loaded: false, error: error instanceof Error ? error.message : String(error) }];
  }
  if (files.length === 0) return [];
  const dirRefused = pluginDirectoryTrustError(dir);
  if (dirRefused) return [{ file: dir, name: "plugins directory", loaded: false, error: `refused: ${dirRefused}` }];
  // Check and import through the resolved path, so both refer to the same components.
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch (error) {
    return [{ file: dir, name: "plugins directory", loaded: false, error: error instanceof Error ? error.message : String(error) }];
  }
  const ancestorRefused = pluginAncestorsTrustError(realDir);
  if (ancestorRefused) return [{ file: dir, name: "plugins directory", loaded: false, error: `refused: ${ancestorRefused}` }];
  const results: PluginLoadResult[] = [];
  for (const file of files.map(listed => join(realDir, basename(listed)))) {
    const fallbackName = basename(file).replace(/\.(ts|js|mjs)$/, "");
    const refused = pluginFileTrustError(file);
    if (refused) {
      results.push({ file, name: fallbackName, loaded: false, error: `refused: ${refused}` });
      continue;
    }
    const unregister: Array<() => void> = [];
    // Closed when setup fails or times out: a setup that resumes later must not register.
    let active = true;
    let shutdownCount = 0;
    const whileActive = (name: string, register: () => () => void): void => {
      if (!active) {
        console.error(`[plugin:${name}] registration after a failed setup was ignored`);
        return;
      }
      unregister.push(register());
    };
    try {
      const module = await import(pathToFileURL(file).href) as { default?: unknown; plugin?: unknown };
      const plugin = module.default ?? module.plugin;
      if (!isPlugin(plugin)) throw new Error("default export must be { name?, setup(context) }");
      const name = typeof plugin.name === "string" && plugin.name.trim() ? plugin.name.trim() : fallbackName;
      const context: OcxPluginContext = {
        name,
        configDir: getConfigDir(),
        pluginDir: dir,
        log: message => console.log(`[plugin:${name}] ${message}`),
        registerUpstreamRewriter: rewrite => whileActive(name, () => registerUpstreamRewriter(name, rewrite)),
        // Keyed by file and registration, not name: two plugins may share a display name, and
        // one plugin may register several teardowns.
        onShutdown: teardown => whileActive(name, () => registerOptionalShutdownHook(`plugin:${file}#${++shutdownCount}`, teardown)),
      };
      const timeoutMs = options.setupTimeoutMs ?? SETUP_TIMEOUT_MS;
      await withTimeout(Promise.resolve(plugin.setup(context)), timeoutMs, `plugin "${name}" setup`);
      results.push({ file, name, loaded: true });
    } catch (error) {
      // A half-initialised plugin must not leave hooks behind, now or later.
      active = false;
      for (const undo of unregister) undo();
      results.push({
        file,
        name: fallbackName,
        loaded: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/** `ocx start` entry: load and print one line per plugin. Never throws. */
export async function loadAndReportOcxPlugins(): Promise<void> {
  try {
    for (const result of await loadOcxPlugins()) {
      if (result.loaded) console.log(`🔌 Plugin loaded: ${result.name}`);
      else console.error(`⚠️  Plugin ${result.name} skipped: ${result.error}`);
    }
  } catch (error) {
    console.error(`⚠️  Plugin loading failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
