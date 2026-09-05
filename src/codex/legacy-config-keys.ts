import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveCodexHomeDir } from "./home";
import { parseTomlDocument } from "./project-config-warnings";

/**
 * Keys that are valid in model catalog data but not at the top level of the
 * user config. Codex rejects them when strict config parsing is enabled.
 */
const LEGACY_KEYS = ["persistent_instructions"] as const;

export type LegacyCodexConfigKey = (typeof LEGACY_KEYS)[number];

export interface LegacyCodexConfigKeyDiagnostic {
  readonly path: string;
  readonly code: LegacyCodexConfigKey;
  readonly detail: string;
}

export type LegacyCodexConfigKeyDiagnosticsResult =
  | { readonly status: "available"; readonly path: string; readonly diagnostics: readonly LegacyCodexConfigKeyDiagnostic[] }
  | { readonly status: "unavailable"; readonly path: string; readonly reason: "read_failed" | "not_a_file" };

function resolveCodexConfigPath(codexConfigPath?: string): string {
  if (codexConfigPath) return codexConfigPath;
  return join(resolveCodexHomeDir(), "config.toml");
}

export function collectLegacyCodexConfigKeyDiagnostics(
  options: { codexConfigPath?: string } = {},
): LegacyCodexConfigKeyDiagnosticsResult {
  const path = resolveCodexConfigPath(options.codexConfigPath);
  if (!existsSync(path)) return { status: "available", path, diagnostics: [] };
  let content: string;
  try {
    if (!statSync(path).isFile()) return { status: "unavailable", path, reason: "not_a_file" };
    content = readFileSync(path, "utf-8");
  } catch { // no-excuse-ok: catch -- optional doctor diagnostics must not fail on an unreadable file.
    return { status: "unavailable", path, reason: "read_failed" };
  }
  const { root } = parseTomlDocument(content);
  const found: LegacyCodexConfigKeyDiagnostic[] = [];
  for (const key of LEGACY_KEYS) {
    if (key in root) {
      found.push({
        path,
        code: key,
        detail: `${path}: top-level '${key}' is not a valid Codex config key. `
          + "codex --strict-config rejects the whole file. Remove the key and put durable guidance in AGENTS.md.",
      });
    }
  }
  return { status: "available", path, diagnostics: found };
}

export function formatLegacyCodexConfigKeyDiagnosticsForDoctor(
  result: LegacyCodexConfigKeyDiagnosticsResult,
): string[] {
  if (result.status === "unavailable") {
    return [`  --     Codex config at ${result.path} could not be read (${result.reason}); legacy-key check skipped`];
  }
  if (result.diagnostics.length === 0) {
    return ["  ok     no unsupported legacy top-level keys in the Codex config"];
  }
  return result.diagnostics.map(diagnostic => `[WARN] ${diagnostic.detail}`);
}
