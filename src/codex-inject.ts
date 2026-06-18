import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./config";
import { restoreCodexCatalog } from "./codex-catalog";
import type { OcxConfig } from "./types";

const CODEX_HOME = join(homedir(), ".codex");
const CODEX_CONFIG_PATH = join(CODEX_HOME, "config.toml");
const CODEX_PROFILE_PATH = join(CODEX_HOME, "opencodex.config.toml");

const OCX_SECTION_MARKER = "# Auto-injected by opencodex";

function buildProviderBlock(port: number): string {
  const lines = [
    "",
    OCX_SECTION_MARKER,
    'model_provider = "opencodex"',
    "",
    "[model_providers.opencodex]",
    'name = "OpenCodex Proxy"',
    `base_url = "http://localhost:${port}/v1"`,
    'wire_api = "responses"',
  ];
  return lines.join("\n") + "\n";
}

function buildProfileFile(port: number): string {
  return [
    "# OpenCodex proxy profile — use with: codex --profile opencodex",
    `# Routes all model requests through the opencodex proxy at localhost:${port}`,
    'model_provider = "opencodex"',
    "",
  ].join("\n");
}

export async function injectCodexConfig(port: number, _config?: OcxConfig): Promise<{ success: boolean; message: string }> {
  if (!existsSync(CODEX_CONFIG_PATH)) {
    return { success: false, message: `Codex config not found at ${CODEX_CONFIG_PATH}. Is Codex installed?` };
  }

  let content = readFileSync(CODEX_CONFIG_PATH, "utf-8");

  if (content.includes("[model_providers.opencodex]")) {
    content = removeOcxSection(content);
  }

  const block = buildProviderBlock(port);
  content = content.trimEnd() + "\n" + block;

  writeFileSync(CODEX_CONFIG_PATH, content, "utf-8");
  writeFileSync(CODEX_PROFILE_PATH, buildProfileFile(port), "utf-8");

  return {
    success: true,
    message: `Injected opencodex as default provider into Codex config.\n` +
      `  All models now route through opencodex proxy (like OpenRouter).\n` +
      `  OpenAI models (gpt-5.5, etc.) are passed through to OpenAI.\n` +
      `  Custom models route to their configured providers.\n` +
      `  Fallback: codex --profile opencodex (same behavior)`,
  };
}

function removeOcxSection(content: string): string {
  const lines = content.split("\n");
  const filtered: string[] = [];
  let inOcxSection = false;
  for (const line of lines) {
    if (line.includes(OCX_SECTION_MARKER) || line.trim() === "[model_providers.opencodex]") {
      inOcxSection = true;
      continue;
    }
    if (inOcxSection) {
      // End the injected section at the next table header that ISN'T our own — exact match so a
      // user's "[model_providers.opencodex_backup]" (or similar) is preserved, not swallowed.
      if (line.startsWith("[") && line.trim() !== "[model_providers.opencodex]") {
        inOcxSection = false;
        filtered.push(line);
      }
      continue;
    }
    filtered.push(line);
  }
  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Pure transform: strip the opencodex provider block + `model_provider = "opencodex"` lines. */
export function stripOpencodexConfig(content: string): string {
  let out = content;
  if (out.includes("[model_providers.opencodex]")) {
    out = removeOcxSection(out);
  }
  // Regex (not exact-string) removal so compact `model_provider="opencodex"` is stripped too —
  // must match the detection regex above, or a detected line could survive un-removed.
  out = out.split("\n").filter(l => !/^\s*model_provider\s*=\s*"opencodex"\s*$/.test(l)).join("\n");
  return out.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function hasOpencodexRouting(content: string): boolean {
  return content.includes("[model_providers.opencodex]") || /^\s*model_provider\s*=\s*"opencodex"/m.test(content);
}

export function removeCodexConfig(): { success: boolean; message: string } {
  if (!existsSync(CODEX_CONFIG_PATH)) {
    return { success: false, message: "Codex config not found." };
  }
  const content = readFileSync(CODEX_CONFIG_PATH, "utf-8");
  const had = hasOpencodexRouting(content);
  if (had) {
    atomicWriteFile(CODEX_CONFIG_PATH, stripOpencodexConfig(content));
  }
  if (existsSync(CODEX_PROFILE_PATH)) unlinkSync(CODEX_PROFILE_PATH);
  return {
    success: true,
    message: had ? "Removed opencodex routing from Codex config + profile." : "opencodex not present in Codex config.",
  };
}

/**
 * Recover native Codex: strip opencodex from config.toml AND drop proxy-routed catalog entries,
 * so plain `codex` works when the proxy is stopped. Called by `ocx stop`, the proxy shutdown
 * handler, and `ocx restore`. Idempotent + atomic.
 */
export function restoreNativeCodex(): { success: boolean; message: string } {
  const cfg = removeCodexConfig();
  const cat = restoreCodexCatalog();
  const msg = cat.removed > 0
    ? `${cfg.message} Catalog restored to ${cat.kept} native model(s) (dropped ${cat.removed} proxy-routed).`
    : cfg.message;
  return { success: cfg.success, message: msg };
}

export function getCodexConfigPath(): string {
  return CODEX_CONFIG_PATH;
}
