import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { mergeConfigDefaults } from "../config/diagnostics";
import { sanitizeRemovedOpenCodeFreeForLoad } from "../config/removed-opencode-free";
import { sanitizeOpenCodeOverridesForLoad } from "../config/opencode-wire-upgrade";
import { configSchema } from "../config/schema/config-schema";
import { sanitizeAliasesForLoad, sanitizeAnthropicSidecarInstanceForLoad, sanitizeAutoReviewForLoad,
  sanitizeCapabilityDeclarationsForLoad, sanitizeModelCostsForLoad, sanitizeModelDisplayNamesForLoad,
  sanitizeReasoningPinsForLoad, sanitizeRetryOn429ForLoad } from "../config/load-degrade";

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
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    // Match loadConfig's transformations without preserving a backup or printing values.
    sanitizeRemovedOpenCodeFreeForLoad(parsed);
    sanitizeOpenCodeOverridesForLoad(parsed); // Its warnings contain only fixed text.
    const quiet = () => {};
    sanitizeAliasesForLoad(parsed, quiet);
    sanitizeReasoningPinsForLoad(parsed, quiet);
    sanitizeModelDisplayNamesForLoad(parsed, quiet);
    sanitizeAutoReviewForLoad(parsed, quiet);
    sanitizeRetryOn429ForLoad(parsed, quiet);
    sanitizeAnthropicSidecarInstanceForLoad(parsed, quiet);
    sanitizeModelCostsForLoad(parsed, quiet);
    sanitizeCapabilityDeclarationsForLoad(parsed, quiet);
    if (configSchema.safeParse(parsed).success) return true;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const merged = mergeConfigDefaults(parsed);
    return configSchema.safeParse(merged).success;
  } catch {
    return false;
  }
}
