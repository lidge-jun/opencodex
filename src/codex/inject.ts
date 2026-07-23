import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { atomicWriteFile, loadConfig, websocketsEnabled } from "../config";
import { markJournalInjectedState, removeJournal, restoreJournalState, writeJournal } from "./journal";
import { restoreCodexCatalog } from "./catalog";
import { migrateHistoryToOpenai, syncCodexHistoryProvider } from "./history-provider";
import { CODEX_CONFIG_PATH, CODEX_PROFILE_PATH, DEFAULT_CATALOG_PATH, parseTomlString, readRootTomlString, resolveCodexConfigPath, tomlString } from "./paths";
import { resolveEffectiveProjectModelProvider } from "./project-config-warnings";
import type { OcxConfig } from "../types";

const OCX_SECTION_MARKER = "# Auto-injected by opencodex";

export function externalCodexModelProvider(content: string): string | null {
  const provider = resolveEffectiveProjectModelProvider(content).provider;
  return provider && provider !== "openai" && provider !== "opencodex" ? provider : null;
}

export function currentExternalCodexModelProvider(): string | null {
  if (!existsSync(CODEX_CONFIG_PATH)) return null;
  return externalCodexModelProvider(readFileSync(CODEX_CONFIG_PATH, "utf8"));
}

/**
 * Detect the file's dominant line ending. Every transform in this module is LF-pure
 * (split("\n") + hard "\n" joins), so CRLF configs (Windows-edited config.toml) are
 * normalized to LF at the pipeline boundary and converted back on write — otherwise a
 * single inject would leave a mixed-EOL file.
 */
export function dominantEol(content: string): "\r\n" | "\n" {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return "\n";
  const bareLf = (content.match(/\n/g) ?? []).length - crlf;
  return crlf >= bareLf ? "\r\n" : "\n";
}

/** Normalize all line endings to `eol` (CRLF first collapsed to LF, then expanded). */
export function applyEol(content: string, eol: "\r\n" | "\n"): string {
  const lf = content.replace(/\r\n/g, "\n");
  return eol === "\n" ? lf : lf.replace(/\n/g, "\r\n");
}

/**
 * Design B (2026-07-06): loopback installs no longer re-tag the provider. Instead of
 * `model_provider = "opencodex"` + a `[model_providers.opencodex]` table, we set the official
 * built-in override `openai_base_url` (codex-rs config_toml.rs) so codex's own `openai`
 * provider points at the proxy. Threads keep `model_provider = "openai"`, so history never
 * needs remapping or restore. Non-loopback binds keep the legacy table injection because the
 * built-in provider cannot carry the `x-opencodex-api-key` env header.
 */

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

export function shouldInjectApiAuthHeader(config: Pick<OcxConfig, "hostname"> | undefined): boolean {
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

export function buildOpenaiBaseUrlLine(port: number, hostname?: string): string {
  return `openai_base_url = "http://${providerBaseHost(hostname)}:${port}/v1"`;
}

function isRootOpenaiBaseUrlLine(line: string): boolean {
  return /^\s*openai_base_url\s*=/.test(line);
}

/**
 * Design B root-key injection: place `OCX_SECTION_MARKER` + `openai_base_url` at the document
 * ROOT (before the first table header). Idempotent: an existing marker-owned line is rewritten
 * in place. A user's OWN root `openai_base_url` (no marker above it) is respected — we keep it
 * and inject nothing, reporting `keptUserBaseUrl` so the caller can surface it.
 */
export function setRootOpenaiBaseUrl(content: string, port: number, hostname?: string): { content: string; keptUserBaseUrl: boolean } {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const key = buildOpenaiBaseUrlLine(port, hostname);

  for (let i = 0; i < rootEnd; i++) {
    if (!isRootOpenaiBaseUrlLine(lines[i])) continue;
    const markerOwned = i > 0 && lines[i - 1].includes(OCX_SECTION_MARKER);
    if (!markerOwned) return { content, keptUserBaseUrl: true };
    lines[i] = key;
    return { content: lines.join("\n"), keptUserBaseUrl: false };
  }

  if (firstTable === -1) {
    return { content: content.replace(/\n+$/, "") + "\n" + OCX_SECTION_MARKER + "\n" + key + "\n", keptUserBaseUrl: false };
  }
  let insertAt = firstTable;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, OCX_SECTION_MARKER, key);
  return { content: lines.join("\n"), keptUserBaseUrl: false };
}

