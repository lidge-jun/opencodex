// Holds INV-TOML-01 from structure/overview.md; keep the id here if this file is split or renamed.
import { existsSync, readFileSync } from "node:fs";
import { contextCompatibleBaseLine } from "../context-compat";
import { resolveEffectiveProjectModelProvider } from "../project-config-warnings";
import {
  OCX_SECTION_MARKER,
  REALTIME_WS_BASE_URL_KEY,
  isRootOpenaiBaseUrlLine,
  isRootRealtimeWsBaseUrlLine,
  tomlStringPattern,
} from "../injected-marker";
import {
  CODEX_CONFIG_PATH,
  DEFAULT_CATALOG_PATH,
  parseTomlString,
  resolveCodexConfigPath,
  tomlString,
} from "../paths";
import {
  type CodexRoutingTarget,
  providerBaseHost,
  routingTargetOrigin,
  usesProviderTable,
  validateCodexRoutingTarget,
} from "./routing-target";

export function externalCodexModelProvider(content: string): string | null {
  const provider = resolveEffectiveProjectModelProvider(content).provider;
  return provider && provider !== "openai" && provider !== "opencodex"
    ? provider
    : null;
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

export function buildProviderTableBlock(
  port: number,
  supportsWebsockets?: boolean,
  includeApiAuthHeader?: boolean,
  hostname?: string,
): string;
export function buildProviderTableBlock(
  target: CodexRoutingTarget,
  supportsWebsockets?: boolean,
): string;
export function buildProviderTableBlock(
  portOrTarget: number | CodexRoutingTarget,
  supportsWebsockets = false,
  includeApiAuthHeader = false,
  hostname?: string,
): string {
  const target = typeof portOrTarget === "number"
    ? validateCodexRoutingTarget({
        baseUrl: `http://${providerBaseHost(hostname)}:${portOrTarget}/v1`,
        requiresAdmissionToken: includeApiAuthHeader,
        tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
      })
    : validateCodexRoutingTarget(portOrTarget);
  return buildProviderTableBlockForTarget(target, supportsWebsockets);
}

export function buildProviderTableBlockForTarget(
  target: CodexRoutingTarget,
  supportsWebsockets = false,
): string {
  const lines = [
    "",
    OCX_SECTION_MARKER,
    "[model_providers.opencodex]",
    'name = "OpenCodex Proxy"',
    `base_url = ${tomlString(target.baseUrl)}`,
    'wire_api = "responses"',
    // false only in the authless Desktop opt-in (#1107); true keeps the App/TUI account gate.
    `requires_openai_auth = ${target.desktopAuthless === true ? "false" : "true"}`,
  ];
  if (target.requiresAdmissionToken) {
    // codex-cli 0.146+ contract (#2073): env_key sends Authorization: Bearer $VAR and
    // hard-errors on a missing/empty variable instead of silently omitting auth. It
    // coexists with requires_openai_auth (env_key wins wire auth; the flag keeps the
    // login/account UX), and the server substitutes stored main auth for our admission
    // bearer (#1686), so the modern form is strictly better than the legacy
    // env_http_headers table this line used to emit.
    lines.push(`env_key = ${tomlString(target.tokenEnv)}`);
  }
  if (supportsWebsockets) lines.push("supports_websockets = true");
  return lines.join("\n") + "\n";
}

export function buildOpenaiBaseUrlLine(
  port: number,
  hostname?: string,
): string;
export function buildOpenaiBaseUrlLine(target: CodexRoutingTarget): string;
export function buildOpenaiBaseUrlLine(
  portOrTarget: number | CodexRoutingTarget,
  hostname?: string,
): string {
  return typeof portOrTarget === "number"
    ? `openai_base_url = "http://${providerBaseHost(hostname)}:${portOrTarget}/v1"`
    : buildOpenaiBaseUrlLineForTarget(validateCodexRoutingTarget(portOrTarget));
}

function buildOpenaiBaseUrlLineForTarget(target: CodexRoutingTarget): string {
  return `openai_base_url = ${tomlString(target.baseUrl)}`;
}

/**
 * Realtime sideband override (codex-rs `experimental_realtime_ws_base_url`), written with the
 * SAME value as `openai_base_url`. Desktop voice creates its WebRTC call through the proxy
 * (`POST /v1/live`, answered under the Pool account the proxy selects) but, since openai/codex
 * 438c9e98d (#35830), joins the sideband at `wss://api.openai.com/v1/live/{callId}` with the
 * app's own login unless this key redirects it. Two accounts, one call: the join 404s. Pointing
 * the key at the proxy sends the join through `GET /v1/live/{callId}` (src/server/live.ts),
 * where the same Pool account is reused. codex-rs turns `http` into `ws` and appends
 * `/live/{callId}` itself; the value must stay the canonical `/v1` root.
 */
export function buildRealtimeWsBaseUrlLine(target: CodexRoutingTarget): string {
  return `${REALTIME_WS_BASE_URL_KEY} = ${tomlString(target.baseUrl)}`;
}

/**
 * Design B root-key injection: place `OCX_SECTION_MARKER` + `openai_base_url` at the document
 * ROOT (before the first table header). Idempotent: an existing marker-owned line is rewritten
 * in place. A user's OWN root `openai_base_url` (no marker above it) is respected — we keep it
 * and inject nothing, reporting `keptUserBaseUrl` so the caller can surface it.
 */
export function setRootOpenaiBaseUrl(
  content: string,
  port: number,
  hostname?: string,
): { content: string; keptUserBaseUrl: boolean };
export function setRootOpenaiBaseUrl(
  content: string,
  target: CodexRoutingTarget,
): { content: string; keptUserBaseUrl: boolean };
export function setRootOpenaiBaseUrl(
  content: string,
  portOrTarget: number | CodexRoutingTarget,
  hostname?: string,
): { content: string; keptUserBaseUrl: boolean } {
  if (typeof portOrTarget !== "number") {
    return setRootOpenaiBaseUrlForTarget(content, validateCodexRoutingTarget(portOrTarget));
  }
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const key = contextCompatibleBaseLine(content, buildOpenaiBaseUrlLine(portOrTarget, hostname));

  for (let i = 0; i < rootEnd; i++) {
    if (!isRootOpenaiBaseUrlLine(lines[i])) continue;
    const markerOwned = i > 0 && lines[i - 1].includes(OCX_SECTION_MARKER);
    if (!markerOwned) return { content, keptUserBaseUrl: true };
    lines[i] = key;
    return { content: lines.join("\n"), keptUserBaseUrl: false };
  }

  if (firstTable === -1) {
    return {
      content:
        content.replace(/\n+$/, "") +
        "\n" +
        OCX_SECTION_MARKER +
        "\n" +
        key +
        "\n",
      keptUserBaseUrl: false,
    };
  }
  let insertAt = firstTable;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, OCX_SECTION_MARKER, key);
  return { content: lines.join("\n"), keptUserBaseUrl: false };
}

