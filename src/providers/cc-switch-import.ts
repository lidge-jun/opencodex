/**
 * Keyless CC-Switch provider configuration importer (preview, selective apply, and journaled restore).
 *
 * Security & privacy boundary:
 * - Structural non-secret projection: projects values ONLY from an explicit allowlist of non-secret
 *   metadata fields (id, app_type, baseUrl, wire adapter, defaultModel); source bytes are scanned
 *   transiently while secret fields, free-text names, and TOML comments are skipped at the byte
 *   level (never decoded into strings, written, or logged) and transient buffers are zeroed in finally.
 * - Enforces a narrow URL path grammar and identifier/model syntax checks as defense in depth.
 * - Source files are opened read-only with O_NOFOLLOW | O_NONBLOCK, descriptor-verified, and
 *   refused if an active SQLite -wal/-journal sidecar is non-empty.
 * - Apply and restore run only while the proxy is stopped, under the service ownership lease and
 *   the shared config mutation lock, with a durable streaming journal for rollback.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
import { codexAccountNamespaceProviderCollisionError } from "../codex/account-namespace-match";
import { providerDestinationConfigError } from "../lib/destination-policy";
import { getAuthStorePath } from "../oauth/store";
import { rewriteProviderReferences } from "./provider-id-rewrite";
import { acquireOwnershipMutationLease } from "../service/ownership-mutation-lease.mjs";
import { serviceStatePaths } from "../service/state";
import type { OcxConfig, OcxProviderConfig } from "../types";
import {
  CcSwitchImportError,
  MAX_JSON_BYTES,
  METADATA_REFUSED_SENTINEL,
  URL_SYNTAX_REFUSED_SENTINEL,
  equalsAsciiBytes,
  isAllowedMetadataBytes,
  isDisallowedMetadataValue,
  parseCodexTomlBytes,
  readSourceRows,
  readSqliteRows,
  resolveCodexProjection,
  scanCcSwitchJsonBytes,
  setCcSwitchSourceOpenHookForTests,
  unescapeJsonStringBytesBounded,
  validateJsonPrimitiveBytes,
  validateUtf8AndJsonStringBounds,
  type CcSwitchInvalidReason,
  type CodexTomlProjection,
  type MetadataFieldKind,
  type RawExtractedRow,
} from "./cc-switch-import-source";

export {
  CcSwitchImportError,
  METADATA_REFUSED_SENTINEL,
  URL_SYNTAX_REFUSED_SENTINEL,
  isAllowedMetadataBytes,
  parseCodexTomlBytes,
  readSqliteRows,
  scanCcSwitchJsonBytes,
  setCcSwitchSourceOpenHookForTests,
  type CcSwitchInvalidReason,
  type CodexTomlProjection,
  type MetadataFieldKind,
};

export interface CcSwitchCandidateProvider {
  name: string;
  sourceId: string;
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

function evaluateExtractedRow(
  row: RawExtractedRow,
  targetName: string,
  allowPrivateNetwork: boolean,
): { ok: true; candidate: CcSwitchCandidateProvider } | { ok: false; reason: CcSwitchInvalidReason } {
  const sourceId = (row.id ?? "").trim();
  const appType = (row.appType || "").trim().toLowerCase();
  if (!sourceId) return { ok: false, reason: "malformed_entry" };
  if (isDisallowedMetadataValue(sourceId, "id") || (appType !== "" && isDisallowedMetadataValue(appType, "app"))) {
    return { ok: false, reason: "disallowed_metadata" };
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
      if (wire === METADATA_REFUSED_SENTINEL.toLowerCase()) return { ok: false, reason: "disallowed_metadata" };
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
        if (wire === METADATA_REFUSED_SENTINEL.toLowerCase()) return { ok: false, reason: "disallowed_metadata" };
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
      if (wire === METADATA_REFUSED_SENTINEL.toLowerCase()) return { ok: false, reason: "disallowed_metadata" };
      if (wire === "responses" || wire === "openai-responses") adapter = "openai-responses";
      else if (wire === "chat" || wire === "chat_completions" || wire === "openai-completions" || wire === "openai-chat") adapter = "openai-chat";
      else return { ok: false, reason: "malformed_entry" };
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
  if (defaultModel !== undefined && isDisallowedMetadataValue(defaultModel, "model")) {
    return { ok: false, reason: "disallowed_metadata" };
  }
  if (baseUrl === URL_SYNTAX_REFUSED_SENTINEL || isDisallowedMetadataValue(baseUrl, "url")) {
    return { ok: false, reason: "invalid_base_url" };
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
 * Read-only byte-level inspection of ~/.opencodex/auth.json to determine whether `name` has stored
 * OAuth accounts (or whether auth.json is unreadable/malformed) without decoding any OAuth tokens.
 */
