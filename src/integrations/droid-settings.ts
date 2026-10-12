/** Read-only guard for competing Factory settings before a managed write. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join, win32 } from "node:path";

const isWindowsRoot = (path: string) => /^[A-Za-z]:[\\/]|^\\\\/.test(path);

function endpointKey(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase())
      ? "127.0.0.1" : url.hostname.toLowerCase();
    return `${url.protocol}//${host}:${url.port}${url.pathname.replace(/\/+$/, "") || "/"}`;
  } catch { return null; }
}

/** Other Factory settings can take priority over the managed personal rows. */
export function assertDroidSettingsUnambiguous(root: string, baseUrl?: string, modelIds: readonly string[] = []): void {
  const managedEndpoint = baseUrl === undefined ? null : endpointKey(baseUrl);
  const managedModels = new Set(modelIds);
  try {
    const directory = lstatSync(root);
    if (!directory.isDirectory()) throw new Error("Unsafe Factory settings directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const name of ["config.json", "settings.local.json"]) {
    const path = isWindowsRoot(root) ? win32.join(root, name) : join(root, name);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Cannot inspect Factory ${name}`);
    }
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error(`Unsafe Factory ${name}`);
    let value: unknown;
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > 1024 * 1024 || opened.ino !== stat.ino || opened.dev !== stat.dev) {
        throw new Error("file changed during inspection");
      }
      value = JSON.parse(readFileSync(fd, "utf8"));
    } catch { throw new Error(`Cannot safely parse Factory ${name}`); }
    finally { if (fd !== undefined) closeSync(fd); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Unsafe Factory ${name}`);
    const rows = name === "config.json"
      ? (value as Record<string, unknown>).custom_models
      : (value as Record<string, unknown>).customModels;
    if (name === "settings.local.json" && rows !== undefined) {
      throw new Error("Factory settings.local.json overrides customModels; resolve its precedence before enabling Droid");
    }
    if (name === "config.json" && Array.isArray(rows) && rows.some(row => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return false;
      const legacy = row as Record<string, unknown>;
      return (typeof legacy.display_name === "string" && legacy.display_name.startsWith("OpenCodex:"))
        || (typeof legacy.model === "string" && managedModels.has(legacy.model))
        || (managedEndpoint !== null && typeof legacy.base_url === "string"
          && endpointKey(legacy.base_url) === managedEndpoint);
    })) {
      throw new Error("Factory config.json already defines OpenCodex models; resolve its precedence before enabling Droid");
    }
  }
}