export function setRootOpenaiBaseUrlForTarget(
  content: string,
  target: CodexRoutingTarget,
): { content: string; keptUserBaseUrl: boolean } {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const key = contextCompatibleBaseLine(content, buildOpenaiBaseUrlLineForTarget(target));
  for (let index = 0; index < rootEnd; index += 1) {
    if (!isRootOpenaiBaseUrlLine(lines[index])) continue;
    const markerOwned = index > 0 && lines[index - 1].includes(OCX_SECTION_MARKER);
    if (!markerOwned) return { content, keptUserBaseUrl: true };
    lines[index] = key;
    return { content: lines.join("\n"), keptUserBaseUrl: false };
  }
  if (firstTable === -1) {
    return {
      content: `${content.replace(/\n+$/, "")}\n${OCX_SECTION_MARKER}\n${key}\n`,
      keptUserBaseUrl: false,
    };
  }
  let insertAt = firstTable;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt -= 1;
  lines.splice(insertAt, 0, OCX_SECTION_MARKER, key);
  return { content: lines.join("\n"), keptUserBaseUrl: false };
}

/**
 * Companion to `setRootOpenaiBaseUrlForTarget` for the realtime sideband override. Same
 * ownership rule, applied per key: the line is ours only when the marker sits directly
 * above it; a user's own line (no marker above it) is kept and nothing is injected. The
 * key gets its OWN marker line rather than sharing the routing override's, so a user line
 * that happens to sit right under our `openai_base_url` is never mistaken for ours.
 * Placement: directly after the marker-owned `openai_base_url` pair. Only ever called on
 * the Design B (loopback) path right after the routing override was written — the legacy
 * provider-table form needs the admission-token header, which the sideband cannot carry.
 */