export function hasOrCannotVerifyOAuthAccounts(name: string): boolean {
  const authPath = getAuthStorePath();
  const nameBytes = Buffer.from(name, "utf8");
  let fd: number | undefined;
  let buf: Buffer | undefined;
  try {
    try {
      fd = openSync(
        authPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > MAX_JSON_BYTES) return true;
      if (st.size === 0) return true;
      buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const got = readSync(fd, buf, off, st.size - off, off);
        if (got <= 0) break;
        off += got;
      }
      if (off !== st.size) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      return true;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
    const bytes = buf!;
    let pos = 0;
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) pos = 3;
    const skipWs = () => {
      while (pos < bytes.length && (bytes[pos] === 0x20 || bytes[pos] === 0x09 || bytes[pos] === 0x0a || bytes[pos] === 0x0d)) pos++;
    };
    const scanStr = (): { start: number; end: number; hasEsc: boolean } => {
      const res = validateUtf8AndJsonStringBounds(bytes, pos);
      if (!res) throw new Error("malformed");
      pos = res.nextPos;
      return { start: res.start, end: res.end, hasEsc: res.hasEscapes };
    };
    const keyEqualsBytes = (b: { start: number; end: number; hasEsc: boolean }, target: Uint8Array): boolean => {
      if (!b.hasEsc) {
        const raw = bytes.subarray(b.start, b.end);
        if (raw.length !== target.length) return false;
        for (let i = 0; i < raw.length; i++) if (raw[i] !== target[i]) return false;
        return true;
      }
      const unesc = unescapeJsonStringBytesBounded(bytes, { start: b.start, end: b.end, hasEscapes: true }, 128);
      if (!unesc) throw new Error("malformed");
      try {
        if (unesc.length !== target.length) return false;
        for (let i = 0; i < unesc.length; i++) if (unesc[i] !== target[i]) return false;
        return true;
      } finally {
        unesc.fill(0);
      }
    };
    const keyEqualsAscii = (b: { start: number; end: number; hasEsc: boolean }, target: string): boolean => {
      if (!b.hasEsc) return equalsAsciiBytes(bytes.subarray(b.start, b.end), target);
      const unesc = unescapeJsonStringBytesBounded(bytes, { start: b.start, end: b.end, hasEscapes: true }, 128);
      if (!unesc) throw new Error("malformed");
      try {
        return equalsAsciiBytes(unesc, target);
      } finally {
        unesc.fill(0);
      }
    };
    const skipPrim = () => {
      const s = pos;
      while (pos < bytes.length && ![0x20, 0x09, 0x0a, 0x0d, 0x2c, 0x7d, 0x5d].includes(bytes[pos]!)) pos++;
      if (!validateJsonPrimitiveBytes(bytes, s, pos)) {
        throw new Error("malformed");
      }
    };
    const skipVal = (depth = 0): void => {
      if (depth > 32) throw new Error("malformed");
      skipWs();
      const b = bytes[pos];
      if (b === 0x22) { scanStr(); return; }
      if (b === 0x7b) {
        pos++; skipWs();
        if (bytes[pos] === 0x7d) { pos++; return; }
        for (;;) {
          skipWs(); scanStr(); skipWs();
          if (bytes[pos] !== 0x3a) throw new Error("malformed");
          pos++; skipVal(depth + 1); skipWs();
          if (bytes[pos] === 0x2c) { pos++; continue; }
          if (bytes[pos] === 0x7d) { pos++; return; }
          throw new Error("malformed");
        }
      }
      if (b === 0x5b) {
        pos++; skipWs();
        if (bytes[pos] === 0x5d) { pos++; return; }
        for (;;) {
          skipVal(depth + 1); skipWs();
          if (bytes[pos] === 0x2c) { pos++; continue; }
          if (bytes[pos] === 0x5d) { pos++; return; }
          throw new Error("malformed");
        }
      }
      skipPrim();
    };
    skipWs();
    if (bytes[pos] !== 0x7b) return true;
    pos++; skipWs();
    let foundAccounts = false;
    if (bytes[pos] === 0x7d) {
      pos++;
    } else {
      for (;;) {
        skipWs();
        const provKeyBounds = scanStr();
        skipWs();
        if (bytes[pos] !== 0x3a) return true;
        pos++; skipWs();
        if (!keyEqualsBytes(provKeyBounds, nameBytes)) {
          skipVal();
        } else {
          // Inspect the provider entry without decoding any token strings.
          if (bytes[pos] !== 0x7b) return true;
          pos++; skipWs();
          if (bytes[pos] === 0x7d) { pos++; }
          else {
            let sawAccountsArray = false;
            for (;;) {
              skipWs();
              const fieldKeyBounds = scanStr();
              skipWs();
              if (bytes[pos] !== 0x3a) return true;
              pos++; skipWs();
              if (keyEqualsAscii(fieldKeyBounds, "accounts")) {
                if (bytes[pos] !== 0x5b) return true;
                sawAccountsArray = true;
                pos++; skipWs();
                if (bytes[pos] === 0x5d) {
                  pos++;
                } else {
                  foundAccounts = true;
                  for (;;) {
                    skipVal(1); skipWs();
                    if (bytes[pos] === 0x2c) { pos++; continue; }
                    if (bytes[pos] === 0x5d) { pos++; break; }
                    return true;
                  }
                }
              } else if (keyEqualsAscii(fieldKeyBounds, "activeAccountId") || keyEqualsAscii(fieldKeyBounds, "selectionRevision")) {
                skipVal(1);
              } else {
                // Legacy single-credential shape or unknown field -> retain provider.
                foundAccounts = true;
                skipVal(1);
              }
              skipWs();
              if (bytes[pos] === 0x2c) { pos++; continue; }
              if (bytes[pos] === 0x7d) { pos++; break; }
              return true;
            }
            if (!sawAccountsArray) foundAccounts = true;
          }
        }
        skipWs();
        if (bytes[pos] === 0x2c) { pos++; continue; }
        if (bytes[pos] === 0x7d) { pos++; break; }
        return true;
      }
    }
    skipWs();
    if (pos !== bytes.length) return true;
    return foundAccounts;
  } catch {
    return true;
  } finally {
    nameBytes.fill(0);
    buf?.fill(0);
  }
}

/**
 * Exhaustive check that no setting in OcxConfig references the given provider name before
 * --restore deletes it. Runs inside the mutatePersistedConfig callback on every rebase attempt.
 */
export function isProviderReferencedInConfig(config: OcxConfig, name: string): boolean {
  if (config.defaultProvider === name) return true;
  if (Object.keys(config.providers ?? {}).length <= 1) return true;
  if (hasOrCannotVerifyOAuthAccounts(name)) return true;
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
  const rawSlugs = rows.map(r => normalizeProviderSlug(r.id));
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
        throw new CcSwitchImportError("CC-Switch source does not contain one or more requested --provider IDs.");
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
  onBeforeApplyWrite?: (providers: readonly CcSwitchCandidateProvider[]) => void;
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
          options.onBeforeApplyWrite?.(prepared.providers);

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
                throw new CcSwitchImportError("CC-Switch imported provider configuration failed schema validation.");
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
