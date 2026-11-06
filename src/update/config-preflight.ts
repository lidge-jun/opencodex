import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { configDiagnosticsFromRaw } from "../config/diagnostics";

export interface ConfigPreflightResult {
  ok: boolean;
  reason?: "fallback" | "read_error";
  error?: string;
}

/** Observe the same opened file for type and passive runtime loadability. */
export function runConfigPreflight(configPath: string, open: typeof openSync = openSync, close: typeof closeSync = closeSync): ConfigPreflightResult {
  let fd: number;
  try {
    // Nonblocking open avoids hanging on a FIFO before its type can be checked.
    fd = open(configPath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        // A dangling link occupies the path even though opening its target failed.
        lstatSync(configPath);
      } catch (entryError: unknown) {
        if ((entryError as NodeJS.ErrnoException).code === "ENOENT") return { ok: true };
      }
    }
    return { ok: false, reason: "read_error", error: "Configuration cannot be read as a regular file." };
  }

  let result: ConfigPreflightResult;
  try {
    if (!fstatSync(fd).isFile()) {
      result = { ok: false, reason: "read_error", error: "Configuration is not a regular file." };
    } else {
      const raw = readFileSync(fd, "utf8");
      result = runtimeAcceptsConfig(raw) ? { ok: true } : { ok: false, reason: "fallback", error: "Configuration failed to load." };
    }
  } catch {
    result = { ok: false, reason: "read_error", error: "Configuration cannot be read as a regular file." };
  } finally {
    try { close(fd); } catch { result = { ok: false, reason: "read_error", error: "Configuration cannot be read as a regular file." }; }
  }
  return result;
}

function runtimeAcceptsConfig(raw: string): boolean {
  // Imported text takes the same passive path as disk diagnostics, without a backup.
  // Discard configuration-derived warnings, including provider and model names.
  return configDiagnosticsFromRaw(raw, { warn: () => {} }).source === "file";
}
