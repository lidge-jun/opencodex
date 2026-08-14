/**
 * features.ts — codex feature-flag view for $CODEX_HOME/config.toml.
 *
 * Scope boundary: this module mirrors only the flags opencodex has to READ
 * directly from config.toml:
 *   - `multi_agent_v2`, because opencodex migrates its concurrency value across
 *     the v1/v2 boundary and exposes the multi-agent config surface;
 *   - `default_mode_request_user_input` (Codex Auth page toggle), because the
 *     management API needs a live reader for the flag it manages.
 * Every other upstream feature flag is delegated to the native `codex features`
 * command (see src/cli/v2.ts) and must not be hardcoded here.
 *
 * Upstream reshapes flags freely: in the 1f0566d3f..5a1097ed2 range alone,
 * `code_mode_host` changed from a boolean to a table (it is Stage::Stable and
 * default-enabled upstream), `enable_fanout` and `item_ids` were retired to
 * Stage::Removed ("useless but kept for backward compatibility"), and several
 * under-development flags were added. Delegation is what keeps opencodex out of
 * that churn.
 *
 * Used by the catalog v2-gated-ultra policy (devlog/260709_v2_gated_ultra) and the
 * `ocx v2` toggle surface. The FLAG itself is never written here — toggling goes
 * through the official `codex features enable|disable` CLI (format-preserving).
 * The one write this module owns is the numeric
 * `features.multi_agent_v2.max_concurrent_threads_per_session` scalar
 * (setMaxConcurrentThreads): the codex CLI has no persisted setter for nested
 * feature config (`-c` is per-invocation only), so ocx does a scoped,
 * EOL-preserving line edit — same practice as codex/inject.ts.
 *
 * CODEX_HOME is resolved at CALL time (activeCodexConfigPath pattern, mirrors
 * catalog.ts:40-54) so tests can point fixtures via env or the explicit
 * `configPath` parameter without fighting the module-load-time const in paths.ts.
 */
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { AtomicWriteResidualTempError, AtomicWriteSecretResidualError, atomicWriteFile, expandUserPath, getConfigDir } from "../config";
import { forgetEphemeralSecretPath } from "../lib/windows-secret-acl";
import { CODEX_CONFIG_PATH } from "./paths";
import { resolveAndPersistCodexRuntime } from "./runtime";

/** Upstream codex-rs feature key: allow `request_user_input` in Default mode. */
export const DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE_KEY = "default_mode_request_user_input";

// EOL preservation, local copies of inject.ts dominantEol/applyEol: importing
// inject here would close a module cycle (features -> inject -> catalog -> features).
function dominantEol(content: string): "\r\n" | "\n" {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return "\n";
  const bareLf = (content.match(/\n/g) ?? []).length - crlf;
  return crlf >= bareLf ? "\r\n" : "\n";
}

function applyEol(content: string, eol: "\r\n" | "\n"): string {
  const normalized = content.replace(/\r\n/g, "\n");
  return eol === "\n" ? normalized : normalized.replace(/\n/g, "\r\n");
}

