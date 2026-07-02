import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { atomicWriteFile, websocketsEnabled } from "./config";
import { markJournalInjectedState, restoreJournalState, writeJournal } from "./codex-journal";
import { restoreCodexCatalog } from "./codex-catalog";
import { syncCodexHistoryProvider } from "./codex-history-provider";
import { CODEX_CONFIG_PATH, CODEX_PROFILE_PATH, DEFAULT_CATALOG_PATH, parseTomlString, readRootTomlString, resolveCodexConfigPath, tomlString } from "./codex-paths";
import type { OcxConfig } from "./types";

const OCX_SECTION_MARKER = "# Auto-injected by opencodex";

export interface InjectCodexOptions {
  /**
   * Absolute or CODEX_HOME-relative catalog path to advertise to Codex. Pass `null` only when the
   * opencodex catalog could not be materialized; Codex will then keep its native catalog instead of
   * failing on a missing model_catalog_json file.
   */
  catalogPath?: string | null;
}

/**
 * The `[model_providers.opencodex]` TABLE only. A table is position-independent in TOML, so it is
 * safe to append at EOF. The bare root key `model_provider = "opencodex"` is NOT included here —
 * it must live at the document root (before any table header) and is set separately by
 * setRootModelProvider(). Appending the bare key at EOF was the original bug: it nested under
 * whatever `[table]` happened to be open last (e.g. `[plugins."chrome@openai-bundled"]`), so Codex
 * never saw a global model_provider and silently fell back to the `openai` (ChatGPT) provider.
 */
function isLoopbackHostname(hostname: string | undefined): boolean {
  const normalized = (hostname ?? "127.0.0.1").trim().toLowerCase();
  return normalized === "" || normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function providerBaseHost(hostname: string | undefined): string {
  const trimmed = (hostname ?? "127.0.0.1").trim();
  const lower = trimmed.toLowerCase();
  // Match what the server actually binds. Writing "localhost" while binding IPv4-only
  // 127.0.0.1 breaks on Windows, where localhost commonly resolves to ::1 first.
  if (lower === "::1" || lower === "[::1]") return "[::1]";
  if (isLoopbackHostname(trimmed) || trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "[::]") return "127.0.0.1";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

function shouldInjectApiAuthHeader(config: Pick<OcxConfig, "hostname"> | undefined): boolean {
  return !isLoopbackHostname(config?.hostname);
}

export function buildProviderTableBlock(port: number, supportsWebsockets = false, includeApiAuthHeader = false, hostname?: string): string {
  const host = providerBaseHost(hostname);
  const lines = [
    "",
    OCX_SECTION_MARKER,
    "[model_providers.opencodex]",
    'name = "OpenCodex Proxy"',
    `base_url = "http://${host}:${port}/v1"`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
  ];
  if (includeApiAuthHeader) {
    lines.push('env_http_headers = { "x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN" }');
  }
  if (supportsWebsockets) lines.push("supports_websockets = true");
  return lines.join("\n") + "\n";
}

/**
 * Strip every existing `model_provider` line that we must not duplicate: any line set to
 * "opencodex" (wherever it sits — including a previously mis-nested one under a table), plus any
 * ROOT-level model_provider (before the first table) of any value, since we override the global.
 * A `model_provider` legitimately inside a user table/profile with a non-opencodex value is left
 * untouched.
 */
function stripExistingModelProvider(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (/^\s*model_provider\s*=/.test(line)) {
      const isOurs = /^\s*model_provider\s*=\s*"opencodex"\s*$/.test(line);
      const isRoot = firstTable === -1 || i < firstTable;
      if (isOurs || isRoot) return; // drop it
    }
    out.push(line);
  });
  return out.join("\n");
}

/**
 * Drop ROOT-level `model_context_window` / `model_auto_compact_token_limit` overrides (keys before
 * the first table header). Codex treats these root keys as a global override that wins over the
 * per-model catalog values, so a stale `model_context_window = 1000000` makes every model (e.g.
 * gpt-5.5) report a 1M window. Stripping them on (re)injection lets the catalog drive context size.
 */
export function stripRootContextWindowOverrides(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  return lines
    .filter((line, i) => {
      const isRoot = firstTable === -1 || i < firstTable;
      return !isRoot || !/^\s*model_(?:context_window|auto_compact_token_limit)\s*=/.test(line);
    })
    .join("\n");
}

function stripRootRoutedModel(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  return lines
    .filter((line, i) => {
      const isRoot = firstTable === -1 || i < firstTable;
      if (!isRoot) return true;
      const m = line.match(/^\s*model\s*=\s*("(?:\\.|[^"])*"|'[^']*')\s*$/);
      if (!m) return true;
      const model = parseTomlString(m[1]);
      return !model?.includes("/");
    })
    .join("\n");
}

/**
 * Insert `model_provider = "opencodex"` at the document ROOT — immediately before the first table
 * header (TOML root keys must precede all tables). If there are no tables, append it to the root body.
 */