export function setRootRealtimeWsBaseUrl(
  content: string,
  target: CodexRoutingTarget,
): { content: string; keptUserRealtimeWsBaseUrl: boolean } {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const key = buildRealtimeWsBaseUrlLine(validateCodexRoutingTarget(target));
  for (let index = 0; index < rootEnd; index += 1) {
    if (!isRootRealtimeWsBaseUrlLine(lines[index])) continue;
    const markerOwned = index > 0 && lines[index - 1].includes(OCX_SECTION_MARKER);
    if (!markerOwned) return { content, keptUserRealtimeWsBaseUrl: true };
    lines[index] = key;
    return { content: lines.join("\n"), keptUserRealtimeWsBaseUrl: false };
  }
  for (let index = 0; index < rootEnd; index += 1) {
    if (!isRootOpenaiBaseUrlLine(lines[index])) continue;
    if (!(index > 0 && lines[index - 1].includes(OCX_SECTION_MARKER))) continue;
    lines.splice(index + 1, 0, OCX_SECTION_MARKER, key);
    return { content: lines.join("\n"), keptUserRealtimeWsBaseUrl: false };
  }
  // No marker-owned routing override to attach to: the override has no owner, so inject nothing.
  return { content, keptUserRealtimeWsBaseUrl: false };
}

/**
 * Remove the marker-owned root `openai_base_url` (marker line + the key line right after it).
 * A user's own root override (no marker) survives; an orphaned marker with no key line after
 * it is dropped too so repeated strip/inject cycles cannot accumulate marker comments.
 * A marker-owned `experimental_realtime_ws_base_url` pair is removed by the same rule.
 */
export function stripInjectedOpenaiBaseUrl(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const drop = new Set<number>();
  for (let i = 0; i < rootEnd; i++) {
    if (!lines[i].includes(OCX_SECTION_MARKER)) continue;
    if (i + 1 < rootEnd && (isRootOpenaiBaseUrlLine(lines[i + 1]) || isRootRealtimeWsBaseUrlLine(lines[i + 1]))) {
      drop.add(i);
      drop.add(i + 1);
    } else if (i + 1 >= rootEnd || lines[i + 1].trim() === "") {
      drop.add(i); // orphaned marker at root
    }
  }
  if (drop.size === 0) return content;
  return lines.filter((_, i) => !drop.has(i)).join("\n");
}

/**
 * Strip every existing `model_provider` line that we must not duplicate: any line set to
 * "opencodex" (wherever it sits — including a previously mis-nested one under a table), plus any
 * ROOT-level model_provider (before the first table) of any value, since we override the global.
 * A `model_provider` legitimately inside a user table/profile with a non-opencodex value is left
 * untouched.
 */