function mergeTrailingComments(existing?: string, migrated?: string): string {
  if (!existing) return migrated ?? "";
  if (!migrated || existing.trim() === migrated.trim()) return existing;
  const migratedText = migrated.replace(/^\s*#\s*/, "");
  if (existing.replace(/^\s*#\s*/, "").split(";").map(part => part.trim()).includes(migratedText.trim())) return existing;
  return `${existing}; ${migratedText}`;
}

export function activeCodexConfigPath(): string {
  const raw = process.env.CODEX_HOME?.trim();
  if (!raw) return CODEX_CONFIG_PATH;
  const path = resolve(expandUserPath(raw));
  try {
    return join(realpathSync.native(path), "config.toml");
  } catch {
    return join(path, "config.toml");
  }
}

function readConfigText(configPath?: string): string | null {
  const path = configPath ?? activeCodexConfigPath();
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Body lines of a TOML table `[header]` up to (not including) the next table header.
 *
 * The implementation body is deliberately unchanged by #1295 — only this comment
 * is new. The scanner is line-based and string-unaware, so it ends the table at
 * the first line matching `/^\s*\[/` even inside a multi-line value. Twenty call
 * sites in this file consume its output, most of them by matching a regex
 * against the returned text, so widening that text changes what they match. An
 * earlier attempt at #1295 made this scanner string-aware and thereby gave
 * `getAgentsEnabled`, `getAgentsMaxDepth`, and `getMaxConcurrentThreads` three
 * new wrong answers.
 *
 * The readers that matter for #1295 use a real TOML parse instead (see
 * `parsedTomlTable`). This stays as the fallback for documents that do not
 * parse, and as the reader for the remaining call sites until they are migrated
 * the same way.
 */
function tomlTableBody(content: string, header: string): string | null {
  const lines = content.split("\n");
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex(l => new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`).test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => /^\s*\[/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

function tomlBoolInBody(body: string, key: string): boolean | null {
  const m = body.match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\s*(?:#.*)?$`, "m"));
  return m ? m[1] === "true" : null;
}

/**
 * TRUE when the codex `multi_agent_v2` feature is enabled in config.toml.
 * Recognizes both shipped forms (codex-rs features/src/tests.rs):
 *   [features.multi_agent_v2]           [features]
 *   enabled = true                      multi_agent_v2 = true
 * plus the inline-table form `multi_agent_v2 = { enabled = true, ... }`.
 * Missing file/key -> false (upstream default_enabled = false).
 */
export function isMultiAgentV2Enabled(configPath?: string): boolean {
  const content = readConfigText(configPath);
  return multiAgentV2EnabledFromConfigText(content);
}

/** Parse `multi_agent_v2` from caller-owned config.toml text without consulting disk. */
export function multiAgentV2EnabledFromConfigText(content: string | null): boolean {
  if (content === null) return false;

  // Prefer a real parse. The hand-written table scanner below cannot distinguish
  // an assignment from prose that looks like one — a `"""` value containing the
  // line `enabled = true` reads as the key itself — and TOML has enough value
  // shapes (multi-line arrays opening on the next line, escapes, comments) that
  // each near-miss costs another special case (#1295).
  //
  // The scanner remains only for a document `Bun.TOML.parse` rejects. That is a
  // statement about Bun's parser, not about Codex's — the two are separate
  // implementations and no compatibility evidence is claimed here, so a document
  // Bun rejects may still be one Codex loads. The fallback is therefore
  // best-effort and inherits the ambiguity above. It exists because reporting a
  // feature as disabled on account of an unreadable file presents a failure as
  // a state.
  const parsed = parsedTomlTable(content, "features");
  if (parsed !== null) {
    const table = plainTomlRecord(parsed.multi_agent_v2);
    if (table !== null) return table.enabled === true;
    if (typeof parsed.multi_agent_v2 === "boolean") return parsed.multi_agent_v2;
    return false;
  }

  const table = tomlTableBody(content, "features.multi_agent_v2");
  if (table !== null) {
    const enabled = tomlBoolInBody(table, "enabled");
    if (enabled !== null) return enabled;
    // A bare [features.multi_agent_v2] table without `enabled` counts as on
    // (FeatureToml::Config with enabled: None materializes as enabled upstream
    // only when set; be conservative and require the boolean).
    return false;
  }

  const features = tomlTableBody(content, "features");
  if (features !== null) {
    const bool = tomlBoolInBody(features, "multi_agent_v2");
    if (bool !== null) return bool;
    const inline = features.match(/^\s*multi_agent_v2\s*=\s*\{([^}]*)\}/m);
    if (inline) {
      const enabled = inline[1].match(/enabled\s*=\s*(true|false)/);
      if (enabled) return enabled[1] === "true";
    }
  }
  return false;
}

function plainTomlRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * A top-level table from a full TOML parse, or null when the document does not
 * parse. A parsed document with no such table yields `{}` rather than null: that
 * is a real answer ("no keys"), while null means "could not read, fall back".
 */
function parsedTomlTable(content: string, name: string): Record<string, unknown> | null {
  const toml = (globalThis as { Bun?: { TOML?: { parse(input: string): unknown } } }).Bun?.TOML;
  if (!toml) return null;
  try {
    const root = plainTomlRecord(toml.parse(content));
    if (root === null) return null;
    return plainTomlRecord(root[name]) ?? {};
  } catch {
    return null;
  }
}


/**
 * TRUE when the codex `default_mode_request_user_input` feature is enabled in
 * config.toml — lets a Default-mode session pause and ask the user questions
 * through `request_user_input` (upstream FeatureSpec: under development,
 * default_enabled = false). Recognizes the shipped boolean form
 * `[features] default_mode_request_user_input = true`.
 * Missing file/key -> false.
 */
export function isDefaultModeRequestUserInputEnabled(configPath?: string): boolean {
  const content = readConfigText(configPath);
  if (content === null) return false;
  // Same reason as the v2 reader: a `"""` value whose prose contains
  // `default_mode_request_user_input = true` is not an assignment, and a raw
  // regex over the table body cannot tell the difference (#1295).
  const parsed = parsedTomlTable(content, "features");
  if (parsed !== null) return parsed[DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE_KEY] === true;
  const features = tomlTableBody(content, "features");
  if (features === null) return false;
  return tomlBoolInBody(features, DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE_KEY) === true;
}

/**
 * TRUE when config.toml still carries `[agents] max_threads` — codex-rs REFUSES to
 * boot with that key while multi_agent_v2 is enabled ("agents.max_threads cannot be
 * set when features.multi_agent_v2 is enabled", core/src/config/mod.rs:1421). The
 * `ocx v2 on` flow warns about it instead of editing config itself.
 */
export function hasAgentsMaxThreads(configPath?: string): boolean {
  const content = readConfigText(configPath);
  if (content === null) return false;
  const parsed = parsedTomlTable(content, "agents");
  if (parsed !== null) return Object.hasOwn(parsed, "max_threads");
  const agents = tomlTableBody(content, "agents");
  if (agents === null) return false;
  return /^\s*max_threads\s*=/m.test(agents);
}

/** Current legacy v1 `[agents] max_threads`, or null when absent/invalid. */
export function getAgentsMaxThreads(configPath?: string): number | null {
  const content = readConfigText(configPath);
  if (content === null) return null;
  const parsed = parsedTomlTable(content, "agents");
  if (parsed !== null) {
    const value = parsed.max_threads;
    return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
  }
  const agents = tomlTableBody(content, "agents");
  if (agents === null) return null;
  const m = agents.match(/^\s*max_threads\s*=\s*(\d+)\s*(?:#.*)?$/m);
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * Current `[agents] enabled`. Upstream defaults this to true and lets an enabled
 * `features.multi_agent_v2` override it entirely (codex-rs core/src/config/mod.rs
 * multi_agent_version_override returns V2 first at :1521-1523; `enabled = false`
 * only takes effect with V2 off), so `null` means "unset, upstream default applies"
 * and is NOT the same as `true`.
 */
export function getAgentsEnabled(configPath?: string): boolean | null {
  const content = readConfigText(configPath);
  if (content === null) return null;
  const agents = tomlTableBody(content, "agents");
  if (agents === null) return null;
  const m = agents.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/m);
  return m ? m[1] === "true" : null;
}

/**
 * Current `[agents] max_depth`. Upstream applies this to V1 agent threads only and
 * ignores it under V2 (config_toml.rs: "Maximum nesting depth for V1 agent threads.
 * Ignored by V2."). The upstream type is `Option<i32>` with no minimum, so a
 * negative value is valid config that effectively disables V1 child spawning —
 * do not "correct" it, and do not present this as an effective V2 limit.
 */
export function getAgentsMaxDepth(configPath?: string): number | null {
  const content = readConfigText(configPath);
  if (content === null) return null;
  const agents = tomlTableBody(content, "agents");
  if (agents === null) return null;
  const m = agents.match(/^\s*max_depth\s*=\s*(-?\d+)\s*(?:#.*)?$/m);
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647 ? value : null;
}

/**
 * Current `features.multi_agent_v2.max_concurrent_threads_per_session`, from
 * either the dedicated or inline-table form; null means the Codex default.
 */
export function getMaxConcurrentThreads(configPath?: string): number | null {
  const content = readConfigText(configPath);
  if (content === null) return null;
  const table = tomlTableBody(content, "features.multi_agent_v2");
  const features = tomlTableBody(content, "features");
  const inline = features?.match(/^\s*multi_agent_v2\s*=\s*\{([^}]*)\}/m);
  const m = table?.match(/^\s*max_concurrent_threads_per_session\s*=\s*(\d+)\s*(?:#.*)?$/m)
    ?? inline?.[1].match(/(?:^|,)\s*max_concurrent_threads_per_session\s*=\s*(\d+)\s*(?:,|$)/);
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isFinite(value) && value >= 1 ? value : null;
}

/** Largest V1 child limit we translate. Well below Number.MAX_SAFE_INTEGER and far
 *  above any real concurrency setting; upstream's usize saturates, ours would silently
 *  lose precision. */
const MAX_TRANSLATABLE_V1_CHILD_LIMIT = 1_000_000;
/** The V2 side is one larger by construction: it counts the root agent's own slot, so
 *  the image of the maximum V1 value must itself be translatable back. */
const MAX_TRANSLATABLE_V2_TOTAL_LIMIT = MAX_TRANSLATABLE_V1_CHILD_LIMIT + 1;

export function isTranslatableV1ChildLimit(limit: number): boolean {
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_TRANSLATABLE_V1_CHILD_LIMIT;
}

export function isTranslatableV2TotalLimit(limit: number): boolean {
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_TRANSLATABLE_V2_TOTAL_LIMIT;
}

/**
 * Upstream counts the root agent inside the V2 thread limit but not inside the legacy
 * `[agents]` limit (codex-rs core/src/config/mod.rs resolve_multi_agent_v2_config applies
 * saturating_add(1) to the [agents] value; the inverse saturating_sub(1) appears at
 * mod.rs:1555). These helpers keep our migrations on the same side of that boundary.
 */
export function v1ChildLimitToV2TotalLimit(childLimit: number): number {
  if (!isTranslatableV1ChildLimit(childLimit)) {
    throw new RangeError(`v1 child limit out of translatable range: ${childLimit}`);
  }
  return childLimit + 1;
}

/**
 * Inverse of `v1ChildLimitToV2TotalLimit`. A V2 total of 1 means "root only, no
 * children", which has no representable legacy child count >= 1, so it clamps to 1
 * rather than writing 0 and tripping upstream's `>= 1` validation.
 */
export function v2TotalLimitToV1ChildLimit(totalLimit: number): number {
  if (!isTranslatableV2TotalLimit(totalLimit)) {
    throw new RangeError(`v2 total limit out of translatable range: ${totalLimit}`);
  }
  return Math.max(1, totalLimit - 1);
}

/**
 * Persist `features.multi_agent_v2.max_concurrent_threads_per_session = value`.
 * Scoped edit in either the dedicated table or `[features]` boolean/inline form.
 * Boolean form is upgraded to an inline config so the numeric value remains
 * attached to the feature without a TOML key conflict. Idempotent on equal value.
 */
export function setMaxConcurrentThreads(value: number, configPath?: string, migratedComment?: string): { ok: true; changed: boolean } | { ok: false; error: string } {
  if (!Number.isInteger(value) || value < 1) {
    return { ok: false, error: "max_concurrent_threads_per_session must be an integer >= 1" };
  }
  const path = configPath ?? activeCodexConfigPath();
  const content = readConfigText(path);
  if (content === null) return { ok: false, error: `config.toml not readable at ${path}` };

  const eol = dominantEol(content);
  const lines = content.split(/\r?\n/);
  const headerRe = /^\s*\[features\.multi_agent_v2\]\s*(?:#.*)?$/;
  const headerIdx = lines.findIndex(l => headerRe.test(l));
  if (headerIdx === -1) {
    const featuresHeader = lines.findIndex(l => /^\s*\[features\]\s*(?:#.*)?$/.test(l));
    if (featuresHeader === -1) return { ok: false, error: "multi_agent_v2 feature config not found — enable v2 first (ocx v2 on)" };
    let featuresEnd = lines.length;
    for (let i = featuresHeader + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) { featuresEnd = i; break; }
    }
    const boolRe = /^(\s*)multi_agent_v2\s*=\s*(true|false)(\s*#.*)?$/;
    const inlineRe = /^(\s*)multi_agent_v2\s*=\s*\{([^}]*)\}(\s*#.*)?$/;
    for (let i = featuresHeader + 1; i < featuresEnd; i++) {
      const bool = lines[i].match(boolRe);
      if (bool) {
        lines[i] = `${bool[1]}multi_agent_v2 = { enabled = ${bool[2]}, max_concurrent_threads_per_session = ${value} }${mergeTrailingComments(bool[3], migratedComment)}`;
        atomicWriteFile(path, applyEol(lines.join("\n"), eol));
        return { ok: true, changed: true };
      }
      const inline = lines[i].match(inlineRe);
      if (!inline) continue;
      const existing = inline[2].match(/(?:^|,)\s*max_concurrent_threads_per_session\s*=\s*(\d+)\s*(?=,|$)/);
      if (existing && Number(existing[1]) === value && (!migratedComment || migratedComment === inline[3])) return { ok: true, changed: false };
      const body = existing
        ? inline[2].replace(/(^|,)\s*max_concurrent_threads_per_session\s*=\s*\d+\s*(?=,|$)/, `$1 max_concurrent_threads_per_session = ${value}`)
        : `${inline[2].trim()}${inline[2].trim() ? ", " : ""}max_concurrent_threads_per_session = ${value}`;
      lines[i] = `${inline[1]}multi_agent_v2 = { ${body.trim()} }${mergeTrailingComments(inline[3], migratedComment)}`;
      atomicWriteFile(path, applyEol(lines.join("\n"), eol));
      return { ok: true, changed: true };
    }
    return { ok: false, error: "multi_agent_v2 feature config not found — enable v2 first (ocx v2 on)" };
  }
  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  const keyRe = /^(\s*)max_concurrent_threads_per_session\s*=\s*(\d+)(\s*#.*)?$/;
  for (let i = headerIdx + 1; i < end; i++) {
    const m = lines[i].match(keyRe);
    if (!m) continue;
    if (Number(m[2]) === value && (!migratedComment || migratedComment === m[3])) return { ok: true, changed: false };
    lines[i] = `${m[1]}max_concurrent_threads_per_session = ${value}${mergeTrailingComments(m[3], migratedComment)}`;
    atomicWriteFile(path, applyEol(lines.join("\n"), eol));
    return { ok: true, changed: true };
  }
  lines.splice(headerIdx + 1, 0, `max_concurrent_threads_per_session = ${value}${migratedComment ?? ""}`);
  atomicWriteFile(path, applyEol(lines.join("\n"), eol));
  return { ok: true, changed: true };
}

type ConfigEditResult = { ok: true; changed: boolean } | { ok: false; error: string };

/**
 * Encode a string as a TOML single-line basic string.
 *
 * Character-by-character on purpose. A chained-replace implementation
 * (`.replace(/\\/g, "\\\\").replace(/\t/g, "\\t")`) corrupts input: the backslash
 * pass runs first, then later passes insert NEW backslashes the first pass can no
 * longer protect. Single-line basic strings handle every case including embedded
 * `"""`, which a multi-line `"""..."""` form cannot.
 */
function encodeTomlBasicString(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case "\\": out += "\\\\"; break;
      case '"': out += '\\"'; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      case "\b": out += "\\b"; break;
      case "\f": out += "\\f"; break;
      default: {
        const code = ch.codePointAt(0)!;
        out += code < 0x20 || code === 0x7f
          ? `\\u${code.toString(16).padStart(4, "0")}`
          : ch;
      }
    }
  }
  return out + '"';
}

/**
 * Decode one TOML string token INCLUDING its quotes. Basic strings (`"..."`)
 * unescape; literal strings (`'...'`) are verbatim — a backslash is not special
 * there. Returns null for anything that is not a string token.
 */
function decodeTomlStringToken(token: string): string | null {
  if (token.length < 2) return null;
  // Multi-line literal string: `'''...'''` verbatim (backslashes not special).
  if (token.startsWith("'''")) {
    return token.endsWith("'''") && token.length >= 6
      ? normalizeTomlMultilineBody(token.slice(3, -3))
      : null;
  }
  // Multi-line basic string: `"""..."""` with escapes.
  if (token.startsWith('"""')) {
    if (!token.endsWith('"""') || token.length < 6) return null;
    return decodeBasicStringBody(normalizeTomlMultilineBody(token.slice(3, -3)), true);
  }
  if (token.startsWith("'")) {
    return token.endsWith("'") ? token.slice(1, -1) : null;
  }
  if (!token.startsWith('"') || !token.endsWith('"')) return null;
  return decodeBasicStringBody(token.slice(1, -1));
}

/** Apply TOML's multi-line newline rules before string-body decoding. */
function normalizeTomlMultilineBody(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n");
  return normalized.startsWith("\n") ? normalized.slice(1) : normalized;
}

/** Unescape the body of a TOML basic string (single- or multi-line). */
function decodeBasicStringBody(body: string, multiline = false): string | null {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") { out += ch; continue; }
    const esc = body[++i];
    if (multiline) {
      let newline = i;
      while (body[newline] === " " || body[newline] === "\t") newline++;
      if (body[newline] === "\n") {
        i = newline;
        while (body[i + 1] === " " || body[i + 1] === "\t" || body[i + 1] === "\n") i++;
        continue;
      }
    }
    switch (esc) {
      case "\\": out += "\\"; break;
      case '"': out += '"'; break;
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "t": out += "\t"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "u": {
        const code = parseInt(body.slice(i + 1, i + 5), 16);
        if (Number.isNaN(code)) return null;
        out += String.fromCodePoint(code);
        i += 4;
        break;
      }
      case "U": {
        const code = parseInt(body.slice(i + 1, i + 9), 16);
        if (Number.isNaN(code)) return null;
        out += String.fromCodePoint(code);
        i += 8;
        break;
      }
      default: return null;
    }
  }
  return out;
}

/**
 * End index (exclusive) of the TOML value starting at or after `start` in `text`.
 * String-aware: basic strings honor backslash escapes, literal strings do not.
 * Inline tables and arrays nest and are scanned with the same awareness.
 */
function scanTomlValueEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  const first = text[i];
  if (first === '"') {
    // Multi-line basic string: `"""..."""`. The closing delimiter is a triple
    // quote; a single or double quote inside the body does not end the token.
    if (text[i + 1] === '"' && text[i + 2] === '"') {
      i += 3;
      while (i < text.length) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i] === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
          // TOML permits up to two quotes immediately inside the closing
          // delimiter, so a 4- or 5-quote run means the extra one or two
          // quotes are part of the value. Consume the full valid run and
          // keep the surplus quotes in the body.
          let end = i + 3;
          if (text[end] === '"') {
            end++;
            if (text[end] === '"') end++;
          }
          return end;
        }
        i++;
      }
      return text.length;
    }
    i++;
    while (i < text.length) {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i] === '"') return i + 1;
      i++;
    }
    return text.length;
  }
  if (first === "'") {
    // Multi-line literal string: `'''...'''`.
    if (text[i + 1] === "'" && text[i + 2] === "'") {
      i += 3;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'" && text[i + 2] === "'") {
          // Same as multi-line basic: up to two surplus single quotes can
          // precede the closing delimiter and remain part of the value.
          let end = i + 3;
          if (text[end] === "'") {
            end++;
            if (text[end] === "'") end++;
          }
          return end;
        }
        i++;
      }
      return text.length;
    }
    const close = text.indexOf("'", i + 1);
    return close === -1 ? text.length : close + 1;
  }
  if (first === "{") {
    const close = findInlineTableEnd(text, i);
    return close === -1 ? text.length : close + 1;
  }
  if (first === "[") {
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"' || c === "'") { i = scanTomlValueEnd(text, i); continue; }
      if (c === "[") depth++;
      else if (c === "]") { depth--; if (depth === 0) return i + 1; }
      i++;
    }
    return text.length;
  }
  while (i < text.length && !/[\s,}\]#]/.test(text[i])) i++;
  return i;
}

