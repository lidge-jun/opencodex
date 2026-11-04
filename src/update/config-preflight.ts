import { lstatSync } from "node:fs";
import { readConfigDiagnostics } from "../config";

export interface ConfigPreflightResult {
  ok: boolean;
  reason?: "fallback" | "read_error";
  error?: string;
}

export function runConfigPreflight(configPath: string): ConfigPreflightResult {
  // An occupied path must genuinely be a regular file.
  // A dangling symlink throws ENOENT on stat/readFileSync (treating it as missing in snapshots),
  // but lstatSync reveals the occupied non-file entry.
  try {
    const stat = lstatSync(configPath);
    if (!stat.isFile()) {
      return {
        ok: false,
        reason: "read_error",
        error: `Configuration entry at ${configPath} is not a regular file.`,
      };
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true };
    }
    return {
      ok: false,
      reason: "read_error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Use the runtime's diagnostics loader rather than strict candidate validation.
  // This permits configs repaired by mergeConfigDefaults or sanitized for load,
  // aborting only when loadConfig would fall back to defaults.
  try {
    const diagnostics = readConfigDiagnostics({ passive: true });
    if (diagnostics.source === "fallback") {
      return {
        ok: false,
        reason: "fallback",
        error: diagnostics.error || "Configuration failed to load and fell back to defaults.",
      };
    }
  } catch (err: unknown) {
    return {
      ok: false,
      reason: "read_error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return { ok: true };
}