function setRootModelProvider(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  const key = 'model_provider = "opencodex"';
  if (firstTable === -1) {
    return content.replace(/\n+$/, "") + "\n" + key + "\n";
  }
  let insertAt = firstTable;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, key);
  return lines.join("\n");
}

function readRootModelCatalogPath(content: string): string | null {
  return readRootTomlString(content, "model_catalog_json");
}

function setRootModelCatalogPath(content: string, catalogPath: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  const key = `model_catalog_json = ${tomlString(catalogPath)}`;
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  for (let i = 0; i < rootEnd; i++) {
    const m = lines[i].match(/^\s*model_catalog_json\s*=\s*("(?:\\.|[^"])*"|'[^']*')\s*$/);
    if (!m) continue;
    const existing = parseTomlString(m[1]);
    if (isOpencodexCatalogPath(existing)) {
      lines[i] = key;
      return lines.join("\n");
    }
    return content;
  }
  if (firstTable === -1) {
    return content.replace(/\n+$/, "") + "\n" + key + "\n";
  }
  let insertAt = firstTable;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, key);
  return lines.join("\n");
}

function removeProfileSection(content: string): string {
  const lines = content.split("\n");
  const filtered: string[] = [];
  let inProfile = false;
  for (const line of lines) {
    if (line.trim() === "[profiles.opencodex]") {
      inProfile = true;
      continue;
    }
    if (inProfile) {
      if (/^\s*\[/.test(line) && line.trim() !== "[profiles.opencodex]") {
        inProfile = false;
        filtered.push(line);
      }
      continue;
    }
    filtered.push(line);
  }
  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function normalizeServiceTier(content: string): string {
  return content.replace(/^(\s*service_tier\s*=\s*)["']priority["']\s*$/gm, '$1"fast"');
}

function ensureFastModeFeature(content: string): string {
  const lines = content.split("\n");
  const featuresStart = lines.findIndex(line => line.trim() === "[features]");
  if (featuresStart === -1) {
    return content.trimEnd() + "\n\n[features]\nfast_mode = true\n";
  }

  const nextTable = lines.findIndex((line, index) => index > featuresStart && /^\s*\[/.test(line));
  const featuresEnd = nextTable === -1 ? lines.length : nextTable;
  for (let i = featuresStart + 1; i < featuresEnd; i++) {
    if (/^\s*fast_mode\s*=/.test(lines[i])) {
      lines[i] = lines[i].replace(/^(\s*)fast_mode\s*=.*$/, "$1fast_mode = true");
      return lines.join("\n");
    }
  }

  let insertAt = featuresEnd;
  while (insertAt > featuresStart + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, "fast_mode = true");
  return lines.join("\n");
}

function isOpencodexCatalogPath(path: string): boolean {
  return path.replace(/\\/g, "/").split("/").pop() === "opencodex-catalog.json";
}

function stripOpencodexCatalogPath(content: string): string {
  return content
    .split("\n")
    .filter(line => {
      const m = line.match(/^\s*model_catalog_json\s*=\s*("(?:\\.|[^"])*"|'[^']*')\s*$/);
      return !m || !isOpencodexCatalogPath(parseTomlString(m[1]));
    })
    .join("\n");
}

export function buildProfileFile(port: number, catalogPath?: string | null, supportsWebsockets = false, includeApiAuthHeader = false, hostname?: string): string {
  const host = providerBaseHost(hostname);
  const lines = [
    "# OpenCodex proxy profile — use with: codex --profile opencodex",
    `# Routes all model requests through the opencodex proxy at ${host}:${port}`,
    'model_provider = "opencodex"',
  ];
  if (catalogPath) lines.push(`model_catalog_json = ${tomlString(catalogPath)}`);
  lines.push("", "[features]", "fast_mode = true");
  lines.push(buildProviderTableBlock(port, supportsWebsockets, includeApiAuthHeader, hostname).trimEnd(), "");
  return lines.join("\n");
}

export function chooseCatalogPathForInjection(content: string, requested?: string | null): string | null {
  if (requested !== undefined) return requested;

  const existing = readRootModelCatalogPath(content);
  if (existing) {
    const resolved = resolveCodexConfigPath(existing);
    if (!isOpencodexCatalogPath(resolved) || existsSync(resolved)) return existing;
  }

  return existsSync(DEFAULT_CATALOG_PATH) ? DEFAULT_CATALOG_PATH : null;
}

export async function injectCodexConfig(port: number, config?: OcxConfig, options: InjectCodexOptions = {}): Promise<{ success: boolean; message: string }> {
  if (!existsSync(CODEX_CONFIG_PATH)) {
    return { success: false, message: `Codex config not found at ${CODEX_CONFIG_PATH}. Is Codex installed?` };
  }

  writeJournal();
  let content = readFileSync(CODEX_CONFIG_PATH, "utf-8");

  // Idempotent clean-up of any prior injection: drop the provider table (marker-based) and every
  // stray/mis-nested model_provider line, so re-injecting can't duplicate keys or leave the buggy
  // table-nested key behind.
  if (content.includes("[model_providers.opencodex]")) {
    content = removeOcxSection(content);
  }
  content = removeProfileSection(content);
  content = stripExistingModelProvider(content);
  content = stripRootContextWindowOverrides(content);
  content = normalizeServiceTier(content);
  content = ensureFastModeFeature(content);

  const catalogPath = chooseCatalogPathForInjection(content, options.catalogPath);
  content = catalogPath ? setRootModelCatalogPath(content, catalogPath) : stripOpencodexCatalogPath(content);

  // 1) Root key BEFORE the first table header (must be a global, not nested under a table).
  content = setRootModelProvider(content);
  // 2) Provider table appended at EOF (position-independent).
  content = content.trimEnd() + "\n" + buildProviderTableBlock(port, websocketsEnabled(config ?? {}), shouldInjectApiAuthHeader(config), config?.hostname);

  const profileContent = buildProfileFile(port, catalogPath, websocketsEnabled(config ?? {}), shouldInjectApiAuthHeader(config), config?.hostname);
  atomicWriteFile(CODEX_CONFIG_PATH, content);
  atomicWriteFile(CODEX_PROFILE_PATH, profileContent);
  markJournalInjectedState(content, profileContent);
  const history = config?.syncResumeHistory !== false
    ? syncCodexHistoryProvider("opencodex")
    : { rows: 0, files: 0 };

  const catalogMessage = catalogPath
    ? `  Codex model catalog: ${catalogPath}\n`
    : `  Codex model catalog not injected because no opencodex catalog file exists yet.\n`;
  const historyMessage = config?.syncResumeHistory !== false
    ? `  Codex resume history: ${history.rows} thread(s) made visible for opencodex; originals backed up for restore.\n`
    : `  Codex resume history: left unchanged (syncResumeHistory=false).\n`;
  return {
    success: true,
    message: `Injected opencodex as default provider into Codex config.\n` +
      catalogMessage +
      historyMessage +
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
      if (/^\s*\[/.test(line) && line.trim() !== "[model_providers.opencodex]") {
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
  const hadRootOcxProvider = readRootTomlString(out, "model_provider") === "opencodex";
  if (out.includes("[model_providers.opencodex]")) {
    out = removeOcxSection(out);
  }
  out = removeProfileSection(out);
  // Regex (not exact-string) removal so compact `model_provider="opencodex"` is stripped too —
  // must match the detection regex above, or a detected line could survive un-removed.
  out = out.split("\n").filter(l => !/^\s*model_provider\s*=\s*"opencodex"\s*$/.test(l)).join("\n");
  if (hadRootOcxProvider) out = stripRootRoutedModel(out);
  out = stripOpencodexCatalogPath(out);
  return out.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function hasOpencodexRouting(content: string): boolean {
  return content.includes("[model_providers.opencodex]") || /^\s*model_provider\s*=\s*"opencodex"/m.test(content);
}

export function removeCodexConfig(options: { preserveProfile?: boolean } = {}): { success: boolean; message: string } {
  if (!existsSync(CODEX_CONFIG_PATH)) {
    return { success: false, message: "Codex config not found." };
  }
  const content = readFileSync(CODEX_CONFIG_PATH, "utf-8");
  const had = hasOpencodexRouting(content);
  if (had) {
    atomicWriteFile(CODEX_CONFIG_PATH, stripOpencodexConfig(content));
  } else if (stripOpencodexConfig(content) !== content) {
    atomicWriteFile(CODEX_CONFIG_PATH, stripOpencodexConfig(content));
  }
  if (!options.preserveProfile && existsSync(CODEX_PROFILE_PATH)) unlinkSync(CODEX_PROFILE_PATH);
  return {
    success: true,
    message: had
      ? `Removed opencodex routing from Codex config${options.preserveProfile ? "." : " + profile."}`
      : "opencodex not present in Codex config.",
  };
}

/**
 * Recover native Codex: strip opencodex from config.toml AND drop proxy-routed catalog entries,
 * so plain `codex` works when the proxy is stopped. Called by `ocx stop`, the proxy shutdown
 * handler, and `ocx restore`. Idempotent + atomic.
 */
export function restoreNativeCodex(): { success: boolean; message: string } {
  const journal = restoreJournalState();
  const cfg = journal.configRestored
    ? { success: true, message: "Codex config restored from opencodex journal." }
    : removeCodexConfig({ preserveProfile: journal.profileRestored || journal.profileChanged });
  const cat = restoreCodexCatalog();
  const history = syncCodexHistoryProvider("openai");
  const msg = cat.removed > 0
    ? `${cfg.message} Catalog restored to ${cat.kept} native model(s) (dropped ${cat.removed} proxy-routed).`
    : cfg.message;
  const historyMsg = history.rows > 0
    ? ` Resume history restored from opencodex backup (${history.rows} thread(s)).`
    : history.ejectedRows
      ? ` ${history.ejectedRows} opencodex history thread(s) were ejected to openai so native Codex can resume them.`
      : "";
  return { success: cfg.success, message: `${msg}${historyMsg}` };
}

export function getCodexConfigPath(): string {
  return CODEX_CONFIG_PATH;
}