/** Index of the `}` matching the `{` at `openIdx`, string-aware, or -1. */
function findInlineTableEnd(text: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") { i = scanTomlValueEnd(text, i); continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

interface InlineEntry { keyStart: number; valueStart: number; valueEnd: number }

/** Locate a top-level assignment while skipping complete (possibly multiline) values. */
function findTomlAssignment(text: string, key: string): InlineEntry | null {
  let lineStart = 0;
  while (lineStart < text.length) {
    let i = lineStart;
    while (text[i] === " " || text[i] === "\t") i++;
    const keyStart = i;
    let keyText = "";
    if (text[i] === '"' || text[i] === "'") {
      const keyEnd = scanTomlValueEnd(text, i);
      keyText = decodeTomlStringToken(text.slice(i, keyEnd)) ?? "";
      i = keyEnd;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
      if (match) {
        keyText = match[0];
        i += match[0].length;
      }
    }
    while (text[i] === " " || text[i] === "\t") i++;
    if (keyText && text[i] === "=") {
      const valueStart = i + 1;
      const valueEnd = scanTomlValueEnd(text, valueStart);
      if (keyText === key) return { keyStart, valueStart, valueEnd };
      const nextLine = text.indexOf("\n", valueEnd);
      lineStart = nextLine === -1 ? text.length : nextLine + 1;
      continue;
    }
    const nextLine = text.indexOf("\n", lineStart);
    lineStart = nextLine === -1 ? text.length : nextLine + 1;
  }
  return null;
}

/**
 * Locate `key = value` inside the inline-table body spanning [bodyStart, bodyEnd)
 * (exclusive of the braces), string-aware on both keys and values, or null.
 */
function findInlineEntry(text: string, bodyStart: number, bodyEnd: number, key: string): InlineEntry | null {
  let i = bodyStart;
  while (i < bodyEnd) {
    while (i < bodyEnd && /[\s,]/.test(text[i])) i++;
    if (i >= bodyEnd) break;
    const entryStart = i;
    let keyText: string;
    if (text[i] === '"' || text[i] === "'") {
      const keyEnd = scanTomlValueEnd(text, i);
      keyText = decodeTomlStringToken(text.slice(i, keyEnd)) ?? "";
      i = keyEnd;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i, bodyEnd));
      if (!m) break;
      keyText = m[0];
      i += m[0].length;
    }
    while (i < bodyEnd && /\s/.test(text[i])) i++;
    if (text[i] !== "=") { i = entryStart + 1; continue; }
    i++;
    while (i < bodyEnd && /\s/.test(text[i])) i++;
    const valueStart = i;
    const valueEnd = Math.min(scanTomlValueEnd(text, valueStart), bodyEnd);
    if (keyText === key) return { keyStart: entryStart, valueStart, valueEnd };
    i = valueEnd;
  }
  return null;
}

