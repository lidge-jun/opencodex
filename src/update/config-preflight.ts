import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { configDiagnosticsFromRaw } from "../config/diagnostics";

export interface ConfigPreflightResult {
  ok: boolean;
  reason?: "fallback" | "read_error";
  error?: string;
}

/** Observe the same opened file for type and passive runtime diagnostics. */
export function runConfigPreflight(configPath: string, open: typeof openSync = openSync): ConfigPreflightResult {
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

  try {
    if (!fstatSync(fd).isFile()) {
      return { ok: false, reason: "read_error", error: "Configuration is not a regular file." };
    }
    // This parser takes the passive branch: it neither writes nor creates backups.
    const diagnostics = configDiagnosticsFromRaw(readFileSync(fd, "utf8"));
    return diagnostics.source === "file"
      ? { ok: true }
      : { ok: false, reason: "fallback", error: "Configuration failed to load." };
  } catch {
    return { ok: false, reason: "read_error", error: "Configuration cannot be read as a regular file." };
  } finally {
    closeSync(fd);
  }
}