/**
 * Remove the marker-owned root `openai_base_url` (marker line + the key line right after it).
 * A user's own root override (no marker) survives; an orphaned marker with no key line after
 * it is dropped too so repeated strip/inject cycles cannot accumulate marker comments.
 */
export function stripInjectedOpenaiBaseUrl(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const drop = new Set<number>();
  for (let i = 0; i < rootEnd; i++) {
    if (!lines[i].includes(OCX_SECTION_MARKER)) continue;
    if (i + 1 < rootEnd && isRootOpenaiBaseUrlLine(lines[i + 1])) {
      drop.add(i);
      drop.add(i + 1);
    } else if (i + 1 >= rootEnd || lines[i + 1].trim() === "") {
      drop.add(i); // orphaned marker at root
    }
  }
  if (drop.size === 0) return content;
  return lines.filter((_, i) => !drop.has(i)).join("\n");
}

function hasInjectedOpenaiBaseUrl(content: string): boolean {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  for (let i = 1; i < rootEnd; i++) {
    if (isRootOpenaiBaseUrlLine(lines[i]) && lines[i - 1].includes(OCX_SECTION_MARKER)) return true;
  }
  return false;
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
  // Design B (loopback): the reference/fallback file documents the root override form.
  // Non-loopback keeps the legacy provider-table shape (built-in provider cannot carry
  // the x-opencodex-api-key env header).
  if (!includeApiAuthHeader) {
    const lines = [
      "# OpenCodex proxy fallback config (Design B)",
      `# Root override that points Codex's built-in openai provider at the proxy on ${host}:${port}.`,
      "# Merge these root keys into ~/.codex/config.toml manually if auto-injection was removed.",
      buildOpenaiBaseUrlLine(port, hostname),
    ];
    if (catalogPath) lines.push(`model_catalog_json = ${tomlString(catalogPath)}`);
    lines.push("", "[features]", "fast_mode = true", "");
    return lines.join("\n");
  }
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

  const rawContent = readFileSync(CODEX_CONFIG_PATH, "utf-8");
  const activeProvider = externalCodexModelProvider(rawContent);
  if (activeProvider) {
    // A launcher may have journaled before the provider manager took ownership. Never let shutdown
    // replay that stale snapshot over externally managed config.
    removeJournal();
    return {
      success: true,
      message: `⚠️ Codex routing NOT injected: config.toml selects the external model_provider ${tomlString(activeProvider)}.\n` +
        `  OpenCodex preserves external provider configuration so existing ${tomlString(activeProvider)} session history stays visible.\n` +
        `  Configure that provider for Responses passthrough at http://${providerBaseHost(config?.hostname)}:${port}/v1` +
        `${shouldInjectApiAuthHeader(config) ? ` with x-opencodex-api-key from OPENCODEX_API_AUTH_TOKEN` : ""}.\n` +
        `  For direct injection, switch to the built-in openai provider, remove any user-owned root openai_base_url, and rerun 'ocx start'.`,
    };
  }

  writeJournal();
  // EOL boundary: transforms below are LF-pure; preserve the file's dominant ending on write.
  const eol = dominantEol(rawContent);
  let content = applyEol(rawContent, "\n");

  // Idempotent clean-up of any prior injection: drop the provider table (marker-based) and every
  // stray/mis-nested model_provider line, so re-injecting can't duplicate keys or leave the buggy
  // table-nested key behind.
  // Design B form FIRST: removeOcxSection also keys on the marker line, so a root-level
  // marker + openai_base_url pair must be gone before it scans or it would swallow root keys.
  content = stripInjectedOpenaiBaseUrl(content);
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

  const legacyMode = shouldInjectApiAuthHeader(config);
  let keptUserBaseUrl = false;
  if (legacyMode) {
    // Legacy (non-loopback) injection: the built-in openai provider cannot carry the
    // x-opencodex-api-key env header, so keep the opencodex provider table + root re-tag.
    // 1) Root key BEFORE the first table header (must be a global, not nested under a table).
    content = setRootModelProvider(content);
    // 2) Provider table appended at EOF (position-independent).
    content = content.trimEnd() + "\n" + buildProviderTableBlock(port, websocketsEnabled(config ?? {}), true, config?.hostname);
  } else {
    // Design B (loopback): a single root override; codex keeps its native `openai` provider id
    // so thread history is never remapped. Any legacy form was already stripped above.
    content = stripInjectedOpenaiBaseUrl(content); // normalize before idempotent re-insert
    const result = setRootOpenaiBaseUrl(content, port, config?.hostname);
    content = result.content;
    keptUserBaseUrl = result.keptUserBaseUrl;
  }

  const profileContent = buildProfileFile(port, catalogPath, websocketsEnabled(config ?? {}), legacyMode, config?.hostname);
  content = applyEol(content, eol);
  atomicWriteFile(CODEX_CONFIG_PATH, content);
  atomicWriteFile(CODEX_PROFILE_PATH, profileContent);
  markJournalInjectedState(content, profileContent);
  // Legacy mode still forward-tags history so re-tagged threads stay listable. Design B needs
  // the opposite: a one-time migration of previously re-tagged threads BACK to openai (restore
  // machinery; cheap no-op when there is nothing to migrate).
  const history = config?.syncResumeHistory !== false
    ? (legacyMode ? syncCodexHistoryProvider("opencodex") : migrateHistoryToOpenai())
    : { rows: 0, files: 0 };

  const catalogMessage = catalogPath
    ? `  Codex model catalog: ${catalogPath}\n`
    : `  Codex model catalog not injected because no opencodex catalog file exists yet.\n`;
  const migratedRows = (history.rows ?? 0) + ("ejectedRows" in history ? history.ejectedRows ?? 0 : 0);
  const historyMessage = config?.syncResumeHistory === false
    ? `  Codex resume history: left unchanged (syncResumeHistory=false).\n`
    : history.failed
      ? (legacyMode
        ? `  ⚠️ Codex resume history sync SKIPPED: the history DB is locked (Codex app/IDE open?). Close it and rerun 'ocx start'.\n`
        // Honest in every caller context: the daemon retries in the background while it runs,
        // and this inject path re-runs the migration on every future start/sync anyway.
        : `  ⚠️ Codex resume history migration deferred: the history DB is locked (Codex app/IDE open?). It is retried automatically (while the proxy runs and on every 'ocx start'); to force it now, close the Codex app and run 'ocx sync'.\n`)
      : legacyMode
        ? `  Codex resume history: ${history.rows} thread(s) made visible for opencodex; originals backed up for restore.\n`
        : migratedRows > 0
          ? `  Codex resume history: ${migratedRows} legacy opencodex-tagged thread(s) migrated back to openai (one-time).\n`
          : `  Codex resume history: untouched (threads keep their native openai tag).\n`;
  // A user-owned root openai_base_url means we did NOT install routing — say so honestly
  // instead of claiming the proxy route is active (catalog/fast_mode were still written).
  if (keptUserBaseUrl) {
    return {
      success: true,
      message: `⚠️ Codex routing NOT injected: your config already sets a root openai_base_url, and opencodex never overwrites a user-owned override.\n` +
        catalogMessage +
        historyMessage +
        `  To route plain codex through the proxy, remove your openai_base_url line from ~/.codex/config.toml and rerun 'ocx start'.\n` +
        `  Reference config: ${CODEX_PROFILE_PATH}`,
    };
  }
  const headline = legacyMode
    ? `Injected opencodex as default provider into Codex config.\n`
    : `Pointed Codex's built-in openai provider at the opencodex proxy (openai_base_url).\n`;
  return {
    success: true,
    message: headline +
      catalogMessage +
      historyMessage +
      `  All models now route through opencodex proxy (like OpenRouter).\n` +
      `  OpenAI models (gpt-5.5, etc.) are passed through to OpenAI.\n` +
      `  Custom models route to their configured providers.\n` +
      (legacyMode
        ? `  Fallback: codex --profile opencodex (same behavior)`
        : `  Fallback reference: ${CODEX_PROFILE_PATH}`),
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
  const hadInjectedBaseUrl = hasInjectedOpenaiBaseUrl(out);
  out = stripInjectedOpenaiBaseUrl(out); // before removeOcxSection — it keys on the marker line too
  if (out.includes("[model_providers.opencodex]")) {
    out = removeOcxSection(out);
  }
  out = removeProfileSection(out);
  // Regex (not exact-string) removal so compact `model_provider="opencodex"` is stripped too —
  // must match the detection regex above, or a detected line could survive un-removed.
  out = out.split("\n").filter(l => !/^\s*model_provider\s*=\s*"opencodex"\s*$/.test(l)).join("\n");
  // Routed root model ids (`model = "provider/slug"`) only make sense while the proxy serves
  // them — strip on both the legacy re-tag form and the Design B injected-base-url form.
  if (hadRootOcxProvider || hadInjectedBaseUrl) out = stripRootRoutedModel(out);
  out = stripOpencodexCatalogPath(out);
  return out.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function hasOpencodexRouting(content: string): boolean {
  return content.includes("[model_providers.opencodex]")
    || /^\s*model_provider\s*=\s*"opencodex"/m.test(content)
    || hasInjectedOpenaiBaseUrl(content);
}

export function removeCodexConfig(options: { preserveProfile?: boolean } = {}): { success: boolean; message: string } {
  if (!existsSync(CODEX_CONFIG_PATH)) {
    return { success: false, message: "Codex config not found." };
  }
  const rawContent = readFileSync(CODEX_CONFIG_PATH, "utf-8");
  // Same EOL boundary as inject: strip in LF space, write back in the file's own ending.
  // The unchanged fast path compares in LF space so an untouched file is never rewritten.
  const eol = dominantEol(rawContent);
  const content = applyEol(rawContent, "\n");
  const had = hasOpencodexRouting(content);
  const stripped = stripOpencodexConfig(content);
  if (had || stripped !== content) {
    atomicWriteFile(CODEX_CONFIG_PATH, applyEol(stripped, eol));
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
  const activeProvider = currentExternalCodexModelProvider();
  if (activeProvider) {
    removeJournal();
    return { success: true, message: `External Codex provider ${tomlString(activeProvider)} preserved; no native restore was needed.` };
  }
  const journal = restoreJournalState();
  const cfg = journal.configRestored
    ? { success: true, message: "Codex config restored from opencodex journal." }
    : removeCodexConfig({ preserveProfile: journal.profileRestored || journal.profileChanged });
  const cat = restoreCodexCatalog();
  // Design B (loopback) steady state: threads are already tagged openai, so prove the
  // no-op with a readonly probe instead of write-opening a DB the Codex app may hold
  // (Windows: WAL writer lock -> seconds of stalling + a false warning on every stop).
  // Legacy (non-loopback) installs keep the unconditional write-open restore.
  let skipWhenProvablyNoop = false;
  try {
    skipWhenProvablyNoop = !shouldInjectApiAuthHeader(loadConfig());
  } catch { /* unreadable config: keep the conservative write-open restore */ }
  const history = syncCodexHistoryProvider("openai", undefined, undefined, { skipWhenProvablyNoop });
  const msg = cat.removed > 0
    ? `${cfg.message} Catalog restored to ${cat.kept} native model(s) (dropped ${cat.removed} proxy-routed).`
    : cfg.message;
  const historyMsg = history.failed
    ? ` ⚠️ Codex resume history could NOT be restored — the Codex app appears to be holding the history DB. Close the Codex app/IDE and run 'ocx stop' again; until then routed threads stay hidden in the native app.`
    : history.rows > 0
      ? ` Resume history restored from opencodex backup (${history.rows} thread(s)).`
      : history.ejectedRows
        ? ` ${history.ejectedRows} opencodex history thread(s) were ejected to openai so native Codex can resume them.`
        : "";
  return { success: cfg.success, message: `${msg}${historyMsg}` };
}

export function getCodexConfigPath(): string {
  return CODEX_CONFIG_PATH;
}