/** Whether a TOML assignment's value starts with a triple-quoted string. */
function isMultilineTomlString(text: string, valueStart: number): boolean {
  let start = valueStart;
  while (text[start] === " " || text[start] === "\t") start++;
  return text.startsWith('"""', start) || text.startsWith("'''", start);
}

/** Whether one field in a supported inline `multi_agent_v2` table is triple-quoted. */
function hasInlineMultilineTomlString(text: string, assignment: InlineEntry, key: string): boolean {
  let openIdx = assignment.valueStart;
  while (text[openIdx] === " " || text[openIdx] === "\t") openIdx++;
  if (text[openIdx] !== "{") return false;
  const closeIdx = findInlineTableEnd(text, openIdx);
  if (closeIdx === -1) return false;
  const entry = findInlineEntry(text, openIdx + 1, closeIdx, key);
  return entry !== null && isMultilineTomlString(text, entry.valueStart);
}

/**
 * Set or remove one scalar key inside a top-level TOML table, preserving every
 * other line byte-for-byte — including the existing value's trailing comment,
 * which is kept verbatim. `encoded` is the already-serialized RHS
 * (`encodeTomlBasicString` for strings, `String(n)` for numbers, `"true"`/`"false"`
 * for booleans); null removes the key. Creates the table when absent. Returns the
 * new content; returning the input unchanged means no-op.
 */
function editScalarInTable(content: string, table: string, key: string, encoded: string | null): string {
  const eol = dominantEol(content);
  const lines = content.split(/\r?\n/);
  const headerRe = new RegExp(`^\\s*\\[${table.replace(/\./g, "\\.")}\\]\\s*(?:#.*)?$`);
  const headerIdx = lines.findIndex(l => headerRe.test(l));
  if (headerIdx === -1) {
    if (encoded === null) return content;
    const separator = lines.length > 0 && lines[lines.length - 1] !== "" ? [""] : [];
    lines.push(...separator, `[${table}]`, `${key} = ${encoded}`);
    return applyEol(lines.join("\n"), eol);
  }
  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  for (let i = headerIdx + 1; i < end; i++) {
    const entry = findTomlAssignment(lines[i], key);
    if (!entry) continue;
    // The existing value may itself contain '#', so scan the value token
    // string-aware instead of splitting on '#'.
    const line = lines[i];
    const trailing = line.slice(entry.valueEnd);
    if (encoded === null) {
      lines.splice(i, 1);
      return applyEol(lines.join("\n"), eol);
    }
    if (line.slice(entry.valueStart, entry.valueEnd).trim() === encoded) return content;
    lines[i] = `${line.slice(0, entry.keyStart)}${key} = ${encoded}${trailing}`;
    return applyEol(lines.join("\n"), eol);
  }
  if (encoded === null) return content;
  lines.splice(headerIdx + 1, 0, `${key} = ${encoded}`);
  return applyEol(lines.join("\n"), eol);
}

/** Persist `[agents] enabled = value`, or remove the key when `value` is null. */
export function setAgentsEnabled(value: boolean | null, configPath?: string): ConfigEditResult {
  const path = configPath ?? activeCodexConfigPath();
  const content = readConfigText(path);
  if (content === null) return { ok: false, error: `config.toml not readable at ${path}` };
  const next = editScalarInTable(content, "agents", "enabled", value === null ? null : String(value));
  if (next === content) return { ok: true, changed: false };
  atomicWriteFile(path, next);
  return { ok: true, changed: true };
}

/**
 * Persist `[agents] max_depth = value`, or remove the key when `value` is null.
 * Validation is exactly the upstream contract: `Option<i32>` with no minimum, so
 * any integer in signed-i32 range is accepted — writing anything wider would
 * produce a config upstream cannot deserialize, a hard parse failure for the
 * user's Codex.
 */
export function setAgentsMaxDepth(value: number | null, configPath?: string): ConfigEditResult {
  if (value !== null && (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647)) {
    return { ok: false, error: "max_depth must be an integer within signed i32 range" };
  }
  const path = configPath ?? activeCodexConfigPath();
  const content = readConfigText(path);
  if (content === null) return { ok: false, error: `config.toml not readable at ${path}` };
  const next = editScalarInTable(content, "agents", "max_depth", value === null ? null : String(value));
  if (next === content) return { ok: true, changed: false };
  atomicWriteFile(path, next);
  return { ok: true, changed: true };
}

/**
 * Current `features.multi_agent_v2.subagent_developer_instructions`.
 *
 * Upstream tri-state (codex-rs core/src/config/mod.rs resolve_multi_agent_v2_config):
 *   unset        -> the child inherits the parent's developer instructions
 *   non-empty    -> replaces the inherited parent fragment
 *   empty string -> clears the inherited fragment
 *
 * So `null` and `""` are DIFFERENT values and both must round-trip. Upstream
 * `.trim()`s the configured text, so whitespace-only values are effectively `""`.
 * Reads both the dedicated-table and inline forms; dedicated wins, mirroring
 * `getMaxConcurrentThreads` precedence.
 */
/**
 * Read a string-valued `features.multi_agent_v2` scalar (dedicated table or inline
 * form; dedicated wins, mirroring `getMaxConcurrentThreads` precedence). Returns
 * `null` when the key is absent or the config is unreadable. A present empty string
 * round-trips faithfully — some upstream keys treat `""` and `null` differently.
 */
function getV2StringField(key: string, configPath?: string): string | null {
  const content = readConfigText(configPath);
  if (content === null) return null;
  const table = tomlTableBodyForStringFields(content, "features.multi_agent_v2");
  if (table !== null) {
    const entry = findTomlAssignment(table, key);
    if (entry) {
      const token = table.slice(entry.valueStart, entry.valueEnd).trim();
      return decodeTomlStringToken(token);
    }
    return null;
  }
  const features = tomlTableBodyForStringFields(content, "features");
  if (features === null) return null;
  const v2Entry = findTomlAssignment(features, "multi_agent_v2");
  if (!v2Entry) return null;
  let openIdx = v2Entry.valueStart;
  while (features[openIdx] === " " || features[openIdx] === "\t") openIdx++;
  if (features[openIdx] !== "{") return null;
  const closeIdx = findInlineTableEnd(features, openIdx);
  if (closeIdx === -1) return null;
  const entry = findInlineEntry(features, openIdx + 1, closeIdx, key);
  if (!entry) return null;
  return decodeTomlStringToken(features.slice(entry.valueStart, entry.valueEnd).trim());
}

/**
 * A table body scanner that skips complete TOML values before recognizing the
 * next header. Unlike the legacy line scanner, bracket-shaped prose inside a
 * multi-line string cannot truncate the table.
 */