export function stripExistingModelProvider(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
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
 * Drop ROOT-level `model_context_window` overrides (keys before the first table header). Codex
 * treats this root key as a global override that wins over the per-model catalog values, so a stale
 * `model_context_window = 1000000` makes every model (e.g. gpt-5.5) report a 1M window. User-owned
 * compaction limits do not alter the advertised context window and must survive reinjection.
 */
export function stripRootContextWindowOverrides(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  return lines
    .filter((line, i) => {
      const isRoot = firstTable === -1 || i < firstTable;
      return !isRoot || !/^\s*model_context_window\s*=/.test(line);
    })
    .join("\n");
}

export function stripRootRoutedModel(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  return lines
    .filter((line, i) => {
      const isRoot = firstTable === -1 || i < firstTable;
      if (!isRoot) return true;
      const m = line.match(/^\s*model\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*$/);
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
export function setRootModelProvider(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
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
  const lines = content.split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const modelCatalogAssignment = tomlStringPattern("model_catalog_json");
  let ownedCatalogPath: string | null = null;
  for (let index = 0; index < rootEnd; index += 1) {
    const match = modelCatalogAssignment.exec(lines[index]);
    if (!match) continue;
    const catalogPath = parseTomlString(match[1]);
    if (!isOpencodexCatalogPath(catalogPath)) return catalogPath;
    ownedCatalogPath ??= catalogPath;
  }
  return ownedCatalogPath;
}

export function setRootModelCatalogPath(content: string, catalogPath: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const key = `model_catalog_json = ${tomlString(catalogPath)}`;
  const modelCatalogAssignment = tomlStringPattern("model_catalog_json");
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const ownedAssignments: number[] = [];
  let hasUserAssignment = false;
  for (let i = 0; i < rootEnd; i++) {
    const m = modelCatalogAssignment.exec(lines[i]);
    if (!m) continue;
    const existing = parseTomlString(m[1]);
    if (isOpencodexCatalogPath(existing)) {
      ownedAssignments.push(i);
    } else {
      hasUserAssignment = true;
    }
  }
  if (hasUserAssignment) {
    const owned = new Set(ownedAssignments);
    return lines.filter((_, index) => !owned.has(index)).join("\n");
  }
  if (ownedAssignments.length > 0) {
    lines[ownedAssignments[0]] = key;
    const duplicates = new Set(ownedAssignments.slice(1));
    return lines.filter((_, index) => !duplicates.has(index)).join("\n");
  }
  if (firstTable === -1) {
    return content.replace(/\n+$/, "") + "\n" + key + "\n";
  }
  let insertAt = firstTable;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, key);
  return lines.join("\n");
}

export function removeProfileSection(content: string): string {
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
  return (
    filtered
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}

export function normalizeServiceTier(content: string): string {
  return content.replace(
    /^(\s*service_tier\s*=\s*)["']priority["']\s*$/gm,
    '$1"fast"',
  );
}

export function ensureFastModeFeature(content: string, fastMode?: boolean): string {
  // Tri-state fast mode (see OcxConfig.fastMode): true forces `fast_mode = true`,
  // false forces `fast_mode = false`, and undefined leaves the user's config
  // untouched (no [features] table is added and an existing fast_mode line is
  // preserved as-is). Table and key matching accept the valid TOML spellings
  // `[features] # comment`, `["features"]` / `['features']`, and quoted keys.
  const lines = content.split("\n");
  const featuresHeader = /^\s*\[(["']?)\s*features\s*\1\]\s*(?:#.*)?$/;
  const fastModeKey = /^\s*(?:"fast_mode"|'fast_mode'|fast_mode)\s*=/;
  const featuresStart = lines.findIndex(line => featuresHeader.test(line));
  if (featuresStart === -1) {
    if (fastMode === undefined) return content;
    return content.trimEnd() + "\n\n[features]\nfast_mode = " + (fastMode ? "true" : "false") + "\n";
  }

  const nextTable = lines.findIndex(
    (line, index) => index > featuresStart && /^\s*\[/.test(line),
  );
  const featuresEnd = nextTable === -1 ? lines.length : nextTable;
  for (let i = featuresStart + 1; i < featuresEnd; i++) {
    if (fastModeKey.test(lines[i])) {
      if (fastMode === undefined) return lines.join("\n");
      lines[i] = lines[i].replace(/^(\s*)(?:"fast_mode"|'fast_mode'|fast_mode)\s*=.*$/, `$1fast_mode = ${fastMode ? "true" : "false"}`);
      return lines.join("\n");
    }
  }

  if (fastMode === undefined) return lines.join("\n");
  let insertAt = featuresEnd;
  while (insertAt > featuresStart + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, `fast_mode = ${fastMode ? "true" : "false"}`);
  return lines.join("\n");
}

function isOpencodexCatalogPath(path: string): boolean {
  return path.replace(/\\/g, "/").split("/").pop() === "opencodex-catalog.json";
}

export function stripOpencodexCatalogPath(content: string): string {
  const modelCatalogAssignment = tomlStringPattern("model_catalog_json");
  const lines = content.split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  return lines
    .filter((line, index) => {
      if (index >= rootEnd) return true;
      const m = modelCatalogAssignment.exec(line);
      return !m || !isOpencodexCatalogPath(parseTomlString(m[1]));
    })
    .join("\n");
}

export function buildProfileFile(port: number, catalogPath?: string | null, supportsWebsockets?: boolean, includeApiAuthHeader?: boolean, hostname?: string, fastMode?: boolean): string;
export function buildProfileFile(target: CodexRoutingTarget, catalogPath?: string | null, supportsWebsockets?: boolean, fastMode?: boolean): string;
export function buildProfileFile(
  portOrTarget: number | CodexRoutingTarget,
  catalogPath?: string | null,
  supportsWebsockets = false,
  includeApiAuthHeaderOrFastMode?: boolean,
  hostname?: string,
  fastMode?: boolean,
): string {
  const target = typeof portOrTarget === "number"
    ? validateCodexRoutingTarget({
        baseUrl: `http://${providerBaseHost(hostname)}:${portOrTarget}/v1`,
        requiresAdmissionToken: includeApiAuthHeaderOrFastMode === true,
        tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
      })
    : validateCodexRoutingTarget(portOrTarget);
  return buildProfileFileForTarget(
    target,
    catalogPath,
    supportsWebsockets,
    typeof portOrTarget === "number" ? fastMode : includeApiAuthHeaderOrFastMode,
  );
}

export function buildProfileFileForTarget(
  target: CodexRoutingTarget,
  catalogPath?: string | null,
  supportsWebsockets = false,
  fastMode?: boolean,
): string {
  const origin = routingTargetOrigin(target);
  const host = new URL(origin).host;
  // Design B (loopback): the reference/fallback file documents the root override form.
  // Non-loopback keeps the legacy provider-table shape (built-in provider cannot carry
  // the x-opencodex-api-key env header); explicit Desktop policies share that shape.
  if (!usesProviderTable(target)) {
    const lines = [
      "# OpenCodex proxy fallback config (Design B)",
      `# Root override that points Codex's built-in openai provider at the proxy on ${host}.`,
      "# Merge these root keys into ~/.codex/config.toml manually if auto-injection was removed.",
      buildOpenaiBaseUrlLineForTarget(target),
    ];
    if (catalogPath) lines.push(`model_catalog_json = ${tomlString(catalogPath)}`);
    if (fastMode !== undefined) lines.push("", "[features]", `fast_mode = ${fastMode ? "true" : "false"}`, "");
    return lines.join("\n");
  }
  const lines = [
    "# OpenCodex proxy profile — use with: codex --profile opencodex",
    `# Routes all model requests through the opencodex proxy at ${host}`,
    'model_provider = "opencodex"',
  ];
  if (catalogPath) lines.push(`model_catalog_json = ${tomlString(catalogPath)}`);
  if (fastMode !== undefined) lines.push("", "[features]", `fast_mode = ${fastMode ? "true" : "false"}`);
  lines.push(buildProviderTableBlockForTarget(target, supportsWebsockets).trimEnd(), "");
  return lines.join("\n");
}

export function chooseCatalogPathForInjection(
  content: string,
  requested?: string | null,
): string | null {
  if (requested !== undefined) return requested;

  const existing = readRootModelCatalogPath(content);
  if (existing) {
    const resolved = resolveCodexConfigPath(existing);
    if (!isOpencodexCatalogPath(resolved) || existsSync(resolved))
      return existing;
  }

  return existsSync(DEFAULT_CATALOG_PATH) ? DEFAULT_CATALOG_PATH : null;
}
