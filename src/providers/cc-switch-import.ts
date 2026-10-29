/**
 * Keyless CC-Switch provider configuration importer (preview, selective apply, and journaled restore).
 *
 * Security & privacy boundary:
 * - Reads only non-secret provider metadata (id, name, app_type, baseUrl, wire adapter, defaultModel)
 *   from an explicitly supplied CC-Switch SQLite database (v3.10+) or legacy JSON file.
 * - Never queries, decodes, retains, logs, or writes API keys, bearer tokens, or auth headers.
 * - Source files are opened read-only and verified as bounded plain regular files.
 * - Apply and restore run only while the proxy is stopped, under the service ownership lease and
 *   the shared config mutation lock, with a durable streaming journal for rollback.
 */
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  getConfigDir,
  getConfigPath,
  hasOwnProvider,
  isValidProviderName,
  mutatePersistedConfig,
  readConfigDiagnostics,
  validateConfigCandidate,
  withConfigMutationLockSync,
} from "../config";
import { atomicWriteFileStreamed } from "../config/atomic-write";
import { readConfigFileSnapshot } from "../config/diagnostics";
import { withConfigDirHardeningSettled } from "../config/paths";
import { readAlivePid, readRuntimePort } from "../config/process-state";
import { providerBaseUrlConfigError } from "../config/provider-validation";
import { assertPlainLocalPath } from "../codex/orca-auth-source";
import { codexAccountNamespaceProviderCollisionError } from "../codex/account-namespace-match";
import { providerDestinationConfigError } from "../lib/destination-policy";
import { SENSITIVE_KEY_PATTERN } from "../lib/redact";
import { rewriteProviderReferences } from "./provider-id-rewrite";
import { acquireOwnershipMutationLease } from "../service/ownership-mutation-lease.mjs";
import { serviceStatePaths } from "../service/state";
import type { OcxConfig, OcxProviderConfig } from "../types";

export class CcSwitchImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CcSwitchImportError";
  }
}

export type CcSwitchInvalidReason =
  | "missing_base_url"
  | "invalid_base_url"
  | "private_network_refused"
  | "invalid_provider_name"
  | "unsupported_app_type"
  | "ambiguous_codex_provider"
  | "secret_in_nonsecret_field"
  | "malformed_entry";

export interface CcSwitchCandidateProvider {
  name: string;
  sourceId: string;
  displayName: string;
  appType: string;
  adapter: string;
  baseUrl: string;
  defaultModel?: string;
  allowPrivateNetwork?: boolean;
}

export interface CcSwitchImportPreviewOrApplyResult {
  mode: "preview" | "apply";
  discovered: number;
  eligible: number;
  imported: number;
  conflicts: number;
  conflictNames: string[];
  invalid: number;
  invalidReasons: Partial<Record<CcSwitchInvalidReason, number>>;
  providers: CcSwitchCandidateProvider[];
}

export interface CcSwitchImportRestoreResult {
  mode: "restore";
  restored: number;
  restoredNames: string[];
  alreadyAbsent: number;
  retainedEdited: number;
  retainedNames: string[];
}

export type CcSwitchImportResult = CcSwitchImportPreviewOrApplyResult | CcSwitchImportRestoreResult;

export const CC_SWITCH_IMPORT_JOURNAL_FILENAME = "cc-switch-provider-import-journal.json";
const JOURNAL_SCHEMA_VERSION = 1;
const MAX_SQLITE_BYTES = 32 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const SQLITE_MAGIC_PREFIX = "SQLite format 3";

interface JournalEntry {
  name: string;
  sourceId: string;
  appType: string;
  note: string;
  fingerprint: string;
}

interface ImportJournal {
  schemaVersion: 1;
  state: "prepared" | "committed";
  importId: string;
  createdAt: number;
  entries: JournalEntry[];
}

interface RawExtractedRow {
  id: string;
  appType: string;
  name: string;
  settingsType: string | null;
  claudeBaseUrl: string | null;
  claudeModel: string | null;
  genericBaseUrl: string | null;
  genericModel: string | null;
  genericWireApi: string | null;
  codexTomlLines: string | null;
  codexProjection?: { ok: true; value: CodexTomlProjection } | { ok: false; reason: CcSwitchInvalidReason };
}

// Token-like prefixes or bearer markers that must never appear inside extracted non-secret fields.
const TOKEN_LIKE_VALUE = /(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{8,}|rk-[A-Za-z0-9_-]{8,}|pk-[A-Za-z0-9_-]{8,}|ak-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{12,}|gho_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+/=-]{6,})/i;
const HIGH_ENTROPY_PATH_SEGMENT = /^[A-Za-z0-9_-]{48,}$/;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

