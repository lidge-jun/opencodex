import { existsSync, readFileSync } from "node:fs";
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

function resolveCodexConfigPath(codexConfigPath?: string): string {
  if (codexConfigPath) return codexConfigPath;
  return join(resolveCodexHomeDir(), "config.toml");
}

export function collectLegacyCodexConfigKeyDiagnostics(
  options: { codexConfigPath?: string } = {},
): LegacyCodexConfigKeyDiagnostic[] {
  const path = resolveCodexConfigPath(options.codexConfigPath);
  if (!existsSync(path)) return [];
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch { // no-excuse-ok: catch -- optional doctor diagnostics must not fail on an unreadable file.
    return [];
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
  return found;
}

export function formatLegacyCodexConfigKeyDiagnosticsForDoctor(
  diagnostics: LegacyCodexConfigKeyDiagnostic[],
): string[] {
  return diagnostics.map(d => "[WARN] " + d.detail);
}
