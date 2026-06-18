import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "./types";

const CODEX_HOME = join(homedir(), ".codex");
const CODEX_CONFIG_PATH = join(CODEX_HOME, "config.toml");
const CODEX_PROFILE_PATH = join(CODEX_HOME, "opencodex.config.toml");

const OCX_SECTION_MARKER = "# Auto-injected by opencodex";

function buildProviderBlock(port: number): string {
  const lines = [
    "",
    OCX_SECTION_MARKER,
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
    message: `Injected opencodex provider into Codex config.\n` +
      `  Default mode: OpenAI models (gpt-5.5, o3, etc.) work normally.\n` +
      `  Proxy mode:   codex --profile opencodex`,
  };
}

function removeOcxSection(content: string): string {
  const lines = content.split("\n");
  const filtered: string[] = [];
  let inOcxSection = false;
  for (const line of lines) {
    if (line.includes(OCX_SECTION_MARKER)) { inOcxSection = true; continue; }
    if (inOcxSection) {
      if (line.startsWith("[") && !line.includes("model_providers.opencodex")) {
        inOcxSection = false;
        filtered.push(line);
      }
      continue;
    }
    filtered.push(line);
  }
  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function removeCodexConfig(): { success: boolean; message: string } {
  if (!existsSync(CODEX_CONFIG_PATH)) {
    return { success: false, message: "Codex config not found." };
  }

  let content = readFileSync(CODEX_CONFIG_PATH, "utf-8");

  if (!content.includes("[model_providers.opencodex]")) {
    if (existsSync(CODEX_PROFILE_PATH)) unlinkSync(CODEX_PROFILE_PATH);
    return { success: true, message: "opencodex not found in Codex config." };
  }

  content = removeOcxSection(content);

  if (/^model_provider\s*=\s*"opencodex"/m.test(content)) {
    const lines = content.split("\n");
    const filtered = lines.filter(l => l.trim() !== 'model_provider = "opencodex"');
    content = filtered.join("\n");
  }
  content = content.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

  writeFileSync(CODEX_CONFIG_PATH, content, "utf-8");

  if (existsSync(CODEX_PROFILE_PATH)) {
    unlinkSync(CODEX_PROFILE_PATH);
  }

  return { success: true, message: "Removed opencodex from Codex config and profile." };
}

export function getCodexConfigPath(): string {
  return CODEX_CONFIG_PATH;
}