function looksLikeSecretValue(value: string, isUrl = false): boolean {
  if (hasControlChars(value) || TOKEN_LIKE_VALUE.test(value) || SENSITIVE_KEY_PATTERN.test(value)) return true;
  if (isUrl) {
    try {
      const parsed = new URL(value);
      for (const seg of parsed.pathname.split("/")) {
        if (HIGH_ENTROPY_PATH_SEGMENT.test(seg)) return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

function normalizeProviderSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function canonicalProviderJson(provider: OcxProviderConfig): string {
  const keys = Object.keys(provider).sort();
  const ordered: Record<string, unknown> = {};
  for (const key of keys) {
    const val = (provider as unknown as Record<string, unknown>)[key];
    if (val !== undefined) ordered[key] = val;
  }
  return JSON.stringify(ordered);
}

export function canonicalProviderFingerprint(provider: OcxProviderConfig): string {
  return createHash("sha256").update(canonicalProviderJson(provider), "utf8").digest("hex");
}

function syncDirectoryBestEffort(dirPath: string): void {
  if (process.platform === "win32") return;
  let fd: number | undefined;
  try {
    fd = openSync(dirPath, "r");
    fsyncSync(fd);
  } catch {
    // Best-effort directory sync after unlink on POSIX.
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function writeJournalDurably(journalPath: string, journal: ImportJournal): void {
  const bytes = Buffer.from(JSON.stringify(journal, null, 2) + "\n", "utf8");
  atomicWriteFileStreamed(journalPath, (fd: number) => {
    writeFileSync(fd, bytes);
  });
}

function unlinkJournalDurably(journalPath: string): void {
  try {
    unlinkSync(journalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  syncDirectoryBestEffort(dirname(journalPath));
}

function readJournal(journalPath: string): ImportJournal | null {
  let raw: string;
  try {
    raw = readFileSync(journalPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CcSwitchImportError("Existing CC-Switch import journal is unreadable; inspect or restore before importing.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CcSwitchImportError("Existing CC-Switch import journal is corrupt; inspect or restore before importing.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CcSwitchImportError("Existing CC-Switch import journal is corrupt; inspect or restore before importing.");
  }
  const obj = parsed as Record<string, unknown>;
  if (
    obj.schemaVersion !== JOURNAL_SCHEMA_VERSION
    || (obj.state !== "prepared" && obj.state !== "committed")
    || typeof obj.importId !== "string"
    || !obj.importId.trim()
    || typeof obj.createdAt !== "number"
    || !Array.isArray(obj.entries)
    || obj.entries.length === 0
  ) {
    throw new CcSwitchImportError("Existing CC-Switch import journal is corrupt; inspect or restore before importing.");
  }
  const entries: JournalEntry[] = [];
  const seenNames = new Set<string>();
  for (const item of obj.entries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new CcSwitchImportError("Existing CC-Switch import journal is corrupt; inspect or restore before importing.");
    }
    const rec = item as Record<string, unknown>;
    if (
      typeof rec.name !== "string" || !isValidProviderName(rec.name)
      || typeof rec.sourceId !== "string" || !rec.sourceId
      || typeof rec.appType !== "string" || !rec.appType
      || typeof rec.note !== "string" || !rec.note.startsWith(`imported:cc-switch:${obj.importId}:`)
      || typeof rec.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(rec.fingerprint)
      || seenNames.has(rec.name)
    ) {
      throw new CcSwitchImportError("Existing CC-Switch import journal is corrupt; inspect or restore before importing.");
    }
    seenNames.add(rec.name);
    entries.push({
      name: rec.name,
      sourceId: rec.sourceId,
      appType: rec.appType,
      note: rec.note,
      fingerprint: rec.fingerprint,
    });
  }
  return {
    schemaVersion: 1,
    state: obj.state,
    importId: obj.importId,
    createdAt: obj.createdAt,
    entries,
  };
}

/**
 * Syntax-aware, single-line TOML projection for Codex settings_config.config.
 * Operates on a transient UTF-8 byte buffer (zeroed by the caller in finally) and decodes ONLY:
 * - [table] headers (bare or quoted)
 * - root model, model_provider, base_url, openai_base_url, wire_api
 * - [model_providers.<key>] base_url and wire_api
 * Rejects triple-quoted strings, inline tables, arrays, unclosed quotes, or non-assignment lines.
 */
export interface CodexTomlProjection {
  model?: string;
  modelProvider?: string;
  rootBaseUrl?: string;
  rootWireApi?: string;
  providers: Map<string, { baseUrl?: string; wireApi?: string }>;
}

function parseTomlQuotedString(line: string, startIndex: number): { value: string; restIndex: number } | null {
  const quote = line[startIndex];
  if (quote !== '"' && quote !== "'") return null;
  if (line.slice(startIndex, startIndex + 3) === quote.repeat(3)) return null;
  let out = "";
  let i = startIndex + 1;
  while (i < line.length) {
    const ch = line[i]!;
    if (quote === '"' && ch === "\\") {
      i++;
      if (i >= line.length) return null;
      const esc = line[i]!;
      if (esc === '"' || esc === "\\" || esc === "/") out += esc;
      else if (esc === "n") out += "\n";
      else if (esc === "r") out += "\r";
      else if (esc === "t") out += "\t";
      else if (esc === "b") out += "\b";
      else if (esc === "f") out += "\f";
      else if (esc === "u" && /^[0-9A-Fa-f]{4}$/.test(line.slice(i + 1, i + 5))) {
        out += String.fromCharCode(parseInt(line.slice(i + 1, i + 5), 16));
        i += 4;
      } else return null;
      i++;
      continue;
    }
    if (ch === quote) return { value: out, restIndex: i + 1 };
    if (hasControlChars(ch)) return null;
    out += ch;
    i++;
  }
  return null;
}

function hasOnlyTomlCommentOrSpace(line: string, fromIndex: number): boolean {
  const rest = line.slice(fromIndex).trimStart();
  return rest === "" || rest.startsWith("#");
}

function parseTableHeader(trimmed: string): { kind: "root_other" } | { kind: "model_provider"; id: string } | null {
  if (!trimmed.startsWith("[") || trimmed.startsWith("[[")) return null;
  let i = 1;
  const segments: string[] = [];
  while (i < trimmed.length) {
    while (i < trimmed.length && (trimmed[i] === " " || trimmed[i] === "\t")) i++;
    if (i >= trimmed.length) return null;
    let seg = "";
    if (trimmed[i] === '"' || trimmed[i] === "'") {
      const parsed = parseTomlQuotedString(trimmed, i);
      if (!parsed) return null;
      seg = parsed.value;
      i = parsed.restIndex;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(trimmed.slice(i));
      if (!m) return null;
      seg = m[0];
      i += seg.length;
    }
    if (!seg) return null;
    segments.push(seg);
    while (i < trimmed.length && (trimmed[i] === " " || trimmed[i] === "\t")) i++;
    if (trimmed[i] === ".") {
      i++;
      continue;
    }
    if (trimmed[i] === "]") {
      if (!hasOnlyTomlCommentOrSpace(trimmed, i + 1)) return null;
      if (segments.length === 2 && segments[0] === "model_providers") {
        return { kind: "model_provider", id: segments[1]! };
      }
      return { kind: "root_other" };
    }
    return null;
  }
  return null;
}

const ALLOWED_TOML_KEYS = new Set(["model", "model_provider", "base_url", "openai_base_url", "wire_api"]);

export function parseCodexTomlBytes(bytes: Uint8Array): { ok: true; value: CodexTomlProjection } | { ok: false; reason: CcSwitchInvalidReason } {
  const projection: CodexTomlProjection = { providers: new Map() };
  let currentSection: { kind: "root" } | { kind: "model_provider"; id: string } | { kind: "other" } = { kind: "root" };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let lineStart = 0;

  for (let idx = 0; idx <= bytes.length; idx++) {
    if (idx < bytes.length && bytes[idx] !== 0x0a) continue;
    let lineEnd = idx;
    if (lineEnd > lineStart && bytes[lineEnd - 1] === 0x0d) lineEnd--;
    const slice = bytes.subarray(lineStart, lineEnd);
    lineStart = idx + 1;

    let p = 0;
    while (p < slice.length && (slice[p] === 0x20 || slice[p] === 0x09)) p++;
    if (p >= slice.length || slice[p] === 0x23) continue;
    if (slice[p] === 0x5b) {
      let headerLine: string;
      try { headerLine = decoder.decode(slice.subarray(p)); } catch { return { ok: false, reason: "malformed_entry" }; }
      if (headerLine === "[__MULTILINE_REFUSED__]" || headerLine === "[__MALFORMED_LINE__]") {
        return { ok: false, reason: "malformed_entry" };
      }
      const header = parseTableHeader(headerLine);
      if (!header) return { ok: false, reason: "malformed_entry" };
      currentSection = header.kind === "model_provider" ? header : { kind: "other" };
      continue;
    }

    let eq = -1;
    let inKeyQuote = 0;
    for (let k = p; k < slice.length; k++) {
      const b = slice[k]!;
      if (inKeyQuote === 0 && b === 0x23) break;
      if (inKeyQuote === 0 && (b === 0x22 || b === 0x27)) { inKeyQuote = b; continue; }
      if (inKeyQuote !== 0 && b === 0x5c && inKeyQuote === 0x22) { k++; continue; }
      if (inKeyQuote !== 0 && b === inKeyQuote) { inKeyQuote = 0; continue; }
      if (inKeyQuote === 0 && b === 0x3d) { eq = k; break; }
    }
    if (eq < 0) return { ok: false, reason: "malformed_entry" };

    let keyRaw: string;
    try { keyRaw = decoder.decode(slice.subarray(p, eq)).trim(); } catch { return { ok: false, reason: "malformed_entry" }; }
    let key = keyRaw;
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
      const kp = parseTomlQuotedString(key, 0);
      if (!kp || kp.restIndex !== key.length) return { ok: false, reason: "malformed_entry" };
      key = kp.value;
    } else if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      return { ok: false, reason: "malformed_entry" };
    }

    let vStart = eq + 1;
    while (vStart < slice.length && (slice[vStart] === 0x20 || slice[vStart] === 0x09)) vStart++;
    if (vStart >= slice.length) return { ok: false, reason: "malformed_entry" };
    if (
      vStart + 2 < slice.length
      && ((slice[vStart] === 0x22 && slice[vStart + 1] === 0x22 && slice[vStart + 2] === 0x22)
        || (slice[vStart] === 0x27 && slice[vStart + 1] === 0x27 && slice[vStart + 2] === 0x27))
    ) {
      return { ok: false, reason: "malformed_entry" };
    }

    const relevant =
      (currentSection.kind === "root" && ALLOWED_TOML_KEYS.has(key))
      || (currentSection.kind === "model_provider" && (key === "base_url" || key === "wire_api"));
    if (!relevant) {
      let q = 0;
      let depth = 0;
      for (let k = vStart; k < slice.length; k++) {
        const b = slice[k]!;
        if (q === 0 && b === 0x23) break;
        if (q === 0 && (b === 0x22 || b === 0x27)) { q = b; continue; }
        if (q !== 0 && b === 0x5c && q === 0x22) { k++; continue; }
        if (q !== 0 && b === q) { q = 0; continue; }
        if (q === 0 && (b === 0x5b || b === 0x7b)) depth++;
        if (q === 0 && (b === 0x5d || b === 0x7d)) {
          depth--;
          if (depth < 0) return { ok: false, reason: "malformed_entry" };
        }
      }
      if (q !== 0 || depth !== 0) return { ok: false, reason: "malformed_entry" };
      continue;
    }

    let valPart: string;
    try { valPart = decoder.decode(slice.subarray(vStart)); } catch { return { ok: false, reason: "malformed_entry" }; }
    const parsedVal = parseTomlQuotedString(valPart, 0);
    if (!parsedVal || !hasOnlyTomlCommentOrSpace(valPart, parsedVal.restIndex)) {
      return { ok: false, reason: "malformed_entry" };
    }
    const value = parsedVal.value.trim();
    if (!value) return { ok: false, reason: "malformed_entry" };

    if (currentSection.kind === "root") {
      if (key === "model") projection.model = value;
      else if (key === "model_provider") projection.modelProvider = value;
      else if (key === "base_url" || key === "openai_base_url") projection.rootBaseUrl = value;
      else if (key === "wire_api") projection.rootWireApi = value;
    } else if (currentSection.kind === "model_provider") {
      const entry = projection.providers.get(currentSection.id) ?? {};
      if (key === "base_url") entry.baseUrl = value;
      else if (key === "wire_api") entry.wireApi = value;
      projection.providers.set(currentSection.id, entry);
    }
  }

  return { ok: true, value: projection };
}

function resolveCodexProjection(proj: CodexTomlProjection): { ok: true; baseUrl: string; wireApi: string; defaultModel?: string } | { ok: false; reason: CcSwitchInvalidReason } {
  let baseUrl: string | undefined;
  let wireApi = proj.rootWireApi ?? "responses";
  if (proj.modelProvider !== undefined) {
    const selected = proj.providers.get(proj.modelProvider);
    if (!selected?.baseUrl) return { ok: false, reason: "missing_base_url" };
    baseUrl = selected.baseUrl;
    if (selected.wireApi) wireApi = selected.wireApi;
  } else if (proj.providers.size > 1) {
    return { ok: false, reason: "ambiguous_codex_provider" };
  } else if (proj.providers.size === 1) {
    const only = [...proj.providers.values()][0]!;
    if (!only.baseUrl) return { ok: false, reason: "missing_base_url" };
    baseUrl = only.baseUrl;
    if (only.wireApi) wireApi = only.wireApi;
  } else if (proj.rootBaseUrl) {
    baseUrl = proj.rootBaseUrl;
  } else {
    return { ok: false, reason: "missing_base_url" };
  }
  return {
    ok: true,
    baseUrl,
    wireApi,
    ...(proj.model ? { defaultModel: proj.model } : {}),
  };
}

const SQLITE_SAFE_QUERY = `
WITH RECURSIVE
  base AS (
    SELECT
      rowid AS rid,
      CAST(id AS TEXT) AS id,
      CAST(app_type AS TEXT) AS app_type,
      CAST(COALESCE(name, id) AS TEXT) AS name,
      COALESCE(sort_index, 0) AS sort_ord,
      CASE WHEN json_valid(settings_config) THEN json_type(settings_config) ELSE NULL END AS settings_type,
      CASE WHEN json_valid(settings_config) AND json_type(settings_config, ?1) = 'text' THEN json_extract(settings_config, ?1) ELSE NULL END AS claude_base_url,
      CASE
        WHEN json_valid(settings_config) AND json_type(settings_config, ?2) = 'text' THEN json_extract(settings_config, ?2)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?3) = 'text' THEN json_extract(settings_config, ?3)
        ELSE NULL
      END AS claude_model,
      CASE
        WHEN json_valid(settings_config) AND json_type(settings_config, ?4) = 'text' THEN json_extract(settings_config, ?4)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?5) = 'text' THEN json_extract(settings_config, ?5)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?6) = 'text' THEN json_extract(settings_config, ?6)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?7) = 'text' THEN json_extract(settings_config, ?7)
        ELSE NULL
      END AS generic_base_url,
      CASE
        WHEN json_valid(settings_config) AND json_type(settings_config, ?8) = 'text' THEN json_extract(settings_config, ?8)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?9) = 'text' THEN json_extract(settings_config, ?9)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?10) = 'text' THEN json_extract(settings_config, ?10)
        WHEN json_valid(settings_config) AND json_type(settings_config, ?11) = 'text' THEN json_extract(settings_config, ?11)
        ELSE NULL
      END AS generic_model,
      CASE WHEN json_valid(settings_config) AND json_type(settings_config, ?12) = 'text' THEN json_extract(settings_config, ?12) ELSE NULL END AS generic_wire_api,
      CASE
        WHEN json_valid(settings_config) AND json_type(settings_config, ?13) = 'text' THEN
          CASE
            WHEN instr(json_extract(settings_config, ?13), '"""') > 0 OR instr(json_extract(settings_config, ?13), '''''''') > 0
              THEN '[__MULTILINE_REFUSED__]' || char(10)
            ELSE json_extract(settings_config, ?13) || char(10)
          END
        ELSE NULL
      END AS raw_cfg
    FROM providers
  ),
  lines(rid, line, rest, idx, sec) AS (
    SELECT
      rid,
      trim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')),
      substr(raw_cfg, instr(raw_cfg, char(10)) + 1),
      1,
      CASE
        WHEN substr(ltrim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')), 1, 1) = '[' THEN
          CASE
            WHEN substr(ltrim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')), 1, 17) = '[model_providers.'
              AND instr(ltrim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')), ']') > 18
              AND (
                (
                  substr(trim(substr(ltrim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')), 18, instr(ltrim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')), ']') - 18)), 1, 1) IN ('"', '''')
                  AND substr(trim(substr(ltrim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')), 18, instr(ltrim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')), ']') - 18)), -1, 1) = substr(trim(substr(ltrim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')), 18, instr(ltrim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')), ']') - 18)), 1, 1)
                  AND instr(replace(replace(substr(trim(substr(ltrim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')), 18, instr(ltrim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')), ']') - 18)), 2, length(trim(substr(ltrim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')), 18, instr(ltrim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')), ']') - 18))) - 2), '\\\\', ''), '\\"', ''), substr(trim(substr(ltrim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')), 18, instr(ltrim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')), ']') - 18)), 1, 1)) = 0
                )
                OR (
                  substr(trim(substr(ltrim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')), 18, instr(ltrim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')), ']') - 18)), 1, 1) NOT IN ('"', '''')
                  AND instr(substr(ltrim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')), 18, instr(ltrim(replace(substr(raw_cfg, 1, instr(raw_cfg, char(10)) - 1), char(13), '')), ']') - 18), '.') = 0
                )
              )
              THEN 'mp'
            ELSE 'other'
          END
        ELSE 'root'
      END
    FROM base WHERE raw_cfg IS NOT NULL AND instr(raw_cfg, char(10)) > 0
    UNION ALL
    SELECT
      rid,
      trim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')),
      substr(rest, instr(rest, char(10)) + 1),
      idx + 1,
      CASE
        WHEN substr(ltrim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')), 1, 1) = '[' THEN
          CASE
            WHEN substr(ltrim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')), 1, 17) = '[model_providers.'
              AND instr(ltrim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')), ']') > 18
              AND (
                (
                  substr(trim(substr(ltrim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')), 18, instr(ltrim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')), ']') - 18)), 1, 1) IN ('"', '''')
                  AND substr(trim(substr(ltrim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')), 18, instr(ltrim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')), ']') - 18)), -1, 1) = substr(trim(substr(ltrim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')), 18, instr(ltrim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')), ']') - 18)), 1, 1)
                  AND instr(replace(replace(substr(trim(substr(ltrim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')), 18, instr(ltrim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')), ']') - 18)), 2, length(trim(substr(ltrim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')), 18, instr(ltrim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')), ']') - 18))) - 2), '\\\\', ''), '\\"', ''), substr(trim(substr(ltrim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')), 18, instr(ltrim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')), ']') - 18)), 1, 1)) = 0
                )
                OR (
                  substr(trim(substr(ltrim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')), 18, instr(ltrim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')), ']') - 18)), 1, 1) NOT IN ('"', '''')
                  AND instr(substr(ltrim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')), 18, instr(ltrim(replace(substr(rest, 1, instr(rest, char(10)) - 1), char(13), '')), ']') - 18), '.') = 0
                )
              )
              THEN 'mp'
            ELSE 'other'
          END
        ELSE sec
      END
    FROM lines WHERE instr(rest, char(10)) > 0 AND idx <= 500
  ),
  projected_lines AS (
    SELECT rid, idx,
      CASE
        WHEN idx > 500 THEN '[__MALFORMED_LINE__]'
        WHEN line = '' OR substr(line, 1, 1) = '#' THEN NULL
        WHEN line = '[__MULTILINE_REFUSED__]' THEN '[__MULTILINE_REFUSED__]'
        WHEN substr(line, 1, 1) = '[' THEN
          CASE
            WHEN sec = 'mp' AND instr(line, ']') > 0 THEN substr(line, 1, instr(line, ']'))
            WHEN instr(line, ']') > 0 THEN '[other]'
            ELSE '[__MALFORMED_LINE__]'
          END
        WHEN instr(line, '=') = 0 THEN '[__MALFORMED_LINE__]'
        WHEN sec = 'root' AND trim(trim(substr(line, 1, instr(line, '=') - 1)), ' "''') IN ('model', 'model_provider', 'base_url', 'openai_base_url', 'wire_api')
          THEN line
        WHEN sec = 'mp' AND trim(trim(substr(line, 1, instr(line, '=') - 1)), ' "''') IN ('base_url', 'wire_api')
          THEN line
        ELSE 'ignored_key = "omitted"'
      END AS safe_line
    FROM lines
  ),
  safe_toml AS (
    SELECT rid, group_concat(safe_line, char(10)) AS codex_toml_lines
    FROM (SELECT rid, safe_line FROM projected_lines WHERE safe_line IS NOT NULL ORDER BY idx ASC)
    GROUP BY rid
  )
SELECT
  b.id AS id,
  b.app_type AS appType,
  b.name AS name,
  b.settings_type AS settingsType,
  b.claude_base_url AS claudeBaseUrl,
  b.claude_model AS claudeModel,
  b.generic_base_url AS genericBaseUrl,
  b.generic_model AS genericModel,
  b.generic_wire_api AS genericWireApi,
  s.codex_toml_lines AS codexTomlLines
FROM base b
LEFT JOIN safe_toml s ON b.rid = s.rid
ORDER BY b.sort_ord ASC, b.id ASC, b.app_type ASC
`;

export function readSqliteRows(sourcePath: string): RawExtractedRow[] {
  let db: Database | undefined;
  try {
    db = new Database(sourcePath, { readonly: true, create: false });
    return db.query(SQLITE_SAFE_QUERY).all(
      "$.env.ANTHROPIC_BASE_URL",
      "$.env.ANTHROPIC_MODEL",
      "$.env.ANTHROPIC_DEFAULT_SONNET_MODEL",
      "$.baseUrl",
      "$.base_url",
      "$.env.OPENAI_BASE_URL",
      "$.env.GEMINI_BASE_URL",
      "$.model",
      "$.defaultModel",
      "$.env.OPENAI_MODEL",
      "$.env.GEMINI_MODEL",
      "$.wire_api",
      "$.config",
    ) as RawExtractedRow[];
  } catch {
    throw new CcSwitchImportError("CC-Switch SQLite source could not be read or has an unsupported schema.");
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * Byte-level UTF-8 JSON scanner for legacy CC-Switch JSON files.
 * Walks the JSON structure on a transient Uint8Array (zeroed in finally) and decodes ONLY
 * allowlisted non-secret scalar fields, skipping over secret values without decoding them into JS strings.
 */
export function scanCcSwitchJsonBytes(bytes: Uint8Array): RawExtractedRow[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pos = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    pos = 3;
  }

  function skipWs(): void {
    while (pos < bytes.length) {
      const b = bytes[pos]!;
      if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) pos++;
      else break;
    }
  }

  function scanStringBounds(): { start: number; end: number; hasEscapes: boolean } {
    if (bytes[pos] !== 0x22) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    pos++;
    const start = pos;
    let hasEscapes = false;
    while (pos < bytes.length) {
      const b = bytes[pos]!;
      if (b < 0x20) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      if (b === 0x5c) {
        hasEscapes = true;
        pos += 2;
        if (pos > bytes.length) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
        continue;
      }
      if (b === 0x22) {
        const end = pos;
        pos++;
        return { start, end, hasEscapes };
      }
      pos++;
    }
    throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
  }

  function decodeBoundedString(bounds: { start: number; end: number; hasEscapes: boolean }): string {
    const raw = decoder.decode(bytes.subarray(bounds.start, bounds.end));
    if (!bounds.hasEscapes) return raw;
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    }
  }

  function parseJsonEscapedTomlInPlace(bounds: { start: number; end: number }): { ok: true; value: CodexTomlProjection } | { ok: false; reason: CcSwitchInvalidReason } {
    const out = new Uint8Array(bounds.end - bounds.start);
    const encodeInto = new TextEncoder();
    let readIdx = bounds.start;
    let writeIdx = 0;
    try {
      while (readIdx < bounds.end) {
        const b = bytes[readIdx]!;
        if (b !== 0x5c) {
          out[writeIdx++] = b;
          readIdx++;
          continue;
        }
        readIdx++;
        if (readIdx >= bounds.end) return { ok: false, reason: "malformed_entry" };
        const esc = bytes[readIdx]!;
        readIdx++;
        if (esc === 0x22 || esc === 0x5c || esc === 0x2f) out[writeIdx++] = esc;
        else if (esc === 0x6e) out[writeIdx++] = 0x0a;
        else if (esc === 0x72) out[writeIdx++] = 0x0d;
        else if (esc === 0x74) out[writeIdx++] = 0x09;
        else if (esc === 0x62) out[writeIdx++] = 0x08;
        else if (esc === 0x66) out[writeIdx++] = 0x0c;
        else if (esc === 0x75) {
          if (readIdx + 4 > bounds.end) return { ok: false, reason: "malformed_entry" };
          const hex = decoder.decode(bytes.subarray(readIdx, readIdx + 4));
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return { ok: false, reason: "malformed_entry" };
          readIdx += 4;
          let codePoint = parseInt(hex, 16);
          if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
            if (readIdx + 6 > bounds.end || bytes[readIdx] !== 0x5c || bytes[readIdx + 1] !== 0x75) {
              return { ok: false, reason: "malformed_entry" };
            }
            const lowHex = decoder.decode(bytes.subarray(readIdx + 2, readIdx + 6));
            if (!/^[0-9A-Fa-f]{4}$/.test(lowHex)) return { ok: false, reason: "malformed_entry" };
            const low = parseInt(lowHex, 16);
            if (low < 0xdc00 || low > 0xdfff) return { ok: false, reason: "malformed_entry" };
            readIdx += 6;
            codePoint = ((codePoint - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
          } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
            return { ok: false, reason: "malformed_entry" };
          }
          const encoded = encodeInto.encode(String.fromCodePoint(codePoint));
          out.set(encoded, writeIdx);
          writeIdx += encoded.length;
        } else {
          return { ok: false, reason: "malformed_entry" };
        }
      }
      return parseCodexTomlBytes(out.subarray(0, writeIdx));
    } finally {
      out.fill(0);
    }
  }

  function skipPrimitive(): void {
    const start = pos;
    while (pos < bytes.length) {
      const b = bytes[pos]!;
      if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x2c || b === 0x7d || b === 0x5d) break;
      pos++;
    }
    if (pos === start) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    const token = decoder.decode(bytes.subarray(start, pos));
    if (token !== "true" && token !== "false" && token !== "null" && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) {
      throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    }
  }

  function skipValue(depth = 0): void {
    if (depth > 64) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    skipWs();
    if (pos >= bytes.length) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    const b = bytes[pos]!;
    if (b === 0x22) {
      scanStringBounds();
    } else if (b === 0x7b) {
      pos++;
      skipWs();
      if (bytes[pos] === 0x7d) { pos++; return; }
      for (;;) {
        skipWs();
        scanStringBounds();
        skipWs();
        if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
        pos++;
        skipValue(depth + 1);
        skipWs();
        if (bytes[pos] === 0x2c) { pos++; continue; }
        if (bytes[pos] === 0x7d) { pos++; break; }
        throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      }
    } else if (b === 0x5b) {
      pos++;
      skipWs();
      if (bytes[pos] === 0x5d) { pos++; return; }
      for (;;) {
        skipValue(depth + 1);
        skipWs();
        if (bytes[pos] === 0x2c) { pos++; continue; }
        if (bytes[pos] === 0x5d) { pos++; break; }
        throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      }
    } else {
      skipPrimitive();
    }
  }

  function readOptionalScalarString(): string | null {
    skipWs();
    if (bytes[pos] === 0x22) return decodeBoundedString(scanStringBounds());
    skipValue();
    return null;
  }

  function parseSettingsObject(row: RawExtractedRow): void {
    skipWs();
    if (bytes[pos] !== 0x7b) {
      row.settingsType = null;
      skipValue();
      return;
    }
    row.settingsType = "object";
    pos++;
    skipWs();
    if (bytes[pos] === 0x7d) { pos++; return; }
    for (;;) {
      skipWs();
      const key = decodeBoundedString(scanStringBounds());
      skipWs();
      if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      pos++;
      skipWs();
      if (key === "env" && bytes[pos] === 0x7b) {
        pos++;
        skipWs();
        if (bytes[pos] === 0x7d) { pos++; }
        else {
          for (;;) {
            skipWs();
            const envKey = decodeBoundedString(scanStringBounds());
            skipWs();
            if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
            pos++;
            if (envKey === "ANTHROPIC_BASE_URL") row.claudeBaseUrl = readOptionalScalarString();
            else if (envKey === "ANTHROPIC_MODEL") {
              const v = readOptionalScalarString();
              if (v) row.claudeModel = v;
            } else if (envKey === "ANTHROPIC_DEFAULT_SONNET_MODEL") {
              const v = readOptionalScalarString();
              if (v && !row.claudeModel) row.claudeModel = v;
            } else if (envKey === "OPENAI_BASE_URL" || envKey === "GEMINI_BASE_URL") {
              const v = readOptionalScalarString();
              if (v && !row.genericBaseUrl) row.genericBaseUrl = v;
            } else if (envKey === "OPENAI_MODEL" || envKey === "GEMINI_MODEL") {
              const v = readOptionalScalarString();
              if (v && !row.genericModel) row.genericModel = v;
            } else {
              skipValue();
            }
            skipWs();
            if (bytes[pos] === 0x2c) { pos++; continue; }
            if (bytes[pos] === 0x7d) { pos++; break; }
            throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
          }
        }
      } else if (key === "baseUrl" || key === "base_url") {
        const v = readOptionalScalarString();
        if (v && !row.genericBaseUrl) row.genericBaseUrl = v;
      } else if (key === "model" || key === "defaultModel") {
        const v = readOptionalScalarString();
        if (v && !row.genericModel) row.genericModel = v;
      } else if (key === "wire_api") {
        const v = readOptionalScalarString();
        if (v) row.genericWireApi = v;
      } else if (key === "config") {
        skipWs();
        if (bytes[pos] === 0x22) {
          row.codexProjection = parseJsonEscapedTomlInPlace(scanStringBounds());
        } else {
          skipValue();
        }
      } else {
        skipValue();
      }
      skipWs();
      if (bytes[pos] === 0x2c) { pos++; continue; }
      if (bytes[pos] === 0x7d) { pos++; break; }
      throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    }
  }

  function parseProviderEntryObject(fallbackId = "", fallbackApp = ""): RawExtractedRow {
    skipWs();
    if (bytes[pos] !== 0x7b) throw new CcSwitchImportError("Malformed CC-Switch JSON provider entry.");
    pos++;
    const row: RawExtractedRow = {
      id: fallbackId,
      appType: fallbackApp,
      name: "",
      settingsType: null,
      claudeBaseUrl: null,
      claudeModel: null,
      genericBaseUrl: null,
      genericModel: null,
      genericWireApi: null,
      codexTomlLines: null,
    };
    skipWs();
    if (bytes[pos] === 0x7d) { pos++; return row; }
    for (;;) {
      skipWs();
      const key = decodeBoundedString(scanStringBounds());
      skipWs();
      if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      pos++;
      if (key === "id") {
        const v = readOptionalScalarString();
        if (v !== null) row.id = v;
      } else if (key === "app_type" || key === "appType") {
        const v = readOptionalScalarString();
        if (v !== null) row.appType = v;
      } else if (key === "name") {
        const v = readOptionalScalarString();
        if (v !== null) row.name = v;
      } else if (key === "settings_config" || key === "settingsConfig") {
        parseSettingsObject(row);
      } else {
        skipValue();
      }
      skipWs();
      if (bytes[pos] === 0x2c) { pos++; continue; }
      if (bytes[pos] === 0x7d) { pos++; break; }
      throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    }
    if (!row.name) row.name = row.id;
    return row;
  }

  function parseProvidersCollection(appHint = ""): RawExtractedRow[] {
    const out: RawExtractedRow[] = [];
    skipWs();
    if (bytes[pos] === 0x5b) {
      pos++;
      skipWs();
      if (bytes[pos] === 0x5d) { pos++; return out; }
      for (;;) {
        out.push(parseProviderEntryObject("", appHint));
        skipWs();
        if (bytes[pos] === 0x2c) { pos++; continue; }
        if (bytes[pos] === 0x5d) { pos++; break; }
        throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      }
    } else if (bytes[pos] === 0x7b) {
      pos++;
      skipWs();
      if (bytes[pos] === 0x7d) { pos++; return out; }
      for (;;) {
        skipWs();
        const id = decodeBoundedString(scanStringBounds());
        skipWs();
        if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
        pos++;
        out.push(parseProviderEntryObject(id, appHint));
        skipWs();
        if (bytes[pos] === 0x2c) { pos++; continue; }
        if (bytes[pos] === 0x7d) { pos++; break; }
        throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      }
    } else {
      throw new CcSwitchImportError("Malformed CC-Switch JSON providers section.");
    }
    return out;
  }

  function parseAppSection(appName: string): RawExtractedRow[] {
    const out: RawExtractedRow[] = [];
    skipWs();
    if (bytes[pos] !== 0x7b) { skipValue(); return out; }
    pos++;
    skipWs();
    if (bytes[pos] === 0x7d) { pos++; return out; }
    for (;;) {
      skipWs();
      const k = decodeBoundedString(scanStringBounds());
      skipWs();
      if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      pos++;
      if (k === "providers") out.push(...parseProvidersCollection(appName));
      else skipValue();
      skipWs();
      if (bytes[pos] === 0x2c) { pos++; continue; }
      if (bytes[pos] === 0x7d) { pos++; break; }
      throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    }
    return out;
  }

  const rows: RawExtractedRow[] = [];
  let sawStructure = false;
  skipWs();
  if (bytes[pos] !== 0x7b) throw new CcSwitchImportError("CC-Switch JSON source must be a JSON object.");
  pos++;
  skipWs();
  if (bytes[pos] === 0x7d) {
    pos++;
  } else {
    for (;;) {
      skipWs();
      const topKey = decodeBoundedString(scanStringBounds());
      skipWs();
      if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
      pos++;
      if (topKey === "providers") {
        sawStructure = true;
        rows.push(...parseProvidersCollection(""));
      } else if (topKey === "apps") {
        sawStructure = true;
        skipWs();
        if (bytes[pos] !== 0x7b) throw new CcSwitchImportError("Malformed CC-Switch JSON apps section.");
        pos++;
        skipWs();
        if (bytes[pos] === 0x7d) { pos++; }
        else {
          for (;;) {
            skipWs();
            const appName = decodeBoundedString(scanStringBounds());
            skipWs();
            if (bytes[pos] !== 0x3a) throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
            pos++;
            rows.push(...parseAppSection(appName));
            skipWs();
            if (bytes[pos] === 0x2c) { pos++; continue; }
            if (bytes[pos] === 0x7d) { pos++; break; }
            throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
          }
        }
      } else if (topKey === "claude" || topKey === "codex" || topKey === "openai" || topKey === "gemini" || topKey === "opencode") {
        sawStructure = true;
        rows.push(...parseAppSection(topKey));
      } else {
        skipValue();
      }
      skipWs();
      if (bytes[pos] === 0x2c) { pos++; continue; }
      if (bytes[pos] === 0x7d) { pos++; break; }
      throw new CcSwitchImportError("Malformed CC-Switch JSON source.");
    }
  }
  skipWs();
  if (pos !== bytes.length || !sawStructure) {
    throw new CcSwitchImportError("CC-Switch JSON source does not contain a recognized providers structure.");
  }
  return rows;
}

function readSourceRows(sourcePath: string): RawExtractedRow[] {
  const resolved = resolve(sourcePath);
  try {
    assertPlainLocalPath(resolved);
  } catch {
    throw new CcSwitchImportError("CC-Switch source path must be a plain regular local file without symlink traversal.");
  }
  let fd: number | undefined;
  let isSqlite = false;
  let size = 0;
  const header = Buffer.alloc(16);
  let jsonBuf: Buffer | undefined;
  try {
    try {
      fd = openSync(resolved, "r");
      const st = statSync(resolved);
      if (!st.isFile()) throw new CcSwitchImportError("CC-Switch source path must be a regular file.");
      size = st.size;
      const n = readSync(fd, header, 0, 16, 0);
      if (n === 16 && header.subarray(0, 15).toString("ascii") === SQLITE_MAGIC_PREFIX && header[15] === 0) {
        isSqlite = true;
      } else if (/\.(?:db|sqlite|sqlite3)$/i.test(resolved)) {
        throw new CcSwitchImportError("CC-Switch SQLite source is not a valid SQLite 3 file.");
      } else {
        if (size === 0 || size > MAX_JSON_BYTES) {
          throw new CcSwitchImportError("CC-Switch JSON source is empty or exceeds the maximum supported size.");
        }
        jsonBuf = Buffer.allocUnsafe(size);
        let offset = 0;
        while (offset < size) {
          const got = readSync(fd, jsonBuf, offset, size - offset, offset);
          if (got <= 0) break;
          offset += got;
        }
        if (offset !== size) {
          throw new CcSwitchImportError("CC-Switch JSON source changed while reading.");
        }
      }
    } catch (error) {
      if (error instanceof CcSwitchImportError) throw error;
      throw new CcSwitchImportError("CC-Switch source file could not be opened.");
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }

    if (isSqlite) {
      if (size === 0 || size > MAX_SQLITE_BYTES) {
        throw new CcSwitchImportError("CC-Switch SQLite source exceeds the maximum supported size.");
      }
      return readSqliteRows(resolved);
    }
    return scanCcSwitchJsonBytes(jsonBuf!);
  } finally {
    header.fill(0);
    jsonBuf?.fill(0);
  }
}

function evaluateExtractedRow(
  row: RawExtractedRow,
  targetName: string,
  allowPrivateNetwork: boolean,
): { ok: true; candidate: CcSwitchCandidateProvider } | { ok: false; reason: CcSwitchInvalidReason } {
  const sourceId = (row.id ?? "").trim();
  const displayName = (row.name || sourceId).trim();
  const appType = (row.appType || "").trim().toLowerCase();
  if (!sourceId || !displayName) return { ok: false, reason: "malformed_entry" };
  if (looksLikeSecretValue(sourceId) || looksLikeSecretValue(displayName)) {
    return { ok: false, reason: "secret_in_nonsecret_field" };
  }
  if (!isValidProviderName(targetName)) return { ok: false, reason: "invalid_provider_name" };
  if (row.settingsType !== "object") return { ok: false, reason: "malformed_entry" };

  let adapter: string;
  let baseUrl: string | undefined;
  let defaultModel: string | undefined;

  if (appType === "claude") {
    adapter = "anthropic";
    baseUrl = (row.claudeBaseUrl ?? row.genericBaseUrl ?? "").trim() || undefined;
    defaultModel = (row.claudeModel ?? row.genericModel ?? "").trim() || undefined;
  } else if (appType === "codex") {
    if (row.codexProjection !== undefined) {
      if (!row.codexProjection.ok) return row.codexProjection;
      const resolved = resolveCodexProjection(row.codexProjection.value);
      if (!resolved.ok) return resolved;
      baseUrl = resolved.baseUrl.trim();
      defaultModel = resolved.defaultModel?.trim() || (row.genericModel ?? "").trim() || undefined;
      const wire = resolved.wireApi.trim().toLowerCase();
      if (wire === "responses" || wire === "openai-responses") adapter = "openai-responses";
      else if (wire === "chat" || wire === "chat_completions" || wire === "openai-completions" || wire === "openai-chat") adapter = "openai-chat";
      else return { ok: false, reason: "malformed_entry" };
    } else if (row.codexTomlLines !== null) {
      const encoder = new TextEncoder();
      const tomlBytes = encoder.encode(row.codexTomlLines);
      try {
        const parsed = parseCodexTomlBytes(tomlBytes);
        if (!parsed.ok) return parsed;
        const resolved = resolveCodexProjection(parsed.value);
        if (!resolved.ok) return resolved;
        baseUrl = resolved.baseUrl.trim();
        defaultModel = resolved.defaultModel?.trim() || (row.genericModel ?? "").trim() || undefined;
        const wire = resolved.wireApi.trim().toLowerCase();
        if (wire === "responses" || wire === "openai-responses") adapter = "openai-responses";
        else if (wire === "chat" || wire === "chat_completions" || wire === "openai-completions" || wire === "openai-chat") adapter = "openai-chat";
        else return { ok: false, reason: "malformed_entry" };
      } finally {
        tomlBytes.fill(0);
      }
    } else if (row.genericBaseUrl) {
      baseUrl = row.genericBaseUrl.trim();
      defaultModel = (row.genericModel ?? "").trim() || undefined;
      const wire = (row.genericWireApi ?? "responses").trim().toLowerCase();
      adapter = wire === "chat" || wire === "chat_completions" || wire === "openai-chat" ? "openai-chat" : "openai-responses";
    } else {
      return { ok: false, reason: "missing_base_url" };
    }
  } else if (appType === "openai" || appType === "opencode") {
    adapter = "openai-chat";
    baseUrl = (row.genericBaseUrl ?? "").trim() || undefined;
    defaultModel = (row.genericModel ?? "").trim() || undefined;
  } else if (appType === "gemini") {
    adapter = "google";
    baseUrl = (row.genericBaseUrl ?? "").trim() || undefined;
    defaultModel = (row.genericModel ?? "").trim() || undefined;
  } else {
    return { ok: false, reason: "unsupported_app_type" };
  }

  if (!baseUrl) return { ok: false, reason: "missing_base_url" };
  if (looksLikeSecretValue(baseUrl, true) || (defaultModel !== undefined && looksLikeSecretValue(defaultModel))) {
    return { ok: false, reason: "secret_in_nonsecret_field" };
  }
  if (providerBaseUrlConfigError(baseUrl) !== null) {
    return { ok: false, reason: "invalid_base_url" };
  }
  // Classify against a synthetic non-registry name so local registry names (like "ollama")
  // still require explicit --allow-private-network opt-in when imported from CC-Switch.
  const strictDestErr = providerDestinationConfigError("__cc_switch_imported__", { baseUrl, allowPrivateNetwork: false });
  if (strictDestErr !== null) {
    const permissiveDestErr = providerDestinationConfigError("__cc_switch_imported__", { baseUrl, allowPrivateNetwork: true });
    if (permissiveDestErr !== null || providerDestinationConfigError(targetName, { baseUrl, allowPrivateNetwork: true }) !== null) {
      return { ok: false, reason: "invalid_base_url" };
    }
    if (!allowPrivateNetwork) {
      return { ok: false, reason: "private_network_refused" };
    }
    return {
      ok: true,
      candidate: {
        name: targetName,
        sourceId,
        displayName,
        appType,
        adapter,
        baseUrl,
        ...(defaultModel ? { defaultModel } : {}),
        allowPrivateNetwork: true,
      },
    };
  }

  return {
    ok: true,
    candidate: {
      name: targetName,
      sourceId,
      displayName,
      appType,
      adapter,
      baseUrl,
      ...(defaultModel ? { defaultModel } : {}),
    },
  };
}

function buildImportedProviderConfig(candidate: CcSwitchCandidateProvider, importId: string): OcxProviderConfig {
  return {
    adapter: candidate.adapter,
    baseUrl: candidate.baseUrl,
    ...(candidate.defaultModel ? { defaultModel: candidate.defaultModel } : {}),
    ...(candidate.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
    note: `imported:cc-switch:${importId}:${candidate.sourceId}:${candidate.appType}`,
  };
}

function assertStopped(): void {
  let running = readAlivePid() !== null;
  const runtime = readRuntimePort();
  if (runtime) {
    try {
      process.kill(runtime.pid, 0);
      running = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") running = true;
    }
  }
  if (running) {
    throw new CcSwitchImportError("Stop the opencodex proxy before applying or restoring a CC-Switch provider import.");
  }
}

/**
 * Exhaustive check that no setting in OcxConfig references the given provider name before
 * --restore deletes it. Runs inside the mutatePersistedConfig callback on every rebase attempt.
 */
export function isProviderReferencedInConfig(config: OcxConfig, name: string): boolean {
  if (config.defaultProvider === name) return true;
  if (Object.keys(config.providers ?? {}).length <= 1) return true;
  const prefix = `${name}/`;
  const rewriteProbe = rewriteProviderReferences(structuredClone(config), name, "__cc_switch_probe__");
  if (rewriteProbe.changed > 0 || rewriteProbe.collisions.length > 0) return true;

  if (config.fallback?.providers && Object.hasOwn(config.fallback.providers, name)) return true;
  if (config.fallback?.routes && Object.keys(config.fallback.routes).some(k => k === name || k.startsWith(prefix))) return true;

  const startsWithPrefix = (v: unknown): boolean => typeof v === "string" && v.trim().startsWith(prefix);
  if (startsWithPrefix(config.claudeCode?.classifierModel)) return true;
  if ((config.claudeCode?.classifierFallbacks ?? []).some(startsWithPrefix)) return true;
  if (config.subagentModelFallbackByModel) {
    for (const [k, list] of Object.entries(config.subagentModelFallbackByModel)) {
      if (k.startsWith(prefix) || (Array.isArray(list) && list.some(startsWithPrefix))) return true;
    }
  }
  for (const tierList of [config.codexRoleTiers?.fast, config.codexRoleTiers?.standard, config.codexRoleTiers?.frontier]) {
    if ((tierList ?? []).some(startsWithPrefix)) return true;
  }
  if ((config.modelPickerOrder ?? []).some(startsWithPrefix)) return true;
  if (config.modelPinnedEfforts && Object.keys(config.modelPinnedEfforts).some(k => k.startsWith(prefix))) return true;
  if (startsWithPrefix(config.compactionRouting?.model)) return true;
  if ((config.compactionRouting?.sourceModels ?? []).some(startsWithPrefix)) return true;
  if (startsWithPrefix(config.compactionRecovery?.model)) return true;
  if (startsWithPrefix(config.memoryModels?.extract?.model) || startsWithPrefix(config.memoryModels?.consolidation?.model)) return true;
  if (startsWithPrefix(config.autoReviewOverride?.model)) return true;
  if (startsWithPrefix(config.codexMainAccountHardLockFallback?.model)) return true;
  if (startsWithPrefix(config.agentTaskRecovery?.model)) return true;
  if (startsWithPrefix(config.advisor?.model)) return true;
  if (config.blockedModelRedirects) {
    for (const [k, v] of Object.entries(config.blockedModelRedirects)) {
      if (k.startsWith(prefix) || startsWithPrefix(v)) return true;
    }
  }
  for (const keyEntry of config.apiKeys ?? []) {
    if ((keyEntry.allowedProviders ?? []).includes(name)) return true;
    if ((keyEntry.allowedModels ?? []).some(startsWithPrefix)) return true;
  }
  if (config.spendPoolAliases && Object.values(config.spendPoolAliases).some(v => v === name)) return true;
  for (const group of config.pool?.credentialGroups ?? []) {
    if ((group.credentials ?? []).some(c => typeof c === "string" && c.toLowerCase().startsWith(`${name.toLowerCase()}:`))) {
      return true;
    }
  }
  return false;
}

function requireValidPersistedConfig(): OcxConfig {
  const diag = readConfigDiagnostics();
  if (diag.source !== "file" || diag.error !== null) {
    throw new CcSwitchImportError("Initialize a valid opencodex configuration before importing or restoring providers.");
  }
  return diag.config;
}

function assignTargetNames(rows: RawExtractedRow[]): string[] {
  const slugCounts = new Map<string, number>();
  const rawSlugs = rows.map(r => normalizeProviderSlug(r.id || r.name));
  for (const s of rawSlugs) {
    slugCounts.set(s, (slugCounts.get(s) ?? 0) + 1);
  }
  const used = new Set<string>();
  return rows.map((r, i) => {
    const base = rawSlugs[i]!;
    const appSlug = normalizeProviderSlug(r.appType);
    let candidate = (slugCounts.get(base) ?? 0) > 1 && appSlug ? `${base}-${appSlug}` : base;
    if (used.has(candidate)) {
      let suffix = 2;
      while (used.has(`${candidate}-${suffix}`)) suffix++;
      candidate = `${candidate}-${suffix}`;
    }
    used.add(candidate);
    return candidate;
  });
}

function prepareCandidates(options: {
  sourcePath: string;
  selectedProviders?: readonly string[];
  allowPrivateNetwork?: boolean;
  config: OcxConfig;
}): CcSwitchImportPreviewOrApplyResult {
  const rows = readSourceRows(options.sourcePath);
  const targetNames = assignTargetNames(rows);
  const filterSet = options.selectedProviders && options.selectedProviders.length > 0
    ? new Set(options.selectedProviders.map(s => s.trim()).filter(Boolean))
    : null;

  if (filterSet) {
    for (const wanted of filterSet) {
      const matchesAny = rows.some((r, idx) => r.id === wanted || targetNames[idx] === wanted);
      if (!matchesAny) {
        throw new CcSwitchImportError(`Requested provider "${wanted}" was not found in the CC-Switch source.`);
      }
    }
  }

  const result: CcSwitchImportPreviewOrApplyResult = {
    mode: "preview",
    discovered: 0,
    eligible: 0,
    imported: 0,
    conflicts: 0,
    conflictNames: [],
    invalid: 0,
    invalidReasons: {},
    providers: [],
  };

  rows.forEach((row, idx) => {
    const targetName = targetNames[idx]!;
    if (filterSet && !filterSet.has(row.id) && !filterSet.has(targetName)) return;
    result.discovered++;
    const evaluated = evaluateExtractedRow(row, targetName, options.allowPrivateNetwork === true);
    if (!evaluated.ok) {
      result.invalid++;
      result.invalidReasons[evaluated.reason] = (result.invalidReasons[evaluated.reason] ?? 0) + 1;
      return;
    }
    const { candidate } = evaluated;
    if (
      hasOwnProvider(options.config.providers, candidate.name)
      || Boolean(codexAccountNamespaceProviderCollisionError(options.config.codexAccountNamespaces, candidate.name))
    ) {
      result.conflicts++;
      result.conflictNames.push(candidate.name);
      return;
    }
    result.eligible++;
    result.providers.push(candidate);
  });

  return result;
}

function reconcileJournalForApply(config: OcxConfig, journalPath: string): void {
  const existing = readJournal(journalPath);
  if (!existing) return;
  const anyPublished = existing.entries.some(e => {
    const current = config.providers?.[e.name];
    return current !== undefined && current.note === e.note;
  });
  if (existing.state === "committed" || anyPublished) {
    throw new CcSwitchImportError(
      "An active CC-Switch import journal already exists; run 'ocx provider import-cc-switch --restore' before applying another import.",
    );
  }
  // Stale prepared journal where zero entries carry this journal's importId note.
  unlinkJournalDurably(journalPath);
}

export async function runCcSwitchProviderImport(options: {
  mode: "preview" | "apply" | "restore";
  sourcePath?: string;
  selectedProviders?: readonly string[];
  allowPrivateNetwork?: boolean;
}): Promise<CcSwitchImportResult> {
  if (options.mode === "preview") {
    if (!options.sourcePath) throw new CcSwitchImportError("--source is required for preview and apply.");
    const config = requireValidPersistedConfig();
    return prepareCandidates({
      sourcePath: options.sourcePath,
      selectedProviders: options.selectedProviders,
      allowPrivateNetwork: options.allowPrivateNetwork,
      config,
    });
  }

  assertStopped();
  return await withConfigDirHardeningSettled(getConfigDir(), () => {
    const lease = acquireOwnershipMutationLease(serviceStatePaths());
    try {
      assertStopped();
      return withConfigMutationLockSync(() => {
        assertStopped();
        const journalPath = join(getConfigDir(), CC_SWITCH_IMPORT_JOURNAL_FILENAME);

        if (options.mode === "apply") {
          if (!options.sourcePath) throw new CcSwitchImportError("--source is required for preview and apply.");
          const initialConfig = requireValidPersistedConfig();
          reconcileJournalForApply(initialConfig, journalPath);

          const prepared = prepareCandidates({
            sourcePath: options.sourcePath,
            selectedProviders: options.selectedProviders,
            allowPrivateNetwork: options.allowPrivateNetwork,
            config: initialConfig,
          });
          prepared.mode = "apply";
          if (prepared.providers.length === 0) return prepared;

          const importId = randomUUID();
          const builtEntries = prepared.providers.map(candidate => {
            const providerConfig = buildImportedProviderConfig(candidate, importId);
            const fingerprint = canonicalProviderFingerprint(providerConfig);
            return {
              candidate,
              providerConfig,
              journalEntry: {
                name: candidate.name,
                sourceId: candidate.sourceId,
                appType: candidate.appType,
                note: providerConfig.note!,
                fingerprint,
              },
            };
          });

          const journal: ImportJournal = {
            schemaVersion: 1,
            state: "prepared",
            importId,
            createdAt: Date.now(),
            entries: builtEntries.map(b => b.journalEntry),
          };
          writeJournalDurably(journalPath, journal);

          try {
            const outcome = mutatePersistedConfig(config => {
              assertStopped();
              for (const { candidate, providerConfig } of builtEntries) {
                if (
                  hasOwnProvider(config.providers, candidate.name)
                  || Boolean(codexAccountNamespaceProviderCollisionError(config.codexAccountNamespaces, candidate.name))
                ) {
                  throw new CcSwitchImportError("Target configuration changed and now conflicts with imported provider names; retry.");
                }
                config.providers[candidate.name] = structuredClone(providerConfig);
              }
              const validation = validateConfigCandidate(config);
              if (!validation.ok) {
                throw new CcSwitchImportError(`Imported provider configuration failed validation: ${validation.error}`);
              }
              return { changed: true, value: builtEntries.length };
            });
            if (outcome.status !== "committed") {
              throw new CcSwitchImportError("Target configuration could not be committed.");
            }
            writeJournalDurably(journalPath, { ...journal, state: "committed" });
            prepared.imported = builtEntries.length;
            return prepared;
          } catch (error) {
            // Never blindly unlink the prepared journal if the config write actually published!
            const snap = readConfigFileSnapshot();
            if (snap.diagnostics.source === "file" && snap.diagnostics.error === null) {
              const landed = journal.entries.filter(e => snap.diagnostics.config.providers?.[e.name]?.note === e.note);
              if (landed.length === 0) {
                unlinkJournalDurably(journalPath);
              } else {
                writeJournalDurably(journalPath, { ...journal, state: "committed", entries: landed });
              }
            }
            if (error instanceof CcSwitchImportError) throw error;
            throw new CcSwitchImportError("CC-Switch provider import could not be committed.");
          }
        }

        // mode === "restore"
        requireValidPersistedConfig();
        const journal = readJournal(journalPath);
        if (!journal) {
          throw new CcSwitchImportError("No CC-Switch provider import journal found to restore.");
        }

        try {
          const outcome = mutatePersistedConfig(config => {
            assertStopped();
            const restoredNames: string[] = [];
            let alreadyAbsent = 0;
            const retainedEntries: JournalEntry[] = [];

            for (const entry of journal.entries) {
              if (!hasOwnProvider(config.providers, entry.name)) {
                alreadyAbsent++;
                continue;
              }
              const current = config.providers[entry.name]!;
              if (
                current.note !== entry.note
                || canonicalProviderFingerprint(current) !== entry.fingerprint
                || isProviderReferencedInConfig(config, entry.name)
              ) {
                retainedEntries.push(entry);
                continue;
              }
              const probe = structuredClone(config);
              delete probe.providers[entry.name];
              if (!validateConfigCandidate(probe).ok) {
                retainedEntries.push(entry);
                continue;
              }
              delete config.providers[entry.name];
              restoredNames.push(entry.name);
            }

            if (restoredNames.length > 0) {
              const validation = validateConfigCandidate(config);
              if (!validation.ok) {
                throw new CcSwitchImportError("Configuration after restoring CC-Switch providers failed validation.");
              }
            }
            return {
              changed: restoredNames.length > 0,
              value: { restoredNames, alreadyAbsent, retainedEntries },
            };
          });

          if (outcome.status === "unavailable") {
            throw new CcSwitchImportError("Target configuration could not be committed during restore.");
          }
          const { restoredNames, alreadyAbsent, retainedEntries } = outcome.value;
          if (retainedEntries.length === 0) {
            unlinkJournalDurably(journalPath);
          } else {
            writeJournalDurably(journalPath, {
              ...journal,
              state: "committed",
              entries: retainedEntries,
            });
          }
          return {
            mode: "restore",
            restored: restoredNames.length,
            restoredNames,
            alreadyAbsent,
            retainedEdited: retainedEntries.length,
            retainedNames: retainedEntries.map(e => e.name),
          };
        } catch (error) {
          const snap = readConfigFileSnapshot();
          if (snap.diagnostics.source === "file" && snap.diagnostics.error === null) {
            const remaining = journal.entries.filter(e => hasOwnProvider(snap.diagnostics.config.providers, e.name));
            if (remaining.length > 0) {
              writeJournalDurably(journalPath, { ...journal, state: "committed", entries: remaining });
            }
          }
          if (error instanceof CcSwitchImportError) throw error;
          throw new CcSwitchImportError("CC-Switch provider restore could not complete.");
        }
      });
    } finally {
      lease.release();
    }
  });
}