function tomlTableBodyForStringFields(content: string, header: string): string | null {
  const escaped = escapeRegExp(header);
  const match = new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`, "m").exec(content);
  if (!match) return null;
  const newline = content.indexOf("\n", match.index + match[0].length);
  if (newline === -1) return "";
  const bodyStart = newline + 1;
  let lineStart = bodyStart;
  while (lineStart < content.length) {
    let cursor = lineStart;
    while (content[cursor] === " " || content[cursor] === "\t") cursor++;
    if (content[cursor] === "[") return content.slice(bodyStart, lineStart);
    const lineEnd = content.indexOf("\n", cursor);
    const boundedEnd = lineEnd === -1 ? content.length : lineEnd;
    let keyEnd = cursor;
    if (content[keyEnd] === '"' || content[keyEnd] === "'") {
      keyEnd = scanTomlValueEnd(content, keyEnd);
    } else {
      const keyMatch = /^[A-Za-z0-9_.-]+/.exec(content.slice(keyEnd, boundedEnd));
      if (keyMatch) keyEnd += keyMatch[0].length;
    }
    while (content[keyEnd] === " " || content[keyEnd] === "\t") keyEnd++;
    if (content[keyEnd] === "=" && keyEnd < boundedEnd) {
      const valueEnd = scanTomlValueEnd(content, keyEnd + 1);
      const nextLine = content.indexOf("\n", valueEnd);
      lineStart = nextLine === -1 ? content.length : nextLine + 1;
    } else {
      lineStart = lineEnd === -1 ? content.length : lineEnd + 1;
    }
  }
  return content.slice(bodyStart);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bare and quoted TOML forms of one known-safe key. */
function tomlKeyPattern(key: string): string {
  const escaped = escapeRegExp(key);
  return `(?:${escaped}|"${escaped}"|'${escaped}')`;
}

export function getSubagentDeveloperInstructions(configPath?: string): string | null {
  return getV2StringField("subagent_developer_instructions", configPath);
}

/** Current `features.multi_agent_v2.multi_agent_mode_hint_text`, or null when unset. */
export function getMultiAgentModeHintText(configPath?: string): string | null {
  return getV2StringField("multi_agent_mode_hint_text", configPath);
}

/**
 * Persist `features.multi_agent_v2.subagent_developer_instructions`, or remove the
 * key when `value` is null. Handles all three existing encodings: the dedicated
 * table (scalar edit), the inline table (string-aware edit inside the braces — a
 * regex over `[^}]*` would corrupt any value containing `}`), and the bare boolean
 * form (upgraded in place to an inline table, mirroring `setMaxConcurrentThreads`).
 * With no existing v2 config, creates the dedicated table carrying only this key.
 * The key name must match upstream character-for-character: the upstream struct
 * carries `#[serde(deny_unknown_fields)]`, so a misspelling is not ignored — it is
 * a hard config-parse failure for the user's Codex.
 */
function setV2StringField(key: string, value: string | null, configPath?: string): ConfigEditResult {
  const path = configPath ?? activeCodexConfigPath();
  const content = readConfigText(path);
  if (content === null) return { ok: false, error: `config.toml not readable at ${path}` };
  const encoded = value === null ? null : encodeTomlBasicString(value);

  // A parsed V2 object without one of the supported source forms came from
  // dotted/quoted path segments. Appending a dedicated table would redefine it
  // and make Codex reject the file, so fail closed without changing any bytes.
  const parsedFeatures = parsedTomlTable(content, "features");
  const parsedV2 = parsedFeatures === null ? null : plainTomlRecord(parsedFeatures.multi_agent_v2);
  const dedicatedV2 = tomlTableBodyForStringFields(content, "features.multi_agent_v2") !== null;
  const featuresBody = tomlTableBodyForStringFields(content, "features");
  const featuresV2Entry = featuresBody === null ? null : findTomlAssignment(featuresBody, "multi_agent_v2");
  const supportedFeaturesEntry = featuresV2Entry !== null;
  if (parsedV2 !== null && !dedicatedV2 && !supportedFeaturesEntry) {
    return { ok: false, error: "dotted or quoted multi_agent_v2 config is not supported for managed string fields" };
  }

  const dedicatedStringBody = tomlTableBodyForStringFields(content, "features.multi_agent_v2");
  if (dedicatedStringBody !== null) {
    // Multiline TOML strings ("""...""" / '''...''') span multiple lines and the
    // single-line table editor cannot rewrite or remove them without corrupting
    // the document. Scope this guard to the target V2 table so an unrelated
    // table carrying the same key does not block an otherwise safe edit.
    const dedicatedEntry = findTomlAssignment(dedicatedStringBody, key);
    if (dedicatedEntry !== null && isMultilineTomlString(dedicatedStringBody, dedicatedEntry.valueStart)) {
      return { ok: false, error: `multi-line TOML string for ${key} is not editable; convert it to a single-line string first` };
    }
    const legacyDedicatedBody = tomlTableBody(content, "features.multi_agent_v2") ?? "";
    if (dedicatedEntry !== null && findTomlAssignment(legacyDedicatedBody, key) === null) {
      return { ok: false, error: `cannot edit ${key} after a header-shaped multiline value safely` };
    }
    const next = editScalarInTable(content, "features.multi_agent_v2", key, encoded);
    if (next === content) return { ok: true, changed: false };
    atomicWriteFile(path, next);
    return { ok: true, changed: true };
  }

  if (featuresBody !== null && featuresV2Entry !== null && hasInlineMultilineTomlString(featuresBody, featuresV2Entry, key)) {
    return { ok: false, error: `multi-line TOML string for ${key} is not editable; convert it to a single-line string first` };
  }

  const eol = dominantEol(content);
  const lines = content.split(/\r?\n/);
  const featuresHeader = lines.findIndex(l => /^\s*\[features\]\s*(?:#.*)?$/.test(l));
  if (featuresHeader !== -1) {
    let featuresEnd = lines.length;
    for (let i = featuresHeader + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) { featuresEnd = i; break; }
    }
    for (let i = featuresHeader + 1; i < featuresEnd; i++) {
      const line = lines[i];
      const inlineMatch = line.match(/^(\s*)multi_agent_v2\s*=\s*\{/);
      if (inlineMatch) {
        const openIdx = inlineMatch[0].length - 1;
        const closeIdx = findInlineTableEnd(line, openIdx);
        if (closeIdx === -1) return { ok: false, error: "malformed multi_agent_v2 inline table" };
        const entry = findInlineEntry(line, openIdx + 1, closeIdx, key);
        if (encoded === null) {
          if (!entry) return { ok: true, changed: false };
          let start = entry.keyStart;
          let stop = entry.valueEnd;
          let j = stop;
          while (j < closeIdx && line[j] === " ") j++;
          if (line[j] === ",") {
            stop = j + 1;
            while (stop < closeIdx && line[stop] === " ") stop++;
          } else {
            let k = start;
            while (k > openIdx + 1 && line[k - 1] === " ") k--;
            if (line[k - 1] === ",") start = k - 1;
          }
          lines[i] = line.slice(0, start) + line.slice(stop);
          atomicWriteFile(path, applyEol(lines.join("\n"), eol));
          return { ok: true, changed: true };
        }
        if (entry) {
          if (line.slice(entry.valueStart, entry.valueEnd).trim() === encoded) return { ok: true, changed: false };
          lines[i] = line.slice(0, entry.valueStart) + encoded + line.slice(entry.valueEnd);
        } else {
          let insertPos = closeIdx;
          while (insertPos > openIdx + 1 && line[insertPos - 1] === " ") insertPos--;
          const hasEntries = line.slice(openIdx + 1, insertPos).trim().length > 0;
          const insertion = hasEntries
            ? `, ${key} = ${encoded} `
            : ` ${key} = ${encoded} `;
          lines[i] = line.slice(0, insertPos) + insertion + line.slice(closeIdx);
        }
        atomicWriteFile(path, applyEol(lines.join("\n"), eol));
        return { ok: true, changed: true };
      }
      const boolMatch = line.match(/^(\s*)multi_agent_v2\s*=\s*(true|false)(\s*(?:#.*)?)$/);
      if (boolMatch) {
        if (encoded === null) return { ok: true, changed: false };
        lines[i] = `${boolMatch[1]}multi_agent_v2 = { enabled = ${boolMatch[2]}, ${key} = ${encoded} }${boolMatch[3]}`;
        atomicWriteFile(path, applyEol(lines.join("\n"), eol));
        return { ok: true, changed: true };
      }
    }
    if (featuresV2Entry !== null) {
      return { ok: false, error: "multi_agent_v2 inside a multiline [features] table is not editable safely" };
    }
  }

  if (encoded === null) return { ok: true, changed: false };
  const suffix = content.endsWith("\n") || content.length === 0 ? "" : eol;
  const separator = content.length > 0 && !content.endsWith(`${eol}${eol}`) ? eol : "";
  const tableText = `[features.multi_agent_v2]${eol}${key} = ${encoded}${eol}`;
  atomicWriteFile(path, `${content}${suffix}${separator}${tableText}`);
  return { ok: true, changed: true };
}

export function setSubagentDeveloperInstructions(value: string | null, configPath?: string): ConfigEditResult {
  return setV2StringField("subagent_developer_instructions", value, configPath);
}

export const MODE_HINT_UNSUPPORTED_ERROR =
  "installed Codex does not support multi_agent_mode_hint_text; update Codex first";

/**
 * Persist `features.multi_agent_v2.multi_agent_mode_hint_text`, or remove the key
 * when `value` is null. Same encoding coverage and upstream-name discipline as
 * `setSubagentDeveloperInstructions`; the upstream struct rejects unknown fields,
 * so the key spelling must match codex-rs exactly.
 */
export function setMultiAgentModeHintText(value: string | null, configPath?: string): ConfigEditResult {
  // The upstream `multi_agent_mode_hint_text` key is newer than the v2 config
  // surface opencodex already manages; an older Codex build rejects the unknown
  // member (`#[serde(deny_unknown_fields)]`) and fails to start. Probe the
  // installed runtime binary for the key string and refuse the write when the
  // binary provably lacks it. A probe that cannot run (missing binary,
  // unreadable file) does not block: that is the test/hermetic path and the
  // headless runtime fallback.
  if (value !== null) {
    const probe = probeCodexSupportsModeHint();
    if (probe === false) {
      return {
        ok: false,
        error: MODE_HINT_UNSUPPORTED_ERROR,
      };
    }
  }
  return setV2StringField("multi_agent_mode_hint_text", value, configPath);
}

export const MODE_HINT_CAPABILITY_CACHE_MAX_ENTRIES = 8;
export const modeHintCapabilityCache = new Map<string, boolean | null>();

export function rememberModeHintCapability(cacheKey: string, capability: boolean | null): void {
  modeHintCapabilityCache.delete(cacheKey);
  modeHintCapabilityCache.set(cacheKey, capability);
  while (modeHintCapabilityCache.size > MODE_HINT_CAPABILITY_CACHE_MAX_ENTRIES) {
    const oldest = modeHintCapabilityCache.keys().next().value;
    if (oldest === undefined) break;
    modeHintCapabilityCache.delete(oldest);
  }
}

/**
 * True when the installed Codex runtime binary contains the
 * `multi_agent_mode_hint_text` config key, false when it provably does not, and
 * null when the probe could not run (missing binary, unreadable file).
 */
export function probeCodexSupportsModeHint(): boolean | null {
  try {
    const runtime = resolveAndPersistCodexRuntime({ env: process.env }).runtime;
    const selectedPath = resolveSelectedCommandPath(runtime.command);
    let selectedIdentity = selectedPath ?? "";
    try { if (selectedPath) selectedIdentity = realpathSync(selectedPath); } catch { /* keep lexical path */ }
    const candidates = codexNativeBinaryCandidates(runtime.command);
    const binaryStatFingerprint = candidates.map(candidate => {
      try {
        const stat = statSync(candidate);
        return `${candidate}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`;
      } catch {
        return `${candidate}\0missing`;
      }
    }).join("\0");
    const cacheKey = `${runtime.command}\0${runtime.version ?? ""}\0${selectedIdentity}\0${binaryStatFingerprint}`;
    const cached = modeHintCapabilityCache.get(cacheKey);
    if (cached !== undefined) return cached;
    let sawBinary = false;
    for (const candidate of candidates) {
      try {
        if (!existsSync(candidate)) continue;
        const buf = readFileSync(candidate);
        if (!isNativeExecutable(buf)) continue;
        sawBinary = true;
        if (buf.includes(Buffer.from("multi_agent_mode_hint_text", "utf8"))) {
          rememberModeHintCapability(cacheKey, true);
          return true;
        }
      } catch {
        continue;
      }
    }
    // At least one real binary was inspected and none contained the key.
    const result = sawBinary ? false : null;
    rememberModeHintCapability(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}

const CODEX_PLATFORM_PACKAGES = [
  ["codex-darwin-arm64", "aarch64-apple-darwin", "codex"],
  ["codex-darwin-x64", "x86_64-apple-darwin", "codex"],
  ["codex-linux-x64", "x86_64-unknown-linux-musl", "codex"],
  ["codex-linux-arm64", "aarch64-unknown-linux-musl", "codex"],
  ["codex-win32-x64", "x86_64-pc-windows-msvc", "codex.exe"],
  ["codex-win32-arm64", "aarch64-pc-windows-msvc", "codex.exe"],
] as const;

function isNativeExecutable(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  if (buf[0] === 0x4d && buf[1] === 0x5a) return true; // PE/COFF
  const magic = buf.readUInt32BE(0);
  return magic === 0x7f454c46 // ELF
    || magic === 0xfeedface || magic === 0xfeedfacf
    || magic === 0xcefaedfe || magic === 0xcffaedfe
    || magic === 0xcafebabe || magic === 0xbebafeca; // Mach-O/fat Mach-O
}

/**
 * Candidate native codex binaries to probe. The resolved `command` may be the
 * opencodex shim or the npm JS wrapper (`codex.opencodex-real`), neither of
 * which embeds the Rust config schema. The real binary ships under the
 * platform package's `vendor/<triple>/bin/codex`; also try adjacent wrappers.
 */
function codexNativeBinaryCandidates(command: string): string[] {
  const out = new Set<string>();
  const resolverBases = new Set<string>();
  const selectedPath = resolveSelectedCommandPath(command);

  const addSelectedTarget = (target: string) => {
    try {
      const real = realpathSync(target);
      out.add(target);
      out.add(real);
      if (/[\\/]@openai[\\/]codex[\\/]bin[\\/]/.test(real)) resolverBases.add(real);
    } catch {
      // Missing backing paths cannot establish capability either way.
    }
  };

  // Follow the resolved command to its real location. The opencodex shim and
  // the npm JS wrapper resolve to `@openai/codex/bin/codex.js`; the native
  // binary lives in the sibling platform package's vendor directory.
  if (selectedPath) {
    addSelectedTarget(selectedPath);
    for (const target of selectedShimBackingPaths(selectedPath)) addSelectedTarget(target);
  }

  // npm's Windows wrappers are ordinary scripts. Resolve from both the global
  // prefix layout and a project-local node_modules/.bin layout; createRequire
  // then follows the selected installation's own dependency tree (including
  // pnpm/nested optional dependencies) without consulting unrelated PATH bins.
  const wrapperPath = selectedPath ?? command;
  if (/\.(?:cmd|ps1)$/i.test(wrapperPath)) {
    resolverBases.add(resolve(dirname(wrapperPath), "node_modules", "@openai", "codex", "bin", "codex.js"));
    resolverBases.add(resolve(dirname(wrapperPath), "..", "@openai", "codex", "bin", "codex.js"));
  }

  for (const base of resolverBases) {
    const requireFromSelected = createRequire(base);
    for (const [pkg, triple, exe] of CODEX_PLATFORM_PACKAGES) {
      try {
        const manifest = requireFromSelected.resolve(`@openai/${pkg}/package.json`);
        out.add(join(dirname(manifest), "vendor", triple, "bin", exe));
      } catch {
        // Optional platform packages for other targets are normally absent.
      }
    }
  }
  return [...out];
}

/** Backing paths tied to this exact OCX shim entry in codex-shim.json. */
function selectedShimBackingPaths(commandPath: string): string[] {
  try {
    const state = JSON.parse(readFileSync(join(getConfigDir(), "codex-shim.json"), "utf8")) as {
      wrapperPath?: unknown;
      originalPath?: unknown;
      backupPath?: unknown;
      realPath?: unknown;
      wrappers?: Array<Record<string, unknown>>;
    };
    const entries = Array.isArray(state.wrappers) && state.wrappers.length > 0 ? state.wrappers : [state];
    const selected = resolve(commandPath);
    for (const entry of entries) {
      if (typeof entry.wrapperPath !== "string" || resolve(entry.wrapperPath) !== selected) continue;
      return [entry.backupPath, entry.realPath, entry.originalPath]
        .filter((value): value is string => typeof value === "string" && value.length > 0 && resolve(value) !== selected);
    }
  } catch {
    // Not an OCX-owned shim, or no readable state.
  }
  return [];
}

/** Resolve only the selected bare command against PATH; never enumerate peers. */
function resolveSelectedCommandPath(command: string): string | null {
  if (command.includes("/") || command.includes("\\")) return existsSync(command) ? resolve(command) : null;
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function editAgentsMaxThreads(value: number | null, configPath?: string, migratedComment?: string): ConfigEditResult {
  const path = configPath ?? activeCodexConfigPath();
  const content = readConfigText(path);
  if (content === null) return { ok: false, error: `config.toml not readable at ${path}` };
  const eol = dominantEol(content);
  const lines = content.split(/\r?\n/);
  const headerIdx = lines.findIndex(l => /^\s*\[agents\]\s*(?:#.*)?$/.test(l));
  if (headerIdx === -1) {
    if (value === null) return { ok: true, changed: false };
    const separator = lines.length > 0 && lines[lines.length - 1] !== "" ? [""] : [];
    lines.push(...separator, "[agents]", `max_threads = ${value}${migratedComment ?? ""}`);
    atomicWriteFile(path, applyEol(lines.join("\n"), eol));
    return { ok: true, changed: true };
  }
  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  const keyRe = /^(\s*)max_threads\s*=\s*(\d+)(\s*#.*)?$/;
  for (let i = headerIdx + 1; i < end; i++) {
    const m = lines[i].match(keyRe);
    if (!m) continue;
    if (value === null) lines.splice(i, 1);
    else if (Number(m[2]) === value && (!migratedComment || migratedComment === m[3])) return { ok: true, changed: false };
    else lines[i] = `${m[1]}max_threads = ${value}${mergeTrailingComments(m[3], migratedComment)}`;
    atomicWriteFile(path, applyEol(lines.join("\n"), eol));
    return { ok: true, changed: true };
  }
  if (value === null) return { ok: true, changed: false };
  lines.splice(headerIdx + 1, 0, `max_threads = ${value}${migratedComment ?? ""}`);
  atomicWriteFile(path, applyEol(lines.join("\n"), eol));
  return { ok: true, changed: true };
}

function removeMaxConcurrentThreads(configPath?: string): ConfigEditResult {
  const path = configPath ?? activeCodexConfigPath();
  const content = readConfigText(path);
  if (content === null) return { ok: false, error: `config.toml not readable at ${path}` };
  const eol = dominantEol(content);
  const lines = content.split(/\r?\n/);
  const headerIdx = lines.findIndex(l => /^\s*\[features\.multi_agent_v2\]\s*(?:#.*)?$/.test(l));
  if (headerIdx !== -1) {
    let end = lines.length;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) { end = i; break; }
    }
    const keyIdx = lines.findIndex((line, i) => i > headerIdx && i < end && /^\s*max_concurrent_threads_per_session\s*=/.test(line));
    if (keyIdx !== -1) {
      lines.splice(keyIdx, 1);
      atomicWriteFile(path, applyEol(lines.join("\n"), eol));
      return { ok: true, changed: true };
    }
  }
  const featuresHeader = lines.findIndex(l => /^\s*\[features\]\s*(?:#.*)?$/.test(l));
  if (featuresHeader === -1) return { ok: true, changed: false };
  let featuresEnd = lines.length;
  for (let i = featuresHeader + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { featuresEnd = i; break; }
  }
  const inlineRe = /^(\s*)multi_agent_v2\s*=\s*\{([^}]*)\}(\s*#.*)?$/;
  for (let i = featuresHeader + 1; i < featuresEnd; i++) {
    const inline = lines[i].match(inlineRe);
    if (!inline || !/(?:^|,)\s*max_concurrent_threads_per_session\s*=/.test(inline[2])) continue;
    const body = inline[2]
      .replace(/^\s*max_concurrent_threads_per_session\s*=\s*\d+\s*,?\s*/, "")
      .replace(/,\s*max_concurrent_threads_per_session\s*=\s*\d+\s*(?=,|$)/, "")
      .trim();
    lines[i] = `${inline[1]}multi_agent_v2 = { ${body} }${inline[3] ?? ""}`;
    atomicWriteFile(path, applyEol(lines.join("\n"), eol));
    return { ok: true, changed: true };
  }
  return { ok: true, changed: false };
}

function ensureDisabledV2Config(value: number | null, configPath?: string, migratedComment?: string): ConfigEditResult {
  const path = configPath ?? activeCodexConfigPath();
  const content = readConfigText(path);
  if (content === null) return { ok: false, error: `config.toml not readable at ${path}` };
  if (tomlTableBody(content, "features.multi_agent_v2") !== null || tomlTableBody(content, "features")?.match(/^\s*multi_agent_v2\s*=/m)) {
    if (value === null) return { ok: true, changed: false };
    return setMaxConcurrentThreads(value, path, migratedComment);
  }
  const eol = dominantEol(content);
  const suffix = content.endsWith("\n") || content.length === 0 ? "" : eol;
  const table = `[features.multi_agent_v2]${eol}enabled = false${value === null ? "" : `${eol}max_concurrent_threads_per_session = ${value}${migratedComment ?? ""}`}${eol}`;
  atomicWriteFile(path, `${content}${suffix}${content.length > 0 && !content.endsWith(`${eol}${eol}`) ? eol : ""}${table}`);
  return { ok: true, changed: true };
}

/**
 * The effective concurrency limit expressed in the units of the currently ACTIVE
 * backend: under V2 the total-thread limit upstream enforces, under V1 the child
 * limit. The active backend's own key wins; the other backend's key is translated
 * across the root-agent slot. Display path only — never throws: a stored value
 * outside the translatable range is returned raw (at that magnitude the ±1 root
 * slot is already below float precision, and crashing `ocx v2 status` or
 * `GET /api/v2` is not a price worth paying for a translation that means nothing).
 * Migration code uses `discoverStoredThreadLimit` instead, which keeps provenance.
 */
export function getLogicalMaxThreads(configPath?: string): number | null {
  if (isMultiAgentV2Enabled(configPath)) {
    const v2 = getMaxConcurrentThreads(configPath);
    if (v2 !== null) return v2;
    const legacy = getAgentsMaxThreads(configPath);
    if (legacy === null) return null;
    return isTranslatableV1ChildLimit(legacy) ? v1ChildLimitToV2TotalLimit(legacy) : legacy;
  }
  const legacy = getAgentsMaxThreads(configPath);
  if (legacy !== null) return legacy;
  const v2 = getMaxConcurrentThreads(configPath);
  if (v2 === null) return null;
  return isTranslatableV2TotalLimit(v2) ? v2TotalLimitToV1ChildLimit(v2) : v2;
}

type ThreadLimitUnits = "v1-child" | "v2-total";

/**
 * Which storage the active limit lives in, in that storage's native units. The
 * active backend's own key wins; the other backend's key is the fallback and keeps
 * ITS units. Never translates and never throws. This is the migration-side sibling
 * of `getLogicalMaxThreads`: a migration needs to know exactly which storage the
 * value came from, and a display function's raw fallback would lose that.
 */
function discoverStoredThreadLimit(configPath?: string): { value: number; units: ThreadLimitUnits } | null {
  if (isMultiAgentV2Enabled(configPath)) {
    const v2 = getMaxConcurrentThreads(configPath);
    if (v2 !== null) return { value: v2, units: "v2-total" };
    const legacy = getAgentsMaxThreads(configPath);
    return legacy === null ? null : { value: legacy, units: "v1-child" };
  }
  const legacy = getAgentsMaxThreads(configPath);
  if (legacy !== null) return { value: legacy, units: "v1-child" };
  const v2 = getMaxConcurrentThreads(configPath);
  return v2 === null ? null : { value: v2, units: "v2-total" };
}

function activeThreadComment(content: string, v2Enabled: boolean): string | undefined {
  const legacy = tomlTableBody(content, "agents")?.match(/^\s*max_threads\s*=\s*\d+(\s*#.*)$/m)?.[1];
  const dedicated = tomlTableBody(content, "features.multi_agent_v2")
    ?.match(/^\s*max_concurrent_threads_per_session\s*=\s*\d+(\s*#.*)$/m)?.[1];
  const features = tomlTableBody(content, "features");
  const inlineLine = features?.match(/^\s*multi_agent_v2\s*=\s*\{([^}]*)\}(\s*#.*)$/m);
  const inline = inlineLine && /(?:^|,)\s*max_concurrent_threads_per_session\s*=\s*\d+\s*(?:,|$)/.test(inlineLine[1])
    ? inlineLine[2]
    : undefined;
  return v2Enabled ? dedicated ?? inline ?? legacy : legacy ?? dedicated ?? inline;
}

let migrationEditSeq = 0;
/** Both residual classes gate the memo release: a plain residual and a
 * secret-bearing one alike keep their destination memo while the file
 * remains on disk. Exported for the regression seam. */
export function isAtomicResidualError(error: unknown): boolean {
  return error instanceof AtomicWriteResidualTempError || error instanceof AtomicWriteSecretResidualError;
}

function applyConfigEditsAtomically(path: string, edit: (tempPath: string) => ConfigEditResult): ConfigEditResult {
  const content = readConfigText(path);
  if (content === null) return { ok: false, error: `config.toml not readable at ${path}` };
  const tempPath = `${path}.ocx-migration.${process.pid}.${++migrationEditSeq}`;
  // An inner residual temp (AtomicWriteResidualTempError) keeps its
  // destination-keyed memo: fail-closed while the residual exists.
  let innerResidual = false;
  try {
    atomicWriteFile(tempPath, content);
    const result = edit(tempPath);
    if (!result.ok) return result;
    const edited = readConfigText(tempPath);
    if (edited === null) return { ok: false, error: "temporary config migration output is unreadable" };
    if (edited === content) return { ok: true, changed: false };
    atomicWriteFile(path, edited);
    return { ok: true, changed: true };
  } catch (error) {
    if (isAtomicResidualError(error)) innerResidual = true;
    throw error;
  } finally {
    try {
      unlinkSync(tempPath);
      if (!innerResidual) forgetEphemeralSecretPath(tempPath);
    } catch (error) {
      // Already absent is also proven-absent; other failures keep the memo.
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        if (!innerResidual) forgetEphemeralSecretPath(tempPath);
      }
    }
  }
}

export type MultiAgentV2TransitionResult =
  | { ok: true; changed: boolean; threadLimit: number | null }
  | { ok: false; error: string };

function transitionConfigError(content: string): string | null {
  if (/^\s*(?:features\.multi_agent_v2(?:\.[A-Za-z0-9_]+)?|agents\.max_threads)\s*=/m.test(content)) {
    return "dotted multi-agent config keys are not supported for automatic migration";
  }
  const dedicatedTables = content.match(/^\s*\[features\.multi_agent_v2\]\s*(?:#.*)?$/gm) ?? [];
  const featuresTables = content.match(/^\s*\[features\]\s*(?:#.*)?$/gm) ?? [];
  const agentsTables = content.match(/^\s*\[agents\]\s*(?:#.*)?$/gm) ?? [];
  if (dedicatedTables.length > 1 || featuresTables.length > 1 || agentsTables.length > 1) {
    return "duplicate multi-agent TOML tables cannot be migrated safely";
  }
  const features = tomlTableBody(content, "features");
  const featureDefs = features?.match(/^\s*multi_agent_v2\s*=/gm) ?? [];
  if (featureDefs.length > 1 || (dedicatedTables.length === 1 && featureDefs.length === 1)) {
    return "duplicate multi_agent_v2 definitions cannot be migrated safely";
  }
  if (features && /^\s*multi_agent_v2\.(?:enabled|max_concurrent_threads_per_session)\s*=/m.test(features)) {
    return "dotted multi_agent_v2 fields are not supported for automatic migration";
  }
  const agents = tomlTableBody(content, "agents");
  if ((agents?.match(/^\s*max_threads\s*=/gm) ?? []).length > 1) {
    return "duplicate agents.max_threads definitions cannot be migrated safely";
  }
  const dedicated = tomlTableBody(content, "features.multi_agent_v2");
  if ((dedicated?.match(/^\s*max_concurrent_threads_per_session\s*=/gm) ?? []).length > 1) {
    return "duplicate v2 thread-limit definitions cannot be migrated safely";
  }
  return null;
}

/**
 * Toggle native multi_agent_v2 while moving the active thread limit to the key
 * valid for the destination version. Any failed command/postcondition restores
 * the exact original config bytes.
 */
export function transitionMultiAgentV2(
  enabled: boolean,
  toggleFeature: (enabled: boolean) => void,
  options: { configPath?: string; threadLimit?: number } = {},
): MultiAgentV2TransitionResult {
  if (options.threadLimit !== undefined && (!Number.isInteger(options.threadLimit) || options.threadLimit < 1)) {
    return { ok: false, error: "thread limit must be an integer >= 1" };
  }
  const path = options.configPath ?? activeCodexConfigPath();
  const original = readConfigText(path);
  if (original === null) return { ok: false, error: `config.toml not readable at ${path}` };
  const preflightError = transitionConfigError(original);
  if (preflightError) return { ok: false, error: preflightError };
  const beforeEnabled = isMultiAgentV2Enabled(path);
  // A caller-supplied limit is already in the DESTINATION backend's units and is
  // never translated. A discovered limit carries the units of the storage it was
  // read from and crosses the root-slot boundary only when those units differ
  // from the destination's — which covers both backend flips and same-state
  // storage migrations (legacy-only under V2, V2-only under V1). The range
  // check runs only when a translation is actually needed, and before the try
  // block so an out-of-range stored value is a normal error result rather than
  // a RangeError escaping the rollback contract.
  const discovered = discoverStoredThreadLimit(path);
  const destinationUnits: ThreadLimitUnits = enabled ? "v2-total" : "v1-child";
  let threadLimit = options.threadLimit ?? discovered?.value ?? null;
  if (options.threadLimit === undefined && discovered !== null && discovered.units !== destinationUnits) {
    const translatable = discovered.units === "v1-child" ? isTranslatableV1ChildLimit : isTranslatableV2TotalLimit;
    if (!translatable(discovered.value)) {
      return { ok: false, error: `stored thread limit out of translatable range: ${discovered.value}` };
    }
    threadLimit = discovered.units === "v1-child"
      ? v1ChildLimitToV2TotalLimit(discovered.value)
      : v2TotalLimitToV1ChildLimit(discovered.value);
  }
  const migratedComment = activeThreadComment(original, beforeEnabled);
  try {
    if (enabled) {
      if (!beforeEnabled) {
        const staged = applyConfigEditsAtomically(path, tempPath => {
          const v2 = ensureDisabledV2Config(threadLimit, tempPath, migratedComment);
          if (!v2.ok) return v2;
          return editAgentsMaxThreads(null, tempPath);
        });
        if (!staged.ok) throw new Error(staged.error);
        toggleFeature(true);
      }
      if (!isMultiAgentV2Enabled(path)) throw new Error("codex feature command did not enable multi_agent_v2");
      const target = applyConfigEditsAtomically(path, tempPath => {
        const v2 = threadLimit === null
          ? removeMaxConcurrentThreads(tempPath)
          : setMaxConcurrentThreads(threadLimit, tempPath, migratedComment);
        if (!v2.ok) return v2;
        return editAgentsMaxThreads(null, tempPath);
      });
      if (!target.ok) throw new Error(target.error);
      if (hasAgentsMaxThreads(path) || getMaxConcurrentThreads(path) !== threadLimit) throw new Error("v2 thread-limit migration postcondition failed");
    } else {
      if (beforeEnabled) toggleFeature(false);
      if (isMultiAgentV2Enabled(path)) throw new Error("codex feature command did not disable multi_agent_v2");
      const target = applyConfigEditsAtomically(path, tempPath => {
        const v2 = removeMaxConcurrentThreads(tempPath);
        if (!v2.ok) return v2;
        return editAgentsMaxThreads(threadLimit, tempPath, migratedComment);
      });
      if (!target.ok) throw new Error(target.error);
      if (getMaxConcurrentThreads(path) !== null || getAgentsMaxThreads(path) !== threadLimit) throw new Error("v1 thread-limit migration postcondition failed");
    }
    return { ok: true, changed: readConfigText(path) !== original, threadLimit };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      atomicWriteFile(path, original);
      return { ok: false, error: message };
    } catch (rollbackErr) {
      return { ok: false, error: `${message}; rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}` };
    }
  }
}
